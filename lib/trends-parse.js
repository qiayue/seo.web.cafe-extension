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

  // 插件只认这四种时间范围，和 seo.web.cafe 那边 google_trends 工具的 7d / 30d / 12m / 5y 一一对应
  var RANGE_DATES = ["now 7-d", "today 1-m", "today 12-m", "today 5-y"];
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

  /** 热度曲线 → [{t, v}]。只取第一个词（插件一次只查一个词）；
   *  最后一个点常标着 isPartial（这一周 / 这一天还没过完），数值偏低，像是跌了——去掉，免得被读成「热度掉了」 */
  function parseTimeline(text) {
    var j = parseBody(text);
    var rows = (j && j["default"] && j["default"].timelineData) || [];
    var points = [];
    for (var i = 0; i < rows.length && points.length < MAX_POINTS; i++) {
      var r = rows[i];
      if (!r || r.isPartial) continue;
      var t = Number(r.time), v = Number(r.value && r.value[0]);
      if (!isFinite(t) || !isFinite(v)) continue;
      points.push({ t: Math.round(t), v: Math.max(0, Math.min(100, Math.round(v))) });
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
      out.push({ q: it.query.trim().slice(0, 120), v: String(it.formattedValue != null ? it.formattedValue : it.value != null ? it.value : "").slice(0, 16) });
    }
    return out;
  }

  /** 相关查询 → { top: [{q, v}], rising: [{q, v}] }（v 是网页上显示的那个，如 "Breakout" / "飙升" / "+450%"） */
  function parseRelated(text) {
    var j = parseBody(text);
    var lists = (j && j["default"] && j["default"].rankedList) || [];
    return { top: rankedItems(lists[0]), rising: rankedItems(lists[1]) };
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

  var api = { parseBody: parseBody, parseReq: parseReq, parseTimeline: parseTimeline, parseRelated: parseRelated, buildTrendsUrl: buildTrendsUrl, RANGE_DATES: RANGE_DATES };
  root.GefeiTrendsParse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
