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
//       ⑤ 不是 seo.web.cafe 发来的请求一律不接；⑥ 侧边栏页面能打开、没有脚本错误；
//       ⑦ 侧边栏直接查谷歌趋势：曲线 / 统计 / 相关查询 / 原始 JSON 显示出来，可选取完不关标签页，失败说原因。
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

const TIMELINE = { default: { timelineData: Array.from({ length: 52 }, (_, i) => ({ time: String(1759017600 + i * 604800), value: [i < 40 ? 0 : (i - 39) * 8], hasData: [true] })) } };
const RELATED = { default: { rankedList: [{ rankedKeyword: [{ query: "jev ai", value: 100, formattedValue: "100" }] }, { rankedKeyword: [{ query: "jev api", value: 4550, formattedValue: "Breakout" }] }] } };

// 假的谷歌趋势探索页：和真页面一样，自己去请求两个接口（一个 fetch、一个 XHR，两种都要截得到）
const trendsPage = `<!doctype html><title>Google Trends (mock)</title><script>
  var q = new URLSearchParams(location.search).get('q') || '';
  var kw = { type: 'BROAD', value: q };
  var multi = { time: 'x', resolution: 'WEEK', comparisonItem: [{ geo: {}, complexKeywordsRestriction: { keyword: [kw] } }] };
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
function handle(req, res) {
  const host = String(req.headers.host || "").split(":")[0];
  const u = new URL(req.url, "https://" + host);
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (host === "trends.google.com") {
    if (u.pathname.startsWith("/trends/explore")) {
      if (u.searchParams.get("q") === "captcha") { res.writeHead(302, { location: "https://www.google.com/sorry/index?continue=x" }); return res.end(); }
      return send(200, "text/html", trendsPage);
    }
    if (u.pathname.includes("/widgetdata/multiline")) {
      return throttle ? send(429, "text/plain", "Too Many Requests") : send(200, "application/json", XSSI + JSON.stringify(TIMELINE));
    }
    if (u.pathname.includes("/widgetdata/relatedsearches")) return send(200, "application/json", XSSI + JSON.stringify(RELATED));
    return send(404, "text/plain", "");
  }
  if (host === "www.google.com") return send(200, "text/html", "<title>unusual traffic</title>人机验证");
  if (host === "seo.web.cafe" || host === "evil.example") {
    if (u.pathname === "/extension/version.json") return send(200, "application/json", JSON.stringify({ version: MANIFEST.version }));
    return send(200, "text/html", chatPage);
  }
  send(404, "text/plain", "");
}

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
      "--host-resolver-rules=" + ["trends.google.com", "www.google.com", "seo.web.cafe", "evil.example"].map((h) => "MAP " + h + " 127.0.0.1:" + port).join(", "),
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
    check("曲线完整（52 周）、带上词", r1.data && r1.data.points.length === 52 && r1.data.keyword === "jev" && r1.data.points[45].v === 48);
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

    // ⑦ 侧边栏直接查谷歌趋势（单独调试用，不经过 Agent）：同一条取数路，结果显示在侧边栏
    const trendsTabs2 = () => context.pages().filter((p) => p.url().startsWith("https://trends.google.com/"));
    const ask = async (kw) => {
      await panel.fill("#word", kw);
      await panel.click("#trendsGo");
      await panel.waitForFunction(() => /\b(ok|err)\b/.test(document.getElementById("trendsStatus").className), null, { timeout: 20000 });
      return {
        cls: await panel.getAttribute("#trendsStatus", "class"),
        status: await panel.textContent("#trendsStatus"),
        raw: JSON.parse((await panel.textContent("#raw")) || "{}"),
      };
    };
    const a1 = await ask("jev");
    check("侧边栏查询：取到并显示", /\bok\b/.test(a1.cls), a1.status);
    const pts = await panel.getAttribute("#chart polyline", "points");
    check("画出曲线（52 个点）", (pts || "").trim().split(/\s+/).length === 52);
    const risingText = await panel.textContent("#rising");
    check("上升最快的相关查询显示出来", risingText.includes("jev api") && risingText.includes("Breakout"), risingText);
    const stats = await panel.textContent("#stats");
    check("统计：点数、第一次有热度、耗时、网页链接", /52 个/.test(stats) && /第一次有热度/.test(stats) && /耗时/.test(stats)
      && (await panel.getAttribute("#stats a", "href") || "").startsWith("https://trends.google.com/trends/explore"), stats.replace(/\s+/g, " ").slice(0, 120));
    check("原始 JSON 可看：数据 + 调试信息", a1.raw.ok === true && a1.raw.data.points.length === 52 && /^https:\/\/trends\.google\.com\//.test(a1.raw.debug.url) && a1.raw.debug.related === true);
    await new Promise((r) => setTimeout(r, 500));
    check("默认取完关掉谷歌趋势标签页", trendsTabs2().length === 0);

    await panel.check("#keepTab");
    const a2 = await ask("jev");
    await new Promise((r) => setTimeout(r, 500));
    check("勾了「取完不关」：标签页留着对照", /\bok\b/.test(a2.cls) && trendsTabs2().length === 1);
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
  } catch (e) {
    failed++;
    console.log("  ✕ 跑挂了：" + (e && e.stack || e));
  } finally {
    await context.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
  process.exit(failed ? 1 : 0);
})();
