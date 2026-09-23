// content/awake.js — 跑在网页自己的环境里（world: MAIN），排在各站的截数据脚本前面
//
// 插件自己开的取数标签页（谷歌趋势、Ahrefs）网址末尾带 #gefei-seo-agent：只对这种标签页让它在后台也照常加载，
// 并在页面上留个记号 window.__gefeiAgentTab（Ahrefs 的截数据脚本只在带记号的标签页里干活）。
// 用户自己打开的标签页没有这个记号，一概不碰。
(function () {
  "use strict";
  // ---------- 插件自己开的标签页：让它在后台也照常加载 ----------
  // 线上实测：谷歌趋势的网页在后台标签页里不去取数，一直等到用户切过去看才加载（浏览器对看不见的页面
  // 不跑动画帧、不回调可见性观察器，页面自己也会看 document.hidden）。插件开的标签页网址末尾带 #gefei-seo-agent，
  // 只对这种标签页：告诉页面「你是可见的」，动画帧 / 可见性观察器在真看不见时改用计时器顶上。
  // 用户自己打开的谷歌趋势标签页没有这个记号，一概不碰。记号读完就从网址里抹掉，页面自己看不到它。
  // 这一招不保证对谷歌以后的改版一直有效：后台那边 8 秒没等到数据，会把标签页短暂切到前台兜底（background.js）
  var MARK = "#gefei-seo-agent";
  if (location.hash === MARK) {
    try { history.replaceState(history.state, "", location.href.slice(0, -MARK.length)); } catch (e) {}
    try { keepAwake(); } catch (e) {}
    try { Object.defineProperty(window, "__gefeiAgentTab", { value: true }); } catch (e) {}
  }

  function keepAwake() {
    var D = Document.prototype;
    var realHidden = Object.getOwnPropertyDescriptor(D, "hidden").get;
    var reallyHidden = function () { try { return realHidden.call(document); } catch (e) { return false; } };
    Object.defineProperty(D, "hidden", { configurable: true, get: function () { return false; } });
    Object.defineProperty(D, "visibilityState", { configurable: true, get: function () { return "visible"; } });
    D.hasFocus = function () { return true; };
    // 切走 / 切回的通知不往下传：页面一直当自己在前台
    var swallow = function (e) { e.stopImmediatePropagation(); };
    window.addEventListener("visibilitychange", swallow, true);
    document.addEventListener("visibilitychange", swallow, true);

    // 动画帧：真看不见时浏览器根本不回调，改用计时器（后台计时器约 1 秒一次，够把页面推着走）
    var rAF = window.requestAnimationFrame, cAF = window.cancelAnimationFrame;
    var seq = 0, timers = {};
    window.requestAnimationFrame = function (cb) {
      if (!reallyHidden()) return rAF.call(window, cb);
      var id = -(++seq); // 负数编号，和浏览器自己的区分开
      timers[id] = setTimeout(function () { delete timers[id]; cb(performance.now()); }, 16);
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      if (id < 0) { clearTimeout(timers[id]); delete timers[id]; } else cAF.call(window, id);
    };

    // 可见性观察器（懒加载常用）：真看不见时浏览器不回调，就当被观察的元素已经进了视口
    var IO = window.IntersectionObserver;
    if (typeof IO === "function") {
      var Patched = function (cb, opts) {
        var io = new IO(cb, opts);
        var observe = io.observe;
        io.observe = function (el) {
          observe.call(io, el);
          if (!reallyHidden()) return;
          setTimeout(function () {
            if (!reallyHidden()) return; // 已经切到前台：交给浏览器自己回调
            var r = el.getBoundingClientRect();
            try { cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: performance.now() }], io); } catch (e) {}
          }, 50);
        };
        return io;
      };
      Patched.prototype = IO.prototype;
      window.IntersectionObserver = Patched;
    }
  }

})();
