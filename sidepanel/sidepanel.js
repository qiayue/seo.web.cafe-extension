// sidepanel/sidepanel.js — 侧边栏：一键把当前网站 / 一个新词交给 seo.web.cafe 上的哥飞 SEO Agent
//
// 不在插件里另做一个 Agent：点按钮就是打开对话页并带上问题（/chat/?q=…，对话页会自动发出去），
// 回答、扣积分、存对话都在网站上，和平时一样。
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
  $("askWord").addEventListener("click", function () {
    var w = $("word").value.replace(/\s+/g, " ").trim();
    if (!w) { $("word").focus(); return; }
    openChat("「" + w + "」是不是新词？它是什么时候开始有热度的、现在还在涨吗？值不值得做？");
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
