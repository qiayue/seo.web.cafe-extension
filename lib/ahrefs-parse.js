// lib/ahrefs-parse.js — 从 Ahrefs 网页自己加载的数据里认出「曲线」和「指标」（纯函数，无副作用）
//
// Ahrefs 的 Site Explorer 是个单页应用：页面上的外链 / 引荐域名 / 自然流量曲线，都来自它自己请求回来的 JSON。
// 这些内部接口没有公开文档、字段名随版本变，所以这里不认具体接口，只按「长相」认：
//   曲线 = 一个数组，每一项都有一个日期字段（"2025-01-01" 这种，或名字像 date / time 的时间戳）和若干数字字段；
//          每个数字字段是一条曲线，名字取「数组所在的键 + 数字字段名」（比如 history.refdomains）。
//   指标 = 名字像 domain_rating / backlinks / refdomains / org_traffic … 的数字。
// 再加上页面上看得到的文字（DR、外链数这些卡片），一起交给 Agent 去读。字段名是 Ahrefs 自己的，Agent 按名字理解。
//
// 同时被三处用到：Ahrefs 页面里的内容脚本、后台 service worker（importScripts）、Node 测试（require）。
(function (root) {
  "use strict";

  var DEFAULT_BASE = "https://app.ahrefs.com";
  var MAX_SERIES = 16, MAX_POINTS = 200, MAX_METRICS = 80, MAX_TEXT = 8000, MAX_DEPTH = 8; // 16 × 200 个点 + 8000 字，交给网站时远小于 200KB
  var METRIC_RE = /(domain_?rating|^dr$|^ur$|url_?rating|backlink|ref_?domain|refdomain|referring|linked_?domain|traffic|keyword|^org_|organic|^paid|cost|ahrefs_?rank|^rank$)/i;
  var DATE_KEY_RE = /(date|time|^t$|^ts$|^day$|^month$|^period$)/i;
  var LO = 946684800; // 2000-01-01

  /** 去掉可能的防劫持前缀，解析 JSON */
  function parseBody(text) {
    var s = String(text || "");
    var i = s.search(/[[{]/);
    if (i < 0) throw new Error("返回体里没有 JSON");
    return JSON.parse(s.slice(i));
  }

  /** 像日期的值 → unix 秒；不像返回 null。数字只在键名像日期时才认（免得把 17 亿的流量当成时间戳） */
  function toSec(v, key) {
    var hi = Date.now() / 1000 + 2 * 86400;
    if (typeof v === "string") {
      var s = v.trim();
      if (!/^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
      var ms = Date.parse(s.length === 7 ? s + "-01T00:00:00Z" : s.length === 10 ? s + "T00:00:00Z" : s);
      if (!isFinite(ms)) return null;
      var t = Math.round(ms / 1000);
      return t >= LO && t <= hi ? t : null;
    }
    if (typeof v === "number" && isFinite(v) && DATE_KEY_RE.test(String(key || ""))) {
      if (v >= LO && v <= hi) return Math.round(v);
      if (v >= LO * 1000 && v <= hi * 1000) return Math.round(v / 1000);
    }
    return null;
  }
  function num(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    return null;
  }
  function label(path) {
    var named = path.filter(function (p) { return typeof p === "string"; });
    return named.slice(-2).join(".") || "data";
  }
  /** 点太多就均匀抽（按月的十年也才 120 个点，按天的一年抽到 200 个也看得出走势），最后一个点一定留着 */
  function thin(points) {
    if (points.length <= MAX_POINTS) return points;
    var out = [], step = (points.length - 1) / (MAX_POINTS - 1);
    for (var i = 0; i < MAX_POINTS; i++) out.push(points[Math.round(i * step)]);
    return out;
  }
  function mostly(arr, fn) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n++;
    return n >= Math.max(3, Math.ceil(arr.length * 0.8));
  }

  /** 一个数组像不像曲线：像就把每个数字字段变成一条曲线放进 out.series */
  function arraySeries(arr, path, out) {
    if (arr.length < 3) return false;
    var sample = arr.slice(0, 200);
    // 对象数组：[{ date: "2025-01-01", refdomains: 123, … }]
    if (mostly(sample, function (x) { return x && typeof x === "object" && !Array.isArray(x); })) {
      var keys = Object.keys(sample[0] || {});
      var dateKey = null;
      for (var i = 0; i < keys.length && !dateKey; i++) {
        var k = keys[i];
        if (mostly(sample, function (x) { return toSec(x && x[k], k) != null; })) dateKey = k;
      }
      if (!dateKey) return false;
      var found = false;
      keys.forEach(function (k2) {
        if (k2 === dateKey || !mostly(sample, function (x) { return x && num(x[k2]) != null; })) return;
        var pts = [];
        arr.forEach(function (x) { var t = x && toSec(x[dateKey], dateKey), v = x && num(x[k2]); if (t != null && v != null) pts.push([t, v]); });
        if (pts.length >= 3) { out.series.push({ name: label(path) + "." + k2, points: pts }); found = true; }
      });
      return found;
    }
    // 数组的数组：[[1735689600000, 123], …]（图表库常用的写法）
    if (mostly(sample, function (x) { return Array.isArray(x) && x.length >= 2 && toSec(x[0], "t") != null; })) {
      var cols = sample[0].length, any = false;
      for (var c = 1; c < cols; c++) {
        var pts2 = [];
        arr.forEach(function (x) { var t = Array.isArray(x) ? toSec(x[0], "t") : null, v = Array.isArray(x) ? num(x[c]) : null; if (t != null && v != null) pts2.push([t, v]); });
        if (pts2.length >= 3) { out.series.push({ name: label(path) + (cols > 2 ? "[" + c + "]" : ""), points: pts2 }); any = true; }
      }
      return any;
    }
    return false;
  }

  function walk(node, path, depth, out, inList) {
    if (depth > MAX_DEPTH || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (arraySeries(node, path, out)) return;
      // 不是曲线的数组（比如热门页面列表）：只往前几项里找曲线，别把整张表翻一遍；
      // 列表里每一行的数字（某个页面的流量）不是这个站的指标，不收
      for (var i = 0; i < node.length && i < 3; i++) walk(node[i], path.concat(i), depth + 1, out, true);
      return;
    }
    Object.keys(node).forEach(function (k) {
      var v = node[k];
      if (!inList && typeof v === "number" && isFinite(v) && METRIC_RE.test(k) && depth <= 5) {
        var name = out.metrics[k] === undefined ? k : label(path.concat(k));
        if (out.metrics[name] === undefined && Object.keys(out.metrics).length < MAX_METRICS) out.metrics[name] = v;
      } else if (v && typeof v === "object") walk(v, path.concat(k), depth + 1, out, inList);
    });
  }

  /** 一段 JSON → { series: [{ name, points: [[unix 秒, 数值]] }], metrics: { 名字: 数值 } } */
  function extract(json) {
    var out = { series: [], metrics: {} };
    walk(json, [], 0, out);
    var seen = {};
    out.series = out.series.map(function (s) {
      var byT = {};
      s.points.forEach(function (p) { byT[p[0]] = p[1]; });
      var pts = Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return [t, byT[t]]; });
      return { name: s.name.slice(0, 80), points: thin(pts) };
    }).filter(function (s) { if (seen[s.name]) return false; seen[s.name] = 1; return true; })
      // 名字像外链 / 流量指标的排前面，其次点多的
      .sort(function (a, b) { return (METRIC_RE.test(b.name) ? 1 : 0) - (METRIC_RE.test(a.name) ? 1 : 0) || b.points.length - a.points.length; })
      .slice(0, MAX_SERIES);
    return out;
  }

  /** 页面上看得到的文字（指标卡片里的 DR、外链数这些），空白收拢，截到 8000 字 */
  function pageText(doc) {
    var main = doc.querySelector("main") || doc.body;
    var raw = main ? String(main.innerText || main.textContent || "") : "";
    return raw.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, MAX_TEXT);
  }
  /** 是不是登录页：网址里有 login / signin，或者页面上有密码框 */
  function isLoginPage(doc, loc) {
    return /(^|\/)(user\/)?(login|signin|sign-in|sign_in)(\/|$)/i.test(String(loc && loc.pathname || "")) || !!doc.querySelector("input[type=password]");
  }

  /** 用户填的 Ahrefs 地址 → https://域名（官方或镜像站）；不像网址返回 null，空的回官方 */
  function normBase(raw) {
    var s = String(raw || "").trim();
    if (!s) return DEFAULT_BASE;
    try {
      var u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
      if (u.protocol !== "https:" || !/\./.test(u.hostname)) return null;
      return u.origin;
    } catch (e) { return null; }
  }
  /** 要看的网站 → 域名（去掉协议、路径、www.）；不像域名返回 "" */
  function normTarget(raw) {
    var s = String(raw || "").trim().toLowerCase();
    try { if (/^https?:\/\//.test(s)) s = new URL(s).hostname; } catch (e) { return ""; }
    s = s.replace(/[/?#].*$/, "").replace(/^www\./, "");
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) && s.length <= 253 ? s : "";
  }
  function siteExplorerUrl(base, target) {
    return base + "/site-explorer/overview?target=" + encodeURIComponent(target) + "&mode=subdomains";
  }

  var api = { DEFAULT_BASE: DEFAULT_BASE, MAX_SERIES: MAX_SERIES, MAX_POINTS: MAX_POINTS, MAX_TEXT: MAX_TEXT,
    parseBody: parseBody, toSec: toSec, extract: extract, pageText: pageText, isLoginPage: isLoginPage,
    normBase: normBase, normTarget: normTarget, siteExplorerUrl: siteExplorerUrl };
  root.GefeiAhrefsParse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
