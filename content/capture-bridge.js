// content/capture-bridge.js — 远程任务 capture 的传话人（0.11.0 起）：把 capture-hook.js 抄下来的数据交给插件后台
//
// 先问后台「这个标签页是不是你为远程任务开的」：不是（你自己在逛这个网站）就告诉 capture-hook.js 全部扔掉、不再抄；
// 是的话每一段都交上去（后台按任务里的 match 挑要哪些、记下所有请求过的接口）。看到登录页就说一声。
(function () {
  "use strict";
  var mine = null, buffered = [];
  function tell(msg) { try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) { /* 插件刚更新过：旧脚本已失效 */ } }
  function forward(d) { tell({ type: "capture:item", url: d.url, status: d.status, ct: d.ct, size: d.size, body: typeof d.body === "string" ? d.body : null,
    via: d.via, method: d.method, reqHeaders: d.reqHeaders, captureError: typeof d.captureError === "string" ? d.captureError.slice(0, 200) : undefined }); }
  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.source !== "gefei-seo-capture") return;
    if (mine === null) buffered.push(d);
    else if (mine) forward(d);
  });
  function ctl(on) { try { window.postMessage({ source: "gefei-seo-capture-ctl", on: on }, location.origin); } catch (e) {} }
  var looks = 0;
  function lookLogin() {
    var pw = !!document.querySelector("input[type=password]");
    if (pw || /(^|\/)(login|signin|sign-in|account\/login)(\/|$)/i.test(location.pathname)) { tell({ type: "capture:login" }); return; }
    if (++looks < 10) setTimeout(lookLogin, 3000);
  }
  var checkSeq = 0;
  function verify(done) {
    var seq = ++checkSeq;
    mine = null;
    try {
      chrome.runtime.sendMessage({ type: "capture:hello" }, function (r) {
        void chrome.runtime.lastError;
        if (seq !== checkSeq) { if (done) done({ ok: false }); return; }
        mine = !!(r && r.job);
        ctl(mine);
        var q = buffered; buffered = [];
        if (mine) { q.forEach(forward); looks = 0; setTimeout(lookLogin, 3000); }
        if (done) done({ ok: mine });
      });
    } catch (e) { mine = false; buffered = []; ctl(false); if (done) done({ ok: false }); }
  }
  // A node shell loaded before the job existed and was intentionally disabled.
  // Re-check the background's owned-job registry before enabling its existing hook.
  if (chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== "capture:arm" || sender.id !== chrome.runtime.id) return false;
    verify(respond); return true;
  });
  verify();
})();
