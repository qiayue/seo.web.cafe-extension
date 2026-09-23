// content/trends-hook.js — 跑在谷歌趋势网页自己的环境里（world: MAIN），截下页面自己请求回来的数据
//
// 不另外去请求谷歌：网页画图本来就要调那两个内部接口，这里只是在它拿到响应时抄一份，
// 通过 window.postMessage 交给同页的 trends-bridge.js（那边才能跟插件后台说话）。
// 只看 /trends/api/widgetdata/ 下的两个接口，别的请求一概不碰。
// 让插件开的标签页在后台也照常加载的那一段在 content/awake.js（manifest 里排在这个文件前面，Ahrefs 那边也用它）。
(function () {
  "use strict";

  var WANT = /\/trends\/api\/widgetdata\/(multiline|relatedsearches)/;
  function kindOf(url) { var m = String(url || "").match(WANT); return m ? m[1] : null; }
  function send(kind, url, status, body) {
    try { window.postMessage({ source: "gefei-seo-trends", kind: kind, url: String(url), status: status, body: body }, location.origin); } catch (e) {}
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var kind = kindOf(url);
        if (kind) {
          p.then(function (res) {
            res.clone().text().then(function (body) { send(kind, res.url || url, res.status, body); }, function () {});
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
    var kind = kindOf(xhr.__gefeiUrl);
    if (kind) {
      xhr.addEventListener("load", function () {
        try {
          var body = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText
            : xhr.responseType === "json" ? JSON.stringify(xhr.response) : "";
          send(kind, xhr.responseURL || xhr.__gefeiUrl, xhr.status, body);
        } catch (e) {}
      });
    }
    return sendXhr.apply(this, arguments);
  };
})();
