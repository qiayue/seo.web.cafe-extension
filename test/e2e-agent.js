// test/e2e-agent.js — 远程任务整条链路（node test/e2e-agent.js；需要 Playwright）
//
// 和 test/e2e.js 一样：本机起一个 HTTPS 服务，用 --host-resolver-rules 把几个站解析到它，插件一行不改：
//   · new.web.cafe：假的后台「插件任务」页（照 PageComponent 的协议 postMessage 配对令牌）+ 假的 /api/ext-agent/jobs（发任务、收结果）；
//   · pro.similarweb.com / sim.3ue.com：假的 Similarweb（官方 / 共享账号镜像站），单页应用自己去请求一页一页的着陆页数据，
//     底下有「下一页」按钮，翻到第 3 页按钮变灰。
// 钉住：⓪ 只给管理员：不是管理员的令牌配不上、普通用户侧边栏看不到这一块、配对后账号被撤了管理员就清掉令牌；
//       ① 配对令牌经页面交给插件；② capture 截下页面自己请求的数据、点「下一页」一路翻到最后一页、交回、关掉标签页；
//       ③ 设置成镜像站后任务开的是镜像站；fetch 在页面里带登录态请求接口；④ 不认识的网站不开、如实交回原因；
//       ⑤ 进度报给 new.web.cafe；⑥ 你自己开的 Similarweb 标签页一概不抄；⑦ 令牌失效时停下并说清楚。
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
let failed = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "  ✓ " : "  ✕ ") + name + (extra ? "  " + extra : "")); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeCert(dir) {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  } catch { return null; }
}

const TOKEN = "wcx_" + "c".repeat(48);
const queue = [];          // 等插件来领的任务
const reports = [];        // 插件交上来的进度 / 结果
let authFail = false;
let admin = false;         // 配对令牌对应的账号此刻是不是管理员
const pairPage = `<!doctype html><title>插件任务</title><script>
  window.__paired = null;
  window.addEventListener("message", function (e) { if (e.data && e.data.source === "gefei-seo-ext" && e.data.type === "agent:paired") window.__paired = e.data; });
  window.__pair = function (token) { window.postMessage({ source: "gefei-seo-page", type: "agent:pair", token: token, server: location.origin }, location.origin); };
  window.__ext = function () { return document.documentElement.getAttribute("data-gefei-seo-agent"); };
</script>`;
// 假的 Similarweb：单页应用，自己用 fetch（第 1 页）和 XHR（之后几页）请求着陆页数据，「下一页」按钮翻页，第 3 页之后变灰
const swPage = `<!doctype html><title>Similarweb (mock)</title><main><table id=t></table><button class="next" type=button>›</button></main><script>
  var page = 1;
  function show(d) { document.getElementById("t").innerHTML = d.rows.map(function (r) { return "<tr><td>" + r + "</td></tr>"; }).join(""); if (d.page >= 3) document.querySelector("button.next").disabled = true; }
  function load() {
    if (page === 1) fetch("/api/landing?page=1", { credentials: "include" }).then(function (r) { return r.json(); }).then(show);
    else { var x = new XMLHttpRequest(); x.open("GET", "/api/landing?page=" + page); x.onload = function () { show(JSON.parse(x.responseText)); }; x.send(); }
    fetch("/api/other").then(function (r) { return r.json(); });
  }
  document.querySelector("button.next").addEventListener("click", function () { page++; load(); });
  setTimeout(load, 300);
</script>`;
function handle(req, res) {
  const host = String(req.headers.host || "").split(":")[0];
  const u = new URL(req.url, "https://" + host);
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (host === "new.web.cafe") {
    if (u.pathname === "/api/ext-agent/jobs") {
      if (authFail || req.headers.authorization !== "Bearer " + TOKEN) return send(401, "application/json", JSON.stringify({ ok: false, code: "unpaired" }));
      if (!admin) return send(403, "application/json", JSON.stringify({ ok: false, code: "not_admin", error: "不是管理员" }));
      if (u.searchParams.get("whoami") === "1") return send(200, "application/json", JSON.stringify({ ok: true, admin: true, name: "哥飞" }));
      if (req.method === "GET") return send(200, "application/json", JSON.stringify({ ok: true, jobs: queue.length ? [queue.shift()] : [], v: req.headers["x-ext-version"] }));
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => { try { reports.push(JSON.parse(raw)); } catch {} send(200, "application/json", JSON.stringify({ ok: true })); });
      return;
    }
    return send(200, "text/html; charset=utf-8", pairPage);
  }
  if (host === "pro.similarweb.com" || host === "sim.3ue.com") {
    if (u.pathname === "/api/landing") {
      const p = Number(u.searchParams.get("page")) || 1;
      return send(200, "application/json", JSON.stringify({ host, page: p, rows: [1, 2, 3].map((i) => host + "-p" + p + "-" + i), cookie: String(req.headers.cookie || "") }));
    }
    if (u.pathname === "/api/other") return send(200, "application/json", JSON.stringify({ other: true }));
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "sw_session=" + host + "; Path=/; Secure; SameSite=Lax" });
      return res.end(swPage);
    }
    return send(404, "text/plain", "");
  }
  send(404, "text/plain", "");
}
const HOSTS = ["new.web.cafe", "pro.similarweb.com", "sim.3ue.com"];
const id = (c) => c.repeat(32);
async function waitReport(rid, ms = 40000) {
  for (let t = 0; t < ms; t += 200) {
    const r = reports.find((x) => x.requestId === rid && "ok" in x);
    if (r) return r;
    await sleep(200);
  }
  return null;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gefei-agent-"));
  const tls = makeCert(tmp);
  if (!tls) { console.log("跳过：没有 openssl，生成不了测试用的证书"); process.exit(0); }
  const server = https.createServer(tls, handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // 无头浏览器点不了 Chrome 的授权弹窗：拷一份插件，把两个 Similarweb 地址放进必需权限（等于在侧边栏点过「允许读 Similarweb 数据」）
  const extCopy = path.join(tmp, "ext");
  fs.cpSync(EXT, extCopy, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
  const mf = JSON.parse(fs.readFileSync(path.join(extCopy, "manifest.json"), "utf8"));
  mf.host_permissions.push("https://pro.similarweb.com/*", "https://sim.3ue.com/*");
  fs.writeFileSync(path.join(extCopy, "manifest.json"), JSON.stringify(mf));
  const context = await playwright.chromium.launchPersistentContext(path.join(tmp, "profile"), {
    channel: "chromium", ignoreHTTPSErrors: true,
    args: ["--disable-extensions-except=" + extCopy, "--load-extension=" + extCopy, "--ignore-certificate-errors", "--no-proxy-server",
      "--host-resolver-rules=" + HOSTS.map((h) => "MAP " + h + " 127.0.0.1:" + port).join(", ")],
  });
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    const swTabs = () => context.pages().filter((p) => /similarweb|3ue/.test(p.url()));

    // ① 配对
    const adminPage = await context.newPage();
    await adminPage.goto("https://new.web.cafe/manage/ext-agent");
    await adminPage.waitForFunction(() => window.__ext(), null, { timeout: 5000 });
    check("new.web.cafe 页面认得出插件（<html> 上盖了版本章）", /^\d+\.\d+\.\d+$/.test(await adminPage.evaluate(() => window.__ext())));
    await adminPage.evaluate(() => window.__pair("not-a-token"));
    await adminPage.waitForFunction(() => window.__paired, null, { timeout: 5000 });
    check("格式不对的令牌不收", (await adminPage.evaluate(() => window.__paired)).ok === false);
    // ⓪ 普通用户：没配对时侧边栏看不到远程任务这一块、不定闹钟
    const panel0 = await context.newPage();
    await panel0.goto("chrome-extension://" + new URL(sw.url()).host + "/sidepanel/sidepanel.html");
    await sleep(500);
    check("普通用户（没配对）：侧边栏看不到「远程任务」和 Similarweb 设置，也不定闹钟", await panel0.isHidden("#agentBox") && !(await sw.evaluate(() => chrome.alarms.get("gefei-agent-poll"))));
    // ⓪ 令牌格式对、但服务器说不是管理员：不存
    await adminPage.evaluate(() => { window.__paired = null; });
    await adminPage.evaluate((t) => window.__pair(t), TOKEN);
    await adminPage.waitForFunction(() => window.__paired, null, { timeout: 5000 });
    const notAdmin = await adminPage.evaluate(() => window.__paired);
    const stored0 = await sw.evaluate(() => chrome.storage.local.get("agentToken"));
    check("不是管理员的令牌：插件问过服务器后不收、说清楚原因", notAdmin.ok === false && /不是管理员/.test(notAdmin.error) && !stored0.agentToken, notAdmin.error);
    admin = true;
    await adminPage.evaluate(() => { window.__paired = null; });
    await adminPage.evaluate((t) => window.__pair(t), TOKEN);
    await adminPage.waitForFunction(() => window.__paired, null, { timeout: 5000 });
    const paired = await adminPage.evaluate(() => window.__paired);
    const stored = await sw.evaluate(() => chrome.storage.local.get(["agentToken", "agentOn", "agentServer"]));
    await panel0.waitForFunction(() => !document.getElementById("agentBox").hidden, null, { timeout: 3000 }).catch(() => {});
    check("管理员连上之后侧边栏才显示「远程任务」，写明是哪个管理员", !(await panel0.isHidden("#agentBox")) && /管理员 哥飞/.test(await panel0.textContent("#agentState")));
    await panel0.close();
    check("配对：令牌交给插件、存下来、打开接任务", paired.ok === true && stored.agentToken.length === 52 && stored.agentOn === true && stored.agentServer === "https://new.web.cafe", JSON.stringify(paired));
    check("每分钟一次的闹钟定上了", !!(await sw.evaluate(() => chrome.alarms.get("gefei-agent-poll"))));

    // ② capture + 翻页（默认官方地址）
    queue.push({ requestId: id("1"), kind: "capture", site: "similarweb", path: "/#/digitalsuite/landing?key=github.io", match: "/api/landing", quietMs: 1500, minMs: 0,
      pager: { selector: "button.next", times: 8, waitMs: 1200 } });
    await sw.evaluate(() => agentPoll());
    const r1 = await waitReport(id("1"), 60000);
    const items = (r1 && r1.data && r1.data.items) || [];
    const pagesGot = items.map((x) => JSON.parse(x.body).page);
    check("capture：截到页面自己请求的数据（fetch 与 XHR 都截得到），一路翻到最后一页", r1 && r1.ok && pagesGot.join() === "1,2,3", r1 && (r1.error || pagesGot.join()));
    check("官方地址：开的是 pro.similarweb.com", items.length && JSON.parse(items[0].body).host === "pro.similarweb.com");
    check("match 之外的接口只记进清单、不收数据；翻到底说明原因", r1 && r1.data.seen.some((s) => /\/api\/other/.test(s.url)) && !items.some((x) => /other/.test(x.url)) && r1.data.pagerEnd === "已经是最后一页", r1 && r1.data.pagerEnd);
    check("进度报给了 new.web.cafe（页面加载 / 翻页）", reports.some((x) => x.requestId === id("1") && x.stage === "progress" && /翻到第 2 页/.test(x.note)));
    await sleep(800);
    check("做完关掉标签页", swTabs().length === 0, swTabs().map((p) => p.url()).join());

    // ③ 镜像站 + fetch
    await sw.evaluate(() => chrome.storage.local.set({ similarwebBase: "https://sim.3ue.com" }));
    await sleep(300);
    queue.push({ requestId: id("2"), kind: "fetch", site: "similarweb", path: "/", requests: ["/api/landing?page=4", { path: "/api/landing?page=5", headers: { "x-requested-with": "XMLHttpRequest" } }], delayMs: 300 });
    await sw.evaluate(() => agentPoll());
    const r2 = await waitReport(id("2"));
    const res2 = (r2 && r2.data && r2.data.results) || [];
    const b2 = res2.map((x) => JSON.parse(x.body || "{}"));
    check("镜像站：设置成 sim.3ue.com 后任务开的是镜像站", b2.length === 2 && b2.every((b) => b.host === "sim.3ue.com"), r2 && (r2.error || JSON.stringify(b2[0] || {})));
    check("fetch：在页面里带着这个网站的登录态请求（Cookie 跟着走）", b2.length === 2 && b2[0].page === 4 && b2[1].page === 5 && /sw_session=sim\.3ue\.com/.test(b2[0].cookie), b2[0] && b2[0].cookie);

    // ④ 不认识的网站
    queue.push({ requestId: id("3"), kind: "page", site: "gmail", path: "/" });
    await sw.evaluate(() => agentPoll());
    const r3 = await waitReport(id("3"));
    check("不认识的网站：不开，如实交回原因", r3 && r3.ok === false && /插件不开这个网站/.test(r3.error), r3 && r3.error);

    // ⑥ 自己开的 Similarweb 标签页：一概不抄
    const before = reports.length;
    const own = await context.newPage();
    await own.goto("https://sim.3ue.com/");
    await sleep(1500);
    const leaked = await sw.evaluate(() => chrome.storage.session.get("jobs").then((r) => Object.keys(r.jobs || {}).length));
    check("你自己开的 Similarweb 标签页：插件不抄、不交（没有任务）", leaked === 0 && reports.length === before);
    await own.close();

    // 侧边栏能打开、远程任务那一块照着状态显示（管理员连着的时候）
    const panel = await context.newPage();
    const errs = [];
    panel.on("pageerror", (e) => errs.push(String(e)));
    await panel.goto("chrome-extension://" + new URL(sw.url()).host + "/sidepanel/sidepanel.html");
    await panel.waitForFunction(() => document.getElementById("similarwebBase").value === "https://sim.3ue.com", null, { timeout: 3000 }).catch(() => {});
    check("侧边栏「远程任务」里显示 Similarweb 地址（镜像站）、已允许，没有脚本错误", (await panel.inputValue("#similarwebBase")) === "https://sim.3ue.com" && /已允许读 sim\.3ue\.com/.test(await panel.textContent("#similarwebPerm")) && !errs.length, errs.join("; "));

    // ⓪ 配对之后账号被撤了管理员：下一次去领就 403，清掉令牌、收起侧边栏这一块
    admin = false;
    await sw.evaluate(() => agentPoll());
    await sleep(800);
    const st403 = await sw.evaluate(() => chrome.storage.local.get(["agentToken", "agentStatus"]));
    check("账号不再是管理员：清掉令牌、不再领任务、说明原因", !st403.agentToken && /不是管理员/.test((st403.agentStatus || {}).error || ""), (st403.agentStatus || {}).error);
    await panel.waitForFunction(() => document.getElementById("agentBox").hidden, null, { timeout: 3000 }).catch(() => {});
    check("侧边栏「远程任务」随之收起", await panel.isHidden("#agentBox"));

    // ⑦ 令牌失效（重新配对上，再让服务器说令牌不对）
    admin = true;
    await adminPage.evaluate(() => { window.__paired = null; });
    await adminPage.evaluate((t) => window.__pair(t), TOKEN);
    await adminPage.waitForFunction(() => window.__paired, null, { timeout: 5000 });
    authFail = true;
    await sw.evaluate(() => agentPoll());
    await sleep(500);
    const st = await sw.evaluate(() => chrome.storage.local.get("agentStatus").then((r) => r.agentStatus || {}));
    check("令牌失效：记下原因（侧边栏照着显示），不乱做", /令牌失效/.test(st.error || ""), st.error);

    check("令牌失效：侧边栏照着显示原因", await (async () => { await panel.waitForFunction(() => /令牌失效/.test(document.getElementById("agentState").textContent), null, { timeout: 5000 }).catch(() => {}); return /令牌失效/.test(await panel.textContent("#agentState")); })());
  } catch (e) {
    failed++;
    console.log("  ✕ 出错：" + (e && e.stack || e));
  } finally {
    await context.close();
    server.close();
  }
  console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
  process.exit(failed ? 1 : 0);
})();
