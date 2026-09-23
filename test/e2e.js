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
//       ⑨ 插件重新加载后不用刷新对话页：新脚本补进页面、旧脚本不抢着回失败、照常取到；
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
// 对比几个词：第一个词照上面，第二个词一直 40、第三个一直 10（同一把尺子）
const timeline = (date, n = 1) => ({ default: { timelineData: (/1-m|3-m|7-d/.test(date || "") ? DAILY : WEEKLY)
  .map((r) => n > 1 ? Object.assign({}, r, { value: [r.value[0]].concat([40, 10, 5, 2].slice(0, n - 1)) }) : r) } });
const RELATED = { default: { rankedList: [{ rankedKeyword: [{ query: "jev ai", value: 100, formattedValue: "100" }] }, { rankedKeyword: [{ query: "jev api", value: 4550, formattedValue: "Breakout" }] }] } };

// 假的谷歌趋势探索页：和真页面一样，自己去请求两个接口（一个 fetch、一个 XHR，两种都要截得到）
// 顺手报告：页面脚本跑起来时看到的网址、「是否可见」有没有被插件改过（只有插件开的标签页才该被改）
const trendsPage = `<!doctype html><title>Google Trends (mock)</title><script>
  var sp = new URLSearchParams(location.search);
  var q = sp.get('q') || '';
  var patched = !/native code/.test(Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.toString());
  fetch('/trends/probe?q=' + encodeURIComponent(q) + '&patched=' + patched + '&href=' + encodeURIComponent(location.href));
  // 和真页面一样：对比几个词时曲线接口一个（每个词一个 comparisonItem），相关查询每个词各一个
  var words = q.split(',');
  var multi = { time: sp.get('date') || '', resolution: 'WEEK', comparisonItem: words.map(function (w) { return { geo: {}, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: w }] } }; }) };
  fetch('/trends/api/widgetdata/multiline?hl=en-US&req=' + encodeURIComponent(JSON.stringify(multi)) + '&token=t');
  setTimeout(function () {
    words.forEach(function (w) {
      var rel = { restriction: { geo: {}, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: w }] } }, keywordType: 'QUERY', metric: ['TOP', 'RISING'] };
      var x = new XMLHttpRequest();
      x.open('GET', '/trends/api/widgetdata/relatedsearches?hl=en-US&req=' + encodeURIComponent(JSON.stringify(rel)) + '&token=t');
      x.send();
    });
  }, 300);
</script>`;

// 假的对话页：只实现和插件说话的那几句（与 seo.web.cafe 的 chat-page.js 同一套协议）
// __syncSeen：页面脚本一开始执行就能不能认出插件（最早的时刻）——真对话页 /chat/?q=… 的自动发问不管排在什么时候都不用赌时序
const chatPage = `<!doctype html><title>chat (mock)</title><script>
  window.__syncSeen = document.documentElement.getAttribute('data-gefei-seo-ext');
  window.__hello = null; window.__helloCount = 0; window.__results = {}; window.__accepted = {}; window.__progress = {}; window.__stale = {};
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'gefei-seo-ext') return;
    var d = e.data;
    if (d.type === 'hello') { window.__hello = d; window.__helloCount++; }
    if (d.type === 'trends:stale') window.__stale[d.requestId] = true;
    if (d.type === 'trends:result') window.__results[d.requestId] = Object.assign({ acceptedFirst: !!window.__accepted[d.requestId] }, d);
    if (d.type === 'trends:accepted') window.__accepted[d.requestId] = Date.now();
    if (d.type === 'trends:progress') (window.__progress[d.requestId] = window.__progress[d.requestId] || []).push(d.stage);
  });
  window.__cancel = function (id) { window.postMessage({ source: 'gefei-seo-page', type: 'trends:cancel', requestId: id }, location.origin); };
  window.postMessage({ source: 'gefei-seo-page', type: 'ping' }, location.origin);
  window.__page = function (id, url) {
    window.postMessage({ source: 'gefei-seo-page', type: 'trends:fetch', kind: 'page', requestId: id, url: url }, location.origin);
  };
  window.__ahrefs = function (id, target) {
    window.postMessage({ source: 'gefei-seo-page', type: 'trends:fetch', kind: 'ahrefs', requestId: id, target: target }, location.origin);
  };
  window.__fetch = function (id, kw) {
    window.postMessage({ source: 'gefei-seo-page', type: 'trends:fetch', requestId: id, keyword: kw, geo: '', date: 'today 12-m' }, location.origin);
  };
</script>`;

// 假的 Ahrefs（官方和镜像站同一套）：Site Explorer 页面自己去请求两个 JSON 接口（一个 fetch、一个 XHR），再把指标写进页面；
// 接口名、字段名是编的——插件不认具体接口，只按「长相」认曲线和指标（lib/ahrefs-parse.js）
const AH_MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 10));
const AH_METRICS = { metrics: { domain_rating: 76, backlinks: 1234567, refdomains: 23456, org_traffic: 2100000, org_keywords: 80000 } };
const AH_HISTORY = { refdomains: AH_MONTHS.map((d, i) => ({ date: d, refdomains: 1000 + i * 2000 })),
  organic: AH_MONTHS.map((d, i) => ({ date: d, org_traffic: 10000 * (i + 1) * (i + 1), org_keywords: 500 * (i + 1) })),
  top_pages: [{ url: "/a", traffic: 5 }, { url: "/b", traffic: 3 }] };
const ahrefsPage = `<!doctype html><title>Site Explorer (mock)</title><main id="m">Loading…</main><script>
  var t = new URLSearchParams(location.search).get('target') || '';
  fetch('/v4/seMetrics?target=' + t).then(function (r) { return r.json(); }).then(function (j) {
    document.getElementById('m').innerText = 'Domain Rating\\n' + j.metrics.domain_rating + '\\nBacklinks\\n1.2M\\nRef. domains\\n23.4K\\nOrganic traffic\\n2.1M';
  });
  setTimeout(function () { var x = new XMLHttpRequest(); x.open('GET', '/v4/seHistory?target=' + t); x.send(); }, 300);
</script>`;

// 假的「服务器抓不到」的网页：内容是页面脚本跑起来之后才画出来的（服务器那边不执行 JS，只拿到一个空壳）
const jsApp = `<!doctype html><html lang="en"><head><title>JS App</title><meta name="description" content="rendered by js"></head><body><div id="root"></div><script>
  setTimeout(function () {
    document.getElementById('root').innerHTML = '<main><h1>Hello from JS</h1><h2>Section ' + (location.hash || 'none') + '</h2><p>' + 'rendered text '.repeat(40) + '</p>' +
      '<table><tr><th>词根</th><th>热度</th></tr><tr><td>generator</td><td>100</td></tr></table><a href="https://x.example/doc">外部文档</a></main>';
  }, 600);
</script></body></html>`;
const loginPage = "<!doctype html><title>Sign in</title><main><h1>Sign in</h1><form><input type=email><input type=password></form></main>";
const canvasPage = "<!doctype html><title>Sheet</title><body style=margin:0><div>表格 1</div><canvas width=1200 height=900 style='width:100vw;height:100vh'></canvas></body>";

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
      const reply = () => (throttle ? send(429, "text/plain", "Too Many Requests") : send(200, "application/json", XSSI + JSON.stringify(timeline(req.time, req.comparisonItem.length))));
      if (kw === "stall") { stalled.push(reply); return; }
      return reply();
    }
    if (u.pathname.includes("/widgetdata/relatedsearches")) return send(200, "application/json", XSSI + JSON.stringify(RELATED));
    return send(404, "text/plain", "");
  }
  if (host === "www.google.com") return send(200, "text/html", "<title>unusual traffic</title>人机验证");
  if (host === "app.ahrefs.com" || host === "ahrefs.3ue.com") {
    if (u.pathname === "/v4/seMetrics") return send(200, "application/json", JSON.stringify(AH_METRICS));
    if (u.pathname === "/v4/seHistory") return send(200, "application/json", JSON.stringify(AH_HISTORY));
    if (u.pathname === "/user/login") return send(200, "text/html", "<title>Sign in</title><main><form><input type=email><input type=password></form></main>");
    if (u.pathname.startsWith("/site-explorer/overview")) {
      if (u.searchParams.get("target") === "needlogin.com") { res.writeHead(302, { location: "/user/login" }); return res.end(); }
      return send(200, "text/html", ahrefsPage);
    }
    return send(200, "text/html", "<title>Ahrefs (mock)</title>ahrefs");
  }
  if (host === "shop.example") return send(200, "text/html", "<title>Shop " + u.pathname + "</title>shop");
  if (host === "js.example") {
    if (u.pathname === "/app") return send(200, "text/html", jsApp);
    if (u.pathname === "/login") return send(200, "text/html", loginPage);
    if (u.pathname === "/sheet") return send(200, "text/html", canvasPage);
    if (u.pathname === "/away") { res.writeHead(302, { location: "https://other.example/landing" }); return res.end(); }
    return send(404, "text/plain", "");
  }
  if (host === "other.example") return send(200, "text/html", "<title>Other</title><main>other site</main>");
  if (host === "seo.web.cafe" || host === "evil.example") {
    if (u.pathname === "/extension/version.json") return send(200, "application/json", JSON.stringify({ version: MANIFEST.version }));
    return send(200, "text/html", chatPage);
  }
  send(404, "text/plain", "");
}

const HOSTS = ["trends.google.com", "www.google.com", "seo.web.cafe", "evil.example", "app.ahrefs.com", "ahrefs.3ue.com", "shop.example", "js.example", "other.example"];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gefei-ext-"));
  const tls = makeCert(tmp);
  if (!tls) { console.log("跳过：没有 openssl，生成不了测试用的证书"); process.exit(0); }
  const server = https.createServer(tls, handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const userDir = path.join(tmp, "profile");
  // 开着「开发者模式」（本地加载插件的用户都开着）：关着的话，Chrome 会把重新加载过的未打包插件直接停用，⑨ 就测不了
  fs.mkdirSync(path.join(userDir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
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
    check("先回「收到」、再交结果（服务器靠「收到」判断插件在不在）", r1.acceptedFirst === true);
    const prog1 = await chat.evaluate((id) => window.__progress[id] || [], ID1);
    check("每一步都报进度给对话页（页面加载完 / 曲线到了）", prog1.includes("loaded") && prog1.includes("timeline"), prog1.join(","));
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

    // ④e 用户点了停止：对话页发 trends:cancel → 插件结束任务、关掉标签页；图标上的数字跟着变
    const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
    const ID5 = "f".repeat(32);
    await chat.evaluate((id) => window.__fetch(id, "stall"), ID5);
    await chat.evaluate((id) => window.__fetch(id, "stall"), ID5); // 同一张单来两次（刷新后重新转交）：只开一个标签页
    await chat.waitForFunction((id) => window.__accepted[id], ID5, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 600));
    const openNow = context.pages().filter((p) => p.url().startsWith("https://trends.google.com/")).length;
    check("同一张单来两次：只开一个谷歌趋势标签页", openNow === 1, String(openNow));
    check("正在跑：工具栏图标上显示 1", (await badge()) === "1", await badge());
    await chat.evaluate((id) => window.__cancel(id), ID5);
    await chat.waitForFunction((id) => window.__results[id], ID5, { timeout: 5000 });
    const r5 = await chat.evaluate((id) => window.__results[id], ID5);
    await new Promise((r) => setTimeout(r, 600));
    check("点了停止：任务结束、说明原因、标签页关掉、图标数字清掉", r5.ok === false && /取消/.test(r5.error)
      && context.pages().filter((p) => p.url().startsWith("https://trends.google.com/")).length === 0 && (await badge()) === "", r5.error);
    while (stalled.length) stalled.shift()();

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
    const acts = await panel.$$eval("#actList li", (els) => els.map((e) => e.className + "|" + e.textContent));
    check("「插件正在做的事」：列出刚才对话页让它取的词，成功打勾、取消 / 失败写明原因", acts.some((a) => /^ok\|jev/.test(a) && /来自对话页/.test(a))
      && acts.some((a) => /^bad\|stall/.test(a) && /取消/.test(a)) && acts.some((a) => /^bad\|limited/.test(a) && /429/.test(a)), acts.slice(0, 4).join(" / "));
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
    check("没允许读 Ahrefs：设置里给「允许读 ahrefs.3ue.com 的数据」按钮", await panel.isVisible("#ahrefsAllow") && /允许读 ahrefs\.3ue\.com 的数据/.test(await panel.textContent("#ahrefsAllow")) && /还没允许读/.test(await panel.textContent("#ahrefsPerm")));
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

    // ⑩ 对比几个词：谷歌趋势的 0~100 是每次查询各自归一化的，分开查的两条曲线不能比高低——要比就放进同一次查询
    await panel.check("#autoFiner");
    const a4 = await ask("jev, GPTs，jev");
    const c4 = a4.cards[0] || {};
    const lines4 = await panel.$$eval(".result polyline.full", (els) => els.map((e) => e.getAttribute("class")));
    const legend4 = await panel.$$eval(".result .legend span", (els) => els.map((e) => e.textContent));
    check("侧边栏对比：一次查询、一张卡（不自动补查），两个词各一条线、有图例", /\bok\b/.test(a4.cls) && a4.cards.length === 1 && lines4.length === 2 && legend4.join() === "jev,gpts", lines4.join() + " / " + legend4.join());
    check("对比网址：q=jev,gpts（大小写、重复、中文逗号都收拾好）", /[?&]q=jev,gpts$/.test(c4.raw.debug.url), c4.raw.debug.url);
    check("对比数据：每个点带两个词的值，写明是哪两个词", c4.raw.data.keywords.join() === "jev,gpts" && c4.raw.data.points.every((p) => p.vs && p.vs.length === 2) && c4.raw.data.points[0].vs[1] === 40);
    // 倍数按最近 13 周（过完的 52 周的后四分之一）的平均：jev 这 13 周是 0…0、20、45、80，平均 145 / 13 ≈ 11.2；gpts 一直 40 → jev 是它的 0.28 倍
    check("对比统计：谁高谁低按最近一段排；有 GPTs 就以它为基准算倍数", /谁高谁低gpts > jev（最近 13 周）/.test(c4.stats) && /gpts最近 13 周平均 40\.0（基准）/.test(c4.stats)
      && /jev最近 13 周平均 11\.2，是 gpts 的 0\.28 倍 · 整段平均 2\.8/.test(c4.stats), (c4.stats || "").replace(/\s+/g, " ").slice(0, 240));
    check("对比不等相关查询：曲线一到就交", c4.raw.debug.related === false && c4.raw.data.rising.length === 0);
    for (const p of trendsTabs2()) await p.close();

    // ⑨ 插件更新 / 重新加载（用户在 chrome://extensions 点了刷新）：已经打开的对话页不用刷新——
    //    新插件把传话脚本补进页面（hello 再来一次），页面里失效的旧脚本只说「我失效了」、不抢着回失败，新脚本接单、照常取到
    await chat.bringToFront();
    const helloBefore = await chat.evaluate(() => window.__helloCount);
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await chat.waitForFunction((n) => window.__helloCount > n, helloBefore, { timeout: 10000 }).catch(() => {});
    await chat.waitForTimeout(1500);
    const helloAfter = await chat.evaluate(() => window.__helloCount);
    check("插件重新加载后：新插件把传话脚本补进已打开的对话页（又收到 hello），而且只补一份", helloAfter === helloBefore + 1, helloBefore + " → " + helloAfter);
    const ID9 = "9".repeat(32);
    await chat.evaluate((id) => window.__fetch(id, "jev"), ID9);
    await chat.waitForFunction((id) => window.__results[id], ID9, { timeout: 20000 }).catch(() => {});
    const r9 = await chat.evaluate((id) => ({ res: window.__results[id] || null, stale: !!window.__stale[id], accepted: !!window.__accepted[id] }), ID9);
    check("页面里失效的旧脚本只说「我失效了」，不抢着回失败", r9.stale === true && !(r9.res && r9.res.ok === false), JSON.stringify(r9.res && { ok: r9.res.ok, error: r9.res.error }));
    check("补进来的新脚本接单、照常取到数据——不用刷新对话页", r9.accepted && r9.res && r9.res.ok === true && r9.res.data.points.length === 53);
    // 后台闲置被回收、再起来时也会挨个问一遍：页面里的传话脚本活着，就不再补
    const swNew = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    const h0 = await chat.evaluate(() => window.__helloCount);
    await swNew.evaluate(() => ensureBridges());
    await chat.waitForTimeout(1000);
    check("后台再起来：传话脚本活着就不重复补", (await chat.evaluate(() => window.__helloCount)) === h0);

    // 读 Ahrefs：还没允许读设置里的 Ahrefs 地址（可选站点权限）→ 不马上说失败：在对话页旁边打开「允许」页面等你点
    // （前面已经把 Ahrefs 地址存成了镜像站 ahrefs.3ue.com）
    const allowPages = () => context.pages().filter((p) => p.url().startsWith("chrome-extension://" + extId + "/allow/allow.html"));
    const IDN = "7".repeat(32); // 单号别和前面的场景撞上（页面记着每个单号的结果）
    await chat.evaluate((id) => window.__ahrefs(id, "pollo.ai"), IDN);
    for (let i = 0; i < 30 && !allowPages().length; i++) await new Promise((r) => setTimeout(r, 100));
    const allow = allowPages()[0];
    if (allow) await allow.waitForFunction(() => /ahrefs/.test(document.querySelector(".host").textContent), null, { timeout: 5000 }).catch(() => {});
    await chat.waitForFunction((id) => window.__accepted[id], IDN, { timeout: 5000 }).catch(() => {});
    const rn0 = await chat.evaluate((id) => ({ acc: !!window.__accepted[id], res: window.__results[id] || null }), IDN);
    check("读 Ahrefs、还没允许：接单，打开「允许读 ahrefs.3ue.com 的数据」页面等你点，不马上说失败", !!allow && rn0.acc && !rn0.res
      && /允许读 ahrefs\.3ue\.com 的数据/.test(await allow.textContent("#allow")) && /pollo\.ai/.test(await allow.textContent("#forAhrefs .target")) && await allow.isHidden("#forPage"));
    await allow.click("#deny", { noWaitAfter: true }).catch(() => {}); // 点了后台马上关掉这一页：别等点击「收尾」
    await chat.waitForFunction((id) => window.__results[id], IDN, { timeout: 10000 }).catch(() => {});
    const rn = await chat.evaluate((id) => window.__results[id] || null, IDN);
    check("点「不允许」：这次不读，说清楚原因（对话里的 Agent 会停下来）；「允许」页面关掉", rn && rn.ok === false && /没允许插件读 ahrefs\.3ue\.com 的页面（你点了「不允许」）/.test(rn.error) && allowPages().length === 0, rn && rn.error);
    // 关掉「允许」页面也一样
    const IDC2 = "8".repeat(32);
    await chat.evaluate((id) => window.__ahrefs(id, "pollo.ai"), IDC2);
    for (let i = 0; i < 30 && !allowPages().length; i++) await new Promise((r) => setTimeout(r, 100));
    await allowPages()[0].close();
    await chat.waitForFunction((id) => window.__results[id], IDC2, { timeout: 10000 }).catch(() => {});
    const rc2 = await chat.evaluate((id) => window.__results[id] || null, IDC2);
    check("关掉「允许」页面：同样说没允许", rc2 && rc2.ok === false && /「允许」页面被关掉了/.test(rc2.error), rc2 && rc2.error);
    // 等「允许」的时候在对话页点了停止：关掉那个页面，单子作废
    const IDS = "6".repeat(32);
    await chat.evaluate((id) => window.__ahrefs(id, "pollo.ai"), IDS);
    for (let i = 0; i < 30 && !allowPages().length; i++) await new Promise((r) => setTimeout(r, 100));
    await chat.waitForFunction((id) => window.__accepted[id], IDS, { timeout: 5000 }).catch(() => {});
    await chat.evaluate((id) => window.__cancel(id), IDS);
    await chat.waitForFunction((id) => window.__results[id], IDS, { timeout: 10000 }).catch(() => {});
    const rs = await chat.evaluate((id) => window.__results[id] || null, IDS);
    await new Promise((r) => setTimeout(r, 300));
    check("等「允许」时点了停止：关掉「允许」页面、单子作废", rs && rs.ok === false && /点了停止/.test(rs.error) && allowPages().length === 0, rs && rs.error);
    // 点「允许」之后 Chrome 会弹一次权限确认——无头浏览器里点不到那个弹窗，「允许之后接着读」放到下面 ⑪（那边的插件拷贝已有权限）里测

    // 用浏览器打开网页：这个网站还没允许 → 打开「允许」页面（写明是哪个网址、登录后的内容也读得到），点「不允许」就不开
    const IDP = "5".repeat(32);
    await chat.evaluate((id) => window.__page(id, "https://js.example/app"), IDP);
    for (let i = 0; i < 30 && !allowPages().length; i++) await new Promise((r) => setTimeout(r, 100));
    const allowP = allowPages()[0];
    if (allowP) await allowP.waitForFunction(() => /js\.example/.test(document.getElementById("allow").textContent), null, { timeout: 5000 }).catch(() => {});
    const pageAllowText = allowP ? await allowP.evaluate(() => ({ btn: document.getElementById("allow").textContent, page: !document.getElementById("forPage").hidden, body: document.body.innerText })) : null;
    check("打开网页、这个网站还没允许：打开「允许打开并读 js.example」页面，写明网址、提醒登录后的内容也读得到，有「所有网站都允许」可选", pageAllowText && pageAllowText.page
      && /允许打开并读 js\.example/.test(pageAllowText.btn) && /https:\/\/js\.example\/app/.test(pageAllowText.body) && /登录后能看到的内容，它也读得到/.test(pageAllowText.body) && /所有网站都允许/.test(pageAllowText.body), pageAllowText && pageAllowText.btn);
    if (allowP) await allowP.click("#deny", { noWaitAfter: true }).catch(() => {});
    await chat.waitForFunction((id) => window.__results[id], IDP, { timeout: 10000 }).catch(() => {});
    const rp = await chat.evaluate((id) => window.__results[id] || null, IDP);
    check("点「不允许」：这次不打开，说清楚", rp && rp.ok === false && /没允许插件读 js\.example 的页面（你点了「不允许」），这次没读这个网页/.test(rp.error), rp && rp.error);
    const IDL0 = "4".repeat(32);
    await chat.evaluate((id) => window.__page(id, "http://192.168.1.1/admin"), IDL0);
    await chat.waitForFunction((id) => window.__results[id], IDL0, { timeout: 10000 }).catch(() => {});
    const rl0 = await chat.evaluate((id) => window.__results[id] || null, IDL0);
    check("局域网 / 本机的网址：插件不开", rl0 && rl0.ok === false && /本机和局域网的不开/.test(rl0.error) && allowPages().length === 0, rl0 && rl0.error);

    // 对话页请插件对比（Agent 调 google_trends 带 compare）
    const IDC = "c".repeat(32);
    await chat.evaluate((id) => window.__fetch(id, "jev,gpts,sora"), IDC);
    await chat.waitForFunction((id) => window.__results[id], IDC, { timeout: 20000 }).catch(() => {});
    const rc = await chat.evaluate((id) => window.__results[id] || null, IDC);
    check("对话页对比三个词：取到，三个词在同一把尺子上", rc && rc.ok && rc.data.keywords.join() === "jev,gpts,sora" && rc.data.points.every((p) => p.vs.length === 3), rc && rc.error);
    check("对比不等相关查询的宽限（2.5 秒）：曲线一到就交", rc && rc.debug && rc.debug.ms < 2000 && rc.debug.related === false, rc && rc.debug && rc.debug.ms + "ms");
    await context.close();

    // ⑧ 自动跟随当前网页：要用户授权可选权限 tabs——无头浏览器点不了授权弹窗，
    //    所以拷一份插件、把 tabs 挪进必需权限（等于「已授权」），侧边栏代码一行不改
    const extCopy = path.join(tmp, "ext-tabs");
    fs.cpSync(EXT, extCopy, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
    const mf = JSON.parse(fs.readFileSync(path.join(extCopy, "manifest.json"), "utf8"));
    mf.permissions.push("tabs");
    delete mf.optional_permissions;
    mf.host_permissions.push("https://app.ahrefs.com/*", "https://ahrefs.3ue.com/*"); // 等于在侧边栏点过「允许读 Ahrefs 数据」
    mf.host_permissions.push("https://js.example/*"); // 等于在「允许」页面点过允许打开 js.example
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
      const own = await ahr.evaluate(() => ({ mark: window.__gefeiAgentTab, fetchNative: /native code/.test(window.fetch.toString()) }));
      check("你自己打开的 Ahrefs 标签页：插件不截它的数据（没有记号、fetch 原样）", own.mark === undefined && own.fetchNative, JSON.stringify(own));
      await ahr.close();
      await panel2.fill("#pageUrl", "mysite.com");
      await site.goto("https://shop.example/c");
      await site.bringToFront();
      await panel2.waitForFunction(() => /换成它/.test(document.getElementById("pageHint").textContent), null, { timeout: 5000 }).catch(() => {});
      check("手动填过网址：不覆盖，提示里给「换成它」", (await panel2.inputValue("#pageUrl")) === "mysite.com" && /shop\.example\/c|Shop \/c/.test(await panel2.textContent("#pageHint")));
      await panel2.click("#pageHint button");
      check("点「换成它」：换成当前网页", (await panel2.inputValue("#pageUrl")) === "https://shop.example/c");

      // ⑪ 读 Ahrefs（允许过读这个地址）：用你登录的账号开 Site Explorer，截下页面自己加载的 JSON，认出曲线和指标，连同页面文字交回
      await panel2.click("#settings summary");
      check("侧边栏：允许过读 Ahrefs → 按钮收起、写明只交给你自己的对话", !(await panel2.isVisible("#ahrefsAllow")) && /已允许读 app\.ahrefs\.com/.test(await panel2.textContent("#ahrefsPerm")) && /不进网站的共享缓存/.test(await panel2.textContent("#ahrefsPerm")));
      const ahTabs = () => ctx2.pages().filter((p) => /ahrefs/.test(p.url()) && p !== ahr);
      const chat2 = await ctx2.newPage();
      await chat2.goto("https://seo.web.cafe/chat/");
      await chat2.waitForFunction(() => window.__hello, null, { timeout: 5000 }).catch(() => {});
      const IDA = "a".repeat(32);
      await chat2.evaluate((id) => window.__ahrefs(id, "https://www.Pollo.ai/pricing"), IDA);
      await chat2.waitForFunction((id) => window.__results[id], IDA, { timeout: 40000 }).catch(() => {});
      const ra = await chat2.evaluate((id) => window.__results[id] || null, IDA);
      const names = ra && ra.ok ? ra.data.series.map((x) => x.name) : [];
      check("对话页请插件读 Ahrefs：先回「收到」，读到曲线（引荐域名、自然流量、关键词）", ra && ra.ok && ra.acceptedFirst && names.includes("refdomains.refdomains") && names.includes("organic.org_traffic") && names.includes("organic.org_keywords"), ra && (ra.error || names.join()));
      check("曲线的点：按月、日期对得上、数值原样", ra && ra.ok && ra.data.series.find((x) => x.name === "refdomains.refdomains").points.length === 12
        && ra.data.series.find((x) => x.name === "refdomains.refdomains").points[11][1] === 23000);
      check("指标（DR、外链、引荐域名、流量）；列表里某个页面的流量不当成站点指标", ra && ra.ok && ra.data.metrics.domain_rating === 76 && ra.data.metrics.refdomains === 23456 && ra.data.metrics.traffic === undefined, ra && JSON.stringify(ra.data.metrics));
      check("页面上的文字也带回来（指标卡片）；网址是这个站的 Site Explorer（去掉 www、看全部子域）", ra && ra.ok && /Domain Rating\n76/.test(ra.data.text)
        && ra.data.url === "https://app.ahrefs.com/site-explorer/overview?target=pollo.ai&mode=subdomains", ra && ra.data && ra.data.url);
      await new Promise((r) => setTimeout(r, 500));
      check("读完关掉 Ahrefs 标签页", ahTabs().length === 0, ahTabs().map((p) => p.url()).join());

      const IDL = "b".repeat(32);
      await chat2.evaluate((id) => window.__ahrefs(id, "needlogin.com"), IDL);
      await chat2.waitForFunction((id) => window.__results[id], IDL, { timeout: 40000 }).catch(() => {});
      const rl = await chat2.evaluate((id) => window.__results[id] || null, IDL);
      const front = await sw2.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => (t[0] && t[0].url) || ""));
      check("没登录 Ahrefs：说要先登录，把登录页切到前台", rl && rl.ok === false && /先登录/.test(rl.error) && /\/user\/login/.test(front), (rl && rl.error) + " | " + front);
      for (const p of ahTabs()) await p.close();

      // 允许之后接着读：用一个空白标签页顶替「允许」页面、记一张在等的单子，再发「权限加上了」——
      // 后台关掉那一页、切回对话页、照常去 Ahrefs 读，结果交回对话页（真浏览器里是用户点了「允许」、Chrome 确认之后走这条）
      const IDW = "c".repeat(32);
      const chatTab = await sw2.evaluate(() => chrome.tabs.query({ url: "https://seo.web.cafe/*" }).then((t) => ({ id: t[0].id, windowId: t[0].windowId })));
      const fakeAllow = await sw2.evaluate(() => chrome.tabs.create({ url: "about:blank", active: true }).then((t) => t.id));
      await sw2.evaluate(([tabId, id, from]) => chrome.storage.session.set({ allows: { [tabId]: { msg: { type: "trends:fetch", kind: "ahrefs", requestId: id, target: "pollo.ai" }, from: { panel: false, tabId: from.id, windowId: from.windowId }, base: "https://app.ahrefs.com", target: "pollo.ai", at: Date.now() } } }), [fakeAllow, IDW, chatTab]);
      await sw2.evaluate(() => onAllowGranted());
      await chat2.waitForFunction((id) => window.__results[id], IDW, { timeout: 40000 }).catch(() => {});
      const rw = await chat2.evaluate((id) => window.__results[id] || null, IDW);
      const fakeGone = await sw2.evaluate((id) => chrome.tabs.get(id).then(() => false, () => true), fakeAllow);
      check("允许之后：关掉「允许」页面、接着去 Ahrefs 读，结果交回对话页", fakeGone && rw && rw.ok && rw.data.series.length === 3, rw && (rw.error || rw.data.series.length));

      // ⑫ 用浏览器打开网页读回来（允许过 js.example）：页面脚本画出来的内容也读得到；# 后面的留着；读完关掉
      const readPage = async (id, url) => {
        await chat2.evaluate(([i, u]) => window.__page(i, u), [id, url]);
        await chat2.waitForFunction((i) => window.__results[i], id, { timeout: 40000 }).catch(() => {});
        return chat2.evaluate((i) => window.__results[i] || null, id);
      };
      const pageTabs = () => ctx2.pages().filter((p) => /js\.example|other\.example/.test(p.url()));
      const p1 = await readPage("1".repeat(32), "https://js.example/app#/pricing");
      check("打开网页：页面脚本画出来的正文、标题层级、表格、链接都读到（服务器那边只能拿到空壳）", p1 && p1.ok && /Hello from JS/.test(p1.data.text) && p1.data.textChars > 400
        && p1.data.headings.includes("h1 Hello from JS") && p1.data.tables[0][1].join() === "generator,100" && p1.data.links.some((l) => l.href === "https://x.example/doc"), p1 && (p1.error || p1.data.text.slice(0, 80)));
      check("网页：标题、描述、语言、渲染后的 HTML；# 后面的原样带上（单页应用靠它分页面）", p1 && p1.ok && p1.data.title === "JS App" && p1.data.description === "rendered by js" && p1.data.lang === "en"
        && /Section #\/pricing/.test(p1.data.text) && /<h1>Hello from JS<\/h1>/.test(p1.data.html) && p1.data.finalUrl === "https://js.example/app#/pricing");
      await new Promise((r) => setTimeout(r, 400));
      check("读完关掉那个标签页", pageTabs().length === 0, pageTabs().map((p) => p.url()).join());
      const p2 = await readPage("2".repeat(32), "https://js.example/login");
      check("要登录的页面：读回来并标明要登录（Agent 会请你先在浏览器里登录）", p2 && p2.ok && p2.data.login === true, p2 && (p2.error || JSON.stringify(p2.data.login)));
      const p3 = await readPage("3".repeat(32), "https://js.example/sheet");
      check("在线表格（内容画在 canvas 上）：标明读不出文字", p3 && p3.ok && p3.data.canvas === true, p3 && (p3.error || JSON.stringify(p3.data.canvas)));
      const p4 = await readPage("0".repeat(32), "https://js.example/away");
      check("跳到了没被允许读的网站：说清楚，不硬读", p4 && p4.ok === false && /跳到了插件没被允许读的网址/.test(p4.error), p4 && p4.error);
      for (const p of pageTabs()) await p.close();

      // 镜像站：在设置里换地址，读数据照样走（侧边栏调试按钮，不经过 Agent）
      await panel2.fill("#ahrefsBase", "https://ahrefs.3ue.com/dashboard");
      await panel2.click("#saveAhrefs");
      await panel2.fill("#pageUrl", "pollo.ai");
      await panel2.click("#readAhrefs");
      await panel2.waitForFunction(() => /\b(ok|err)\b/.test(document.getElementById("ahrefsStatus").className), null, { timeout: 40000 }).catch(() => {});
      const mirror = { status: await panel2.textContent("#ahrefsStatus"), raw: JSON.parse((await panel2.textContent("#ahrefsOut pre").catch(() => "{}")) || "{}") };
      check("镜像站：在它那里打开、照样读到曲线和指标（侧边栏调试显示）", /读到了：3 条曲线/.test(mirror.status) && mirror.raw.data && /^https:\/\/ahrefs\.3ue\.com\/site-explorer\/overview\?target=pollo\.ai/.test(mirror.raw.data.url), mirror.status + " " + (mirror.raw.data && mirror.raw.data.url));
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
