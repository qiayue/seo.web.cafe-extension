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
  function extractPage(maxText, maxHtml, around) {
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
    // 还在加载：页面上有看得见的进度条 / aria-busy（GSC 这类报告是一块一块填进来的，别读到半截）
    var busy = arr(d.querySelectorAll('[role="progressbar"], [aria-busy="true"]')).some(function (e) {
      if (e.getAttribute("aria-hidden") === "true") return false;
      var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
    // around（远程任务用，0.11.1 起）：页面上某段文字（比如翻页条上的 "out of"）附近那一块的 HTML——整页 HTML 太大，
    // 前 6 万字里看不到页面底部的翻页按钮，要写翻页的选择器得看到它长什么样
    var aroundHtml = "";
    if (around) {
      var walker = d.createTreeWalker(d.body || d.documentElement, NodeFilter.SHOW_TEXT, null);
      var node, hit = null;
      while ((node = walker.nextNode())) { if (String(node.nodeValue || "").indexOf(around) >= 0) { hit = node.parentElement; break; } }
      var box = hit;
      for (var up = 0; box && box.parentElement && up < 6 && box.parentElement.outerHTML.length < 12000; up++) box = box.parentElement;
      aroundHtml = box ? String(box.outerHTML).slice(0, 12000) : "";
    }
    return {
      around: aroundHtml,
      finalUrl: String(location.href).slice(0, 2000), title: String(d.title || "").slice(0, 300), lang: (d.documentElement && d.documentElement.lang) || "",
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      canonical: String((d.querySelector('link[rel="canonical"]') || {}).href || "").slice(0, 500),
      robots: meta('meta[name="robots"]'),
      headings: headings, text: text.slice(0, maxText), textChars: text.length,
      links: links, tables: tables, html: html.slice(0, maxHtml), htmlChars: html.length,
      login: !!d.querySelector("input[type=password]"),
      challenge: /just a moment|checking your browser|verify you are human|attention required|请完成安全验证|人机验证|安全检查/i.test(head),
      canvas: canvasArea > vp * 0.3 && text.length < 1500, // 在线表格 / 设计稿：内容画在 canvas 上，文字读不出来
      busy: busy,
    };
  }

  // ---------- 页面上的动作（0.13.0 起）：只有一种，在 GSC 网址检查页上点「请求编入索引」 ----------
  // 插件平时只读网页、绝不替你点东西。这一个是哥飞 2026-11-03 要的「帮用户强制提交网址检查，请求收录新网址」：
  // 只认 search.google.com/search-console/inspect 这一种页面、只点那一个按钮，别的网址、别的按钮一律不碰（两边都把关）。
  var GSC_INSPECT_RE = /^https:\/\/search\.google\.com\/search-console\/inspect\?/;
  var ACTIONS = { gsc_request_indexing: GSC_INSPECT_RE };
  /** 这个网址能不能做这个动作：动作要认识，网址要对得上 */
  function actionAllowed(action, url) {
    var k = String(action || "");
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, k)) return false;
    return ACTIONS[k].test(String(url || ""));
  }

  /** 在网页里执行：step=click 找到「请求编入索引」按钮点一下；step=check 看结果出来没有。只能用自己里面的东西 */
  function gscIndexAction(step) {
    var d = document;
    var txt = function (e) { return String((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim(); };
    var body = txt(d.body);
    var DONE = /(Indexing requested|URL was added to a priority crawl queue|已请求编入索引|网址已添加到优先抓取队列|已要求建立索引|已將網址加入優先檢索佇列)/i;
    var QUOTA = /(Quota exceeded|exceeded (your|the) (daily )?quota|超出配额|已超出配額|超過配額)/i;
    var FAIL = /(Something went wrong|An error occurred|出了点问题|发生错误|發生錯誤)/i;
    var TESTING = /(Testing if live URL can be indexed|正在测试实际网址|正在測試即時網址)/i;
    var around = function (re) { var m = body.match(re); if (!m) return ""; var i = body.indexOf(m[0]); return body.slice(Math.max(0, i - 80), i + 220); };
    if (step === "check") {
      if (DONE.test(body)) return { state: "requested", text: around(DONE) };
      if (QUOTA.test(body)) return { state: "quota", text: around(QUOTA) };
      if (FAIL.test(body)) return { state: "failed", text: around(FAIL) };
      return { state: TESTING.test(body) ? "testing" : "waiting" };
    }
    var cands = Array.prototype.slice.call(d.querySelectorAll('[role="button"], button')).filter(function (b) {
      var t = txt(b);
      if (!t || t.length > 40) return false;
      if (!/^(request indexing|请求编入索引|要求建立索引|請求建立索引)$/i.test(t)) return false;
      var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
    if (!cands.length) return { state: "nobutton", text: body.slice(0, 600) };
    var b = cands[0];
    if (b.getAttribute("aria-disabled") === "true" || b.disabled) return { state: "disabled", text: body.slice(0, 600) };
    b.click();
    return { state: "clicked" };
  }

  var api = { MAX_TEXT: MAX_TEXT, MAX_HTML: MAX_HTML, normPageUrl: normPageUrl, extractPage: extractPage, actionAllowed: actionAllowed, gscIndexAction: gscIndexAction };
  root.GefeiPageRead = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
