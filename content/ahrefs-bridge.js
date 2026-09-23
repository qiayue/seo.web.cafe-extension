// content/ahrefs-bridge.js — Ahrefs 网页里的内容脚本：把 ahrefs-hook.js 截下的 JSON 认成曲线 / 指标，连同页面文字交给插件后台
//
// 先问后台「这个标签页是不是你开的取数标签页」：不是（你自己在逛 Ahrefs）就什么都不做、什么都不发。
// 是的话：每段 JSON 认出曲线和指标就交上去；页面文字（DR、外链数这些卡片）每 3 秒看一次，变了就交；
// 看到登录页（没登录、登录过期）就说一声，后台把标签页切到前台让你登录。
(function () {
  "use strict";
  var A = self.GefeiAhrefsParse;
  var mine = null, buffered = [];
  function tell(msg) { try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) { /* 插件刚更新过：旧脚本已失效 */ } }

  function onJson(d) {
    try {
      if (d.status && d.status !== 200) return;
      var x = A.extract(A.parseBody(d.body));
      if (!x.series.length && !Object.keys(x.metrics).length) return;
      var path = "";
      try { path = new URL(d.url, location.href).pathname.slice(0, 120); } catch (e) {}
      tell({ type: "ahrefs:captured", kind: "json", path: path, series: x.series, metrics: x.metrics });
    } catch (e) { /* 不是 JSON / 认不出来：跳过 */ }
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.source !== "gefei-seo-ahrefs") return;
    if (mine === null) buffered.push(d); // 后台还没回话：先攒着
    else if (mine) onJson(d);
  });

  var lastText = "", looks = 0;
  function look() {
    if (A.isLoginPage(document, location)) { tell({ type: "ahrefs:captured", kind: "login" }); return; }
    var t = A.pageText(document);
    if (t && t !== lastText) { lastText = t; tell({ type: "ahrefs:captured", kind: "page", text: t, title: String(document.title || "").slice(0, 200) }); }
    if (++looks < 15) setTimeout(look, 3000);
  }

  try {
    chrome.runtime.sendMessage({ type: "ahrefs:hello" }, function (r) {
      void chrome.runtime.lastError;
      mine = !!(r && r.job);
      var q = buffered; buffered = [];
      if (!mine) return;
      q.forEach(onJson);
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(look, 1500); });
      else setTimeout(look, 1500);
    });
  } catch (e) { mine = false; }
})();
