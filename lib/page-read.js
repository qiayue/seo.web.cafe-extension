// lib/page-read.js — 「用浏览器打开网页读回来」的两件纯逻辑：哪些网址能开、页面上读什么
//
// 网站那边的 fetch_page 抓不到的网页（跳转太多、403、要登录、要执行 JS 才有内容、人机验证），
// Agent 可以请插件在你的浏览器里打开再读：插件在后台开一个标签页，等页面渲染完，读标题、描述、标题层级、正文、
// 链接、表格和渲染后的 HTML，读完关掉。每个网站第一次要你点一次「允许」（Chrome 的站点权限）。
// 同时被后台 service worker（importScripts）和 Node 测试（require）用到；extractPage 还会被整个序列化进网页里执行。
(function (root) {
  "use strict";
  var MAX_TEXT = 20000, MAX_HTML = 60000;

  /** 能不能开：只认 http / https；本机、局域网、带账号密码的网址一律不开（Agent 被网页里的文字带偏时，别让它去摸你的路由器、内网） */
  function normPageUrl(raw) {
    var s = String(raw || "").trim();
    if (!s || s.length > 2000) return "";
    var u;
    try { u = new URL(s); } catch (e) { return ""; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (u.username || u.password) return "";
    var h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!h || h === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(h) || !/\./.test(h)) return "";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      var p = h.split(".").map(Number);
      if (p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)) return "";
    }
    if (h.indexOf(":") >= 0) return ""; // IPv6 字面量：一律不开
    return u.href; // # 后面的留着：单页应用靠它分页面
  }

  /** 在网页里执行（chrome.scripting.executeScript 的 func）：读渲染后的页面。只能用自己里面的东西，不能引用外面的变量 */
  function extractPage(maxText, maxHtml) {
    var d = document;
    var clean = function (s) { return String(s || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); };
    var meta = function (sel) { var e = d.querySelector(sel); return e ? String(e.getAttribute("content") || "").slice(0, 500) : ""; };
    var main = d.querySelector("main, article, [role=main]") || d.body;
    var text = clean(main ? main.innerText : "");
    if (main !== d.body && text.length < 200 && d.body) text = clean(d.body.innerText);
    var arr = function (list) { return Array.prototype.slice.call(list); };
    var headings = arr(d.querySelectorAll("h1,h2,h3")).slice(0, 80).map(function (h) { return h.tagName.toLowerCase() + " " + clean(h.innerText).slice(0, 200); })
      .filter(function (x) { return x.length > 3; });
    var links = arr(d.querySelectorAll("a[href]")).slice(0, 600).map(function (a) { return { text: clean(a.innerText).slice(0, 120), href: String(a.href || "").slice(0, 500) }; })
      .filter(function (l) { return /^https?:/.test(l.href) && l.text; }).slice(0, 80);
    var tables = arr(d.querySelectorAll("table")).slice(0, 5).map(function (t) {
      return arr(t.rows).slice(0, 40).map(function (r) { return arr(r.cells).slice(0, 12).map(function (c) { return clean(c.innerText).slice(0, 80); }); });
    }).filter(function (t) { return t.length; });
    var canvasArea = 0;
    arr(d.querySelectorAll("canvas")).forEach(function (c) { var r = c.getBoundingClientRect(); canvasArea += r.width * r.height; });
    var vp = Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1));
    var html = d.documentElement ? d.documentElement.outerHTML : "";
    var head = (d.title || "") + " " + text.slice(0, 600);
    return {
      finalUrl: String(location.href).slice(0, 2000), title: String(d.title || "").slice(0, 300), lang: (d.documentElement && d.documentElement.lang) || "",
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      canonical: String((d.querySelector('link[rel="canonical"]') || {}).href || "").slice(0, 500),
      robots: meta('meta[name="robots"]'),
      headings: headings, text: text.slice(0, maxText), textChars: text.length,
      links: links, tables: tables, html: html.slice(0, maxHtml), htmlChars: html.length,
      login: !!d.querySelector("input[type=password]"),
      challenge: /just a moment|checking your browser|verify you are human|attention required|请完成安全验证|人机验证|安全检查/i.test(head),
      canvas: canvasArea > vp * 0.3 && text.length < 1500, // 在线表格 / 设计稿：内容画在 canvas 上，文字读不出来
    };
  }

  var api = { MAX_TEXT: MAX_TEXT, MAX_HTML: MAX_HTML, normPageUrl: normPageUrl, extractPage: extractPage };
  root.GefeiPageRead = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
