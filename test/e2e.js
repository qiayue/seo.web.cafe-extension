// test/e2e.js — 把插件真装进 Chromium，整条取数链路跑一遍（node test/e2e.js；需要 Playwright）
//
// 真的谷歌趋势测不了（会被当成自动化访问），所以在网络层把两个站都换成假的——本机起一个 HTTPS 服务，
// 用 --host-resolver-rules 把 trends.google.com / seo.web.cafe 解析到它（插件自己开的标签页 Playwright 拦不到，
// 只能在 DNS 这一层换）：
//   · trends.google.com：一个假的「探索」页，照真页面的样子用 fetch / XHR 去请求 multiline 与 relatedsearches，
//     两个接口回和线上同形的数据（带 )]}' 前缀）；
//   · seo.web.cafe：一个假的对话页，照 chat-page.js 的协议跟插件说话（ping / hello / trends:fetch / trends:result）。
// 插件本身一行不改：真的 service worker、真的内容脚本（MAIN 与隔离两个环境）、真的开标签页 / 关标签页。
//
// 钉住：① 对话页能认出插件，而且页面脚本同步执行时就认得出；② 请求 → 后台开谷歌趋势标签页 → 截到数据 → 送回对话页，数据完整；
//       ③ 取完自动关掉那个标签页；④ 谷歌限流（429）或跳去人机验证页时马上送回原因，并把标签页留在前台让用户看见；
//       ④c 后台叫不醒时 8 秒后切到前台、取到后切回；④d 用户自己开的谷歌趋势标签页一概不碰；
//       ⑤ 不是 seo.web.cafe 发来的请求一律不接；⑥ 侧边栏页面能打开、没有脚本错误；
//       ⑥b Ahrefs 按钮（官方 / 镜像站地址可配）；⑧ 授权后自动跟随当前网页（手动填过的不覆盖）；
//       ⑦ 侧边栏直接查谷歌趋势：曲线（没过完的点虚线）/ 统计 / 相关查询 / 原始 JSON，发现新的一波自动补查更细的，
//          可选取完不关标签页，失败说原因。
// 注意：无头 Chromium 不会像真浏览器那样冻结后台标签页，「叫醒」本身在这里测不出效果，只测它只作用于插件开的标签页；
//       「后台不加载」用假站扣住曲线接口来模拟，测的是兜底（切前台 → 切回）。
"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

let playwright = null;
for (const p of ["playwright", process.env.PLAYWRIGHT_MODULE, "/opt/node22/lib/node_modules/playwright"].filter(Boolean)) {
  try { playwright = require(p); break; } catch {}
}
if (!playwright) { console.log("跳过：没装 Playwright（npm i -D playwright 后再跑）"); process.exit(0); }

const EXT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const XSSI = ")]}',\n";
let failed = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "  ✓ " : "  ✕ ") + name + (extra ? "  " + extra : "")); if (!cond) failed++; };

// 假数据按「现在」往回排（测试哪天跑都一样），形状照线上 jev：之前只有零星 1，最近冲起来，最后一个点没过完
const NOW = Math.floor(Date.now() / 1000), DAY = 86400, WEEK = 7 * DAY;
const weekStart = NOW - (NOW % WEEK);
// 12 个月按周：53 个点，第 20 周有个 1 的小包，三周前那周起一波 20 → 45 → 80，没过完的这一周 100
const WEEKLY = Array.from({ length: 53 }, (_, i) => Object.assign(
  { time: String(weekStart - (52 - i) * WEEK), value: [i === 20 ? 1 : i >= 49 ? [20, 45, 80, 100][i - 49] : 0], hasData: [true] },
  i === 52 ? { isPartial: true } : {}));
// 30 天按天：线上 jev 实测的 31 个值，最后再加一个没过完的今天
const JEV30 = require("./fixtures/jev-30d.json").points.map((p) => p.v).concat(70);
const dayStart = NOW - (NOW % DAY);
const DAILY = JEV30.map((v, i) => Object.assign({ time: String(dayStart - (JEV30.length - 1 - i) * DAY), value: [v], hasData: [true] },
  i === JEV30.length - 1 ? { isPartial: true } : {}));
const timeline = (date) => ({ default: { timelineData: /1-m|3-m|7-d/.test(date || "") ? DAILY : WEEKLY } });
const RELATED = { default: { rankedList: [{ rankedKeyword: [{ query: "jev ai", value: 100, formattedValue: "100" }] }, { rankedKeyword: [{ query: "jev api", value: 4550, formattedValue: "Breakout" }] }] } };

// 假的谷歌趋势探索页：和真页面一样，自己去请求两个接口（一个 fetch、一个 XHR，两种都要截得到）
// 顺手报告：页面脚本跑起来时看到的网址、「是否可见」有没有被插件改过（只有插件开的标签页才该被改）
const trendsPage = `<!doctype html><title>Google Trends (mock)</title><script>
  var sp = new URLSearchParams(location.search);
  var q = sp.get('q') || '';
  var patched = !/native code/.test(Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.toString());
  fetch('/trends/probe?q=' + encodeURIComponent(q) + '&patched=' + patched + '&href=' + encodeURIComponent(location.href));
  var kw = { type: 'BROAD', value: q };
  var multi = { time: sp.get('date') || '', resolution: 'WEEK', comparisonItem: [{ geo: {}, complexKeywordsRestriction: { keyword: [kw] } }] };
  var rel = { restriction: { geo: {}, complexKeywordsRestriction: { keyword: [kw] } }, keywordType: 'QUERY', metric: ['TOP', 'RISING'] };
  fetch('/trends/api/widgetdata/multiline?hl=en-US&req=' + encodeURIComponent(JSON.stringify(multi)) + '&token=t');
  setTimeout(function () {
    var x = new XMLHttpRequest();
    x.open('GET', '/trends/api/widgetdata/relatedsearches?hl=en-US&req=' + encodeURIComponent(JSON.stringify(rel)) + '&token=t');
    x.send();
  }, 300);
</script>`;

// 假的对话页：只实现和插件说话的那几句（与 seo.web.cafe 的 chat-page.js 同一套协议）
// __syncSeen：页面脚本一开始执行就能不能认出插件（最早的时刻）——真对话页 /chat/?q=… 的自动发问不管排在什么时候都不用赌时序
const chatPage = `<!doctype html><title>chat (mock)</title><script>
  window.__syncSeen = document.documentElement.getAttribute('data-gefei-seo-ext');
  window.__hello = null; window.__results = {};
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'gefei-seo-ext') return;
    if (e.data.type === 'hello') window.__hello = e.data;
    if (e.data.type === 'trends:result') window.__results[e.data.requestId] = e.data;
  });
  window.postMessage({ source: 'gefei-seo-page', type: 'ping' }, location.origin);
  window.__fetch = function (id, kw) {
    window.postMessage({ source: 'gefei-seo-page', type: 'trends:fetch', requestId: id, keyword: kw, geo: '', date: 'today 12-m' }, location.origin);
  };
</script>`;

// 本机假站：按 Host 分发。证书现生成（自签，浏览器那边用 --ignore-certificate-errors 放行），不进仓库
function makeCert(dir) {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  } catch { return null; }
}
let throttle = false;
const probes = {};
// 「后台不加载」的谷歌趋势：词是 stall 时，曲线接口先不回，等测试看到那个标签页真切到了前台再放行
const stalled = [];
function handle(req, res) {
  const host = String(req.headers.host || "").split(":")[0];
  const u = new URL(req.url, "https://" + host);
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (host === "trends.google.com") {
    if (u.pathname.startsWith("/trends/explore")) {
      if (u.searchParams.get("q") === "captcha") { res.writeHead(302, { location: "https://www.google.com/sorry/index?continue=x" }); return res.end(); }
      return send(200, "text/html", trendsPage);
    }
    if (u.pathname === "/trends/probe") { probes[u.searchParams.get("q")] = { patched: u.searchParams.get("patched") === "true", href: u.searchParams.get("href") }; return send(204, "text/plain", ""); }
    if (u.pathname.includes("/widgetdata/multiline")) {
      const req = JSON.parse(u.searchParams.get("req") || "{}");
      const kw = req.comparisonItem && req.comparisonItem[0].complexKeywordsRestriction.keyword[0].value;
      const reply = () => (throttle ? send(429, "text/plain", "Too Many Requests") : send(200, "application/json", XSSI + JSON.stringify(timeline(req.time))));
      if (kw === "stall") { stalled.push(reply); return; }
      return reply();
    }
    if (u.pathname.includes("/widgetdata/relatedsearches")) return send(200, "application/json", XSSI + JSON.stringify(RELATED));
    return send(404, "text/plain", "");
  }
  if (host === "www.google.com") return send(200, "text/html", "<title>unusual traffic</title>人机验证");
  if (host === "app.ahrefs.com" || host === "ahrefs.3ue.com") return send(200, "text/html", "<title>Ahrefs (mock)</title>ahrefs");
  if (host === "shop.example") return send(200, "text/html", "<title>Shop " + u.pathname + "</title>shop");
  if (host === "seo.web.cafe" || host === "evil.example") {
    if (u.pathname === "/extension/version.json") return send(200, "application/json", JSON.stringify({ version: MANIFEST.version }));
    return send(200, "text/html", chatPage);
  }
  send(404, "text/plain", "");
}

const HOSTS = ["trends.google.com", "www.google.com", "seo.web.cafe", "evil.example", "app.ahrefs.com", "ahrefs.3ue.com", "shop.example"];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gefei-ext-"));
  const tls = makeCert(tmp);
  if (!tls) { console.log("跳过：没有 openssl，生成不了测试用的证书"); process.exit(0); }
  const server = https.createServer(tls, handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const userDir = path.join(tmp, "profile");
  const context = await playwright.chromium.launchPersistentContext(userDir, {
    channel: "chromium", // 新版无头模式才支持插件
    ignoreHTTPSErrors: true,
    args: [
      "--disable-extensions-except=" + EXT, "--load-extension=" + EXT,
      "--ignore-certificate-errors", "--no-proxy-server",
      "--host-resolver-rules=" + HOSTS.map((h) => "MAP " + h + " 127.0.0.1:" + port).join(", "),
    ],
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extId = new URL(sw.url()).host;
    check("插件装上了（后台 service worker 起来了）", !!extId, extId);

    const chat = await context.newPage();
    await chat.goto("https://seo.web.cafe/chat/");
    await chat.waitForFunction(() => window.__hello, null, { timeout: 5000 });
    const hello = await chat.evaluate(() => window.__hello);
    check("对话页认出插件（hello 带版本号）", hello && /^\d+\.\d+\.\d+$/.test(hello.version), JSON.stringify(hello));
    const syncSeen = await chat.evaluate(() => window.__syncSeen);
    check("页面脚本一跑就认得出插件（/chat/?q= 自动发问那一刻就要带上「可以请插件取数」）", syncSeen === hello.version, String(syncSeen));

    // ② 成功取数
    const ID1 = "a".repeat(32);
    await chat.evaluate((id) => window.__fetch(id, "jev"), ID1);
    await chat.waitForFunction((id) => window.__results[id], ID1, { timeout: 20000 });
    const r1 = await chat.evaluate((id) => window.__results[id], ID1);
    check("数据送回对话页", r1.ok === true, r1.error || "");
    check("曲线完整（53 周）、带上词", r1.data && r1.data.points.length === 53 && r1.data.keyword === "jev" && r1.data.points[50].v === 45);
    check("没过完的这一周留着、标了出来（线上 jev 的 100 就在它上面）", r1.data && r1.data.points[52].v === 100 && r1.data.points[52].p === 1 && !r1.data.points[51].p);
    const pj = probes.jev || {};
    check("插件开的标签页：被「叫醒」（页面看到自己是可见的），网址里的记号已经抹掉", pj.patched === true && !/#/.test(pj.href || "x"), JSON.stringify(pj));
    check("相关查询也带回来了", r1.data && r1.data.rising[0] && r1.data.rising[0].q === "jev api" && r1.data.rising[0].v === "Breakout");
    await new Promise((r) => setTimeout(r, 800));
    const trendsTabs = context.pages().filter((p) => p.url().startsWith("https://trends.google.com/"));
    check("取完自动关掉谷歌趋势标签页", trendsTabs.length === 0, trendsTabs.map((p) => p.url()).join(","));

    // ④ 谷歌限流
    throttle = true;
    const ID2 = "b".repeat(32);
    await chat.evaluate((id) => window.__fetch(id, "limited"), ID2);
    await chat.waitForFunction((id) => window.__results[id], ID2, { timeout: 20000 });
    const r2 = await chat.evaluate((id) => window.__results[id], ID2);
    check("被限流：把原因送回去", r2.ok === false && /429/.test(r2.error), r2.error);
    await new Promise((r) => setTimeout(r, 500));
    const kept = context.pages().filter((p) => p.url().startsWith("https://trends.google.com/"));
    check("取不到时标签页留着，让用户看见", kept.length === 1);
    for (const p of kept) await p.close();
    throttle = false;

    // ④b 谷歌把标签页跳去人机验证页（www.google.com/sorry）：马上报回去，不干等 45 秒
    const ID3 = "d".repeat(32);
    const t0 = Date.now();
    await chat.evaluate((id) => window.__fetch(id, "captcha"), ID3);
    await chat.waitForFunction((id) => window.__results[id], ID3, { timeout: 20000 });
    const r3 = await chat.evaluate((id) => window.__results[id], ID3);
    check("被跳去人机验证页：马上说清楚原因", r3.ok === false && /人机验证/.test(r3.error) && Date.now() - t0 < 10000, (Date.now() - t0) + "ms " + r3.error);
    await new Promise((r) => setTimeout(r, 500));
    const sorry = context.pages().filter((p) => p.url().startsWith("https://www.google.com/sorry"));
    check("验证页留在前台，让用户去点", sorry.length === 1);
    for (const p of sorry) await p.close();

    // ④c 后台叫不醒（谷歌趋势网页只在看得见时加载）：8 秒后切到前台让它加载，取到后切回对话页、关掉标签页
    await chat.bringToFront();
    const activeIds = () => sw.evaluate(() => chrome.tabs.query({ active: true }).then((ts) => ts.map((t) => ({ id: t.id, url: t.url || "" }))));
    const before = await activeIds();
    const ID4 = "e".repeat(32);
    const t4 = Date.now();
    await chat.evaluate((id) => window.__fetch(id, "stall"), ID4);
    let released = false;
    while (!released && Date.now() - t4 < 20000) {
      await new Promise((r) => setTimeout(r, 300));
      if ((await activeIds()).some((t) => t.url.startsWith("https://trends.google.com/"))) { released = true; while (stalled.length) stalled.shift()(); }
    }
    check("后台 8 秒没数据：把谷歌趋势标签页切到前台", released && Date.now() - t4 >= 7500, (Date.now() - t4) + "ms");
    await chat.waitForFunction((id) => window.__results[id], ID4, { timeout: 15000 });
    const r4 = await chat.evaluate((id) => window.__results[id], ID4);
    await new Promise((r) => setTimeout(r, 800));
    const after = await activeIds();
    check("切到前台之后取到了数据", r4.ok === true && r4.data.points.length === 53 && r4.debug.foregroundMs >= 7500, JSON.stringify(r4.debug));
    check("取完切回对话页、谷歌趋势标签页关掉", before.some((b) => after.some((a) => a.id === b.id)) && !after.some((a) => a.url.startsWith("https://trends.google.com/"))
      && context.pages().filter((p) => p.url().startsWith("https://trends.google.com/")).length === 0, JSON.stringify({ before, after }));

    // ④d 用户自己打开的谷歌趋势标签页：插件一个字节都不改
    const own = await context.newPage();
    await own.goto("https://trends.google.com/trends/explore?q=owntab");
    await own.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 500));
    check("用户自己开的谷歌趋势：不被「叫醒」", probes.owntab && probes.owntab.patched === false, JSON.stringify(probes.owntab));
    await own.close();

    // ⑤ 别的网站冒充对话页：内容脚本根本不进那个站，请求石沉大海
    const evil = await context.newPage();
    await evil.goto("https://evil.example/");
    await evil.evaluate(() => window.__fetch("c".repeat(32), "jev"));
    await new Promise((r) => setTimeout(r, 1500));
    const evilGot = await evil.evaluate(() => ({ hello: window.__hello, n: Object.keys(window.__results).length }));
    const opened = context.pages().filter((p) => p.url().startsWith("https://trends.google.com/"));
    check("别的网站既认不出插件，也指使不动它开谷歌趋势", !evilGot.hello && evilGot.n === 0 && opened.length === 0);

    // ⑥ 侧边栏页面
    const panel = await context.newPage();
    const errors = [];
    panel.on("pageerror", (e) => errors.push(String(e)));
    await panel.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
    await panel.waitForSelector("#askWord");
    check("侧边栏能打开、没有脚本错误", errors.length === 0, errors.join(" | "));
    const ver = await panel.textContent("#ver");
    check("侧边栏显示版本号", /版本 \d+\.\d+\.\d+/.test(ver), ver);
    await panel.fill("#pageUrl", "https://www.imagedetector.com/pricing");
    const [chatTab] = await Promise.all([context.waitForEvent("page"), panel.click('[data-ask="traffic"]')]);
    await chatTab.waitForLoadState();
    const q = new URL(chatTab.url()).searchParams.get("q");
    check("「这个站流量怎么起来的」→ 打开对话页并带上问题（去掉 www）", q === "imagedetector.com 这个站流量怎么起来的？", q);
    await chatTab.close();

    // ⑥b 在 Ahrefs 里打开这个站：默认官方，设置里可以换成镜像站（贴带路径的地址也行，只取域名）
    const openAhrefs = async () => {
      const [t] = await Promise.all([context.waitForEvent("page"), panel.click("#openAhrefs")]);
      await t.waitForLoadState();
      const u = t.url();
      await t.close();
      return u;
    };
    const ahr1 = await openAhrefs();
    check("Ahrefs：默认打开官方 Site Explorer（去掉 www、看全部子域）", ahr1 === "https://app.ahrefs.com/site-explorer/overview?target=imagedetector.com&mode=subdomains", ahr1);
    await panel.click("#settings summary");
    await panel.fill("#ahrefsBase", "not a url");
    await panel.click("#saveAhrefs");
    check("Ahrefs 地址写错：当场提示", /不像网址/.test(await panel.textContent("#ahrefsSaved")));
    await panel.fill("#ahrefsBase", "https://ahrefs.3ue.com/dashboard");
    await panel.click("#saveAhrefs");
    const ahr2 = await openAhrefs();
    check("Ahrefs 镜像站：填 …/dashboard 也只取域名，按同样的路径打开", ahr2 === "https://ahrefs.3ue.com/site-explorer/overview?target=imagedetector.com&mode=subdomains", ahr2);
    await panel.reload();
    await panel.waitForSelector("#openAhrefs");
    await new Promise((r) => setTimeout(r, 300));
    check("镜像站地址存下来了（重开侧边栏还在）", (await panel.inputValue("#ahrefsBase")) === "https://ahrefs.3ue.com");
    check("没授权「读取标签页网址」时：显示「自动跟随当前网页」按钮", await panel.isVisible("#followOn"));

    // ⑦ 侧边栏直接查谷歌趋势（单独调试用，不经过 Agent）：同一条取数路，结果显示在侧边栏
    const trendsTabs2 = () => context.pages().filter((p) => p.url().startsWith("https://trends.google.com/"));
    const ask = async (kw) => {
      await panel.fill("#word", kw);
      await panel.click("#trendsGo");
      await panel.waitForFunction(() => /\b(ok|err)\b/.test(document.getElementById("trendsStatus").className), null, { timeout: 30000 });
      return {
        cls: await panel.getAttribute("#trendsStatus", "class"),
        status: await panel.textContent("#trendsStatus"),
        cards: await panel.$$eval(".result", (els) => els.map((e) => ({
          title: e.querySelector("h3").textContent,
          full: (e.querySelector("polyline.full") || { getAttribute: () => "" }).getAttribute("points"),
          partial: !!e.querySelector("polyline.partial"),
          stats: (e.querySelector("dl") || { textContent: "" }).textContent,
          rising: (e.querySelector(".rel ol") || { textContent: "" }).textContent,
          link: (e.querySelector("dl a") || { href: "" }).href,
          raw: JSON.parse((e.querySelector("pre") || { textContent: "{}" }).textContent),
        }))),
      };
    };
    const a1 = await ask("jev");
    check("侧边栏查询：取到并显示", /\bok\b/.test(a1.cls), a1.status);
    const c1 = a1.cards[0] || {};
    check("曲线：52 个过完的点实线，没过完的那一周画虚线", (c1.full || "").trim().split(/\s+/).length === 52 && c1.partial);
    check("上升最快的相关查询显示出来", (c1.rising || "").includes("jev api") && c1.rising.includes("Breakout"), c1.rising);
    check("统计：最高点标明没过完、认出最新一波、耗时分段、网页链接", /100（[^）]*还没过完/.test(c1.stats) && /最新一波.*之前最高只有 1/.test(c1.stats)
      && /耗时.*页面加载完.*曲线到/.test(c1.stats) && c1.link.startsWith("https://trends.google.com/trends/explore"), (c1.stats || "").replace(/\s+/g, " ").slice(0, 200));
    check("原始 JSON 可看：数据 + 调试信息", c1.raw.ok === true && c1.raw.data.points.length === 53 && /^https:\/\/trends\.google\.com\//.test(c1.raw.debug.url) && c1.raw.debug.related === true);
    const c2 = a1.cards[1] || {};
    check("新的一波三周前起来：自动再查过去 30 天（按天）", a1.cards.length === 2 && /过去 30 天/.test(c2.title) && /自动补查/.test(c2.title)
      && c2.raw.data && c2.raw.data.points.length === 32 && /date=today%201-m/.test(c2.raw.debug.url), a1.cards.map((c) => c.title).join(" | "));
    check("按天那张：最新一波落在 8 天前起来的那天（线上 jev 形状）", /最新一波/.test(c2.stats || ""), (c2.stats || "").replace(/\s+/g, " ").slice(0, 120));
    check("状态行写明含自动补查", /含自动补查/.test(a1.status), a1.status);
    await new Promise((r) => setTimeout(r, 500));
    check("默认取完关掉谷歌趋势标签页（两次都关）", trendsTabs2().length === 0);

    await panel.uncheck("#autoFiner");
    await panel.check("#keepTab");
    const a2 = await ask("jev");
    await new Promise((r) => setTimeout(r, 500));
    check("关掉自动补查只查一次；勾了「取完不关」标签页留着对照", /\bok\b/.test(a2.cls) && a2.cards.length === 1 && trendsTabs2().length === 1);
    for (const p of trendsTabs2()) await p.close();
    await panel.uncheck("#keepTab");

    throttle = true;
    const a3 = await ask("limited");
    throttle = false;
    check("侧边栏查询被限流：显示原因", /\berr\b/.test(a3.cls) && /429/.test(a3.status), a3.status);
    for (const p of trendsTabs2()) await p.close();

    await panel.fill("#geo", "1x");
    await panel.fill("#word", "jev");
    await panel.click("#trendsGo");
    check("地区写错：当场提示，不去开谷歌趋势", /两位国家码/.test(await panel.textContent("#trendsStatus")) && trendsTabs2().length === 0);
    await panel.fill("#geo", "");
    await context.close();

    // ⑧ 自动跟随当前网页：要用户授权可选权限 tabs——无头浏览器点不了授权弹窗，
    //    所以拷一份插件、把 tabs 挪进必需权限（等于「已授权」），侧边栏代码一行不改
    const extCopy = path.join(tmp, "ext-tabs");
    fs.cpSync(EXT, extCopy, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
    const mf = JSON.parse(fs.readFileSync(path.join(extCopy, "manifest.json"), "utf8"));
    mf.permissions.push("tabs");
    delete mf.optional_permissions;
    fs.writeFileSync(path.join(extCopy, "manifest.json"), JSON.stringify(mf));
    const ctx2 = await playwright.chromium.launchPersistentContext(path.join(tmp, "profile2"), {
      channel: "chromium", ignoreHTTPSErrors: true,
      args: ["--disable-extensions-except=" + extCopy, "--load-extension=" + extCopy, "--ignore-certificate-errors", "--no-proxy-server",
        "--host-resolver-rules=" + HOSTS.map((h) => "MAP " + h + " 127.0.0.1:" + port).join(", ")],
    });
    try {
      const sw2 = ctx2.serviceWorkers()[0] || await ctx2.waitForEvent("serviceworker", { timeout: 10000 });
      const panel2 = await ctx2.newPage();
      await panel2.goto("chrome-extension://" + new URL(sw2.url()).host + "/sidepanel/sidepanel.html");
      await panel2.waitForSelector("#followNote");
      await new Promise((r) => setTimeout(r, 300));
      check("授权了：按钮收起、写明已开启", !(await panel2.isVisible("#followOn")) && /已开启/.test(await panel2.textContent("#followNote")));
      const site = await ctx2.newPage();
      await site.goto("https://shop.example/a");
      await site.bringToFront();
      await panel2.waitForFunction(() => document.getElementById("pageUrl").value === "https://shop.example/a", null, { timeout: 5000 }).catch(() => {});
      check("切到别的网页：侧边栏自动换成它的网址，不用点插件图标", (await panel2.inputValue("#pageUrl")) === "https://shop.example/a", await panel2.inputValue("#pageUrl"));
      await site.goto("https://shop.example/b");
      await panel2.waitForFunction(() => document.getElementById("pageUrl").value === "https://shop.example/b", null, { timeout: 5000 }).catch(() => {});
      check("同一个标签页里跳到别的页面：也跟上", (await panel2.inputValue("#pageUrl")) === "https://shop.example/b");
      await site.goto("https://seo.web.cafe/chat/");
      await new Promise((r) => setTimeout(r, 800));
      const ahr = await ctx2.newPage();
      await ahr.goto("https://app.ahrefs.com/site-explorer/overview?target=x.com");
      await ahr.bringToFront();
      await new Promise((r) => setTimeout(r, 800));
      check("切到对话页、Ahrefs：不跟（不把要问的网站换成它们）", (await panel2.inputValue("#pageUrl")) === "https://shop.example/b", await panel2.inputValue("#pageUrl"));
      await ahr.close();
      await panel2.fill("#pageUrl", "mysite.com");
      await site.goto("https://shop.example/c");
      await site.bringToFront();
      await panel2.waitForFunction(() => /换成它/.test(document.getElementById("pageHint").textContent), null, { timeout: 5000 }).catch(() => {});
      check("手动填过网址：不覆盖，提示里给「换成它」", (await panel2.inputValue("#pageUrl")) === "mysite.com" && /shop\.example\/c|Shop \/c/.test(await panel2.textContent("#pageHint")));
      await panel2.click("#pageHint button");
      check("点「换成它」：换成当前网页", (await panel2.inputValue("#pageUrl")) === "https://shop.example/c");
    } finally {
      await ctx2.close();
    }
  } catch (e) {
    failed++;
    console.log("  ✕ 跑挂了：" + (e && e.stack || e));
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
  process.exit(failed ? 1 : 0);
})();
