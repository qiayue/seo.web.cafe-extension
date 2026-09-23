// allow/allow.js — 「允许读 Ahrefs 数据」页面
//
// Agent 要读 Ahrefs、插件却还没有这个 Ahrefs 地址的站点权限时，后台在对话页旁边打开这个页面等你点（最多 2 分钟）。
// Chrome 的权限弹窗只能由用户在插件自己的页面里点出来，所以要这一页：点「允许」→ Chrome 问一次 → 允许了就告诉后台，
// 后台关掉这一页、回到对话页，接着去 Ahrefs 读；点「不允许」或关掉这一页，这次就不读，对话里的 Agent 会停下来说明。
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var origin = String(q.get("origin") || ""), target = String(q.get("target") || "");
  var ok = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(origin);
  var host = origin.replace(/^https:\/\//, "");
  $("target").textContent = target || "这个站";
  $("host").textContent = host || "未设置";
  $("allow").textContent = "允许读 " + host + " 的数据";
  function show(text, cls) { var e = $("status"); e.hidden = false; e.textContent = text; e.className = "status" + (cls ? " " + cls : ""); }
  if (!ok) { $("allow").disabled = true; show("Ahrefs 地址不对，打开插件侧边栏「设置」检查一下。", "err"); }
  $("allow").addEventListener("click", function () {
    chrome.permissions.request({ origins: [origin + "/*"] }).then(function (granted) {
      if (granted) { show("已允许，正在回到对话页接着读…", "ok"); chrome.runtime.sendMessage({ type: "ahrefs:allowed" }).catch(function () {}); }
      else show("Chrome 那边没有允许。可以再点一次；不想让插件读，就点「不允许」。", "err");
    }, function (e) { show("没能请求权限：" + ((e && e.message) || e), "err"); });
  });
  $("deny").addEventListener("click", function () {
    show("好的，这次不读 Ahrefs。", "");
    chrome.runtime.sendMessage({ type: "ahrefs:denied" }).catch(function () {});
  });
})();
