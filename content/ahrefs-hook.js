// content/ahrefs-hook.js — 跑在 Ahrefs 网页自己的环境里（world: MAIN），截下页面自己请求回来的 JSON
//
// 只在插件自己打开的标签页里干活（content/awake.js 看到网址带 #gefei-seo-agent 才留下 window.__gefeiAgentTab）：
// 你自己逛 Ahrefs 时这里什么都不做。不另外去请求 Ahrefs——页面画图本来就要拿这些数据，这里只是抄一份，
// 通过 window.postMessage 交给同页的 content/ahrefs-bridge.js（那边认出曲线和指标，再交给插件后台）。
// 这个脚本只在你允许了「读 Ahrefs 数据」之后，由后台按你设置的 Ahrefs 地址（官方或镜像站）注册进来。
(function () {
  "use strict";
  if (!window.__gefeiAgentTab) return;
  var MAX_BODY = 3000000;
  function post(url, status, body) {
    if (!body || body.length > MAX_BODY) return;
    try { window.postMessage({ source: "gefei-seo-ahrefs", url: String(url), status: status, body: body }, location.origin); } catch (e) {}
  }
  function sameSite(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (sameSite(url)) {
          p.then(function (res) {
            if (!/json/i.test(res.headers.get("content-type") || "")) return;
            res.clone().text().then(function (body) { post(res.url || url, res.status, body); }, function () {});
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  var open = XMLHttpRequest.prototype.open;
  var sendXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__gefeiUrl = String(url || ""); } catch (e) {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (sameSite(xhr.__gefeiUrl)) {
      xhr.addEventListener("load", function () {
        try {
          if (!/json/i.test(xhr.getResponseHeader("content-type") || "")) return;
          var body = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText
            : xhr.responseType === "json" ? JSON.stringify(xhr.response) : "";
          post(xhr.responseURL || xhr.__gefeiUrl, xhr.status, body);
        } catch (e) {}
      });
    }
    return sendXhr.apply(this, arguments);
  };
})();
