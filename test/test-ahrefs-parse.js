// test/test-ahrefs-parse.js — 从 Ahrefs 页面自己加载的 JSON 里认曲线 / 指标（node test/test-ahrefs-parse.js）
//
// Ahrefs 的内部接口没有公开文档、字段名会变：插件不认具体接口，只按「长相」认。这里钉住认法：
// 什么算曲线、什么算指标、什么不该收（列表里某一页的流量、像时间戳的大数字）。
"use strict";
const assert = require("node:assert/strict");
const A = require("../lib/ahrefs-parse.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✕ " + name + "  " + e.message); }
}
const months = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 10));

console.log("【曲线】");
check("对象数组：一个日期字段 + 几个数字字段 → 每个数字字段一条曲线，名字带上所在的键", () => {
  const x = A.extract({ data: { history: months(4).map((d, i) => ({ date: d, refdomains: i * 10, backlinks: i * 100, label: "x" })) } });
  assert.deepEqual(x.series.map((s) => s.name).sort(), ["data.history.backlinks", "data.history.refdomains"]); // 所在的键取最近两层
  assert.deepEqual(x.series.find((s) => s.name === "data.history.refdomains").points, months(4).map((d, i) => [Date.parse(d + "T00:00:00Z") / 1000, i * 10]));
});
check("数组的数组（图表库写法 [毫秒时间戳, 数值]）也认", () => {
  const x = A.extract({ chart: { traffic: [[1735689600000, 1], [1738368000000, 2], [1740787200000, 3]] } });
  assert.equal(x.series[0].name, "chart.traffic");
  assert.deepEqual(x.series[0].points[0], [1735689600, 1]);
});
check("「2025-01」这种月份也认；日期乱序会排好、同一天去重", () => {
  const x = A.extract({ h: [{ month: "2025-03", v: 3 }, { month: "2025-01", v: 1 }, { month: "2025-02", v: 2 }, { month: "2025-02", v: 9 }] });
  assert.deepEqual(x.series[0].points.map((p) => p[1]), [1, 9, 3]);
});
check("数字只在键名像日期时才当时间戳（17 亿的流量不是时间）", () => {
  const x = A.extract({ rows: [{ id: 1700000000, traffic: 1 }, { id: 1700000001, traffic: 2 }, { id: 1700000002, traffic: 3 }] });
  assert.equal(x.series.length, 0);
  assert.equal(A.toSec(1700000000, "org_traffic"), null);
  assert.equal(A.toSec(1700000000, "date"), 1700000000);
});
check("不到 3 个点不算曲线；点太多均匀抽到 200 个、最后一个点留着", () => {
  assert.equal(A.extract({ h: [{ date: "2025-01-01", v: 1 }, { date: "2025-02-01", v: 2 }] }).series.length, 0);
  const many = Array.from({ length: 1000 }, (_, i) => ({ date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10), v: i }));
  const s = A.extract({ h: many }).series[0];
  assert.equal(s.points.length, 200);
  assert.equal(s.points[199][1], 999);
});
check("名字像外链 / 流量的曲线排前面，最多 16 条", () => {
  const obj = {};
  for (let i = 0; i < 20; i++) obj["misc" + i] = months(3).map((d) => ({ date: d, v: 1 }));
  obj.hist = months(3).map((d) => ({ date: d, org_traffic: 5 }));
  const x = A.extract(obj);
  assert.equal(x.series.length, 16);
  assert.equal(x.series[0].name, "hist.org_traffic");
});

console.log("【指标】");
check("名字像 DR / 外链 / 引荐域名 / 流量的数字收下，别的不收", () => {
  const x = A.extract({ metrics: { domain_rating: 76, backlinks: 12, refdomains: 3, org_traffic: 9, org_keywords: 8, id: 5, name: "x" } });
  assert.deepEqual(x.metrics, { domain_rating: 76, backlinks: 12, refdomains: 3, org_traffic: 9, org_keywords: 8 });
});
check("列表里每一行的数字（某个页面的流量）不是这个站的指标", () => {
  assert.deepEqual(A.extract({ top_pages: [{ url: "/a", traffic: 5 }, { url: "/b", traffic: 3 }] }).metrics, {});
});
check("同名的指标在别处又出现：带上路径另记一个", () => {
  const x = A.extract({ a: { traffic: 1 }, b: { traffic: 2 } });
  assert.deepEqual(x.metrics, { traffic: 1, "b.traffic": 2 });
});

console.log("【地址与页面】");
check("要看的网站：去掉协议、路径、www.，转小写；不像域名给空", () => {
  assert.equal(A.normTarget("https://www.Pollo.ai/pricing?x=1"), "pollo.ai");
  assert.equal(A.normTarget("pollo.ai"), "pollo.ai");
  assert.equal(A.normTarget("not a domain"), "");
  assert.equal(A.normTarget("javascript:alert(1)"), "");
});
check("Ahrefs 地址：只留 https 域名（镜像站贴 …/dashboard 也行），http / 乱写不认，空的回官方", () => {
  assert.equal(A.normBase("https://ahrefs.3ue.com/dashboard"), "https://ahrefs.3ue.com");
  assert.equal(A.normBase("ahrefs.3ue.com"), "https://ahrefs.3ue.com");
  assert.equal(A.normBase("http://ahrefs.3ue.com"), null);
  assert.equal(A.normBase("not a url"), null);
  assert.equal(A.normBase(""), "https://app.ahrefs.com");
});
check("Site Explorer 网址：看全部子域", () => {
  assert.equal(A.siteExplorerUrl("https://app.ahrefs.com", "pollo.ai"), "https://app.ahrefs.com/site-explorer/overview?target=pollo.ai&mode=subdomains");
});
check("登录页：网址里有 login，或页面上有密码框", () => {
  const doc = (pw) => ({ querySelector: (sel) => (pw && sel === "input[type=password]" ? {} : null) });
  assert.equal(A.isLoginPage(doc(false), { pathname: "/user/login" }), true);
  assert.equal(A.isLoginPage(doc(true), { pathname: "/site-explorer/overview" }), true);
  assert.equal(A.isLoginPage(doc(false), { pathname: "/site-explorer/overview" }), false);
});
check("返回体带前缀也能解析；不是 JSON 就报错", () => {
  assert.deepEqual(A.parseBody(")]}'\n{\"a\":1}"), { a: 1 });
  assert.throws(() => A.parseBody("<html>"));
});

console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
