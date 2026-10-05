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
  const j = G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pager: { selector: "button[aria-label=next]", times: 5000 } }, {});
  assert.equal(j.pager.times, 19, "最多 20 页");
  bad({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pager: { selector: " " } });
  bad({ requestId: ID, kind: "capture", site: "similarweb", path: "/", match: "(" });
});
check("在网页里执行的两个函数能单独序列化（不引用外面的变量）", () => {
  for (const f of [G.fetchInPage, G.clickNext, G.browseLikeHuman]) assert.ok(!/\bG\.|\bSITES\b|\bMAX_/.test(f.toString()), f.name);
});
check("Similarweb 着陆页：在插件里就整理成行（去重、带子站、周趋势按日期排好），交回去的只有这些", () => {
  const page = (n, urls) => ({ url: "https://sim.3ue.com/api/websiteOrganicLandingPagesV2?from=2026%7C09%7C04&to=2026%7C10%7C01&isWindow=true&latest=28d&key=github.io", page: n,
    body: JSON.stringify({ TotalCount: 350121, Data: urls.map((u, i) => ({ Url: u, Trend: { "2026-09-25": 2, "2026-09-18": 1 }, Clicks: 100 - i, PrevClicks: 50, ClicksChange: 1, ClicksShare: 0.01,
      KeywordsCount: 7, TopKeyword: "annas archive", ChangeState: "Positive" })) }) });
  const x = G.runExtract("sw_landing", [page(0, ["A.github.io/x", "b.github.io/"]), page(1, ["b.github.io/", "c.github.io/y"]), { url: "x", body: "not json" }]);
  assert.equal(x.total, 350121);
  assert.deepEqual(x.rows.map((r) => r.url), ["A.github.io/x", "b.github.io/", "c.github.io/y"]);
  assert.equal(x.rows[0].host, "a.github.io");
  assert.deepEqual(x.rows[0].trend, [["2026-09-18", 1], ["2026-09-25", 2]]);
  assert.equal(x.rows[2].page, 1);
  assert.equal(x.rows[0].topKeyword, "annas archive");
  assert.deepEqual(x.period, { from: "2026|09|04", to: "2026|10|01", latest: "28d", isWindow: true, key: "github.io" });
  assert.ok(!("body" in x.rows[0]) && !("Trend" in x.rows[0]));
});
check("带解析器的任务：没写 match 就用解析器自己的；不认识的解析器不接；翻页可以只给翻页条上的一段文字", () => {
  const j = G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/", extract: "sw_landing", pager: { near: "out of", times: 4 } }, {});
  assert.ok(/LandingPages/.test(j.match) && j.pager.near === "out of" && j.pager.selector === "");
  bad({ requestId: ID, kind: "capture", site: "similarweb", path: "/", extract: "evil" });
});
check("要升级才看得到的数据：两成以上的行被锁（网址打码 / 没有点击数 / 写着升级）就算这一页不完整；被锁的行不要", () => {
  const ok = { Url: "a.vercel.app/", Clicks: 10, TopKeyword: "x" };
  const lockedUrl = { Url: "*****.vercel.app", Clicks: 10 }, noClicks = { Url: "b.vercel.app", Clicks: null }, upsell = { Url: "c.vercel.app", Clicks: 1, TopKeyword: "Upgrade to see" };
  assert.equal(G.swPageCheck({ Data: [ok, ok, ok, ok, ok, ok, ok, ok, ok, lockedUrl] }).complete, true);
  assert.equal(G.swPageCheck({ Data: [ok, ok, ok, lockedUrl, noClicks, upsell] }).complete, false);
  assert.equal(G.swPageCheck({ Data: [] }).complete, false);
  assert.deepEqual(G.swLandingRows({ Data: [ok, lockedUrl, noClicks, upsell] }).map((r) => r.url), ["a.vercel.app/"]);
});
check("Similarweb 引荐流量（收款渠道的导入 / 导出）：只留 Records 里的网站、占比、访问量、环比，导出表的子域名放 children，又大又没用的分类 / 话题不要", () => {
  const rec = (d, kids) => ({ Domain: d, Share: 0.1, TotalVisits: 1234.5, Change: -0.2, NewChange: false, Rank: 1228, Category: "Computers", Favicon: "https://x/y.png",
    TotalSharePerMonth: [{ Key: "2026-08-01", Value: 0.1 }], SiteOrigins: { "checkout.stripe.com": 1 }, ...(kids ? { Children: kids } : {}) });
  const out = { url: "https://sim.3ue.com/api/websiteanalysis/GetOutgoingTable?country=999&from=2026%7C08%7C01&to=2026%7C08%7C31&isWindow=false&key=checkout.stripe.com", page: 0,
    body: JSON.stringify({ TotalCount: 946, TotalVisits: 15962159.1, Categories: { big: [1, 2, 3] }, Topics: [{ Name: "x" }],
      Records: [rec("Higgsfield.ai", [rec("higgsfield.ai"), { ...rec("clerk.higgsfield.ai"), NewChange: true, Rank: -1 }]), rec("suno.com"), rec("suno.com"), { Domain: "", Share: 0.01 }] }) };
  const x = G.runExtract("sw_referrals", [out]);
  assert.equal(x.direction, "out");
  assert.equal(x.total, 946);
  assert.equal(Math.round(x.totalVisits), 15962159);
  assert.deepEqual(x.rows.map((r) => r.domain), ["higgsfield.ai", "suno.com"]);
  assert.deepEqual(x.rows[0].children.map((c) => [c.domain, c.isNew, c.rank]), [["higgsfield.ai", false, 1228], ["clerk.higgsfield.ai", true, null]]);
  assert.deepEqual(x.period, { from: "2026|08|01", to: "2026|08|31", latest: "", isWindow: false, key: "checkout.stripe.com" });
  assert.ok(!JSON.stringify(x).includes("Favicon") && !JSON.stringify(x).includes("Topics"));
  const inc = { ...out, url: out.url.replace("GetOutgoingTable", "GetTrafficSourcesTotalReferralsTable") };
  assert.equal(G.runExtract("sw_referrals", [inc]).direction, "in");
  assert.equal(G.EXTRACTORS.sw_referrals.check(out.body).complete, true);
  assert.equal(G.EXTRACTORS.sw_referrals.check("{}").complete, false);
  const j = G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/#/digitalsuite/websiteanalysis/referrals/*/999/1m?key=checkout.stripe.com", extract: "sw_referrals" }, {});
  assert.ok(/GetOutgoingTable/.test(j.match) && !j.pager);
});
check("节奏：任务写 pace: fast 就用快一点的（照样随机、照样歇），其它一律按正常节奏", () => {
  assert.equal(G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pace: "fast" }, {}).pace, "fast");
  assert.equal(G.normAgentJob({ requestId: ID, kind: "capture", site: "similarweb", path: "/", pace: "turbo" }, {}).pace, "normal");
  assert.equal(G.paceOf("fast"), G.FAST);
  assert.equal(G.paceOf("x"), G.HUMAN);
  assert.ok(G.FAST.readMs[0] >= 1000 && G.FAST.restMs[0] >= 5000, "快也不能快到不像人");
});
console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
