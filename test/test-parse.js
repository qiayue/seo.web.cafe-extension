// test/test-parse.js — 谷歌趋势返回体的解析（node test/test-parse.js）
//
// 谷歌趋势的内部接口没有公开文档，格式一变插件就取不到数。这里用和线上同形的样本钉住解析：
// )]}' 前缀、req 参数里的词、isPartial 的最后一个点、相关查询与相关主题的区分、只拼 trends.google.com 的网址。
"use strict";
const assert = require("node:assert/strict");
const P = require("../lib/trends-parse.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✕ " + name + "  " + e.message); }
}
const XSSI = ")]}',\n";
const reqUrl = (path, req) => "https://trends.google.com/trends/api/widgetdata/" + path + "?hl=en-US&tz=-480&req=" + encodeURIComponent(JSON.stringify(req)) + "&token=APP6_x";
const MULTI_REQ = { time: "2025-09-23 2026-09-23", resolution: "WEEK", locale: "en-US", comparisonItem: [{ geo: {}, complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "JEV" }] } }], requestOptions: { property: "", backend: "IZG", category: 0 } };
const REL_REQ = (type) => ({ restriction: { geo: {}, time: "2025-09-23 2026-09-23", complexKeywordsRestriction: { keyword: [{ type: "BROAD", value: "jev" }] } }, keywordType: type, metric: ["TOP", "RISING"], language: "en" });
const timeline = {
  default: {
    timelineData: [
      { time: "1759017600", formattedTime: "Sep 28 – Oct 4, 2025", value: [0], hasData: [false], formattedValue: ["0"] },
      { time: "1759622400", formattedTime: "Oct 5 – 11, 2025", value: [3], hasData: [true], formattedValue: ["3"] },
      { time: "1760227200", formattedTime: "Oct 12 – 18, 2025", value: [100], hasData: [true], formattedValue: ["100"] },
      { time: "1760832000", formattedTime: "Oct 19 – 25, 2025", value: [41], hasData: [true], formattedValue: ["41"], isPartial: true },
    ],
    averages: [],
  },
};
const related = {
  default: {
    rankedList: [
      { rankedKeyword: [{ query: "jev ai", value: 100, formattedValue: "100", hasData: true }, { query: "jev model", value: 62, formattedValue: "62" }] },
      { rankedKeyword: [{ query: "jev api", value: 4550, formattedValue: "Breakout" }, { query: "jev vs llm", value: 450, formattedValue: "+450%" }] },
    ],
  },
};
const topics = { default: { rankedList: [{ rankedKeyword: [{ topic: { mid: "/m/0x", title: "Japanese encephalitis", type: "Disease" }, value: 100, formattedValue: "100" }] }, { rankedKeyword: [] }] } };

console.log("【返回体】");
check("去掉 )]}' 前缀再解析", () => { assert.deepEqual(P.parseBody(XSSI + '{"a":1}'), { a: 1 }); });
check("没有 JSON 就报错，不瞎猜", () => { assert.throws(() => P.parseBody("<html>unusual traffic</html>")); });

console.log("【曲线】");
check("取第一个词的值、按时间给点", () => {
  const { points } = P.parseTimeline(XSSI + JSON.stringify(timeline));
  assert.deepEqual(points.slice(0, 3), [{ t: 1759017600, v: 0 }, { t: 1759622400, v: 3 }, { t: 1760227200, v: 100 }]);
});
check("最后那个没过完的点（isPartial）去掉——它偏低，会被读成「热度掉了」", () => {
  const { points } = P.parseTimeline(XSSI + JSON.stringify(timeline));
  assert.equal(points.length, 3);
  assert.equal(points[points.length - 1].v, 100);
});
check("空曲线报错", () => { assert.throws(() => P.parseTimeline(XSSI + '{"default":{"timelineData":[]}}')); });

console.log("【相关查询】");
check("热门与上升最快分开，带网页上显示的值", () => {
  const r = P.parseRelated(XSSI + JSON.stringify(related));
  assert.deepEqual(r.top, [{ q: "jev ai", v: "100" }, { q: "jev model", v: "62" }]);
  assert.deepEqual(r.rising, [{ q: "jev api", v: "Breakout" }, { q: "jev vs llm", v: "+450%" }]);
});
check("相关主题（没有 query 字段）跳过", () => {
  const r = P.parseRelated(XSSI + JSON.stringify(topics));
  assert.equal(r.top.length, 0);
});

console.log("【请求参数：查的是哪个词】");
check("曲线接口：从 comparisonItem 读出词，转小写", () => {
  assert.deepEqual(P.parseReq(reqUrl("multiline", MULTI_REQ)), { keyword: "jev", keywordType: "" });
});
check("相关接口：从 restriction 读出词，分清查询（QUERY）和主题（ENTITY）", () => {
  assert.equal(P.parseReq(reqUrl("relatedsearches", REL_REQ("QUERY"))).keywordType, "QUERY");
  assert.equal(P.parseReq(reqUrl("relatedsearches", REL_REQ("ENTITY"))).keywordType, "ENTITY");
  assert.equal(P.parseReq(reqUrl("relatedsearches", REL_REQ("QUERY"))).keyword, "jev");
});

console.log("【只拼 trends.google.com 的网址】");
check("范围、地区、词都进网址", () => {
  const u = P.buildTrendsUrl({ keyword: "jev ai", geo: "US", date: "today 1-m" });
  assert.equal(u, "https://trends.google.com/trends/explore?date=today%201-m&geo=US&q=jev%20ai");
});
check("不认识的范围回 12 个月、地区不对就当全球", () => {
  const u = P.buildTrendsUrl({ keyword: "jev", geo: "usa", date: "all" });
  assert.equal(u, "https://trends.google.com/trends/explore?date=today%2012-m&q=jev");
});
check("空词 / 太长的词报错", () => {
  assert.throws(() => P.buildTrendsUrl({ keyword: "  " }));
  assert.throws(() => P.buildTrendsUrl({ keyword: "x".repeat(101) }));
});

console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
