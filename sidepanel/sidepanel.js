// sidepanel/sidepanel.js — 侧边栏：一键把当前网站 / 一个新词交给 seo.web.cafe 上的哥飞 SEO Agent；直接查谷歌趋势
//
// 问 Agent 不在插件里另做一个 Agent：点按钮就是打开对话页并带上问题（/chat/?q=…，对话页会自动发出去），
// 回答、扣积分、存对话都在网站上，和平时一样。
// 直接查谷歌趋势是单独调试用的：和 Agent 取数走同一条路，结果只显示在侧边栏。
(function () {
  "use strict";
  var CHAT = "https://seo.web.cafe/chat/";
  var $ = function (id) { return document.getElementById(id); };

  function openChat(q) { chrome.tabs.create({ url: CHAT + "?q=" + encodeURIComponent(q) }); }

  /** 输入框里的东西 → { url, host }；只写了域名也行 */
  function target() {
    var raw = $("pageUrl").value.trim();
    if (!raw) return null;
    try {
      var u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
      return { url: u.href, host: u.hostname.replace(/^www\./, "") };
    } catch (e) { return null; }
  }

  var ASK = {
    traffic: function (t) { return t.host + " 这个站流量怎么起来的？"; },
    keywords: function (t) { return t.host + " 靠哪些关键词吃流量？主要落地页是哪些？"; },
    page: function (t) { return "帮我看看这个页面的 SEO 能怎么改：" + t.url; },
  };

  function need() {
    var t = target();
    if (!t) { $("pageUrl").focus(); $("pageHint").textContent = "先填一个网址或域名。"; }
    return t;
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-ask]"), function (b) {
    b.addEventListener("click", function () { var t = need(); if (t) openChat(ASK[b.getAttribute("data-ask")](t)); });
  });
  $("askCustom").addEventListener("click", function () {
    var q = $("custom").value.trim();
    if (!q) { $("custom").focus(); return; }
    var t = target();
    openChat(t ? q + "\n（我正在看的网页：" + t.url + "）" : q);
  });
  function word() { return $("word").value.replace(/\s+/g, " ").trim(); }
  $("askWord").addEventListener("click", function () {
    var w = word();
    if (!w) { $("word").focus(); return; }
    openChat("「" + w + "」是不是新词？它是什么时候开始有热度的、现在还在涨吗？值不值得做？");
  });

  // ---------- 谷歌趋势：插件直接取数，显示在这里（单独调试用，不经过 Agent、不进网站缓存） ----------
  // 和对话页走同一条取数路（background.js 开标签页 → 内容脚本截数据），只是结果送回侧边栏
  var pending = null; // { id, timer }
  function newId() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  function setStatus(text, cls) {
    $("trendsOut").hidden = false;
    var el = $("trendsStatus");
    el.textContent = text;
    el.className = "status" + (cls ? " " + cls : "");
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(t, hourly) {
    var d = new Date(t * 1000);
    var day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return hourly ? day + " " + pad(d.getHours()) + ":00" : day;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function svg(tag, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function row(dl, k, v) {
    var dt = document.createElement("dt"); dt.textContent = k;
    var dd = document.createElement("dd");
    if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function list(ol, items) {
    clear(ol);
    if (!items || !items.length) { var li = document.createElement("li"); li.textContent = "（没有）"; ol.appendChild(li); return; }
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.textContent = it.q;
      var sp = document.createElement("span"); sp.textContent = it.v;
      li.appendChild(sp);
      ol.appendChild(li);
    });
  }

  var UNIT = { "now 7-d": "按小时", "today 1-m": "按天", "today 12-m": "按周", "today 5-y": "按周" };
  function render(res, date) {
    var d = res.data || {}, pts = d.points || [], dbg = res.debug || {}, hourly = date === "now 7-d";
    $("chartBox").hidden = false;
    var chart = $("chart");
    clear(chart);
    [25, 50, 75].forEach(function (y) { chart.appendChild(svg("line", { x1: 0, x2: 300, y1: y, y2: y })); });
    var n = pts.length;
    chart.appendChild(svg("polyline", { points: pts.map(function (p, i) {
      return (n > 1 ? (i / (n - 1)) * 300 : 150).toFixed(1) + "," + (100 - p.v).toFixed(1);
    }).join(" ") }));
    $("axisFrom").textContent = n ? fmt(pts[0].t, hourly) : "";
    $("axisTo").textContent = n ? fmt(pts[n - 1].t, hourly) : "";

    var dl = $("stats");
    clear(dl);
    var peak = null, first = null;
    pts.forEach(function (p) { if (!peak || p.v > peak.v) peak = p; if (!first && p.v > 0) first = p; });
    row(dl, "点数", n + " 个（" + (UNIT[date] || "") + "）");
    if (peak) row(dl, "最高点", peak.v + "（" + fmt(peak.t, hourly) + "）");
    row(dl, "第一次有热度", first ? fmt(first.t, hourly) + (pts[0].v > 0 ? "（开头就有，不是这段时间里新冒出来的）" : "") : "整段都是 0");
    if (n) row(dl, "最新一个点", pts[n - 1].v + "（" + fmt(pts[n - 1].t, hourly) + "，没过完的那个点已去掉）");
    if (dbg.ms != null) row(dl, "耗时", (dbg.ms / 1000).toFixed(1) + " 秒" + (dbg.related ? "" : "（相关查询没等到，只拿到曲线）"));
    if (dbg.url) {
      var a = document.createElement("a");
      a.href = dbg.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "打开这个谷歌趋势网页";
      row(dl, "网页", a);
    }
    list($("rising"), d.rising);
    list($("top"), d.top);
  }

  function showRaw(res) {
    $("rawBox").hidden = false;
    $("raw").textContent = JSON.stringify(res, null, 2);
  }

  function done(res) {
    if (!pending) return;
    clearTimeout(pending.timer);
    var date = pending.date;
    pending = null;
    $("trendsGo").disabled = false;
    $("trendsGo").textContent = "查询";
    showRaw(res);
    if (res.ok) {
      setStatus("取到了：" + ((res.data && res.data.keyword) || word()), "ok");
      render(res, date);
    } else {
      $("chartBox").hidden = true;
      setStatus("没取到：" + (res.error || "原因不明"), "err");
    }
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "trends:result" && pending && msg.requestId === pending.id) done(msg);
  });

  function query() {
    var w = word();
    if (!w) { $("word").focus(); return; }
    if (pending) return;
    var geo = $("geo").value.trim().toUpperCase();
    if (geo && !/^[A-Z]{2}$/.test(geo)) { setStatus("地区要写两位国家码，比如 US、GB、IN；不填就是全球。", "err"); return; }
    var id = newId(), date = $("range").value;
    pending = { id: id, date: date, timer: setTimeout(function () { done({ ok: false, error: "60 秒没等到插件后台的回音" }); }, 60000) };
    $("trendsGo").disabled = true;
    $("trendsGo").textContent = "正在取…";
    $("chartBox").hidden = true;
    $("rawBox").hidden = true;
    setStatus("正在后台打开谷歌趋势取「" + w + "」，一般几秒到十几秒……");
    chrome.windows.getCurrent().then(function (win) {
      return chrome.runtime.sendMessage({ type: "trends:fetch", requestId: id, keyword: w, geo: geo, date: date, keepTab: $("keepTab").checked, windowId: win && win.id });
    }).then(function (r) {
      if (!r || !r.ok) done({ ok: false, error: (r && r.error) || "插件后台没接住请求" });
      // 接住了：结果稍后由后台广播回来（上面的 onMessage）
    }, function (e) { done({ ok: false, error: String((e && e.message) || e) }); });
  }
  $("trendsGo").addEventListener("click", query);
  $("word").addEventListener("keydown", function (e) { if (e.key === "Enter") query(); });
  $("copyRaw").addEventListener("click", function () {
    navigator.clipboard.writeText($("raw").textContent).then(function () {
      $("copyRaw").textContent = "已复制";
      setTimeout(function () { $("copyRaw").textContent = "复制"; }, 1500);
    }, function () {});
  });

  // 当前网页：点插件图标时后台记下的（见 background.js）
  function showPage(p) {
    if (p && p.url) {
      $("pageUrl").value = p.url;
      $("pageHint").textContent = "当前网页：" + (p.title || p.url);
    }
  }
  chrome.storage.session.get("lastPage").then(function (r) { showPage(r.lastPage); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "session" && changes.lastPage) showPage(changes.lastPage.newValue);
  });

  // 版本：本地加载的插件不会自动更新，谷歌趋势的内部接口一变就会取不到数，落后了就提示去下载新版
  var mine = chrome.runtime.getManifest().version;
  $("ver").textContent = "版本 " + mine;
  function newer(a, b) {
    var x = String(a).split("."), y = String(b).split(".");
    for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; }
    return false;
  }
  fetch("https://seo.web.cafe/extension/version.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (v && v.version && newer(v.version, mine)) {
      var el = $("update");
      el.hidden = false;
      el.textContent = "有新版本 " + v.version + "（你装的是 " + mine + "）。";
      var a = document.createElement("a");
      a.href = "https://seo.web.cafe/extension/";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "去下载";
      el.appendChild(a);
    }
  }).catch(function () {});
})();
