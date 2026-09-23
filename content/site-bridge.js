// content/site-bridge.js — seo.web.cafe 页面里的内容脚本：对话页与插件之间的传话人
//
// 页面与这里只用 window.postMessage 说话（source 标记分清谁发的）：
//   插件 → 页面：hello（我在，版本 x）/ trends:accepted（收到）/ trends:progress（进度）/ trends:result（取数结果）
//   页面 → 插件：ping（在吗）/ trends:fetch（请去谷歌趋势取这个词）/ trends:cancel（用户点了停止，不取了）
// 页面知道插件在，发问时才会告诉服务器「这一轮可以请插件取数」；服务器的 google_trends 工具缓存没命中时，
// 经 SSE 把取数请求发给页面，页面转到这里，这里交给插件后台去开谷歌趋势。
//
// 在 document_start 就跑，并在 <html> 上盖个章（data-gefei-seo-ext=版本）：DOM 是页面和内容脚本共用的，
// 页面可以同步读到。光靠 hello 不够——/chat/?q=… 进来（侧边栏「查一个新词」就是这么开的）会在页面加载时
// 自动发问，异步的 hello 与这一问谁先到没保证，输了那一问就不带「可以请插件取数」。
(function () {
  "use strict";
  var VERSION = chrome.runtime.getManifest().version;
  try { document.documentElement.setAttribute("data-gefei-seo-ext", VERSION); } catch (e) {}
  function post(msg) {
    msg.source = "gefei-seo-ext";
    window.postMessage(msg, location.origin);
  }
  post({ type: "hello", version: VERSION });

  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.source !== "gefei-seo-page") return;
    if (d.type === "ping") { post({ type: "hello", version: VERSION }); return; }
    if (d.type === "trends:cancel" && d.requestId) {
      try { chrome.runtime.sendMessage({ type: "trends:cancel", requestId: d.requestId }, function () { void chrome.runtime.lastError; }); } catch (err) {}
      return;
    }
    if (d.type !== "trends:fetch" || !d.requestId) return;
    var fail = function (why) { post({ type: "trends:result", requestId: d.requestId, ok: false, error: why }); };
    try {
      chrome.runtime.sendMessage({ type: "trends:fetch", requestId: d.requestId, keyword: d.keyword, geo: d.geo || "", date: d.date }, function (res) {
        if (chrome.runtime.lastError) { fail("插件没接住请求：" + chrome.runtime.lastError.message); return; }
        if (!res || !res.ok) { fail((res && res.error) || "插件没接住请求"); return; }
        // 接住了：先回一句「收到」（页面转给服务器，服务器据此知道插件在、不必干等）；
        // 结果和进度稍后由后台经 chrome.tabs.sendMessage 送回来（见下面）
        post({ type: "trends:accepted", requestId: d.requestId });
      });
    } catch (err) {
      // 插件刚被更新 / 重新加载过：这个页面里的旧脚本已经和插件断开了
      fail("插件刚更新过，请刷新这个对话页再问一次");
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.requestId) return;
    if (msg.type === "trends:progress") { post({ type: "trends:progress", requestId: msg.requestId, stage: msg.stage || "", text: msg.text || "" }); return; }
    if (msg.type !== "trends:result") return;
    // debug（耗时分段、有没有切到前台）一并带上，排查时在对话页里看得到；对话页交给服务器时不带它
    post({ type: "trends:result", requestId: msg.requestId, ok: !!msg.ok, data: msg.data || null, error: msg.error || "", debug: msg.debug || null });
  });
})();
