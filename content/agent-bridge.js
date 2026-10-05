// content/agent-bridge.js — new.web.cafe 页面里的内容脚本：把「连接插件」发的令牌交给插件后台（远程任务，0.11.0 起）
//
// 后台 /manage/ext-agent 点「连接插件」：服务器发一个令牌，页面 postMessage 给这里，这里交给插件后台存起来，
// 之后插件每分钟去 new.web.cafe 领一张任务。在 <html> 上盖个章（data-gefei-seo-agent=版本），页面据此知道插件在。
(function () {
  "use strict";
  var VERSION = chrome.runtime.getManifest().version;
  try { document.documentElement.setAttribute("data-gefei-seo-agent", VERSION); } catch (e) {}
  function post(msg) { msg.source = "gefei-seo-ext"; window.postMessage(msg, location.origin); }
  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.source !== "gefei-seo-page" || d.type !== "agent:pair") return;
    try {
      chrome.runtime.sendMessage({ type: "agent:pair", token: String(d.token || "") }, function (res) {
        if (chrome.runtime.lastError) { post({ type: "agent:paired", ok: false, error: "插件没接住：" + (chrome.runtime.lastError.message || "") }); return; }
        post({ type: "agent:paired", ok: !!(res && res.ok), error: (res && res.error) || "" });
      });
    } catch (err) { post({ type: "agent:paired", ok: false, error: "插件刚更新过，刷新一下这个页面再点" }); }
  });
})();
