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
check("最后那个没过完的点（isPartial）留着、标 p: 1——谷歌连它一起归一化，刚爆的词 100 往往就在它上面", () => {
  const { points } = P.parseTimeline(XSSI + JSON.stringify(timeline));
  assert.equal(points.length, 4);
  assert.deepEqual(points[3], { t: 1760832000, v: 41, p: 1 });
  assert.ok(points.slice(0, 3).every((p) => !("p" in p)));
});
check("空曲线报错", () => { assert.throws(() => P.parseTimeline(XSSI + '{"default":{"timelineData":[]}}')); });

console.log("【相关查询】");
check("热门与上升最快分开，带网页上显示的值和原始数值（「飙升」按语言变字，排序靠数值）", () => {
  const r = P.parseRelated(XSSI + JSON.stringify(related));
  assert.deepEqual(r.top, [{ q: "jev ai", v: "100", n: 100 }, { q: "jev model", v: "62", n: 62 }]);
  assert.deepEqual(r.rising, [{ q: "jev api", v: "Breakout", n: 4550 }, { q: "jev vs llm", v: "+450%", n: 450 }]);
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

console.log("【最新一波 → 再查一次更细的】");
{
  const DAY = 86400, WEEK = 7 * DAY;
  const NOW = 1790164800; // 2026-09-23 12:00 UTC
  const jev30 = require("./fixtures/jev-30d.json").points; // 线上实测：底子 1 左右，9/15 起 2 → 13 → 30 → … → 100
  check("线上 jev（30 天按天）：最新一波从 9/15 起、之前最高 1", () => {
    const w = P.latestWave(jev30);
    assert.equal(new Date(w.start.t * 1000).toISOString().slice(0, 10), "2026-09-15");
    assert.equal(w.before, 1);
    assert.equal(w.peak.v, 100);
  });
  check("起来已经 8 天：7 天按小时盖不住起点，30 天本身就是最细的合适范围——不再补查", () => {
    assert.equal(P.finerDate("today 1-m", P.latestWave(jev30), NOW), null);
  });
  // 线上 jev（12 个月按周）的样子：几乎全是 0、中间有个 1 的小包，9/13 那周 21，没过完的这一周 100
  const T0 = 1758412800; // 2025-09-21
  const weekly = Array.from({ length: 53 }, (_, i) => ({ t: T0 + i * WEEK, v: i === 20 ? 1 : i === 51 ? 21 : i === 52 ? 100 : 0 }));
  weekly[52].p = 1;
  check("12 个月按周：最新一波是 9/13 那周，接着查过去 30 天按天", () => {
    const w = P.latestWave(weekly);
    assert.equal(new Date(w.start.t * 1000).toISOString().slice(0, 10), "2026-09-13");
    assert.equal(P.finerDate("today 12-m", w, NOW), "today 1-m");
  });
  check("丢了没过完的点也认得出（旧版插件取的数据最高只有 21）", () => {
    const w = P.latestWave(weekly.slice(0, 52));
    assert.equal(w.start.v, 21);
  });
  check("这一周才起来：查过去 7 天按小时；两个月前起来：查过去 90 天按天", () => {
    assert.equal(P.finerDate("today 12-m", { start: { t: NOW - 3 * DAY } }, NOW), "now 7-d");
    assert.equal(P.finerDate("today 12-m", { start: { t: NOW - 60 * DAY } }, NOW), "today 3-m");
    assert.equal(P.finerDate("today 12-m", { start: { t: NOW - 200 * DAY } }, NOW), null);
    assert.equal(P.finerDate("now 7-d", { start: { t: NOW - 3 * DAY } }, NOW), null, "已经是最细的");
  });
  check("慢慢爬起来的坡：起点落在坡脚，不是半山腰", () => {
    const ramp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 8, 20, 45, 100].map((v, i) => ({ t: T0 + i * DAY, v }));
    assert.equal(P.latestWave(ramp).start.v, 3);
  });
  check("一直很热的老词、峰值在老早以前、整段一个样：都不算新的一波", () => {
    const steady = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * DAY, v: 60 + (i % 5) * 8 }));
    assert.equal(P.latestWave(steady), null);
    const old = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * DAY, v: i === 3 ? 100 : 10 }));
    assert.equal(P.latestWave(old), null);
    assert.equal(P.latestWave(Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * DAY, v: 0 }))), null);
  });
  check("老词底子 40、最近冲到 100：也算一波，起点在冲上去那里", () => {
    const vals = Array.from({ length: 30 }, (_, i) => (i < 26 ? 40 : [55, 75, 90, 100][i - 26]));
    const w = P.latestWave(vals.map((v, i) => ({ t: T0 + i * DAY, v })));
    assert.equal(w.start.v, 55);
  });
}

console.log("【只拼 trends.google.com 的网址】");
check("范围、地区、词都进网址", () => {
  const u = P.buildTrendsUrl({ keyword: "jev ai", geo: "US", date: "today 1-m" });
  assert.equal(u, "https://trends.google.com/trends/explore?date=today%201-m&geo=US&q=jev%20ai");
});
check("90 天（按天）也认", () => {
  assert.match(P.buildTrendsUrl({ keyword: "jev", date: "today 3-m" }), /date=today%203-m/);
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
