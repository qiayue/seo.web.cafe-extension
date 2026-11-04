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
  function extractPage(maxText, maxHtml, around, waitFor) {
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
    // waitFor（演示模式，0.14.0 起）：等页面上某块出现了才算读完——站点出词要等查询结果（或报错）渲染出来
    if (waitFor) {
      var shown = false;
      try { shown = arr(d.querySelectorAll(waitFor)).some(function (e) { return e.getClientRects().length > 0 && getComputedStyle(e).display !== "none"; }); } catch (e) { shown = true; }
      if (!shown) busy = true;
    }
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

  // ---------- 演示模式（0.14.0 起）：把找词的过程放给用户看，像看电影 ----------
  // 哥飞 2026-11-03：「请只用浏览器插件打开谷歌搜索，以及用 seo.web.cafe/sitekw/ 来给大家演示所有的过程，大家逐步观看，像是看电影」。
  // 只演这两种页面：谷歌搜索结果页、哥飞的「站点出词」页。别的网址插件不演（照样能读，就是不放到前台、不加字幕）。
  var SHOW_RES = [/^https:\/\/www\.google\.[a-z.]{2,12}\/search\?/, /^https:\/\/seo\.web\.cafe\/sitekw\/(\?|$)/];
  function showAllowed(url) {
    var u = String(url || "");
    return SHOW_RES.some(function (re) { return re.test(u); });
  }
  /** 演示要等什么出来：站点出词等结果表或报错；谷歌不用等 */
  function showWaitFor(url) { return /^https:\/\/seo\.web\.cafe\/sitekw\//.test(String(url || "")) ? "#result, #err" : ""; }
  /** 把演示参数收干净：字幕、第几幕、共几幕、停留多久 */
  function normShow(raw) {
    if (!raw || typeof raw !== "object") return null;
    var str = function (v, n) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); };
    var num = function (v, lo, hi, dflt) { var x = Math.round(Number(v)); return isFinite(x) && x >= lo && x <= hi ? x : dflt; };
    return { caption: str(raw.caption, 160), title: str(raw.title, 30), step: num(raw.step, 1, 30, 1), total: num(raw.total, 1, 30, 0), holdMs: num(raw.holdMs, 3000, 20000, 8000) };
  }

  /** 在网页里执行：字幕条 + 高亮搜索结果 + 慢慢往下滚。只能用自己里面的东西 */
  function showStage(caption, title, step, total, holdMs) {
    var d = document, id = "gefei-demo-bar";
    var bar = d.getElementById(id);
    if (!bar) {
      bar = d.createElement("div"); bar.id = id;
      bar.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(880px,92vw);"
        + "background:rgba(20,16,12,.88);color:#fff;border-radius:14px;padding:14px 22px;font:500 18px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;"
        + "box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none;letter-spacing:.2px";
      (d.body || d.documentElement).appendChild(bar);
    }
    bar.textContent = "";
    var head = d.createElement("div");
    head.style.cssText = "font-size:13px;color:#f7a24b;font-weight:700;margin-bottom:4px";
    head.textContent = "哥飞 SEO Agent 演示" + (total ? " · 第 " + step + "/" + total + " 幕" : " · 第 " + step + " 幕") + (title ? " · " + title : "");
    var body = d.createElement("div"); body.textContent = caption || "";
    bar.appendChild(head); bar.appendChild(body);
    // 谷歌结果页：给每个自然结果的标题描一圈，一眼看清这一页都有谁
    var marks = Array.prototype.slice.call(d.querySelectorAll("#search a h3, #rso a h3")).slice(0, 10);
    marks.forEach(function (h, i) {
      h.style.outline = "2px solid rgba(247,101,24,.75)"; h.style.outlineOffset = "3px"; h.style.borderRadius = "4px";
      if (!h.querySelector(".gefei-demo-n")) {
        var n = d.createElement("span"); n.className = "gefei-demo-n"; n.textContent = (i + 1) + " ";
        n.style.cssText = "color:#f76518;font-weight:800;margin-right:4px"; h.insertBefore(n, h.firstChild);
      }
    });
    // 慢慢往下滚，让人看清第一页（站点出词滚到结果表）
    var target = d.getElementById("result");
    var start = window.scrollY, end = target && target.getClientRects().length ? target.getBoundingClientRect().top + window.scrollY - 80
      : Math.min(Math.max(0, (d.documentElement.scrollHeight || 0) - window.innerHeight), window.innerHeight * 2.2);
    var t0 = Date.now(), dur = Math.max(1500, holdMs - 1500);
    var tick = function () {
      var k = Math.min(1, (Date.now() - t0) / dur);
      window.scrollTo(0, start + (end - start) * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2));
      if (k < 1) setTimeout(tick, 40);
    };
    setTimeout(tick, 600);
    return { ok: true, marked: marks.length };
  }

  var api = { MAX_TEXT: MAX_TEXT, MAX_HTML: MAX_HTML, normPageUrl: normPageUrl, extractPage: extractPage, actionAllowed: actionAllowed, gscIndexAction: gscIndexAction,
    showAllowed: showAllowed, showWaitFor: showWaitFor, normShow: normShow, showStage: showStage };
  root.GefeiPageRead = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
