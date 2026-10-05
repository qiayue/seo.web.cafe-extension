// content/capture-hook.js — 跑在网页自己的环境里（world: MAIN），截下页面自己请求回来的同站数据（远程任务 capture，0.11.0 起）
//
// 只注册在你在侧边栏「设置」里填的、并且点过「允许」的网站上（现在是 Similarweb：官方或镜像站）。
// 不另外去请求那个网站——页面画表格本来就要拿这些数据，这里只是抄一份。抄下来的先攒在页面里，
// 等同页的 content/capture-bridge.js 问过后台「这是不是插件为远程任务开的标签页」：是才交出去，不是（你自己在逛）就全部扔掉、不再抄。
(function () {
  "use strict";
  var MAX_BODY = 6000000, MAX_BUFFER = 300;
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
  // 页面发请求时带的请求头（0.11.1 起，摸接口用：有的网站 / 镜像站要页面自己加的头才肯回数据）。Cookie 不记；Authorization 这类只记有没有
  var SECRET = /^(cookie|authorization|x-csrf-token|x-xsrf-token)$/i;
  function headerObj(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach(function (v, k) { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(function (kv) { out[kv[0]] = kv[1]; });
      else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    } catch (e) {}
    Object.keys(out).forEach(function (k) { out[k] = SECRET.test(k) ? "(有，值不记)" : String(out[k]).slice(0, 300); });
    return out;
  }
  function record(url, status, ct, body, meta) {
    if (state === false) return;
    var d = { source: "gefei-seo-capture", url: String(url).slice(0, 2000), status: status, ct: String(ct || "").slice(0, 100), size: body ? body.length : 0,
      via: meta && meta.via, method: meta && meta.method, reqHeaders: meta && meta.headers };
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
          var init = arguments[1] || {};
          var meta = { via: "fetch", method: String(init.method || (input && input.method) || "GET").toUpperCase(),
            headers: headerObj(init.headers || (input && typeof input === "object" && input.headers)) };
          p.then(function (res) {
            var ct = res.headers.get("content-type") || "";
            if (!/json/i.test(ct)) { record(res.url || url, res.status, ct, "", meta); return; }
            res.clone().text().then(function (body) { record(res.url || url, res.status, ct, body, meta); }, function () {});
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }
  var open = XMLHttpRequest.prototype.open, sendXhr = XMLHttpRequest.prototype.send, setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__gefeiCapUrl = String(url || ""); this.__gefeiCapMethod = String(method || "GET").toUpperCase(); this.__gefeiCapHeaders = {}; } catch (e) {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__gefeiCapHeaders) this.__gefeiCapHeaders[k] = v; } catch (e) {}
    return setHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (state !== false && sameSite(xhr.__gefeiCapUrl)) {
      xhr.addEventListener("load", function () {
        try {
          var ct = xhr.getResponseHeader("content-type") || "";
          var body = !/json/i.test(ct) ? "" : xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText
            : xhr.responseType === "json" ? JSON.stringify(xhr.response) : "";
          record(xhr.responseURL || xhr.__gefeiCapUrl, xhr.status, ct, body, { via: "xhr", method: xhr.__gefeiCapMethod, headers: headerObj(xhr.__gefeiCapHeaders) });
        } catch (e) {}
      });
    }
    return sendXhr.apply(this, arguments);
  };
})();
