// test/test-agent-jobs.js — 远程任务：云端派来的任务怎么认、开哪个网址（node test/test-agent-jobs.js）
//
// 任务是从云端（new.web.cafe）来的，插件拿的是你自己登录着的账号：任务里只许写「哪个网站 + 路径」，
// 域名由你在侧边栏设置的地址补（Similarweb 官方或共享账号的镜像站），不认识的网站、带域名的路径一律不开。
"use strict";
const assert = require("node:assert/strict");
const G = require("../lib/agent-jobs.js");
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✕ " + name + "  " + e.message); }
}
const ID = "a".repeat(32);
const bad = (job, bases) => assert.throws(() => G.normAgentJob(job, bases || {}));

check("默认用官方地址；设置成镜像站就用镜像站", () => {
  const j = { requestId: ID, kind: "page", site: "similarweb", path: "/#/digitalsuite/x?key=github.io" };
  assert.equal(G.normAgentJob(j, {}).url, "https://pro.similarweb.com/#/digitalsuite/x?key=github.io");
  assert.equal(G.normAgentJob(j, { similarweb: "https://sim.3ue.com" }).url, "https://sim.3ue.com/#/digitalsuite/x?key=github.io");
  assert.equal(G.normAgentJob(j, G.basesFrom({ similarwebBase: "sim.3ue.com/whatever" })).url, "https://sim.3ue.com/#/digitalsuite/x?key=github.io");
});
check("地址只认 https 域名；乱填的报错而不是悄悄开别的", () => {
  assert.equal(G.normBase("http://sim.3ue.com", "x"), null);
  assert.equal(G.normBase("", "https://pro.similarweb.com"), "https://pro.similarweb.com");
  bad({ requestId: ID, kind: "page", site: "similarweb", path: "/" }, { similarweb: "http://evil" });
});
check("不认识的网站、带域名的路径、不认识的任务类型一律不接", () => {
  bad({ requestId: ID, kind: "page", site: "gmail", path: "/" });
  bad({ requestId: ID, kind: "page", site: "similarweb", path: "https://evil.com/" });
  bad({ requestId: ID, kind: "page", site: "similarweb", path: "//evil.com/" });
  bad({ requestId: ID, kind: "trends", site: "similarweb", path: "/" });
  bad({ requestId: "x", kind: "page", site: "similarweb", path: "/" });
});
check("fetch：只请求同一个网站的路径，Cookie / Authorization 请求头不许带", () => {
  const j = G.normAgentJob({ requestId: ID, kind: "fetch", site: "similarweb", path: "/", requests: ["/api/x?page=1", { path: "/api/x?page=2", headers: { "x-requested-with": "XMLHttpRequest" } }] }, { similarweb: "https://sim.3ue.com" });
  assert.deepEqual(j.requests.map((r) => r.url), ["https://sim.3ue.com/api/x?page=1", "https://sim.3ue.com/api/x?page=2"]);
  bad({ requestId: ID, kind: "fetch", site: "similarweb", path: "/", requests: [{ path: "/a", headers: { Cookie: "1" } }] });
  bad({ requestId: ID, kind: "fetch", site: "similarweb", path: "/", requests: ["https://evil.com/a"] });
});
check("capture：翻页要有按钮选择器，次数有上限", () => {
  const j = G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pager: { selector: "button[aria-label=next]", times: 500 } }, {});
  assert.equal(j.pager.times, 60);
  bad({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pager: { selector: " " } });
  bad({ requestId: ID, kind: "capture", site: "similarweb", path: "/", match: "(" });
});
check("在网页里执行的两个函数能单独序列化（不引用外面的变量）", () => {
  for (const f of [G.fetchInPage, G.clickNext]) assert.ok(!/\bG\.|\bSITES\b|\bMAX_/.test(f.toString()), f.name);
});
console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
