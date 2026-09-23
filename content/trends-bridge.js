// content/trends-bridge.js — 谷歌趋势网页里的内容脚本：把 trends-hook.js 截下的数据解析好，交给插件后台
//
// 只有插件自己打开的那个标签页的数据会被用上（后台按标签页对号入座）；用户自己逛谷歌趋势时这里也会跑，
// 但后台找不到对应的取数任务就直接丢掉，什么都不存、不发。
(function () {
  "use strict";
  var P = self.GefeiTrendsParse;
  function tell(msg) { try { chrome.runtime.sendMessage(msg); } catch (e) { /* 插件刚更新过：旧脚本已失效，忽略 */ } }

  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.source !== "gefei-seo-trends") return;
    try {
      if (d.status && d.status !== 200) {
        tell({ type: "trends:captured", kind: "error", error: "谷歌趋势接口返回 " + d.status + (d.status === 429 ? "（请求太频繁被限流了，过一会儿再试）" : "") });
        return;
      }
      var req = P.parseReq(d.url);
      if (d.kind === "multiline") {
        tell({ type: "trends:captured", kind: "timeline", keyword: req.keyword, points: P.parseTimeline(d.body).points });
      } else if (d.kind === "relatedsearches" && req.keywordType !== "ENTITY") {
        var r = P.parseRelated(d.body);
        tell({ type: "trends:captured", kind: "related", keyword: req.keyword, top: r.top, rising: r.rising });
      }
    } catch (err) {
      tell({ type: "trends:captured", kind: "error", error: "没看懂谷歌趋势返回的数据（" + ((err && err.message) || err) + "），可能是谷歌改了格式，请更新插件" });
    }
  });
})();
