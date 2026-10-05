// content/capture-hook.js — 跑在网页自己的环境里（world: MAIN），截下页面自己请求回来的同站数据（远程任务 capture，0.11.0 起）
//
// 只注册在你在侧边栏「设置」里填的、并且点过「允许」的网站上（现在是 Similarweb：官方或镜像站）。
// 不另外去请求那个网站——页面画表格本来就要拿这些数据，这里只是抄一份。抄下来的先攒在页面里，
// 等同页的 content/capture-bridge.js 问过后台「这是不是插件为远程任务开的标签页」：是才交出去，不是（你自己在逛）就全部扔掉、不再抄。
(function () {
  "use strict";
  var MAX_BODY = 3000000, MAX_BUFFER = 300;
  var state = null, buffer = []; // state：null 还没回话 / true 交出去 / false 不是任务标签页
  function emit(d) {
    if (state === false) return;
    if (state === null) { if (buffer.length < MAX_BUFFER) buffer.push(d); return; }
    try { window.postMessage(d, location.origin); } catch (e) {}
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "gefei-seo-capture-ctl") return;
    state = !!e.data.on;
    var q = buffer; buffer = [];
    if (state) q.forEach(function (d) { try { window.postMessage(d, location.origin); } catch (err) {} });
  });
  function sameSite(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }
  function record(url, status, ct, body) {
    if (state === false) return;
    var d = { source: "gefei-seo-capture", url: String(url).slice(0, 2000), status: status, ct: String(ct || "").slice(0, 100), size: body ? body.length : 0 };
    if (body && /json/i.test(ct || "") && body.length <= MAX_BODY) d.body = body;
    emit(d);
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (state !== false && sameSite(url)) {
          p.then(function (res) {
            var ct = res.headers.get("content-type") || "";
            if (!/json/i.test(ct)) { record(res.url || url, res.status, ct, ""); return; }
            res.clone().text().then(function (body) { record(res.url || url, res.status, ct, body); }, function () {});
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }
  var open = XMLHttpRequest.prototype.open, sendXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__gefeiCapUrl = String(url || ""); } catch (e) {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (state !== false && sameSite(xhr.__gefeiCapUrl)) {
      xhr.addEventListener("load", function () {
        try {
          var ct = xhr.getResponseHeader("content-type") || "";
          var body = !/json/i.test(ct) ? "" : xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText
            : xhr.responseType === "json" ? JSON.stringify(xhr.response) : "";
          record(xhr.responseURL || xhr.__gefeiCapUrl, xhr.status, ct, body);
        } catch (e) {}
      });
    }
    return sendXhr.apply(this, arguments);
  };
})();
