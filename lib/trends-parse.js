// lib/trends-parse.js — 解析谷歌趋势网页自己拿到的数据（纯函数，无副作用）
//
// 谷歌趋势网页画图用的数据来自两个内部接口：
//   /trends/api/widgetdata/multiline      热度曲线（timelineData：每个点 time = unix 秒，value = [0~100]）
//   /trends/api/widgetdata/relatedsearches 相关查询 / 相关主题（rankedList[0] = 热门，[1] = 上升最快）
// 两个接口的返回体都以 )]}' 开头（防 JSON 劫持的前缀），请求参数 req 是一段 JSON，里面有查的是哪个词。
// 这些接口没有公开文档，谷歌改了格式这里就要跟着改——所以解析集中在这一个文件里，并且有测试（test/test-parse.js）。
//
// 这个文件同时被三处用到：谷歌趋势页面里的内容脚本、后台 service worker（importScripts）、Node 测试（require），
// 所以写成不依赖模块系统的普通脚本，挂在全局 GefeiTrendsParse 上。
(function (root) {
  "use strict";

  // 插件只认这五种时间范围，和 seo.web.cafe 那边 google_trends 工具的 7d / 30d / 90d / 12m / 5y 一一对应
  var RANGE_DATES = ["now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y"];
  var RANGE_DAYS = { "now 7-d": 7, "today 1-m": 30, "today 3-m": 90, "today 12-m": 365, "today 5-y": 1825 };
  var MAX_POINTS = 2000;
  var MAX_RELATED = 25;

  /** 去掉 )]}' 前缀，解析 JSON */
  function parseBody(text) {
    var s = String(text || "");
    var i = s.indexOf("{");
    if (i < 0) throw new Error("返回体里没有 JSON");
    return JSON.parse(s.slice(i));
  }

  /** 从接口网址的 req 参数里读出查的是哪个词、什么类型（QUERY = 相关查询，ENTITY = 相关主题） */
  function parseReq(url) {
    var u = new URL(url, "https://trends.google.com");
    var raw = u.searchParams.get("req");
    if (!raw) return { keyword: "", keywordType: "" };
    var req = JSON.parse(raw);
    var kw = "";
    var ci = req && req.comparisonItem && req.comparisonItem[0];
    var r = (ci && ci.complexKeywordsRestriction) || (req && req.restriction && req.restriction.complexKeywordsRestriction);
    if (r && r.keyword && r.keyword[0] && typeof r.keyword[0].value === "string") kw = r.keyword[0].value;
    return { keyword: kw.trim().toLowerCase(), keywordType: String((req && req.keywordType) || "") };
  }

  /** 热度曲线 → [{t, v, p?}]。只取第一个词（插件一次只查一个词）。
   *  最后一个点常标着 isPartial（这一周 / 这一天还没过完）：留着，标 p: 1。不能丢——谷歌是连它一起归一化的，
   *  刚爆的词最高的那个 100 往往就在这个没过完的点上（线上 jev：丢掉它之后整段最高只剩 21）；
   *  读的人要知道它只是半截，别当成「热度掉了」或「就这么高」 */
  function parseTimeline(text) {
    var j = parseBody(text);
    var rows = (j && j["default"] && j["default"].timelineData) || [];
    var points = [];
    for (var i = 0; i < rows.length && points.length < MAX_POINTS; i++) {
      var r = rows[i];
      if (!r) continue;
      var t = Number(r.time), v = Number(r.value && r.value[0]);
      if (!isFinite(t) || !isFinite(v)) continue;
      var pt = { t: Math.round(t), v: Math.max(0, Math.min(100, Math.round(v))) };
      if (r.isPartial) pt.p = 1;
      points.push(pt);
    }
    if (!points.length) throw new Error("曲线是空的");
    return { points: points };
  }

  function rankedItems(list) {
    var out = [];
    var items = (list && list.rankedKeyword) || [];
    for (var i = 0; i < items.length && out.length < MAX_RELATED; i++) {
      var it = items[i];
      if (!it || typeof it.query !== "string" || !it.query.trim()) continue; // 相关主题没有 query 字段，跳过
      var row = { q: it.query.trim().slice(0, 120), v: String(it.formattedValue != null ? it.formattedValue : it.value != null ? it.value : "").slice(0, 16) };
      // 原始数值：热门里是 0~100，上升最快里是涨幅百分比（「飙升 / Breakout」是 5000 以上）——显示的字按语言变，排序靠它
      if (typeof it.value === "number" && isFinite(it.value)) row.n = it.value;
      out.push(row);
    }
    return out;
  }

  /** 相关查询 → { top: [{q, v, n?}], rising: [{q, v, n?}] }（v 是网页上显示的那个，如 "Breakout" / "飙升" / "+450%"；n 是原始数值） */
  function parseRelated(text) {
    var j = parseBody(text);
    var lists = (j && j["default"] && j["default"].rankedList) || [];
    return { top: rankedItems(lists[0]), rising: rankedItems(lists[1]) };
  }

  /** 最新一波：峰值落在最近四分之一，并且比这一波之前的最高点高出一截（≥ 1.5 倍）。
   *  返回这一波从哪个点起、峰值、之前最高多少；整段一直很热、或峰值在老早以前，返回 null。
   *  起点先按「峰值的 20% 或底子的 2 倍（取大）」往回找，再顺着一路抬升的坡往回延（坡脚也算这一波），
   *  免得渐渐起来的词把起点估晚了。seo.web.cafe 的 google_trends 工具里有同一份（src/google-trends.js），改了两边一起改 */
  function latestWave(points) {
    var n = points ? points.length : 0;
    if (n < 6) return null;
    var pk = 0;
    for (var i = 1; i < n; i++) if (points[i].v >= points[pk].v) pk = i; // 并列取最近的
    var peak = points[pk].v;
    var recent = Math.max(3, Math.floor(n / 4));
    if (peak <= 0 || pk < n - recent) return null;
    var early = points.slice(0, n - recent).map(function (p) { return p.v; }).sort(function (a, b) { return a - b; });
    var base = early[Math.floor(early.length / 2)];
    var thr = Math.max(peak * 0.2, base * 2, 5);
    var s = pk;
    while (s > 0 && points[s - 1].v >= thr) s--;
    var floor = Math.max(base, 1);
    while (s > 0 && points[s - 1].v > floor && points[s - 1].v < points[s].v) s--;
    if (s === 0) return null; // 整段都在这一波里：看不出「新的一波」
    var before = 0;
    for (var j = 0; j < s; j++) before = Math.max(before, points[j].v);
    if (peak < before * 1.5) return null; // 之前就有过差不多高的
    return { start: points[s], startIndex: s, peak: points[pk], before: before };
  }

  /** 最新一波从哪天起 → 再查一次用哪个更细的范围：能盖住这一波（前面再多留 2 天看它起来之前）的最短范围，
   *  并且要比现在这个范围短。7 天 = 按小时，30 / 90 天 = 按天。找不到（这一波太老）返回 null */
  function finerDate(date, wave, nowSec) {
    if (!wave) return null;
    var cur = RANGE_DAYS[date] || 365;
    var age = (nowSec - wave.start.t) / 86400;
    var order = ["now 7-d", "today 1-m", "today 3-m", "today 12-m"];
    for (var i = 0; i < order.length; i++) {
      var d = RANGE_DAYS[order[i]];
      if (d >= cur) break;
      if (d >= age + 2) return order[i];
    }
    return null;
  }

  /** 插件自己拼谷歌趋势的网址，不直接用对方传来的网址：只可能打开 trends.google.com，参数只认白名单里的 */
  function buildTrendsUrl(opts) {
    var keyword = String((opts && opts.keyword) || "").replace(/\s+/g, " ").trim();
    if (!keyword || keyword.length > 100) throw new Error("关键词为空或太长");
    var date = RANGE_DATES.indexOf(opts && opts.date) >= 0 ? opts.date : "today 12-m";
    var geo = /^[A-Z]{2}$/.test(String((opts && opts.geo) || "")) ? opts.geo : "";
    return "https://trends.google.com/trends/explore?date=" + encodeURIComponent(date)
      + (geo ? "&geo=" + geo : "") + "&q=" + encodeURIComponent(keyword);
  }

  var api = { parseBody: parseBody, parseReq: parseReq, parseTimeline: parseTimeline, parseRelated: parseRelated, buildTrendsUrl: buildTrendsUrl,
    latestWave: latestWave, finerDate: finerDate, RANGE_DATES: RANGE_DATES, RANGE_DAYS: RANGE_DAYS };
  root.GefeiTrendsParse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
