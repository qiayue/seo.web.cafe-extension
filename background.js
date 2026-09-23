// background.js — 插件后台（MV3 service worker）
//
// 两件事：
//   ① 谷歌趋势取数：对话页（经 content/site-bridge.js）说「去取 jev 过去 12 个月」→ 在对话页旁边开一个**后台**标签页
//      打开谷歌趋势 → 那个页面里的 content/trends-hook.js 截下它自己拿到的数据、trends-bridge.js 交回来 →
//      送回对话页、关掉标签页。取不到（要人机验证 / 被限流 / 超时）就把原因送回去，并把标签页切到前台让用户看见。
//   ② 点插件图标：记下当前网页、打开侧边栏（侧边栏里一键问 Agent「这个站流量怎么起来的」）。
//   ③ 侧边栏自己也能发起取数（单独调试用，不经过 Agent）：走同一条取数路，结果送回侧边栏显示，不进网站缓存。
//
// MV3 的 service worker 随时可能被浏览器回收：进行中的取数任务存在 chrome.storage.session 里，不放内存。
// 超时用 setTimeout，worker 被回收就丢了——对话页那边自己也有 60 秒的超时兜底，不会干等。
importScripts("lib/trends-parse.js");
var P = self.GefeiTrendsParse;

var SITE_ORIGIN = "https://seo.web.cafe";
var JOB_TIMEOUT_MS = 45000;     // 页面那边 60 秒放弃，这里先放弃、把原因说清楚
var RELATED_GRACE_MS = 2500;    // 曲线到了之后再等一会儿相关查询；等不到就只交曲线

// ---------- 任务表（storage.session），所有改动串行，免得曲线和相关查询同时到时互相覆盖 ----------
var queue = Promise.resolve();
function serial(fn) {
  var p = queue.then(fn, fn);
  queue = p.catch(function () {});
  return p;
}
function loadJobs() { return chrome.storage.session.get("jobs").then(function (r) { return r.jobs || {}; }); }
function saveJobs(jobs) { return chrome.storage.session.set({ jobs: jobs }); }

/** from：{ tab }（seo.web.cafe 对话页，结果送回那个标签页）或 { panel, tab?, windowId? }（插件侧边栏，结果广播给插件页面） */
function startJob(msg, from) {
  return serial(function () {
    if (!/^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) throw new Error("取数单号不对");
    var url = P.buildTrendsUrl({ keyword: msg.keyword, geo: msg.geo, date: msg.date });
    var opts = { url: url, active: false };
    if (from.tab) { opts.windowId = from.tab.windowId; opts.index = from.tab.index + 1; }
    else if (Number.isInteger(msg.windowId)) opts.windowId = msg.windowId;
    return chrome.tabs.create(opts).then(function (tab) {
      return loadJobs().then(function (jobs) {
        jobs[tab.id] = {
          requestId: msg.requestId, url: url,
          originTabId: from.panel ? null : from.tab.id, toPanel: !!from.panel,
          keepTab: !!(from.panel && msg.keepTab), // 调试用：取完不关，方便对照网页核对
          keyword: String(msg.keyword || "").replace(/\s+/g, " ").trim().toLowerCase(),
          startedAt: Date.now(), points: null, top: null, rising: null,
        };
        return saveJobs(jobs);
      }).then(function () {
        setTimeout(function () {
          finish(tab.id, { ok: false, error: (JOB_TIMEOUT_MS / 1000) + " 秒内没取到数据（谷歌趋势页面可能没加载完，或要求人机验证）——已把那个标签页切到前台，看一眼就知道" }, true);
        }, JOB_TIMEOUT_MS);
      });
    });
  });
}

/** 结束一个任务：结果送回对话页。成功就关掉谷歌趋势标签页；失败就把它切到前台让用户看见（多半是要人机验证） */
function finish(tabId, result, reveal) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job) return;
      delete jobs[tabId];
      return saveJobs(jobs).then(function () {
        var msg = { type: "trends:result", requestId: job.requestId, ok: !!result.ok, data: result.data || null, error: result.error || "",
          // 给侧边栏调试看的：打开的网址、耗时、相关查询到没到（对话页那边用不上，传过去也不碍事）
          debug: { url: job.url, ms: Date.now() - job.startedAt, related: job.rising !== null } };
        if (job.toPanel) chrome.runtime.sendMessage(msg).catch(function () {}); // 侧边栏关了就没人收，无所谓
        else chrome.tabs.sendMessage(job.originTabId, msg).catch(function () {});
        if (result.ok && job.keepTab) chrome.tabs.update(tabId, { active: true }).catch(function () {});
        else if (result.ok) chrome.tabs.remove(tabId).catch(function () {});
        else if (reveal) chrome.tabs.update(tabId, { active: true }).catch(function () {});
      });
    });
  });
}

function okResult(job) {
  return { ok: true, data: { keyword: job.keyword, points: job.points, top: job.top || [], rising: job.rising || [] } };
}

function onCaptured(tabId, msg) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job) return null; // 不是插件开的标签页（用户自己在逛谷歌趋势）：什么都不做
      if (msg.kind === "error") return { done: { ok: false, error: msg.error }, reveal: true };
      if (msg.keyword && job.keyword && msg.keyword !== job.keyword) return null; // 页面上换了别的词，不收
      if (msg.kind === "timeline" && !job.points && Array.isArray(msg.points) && msg.points.length) {
        job.points = msg.points;
        return saveJobs(jobs).then(function () { return job.rising ? { done: okResult(job) } : { grace: true }; });
      }
      if (msg.kind === "related" && !job.rising) {
        job.top = msg.top || [];
        job.rising = msg.rising || [];
        return saveJobs(jobs).then(function () { return job.points ? { done: okResult(job) } : null; });
      }
      return null;
    });
  }).then(function (next) {
    if (!next) return;
    if (next.done) return finish(tabId, next.done, next.reveal);
    if (next.grace) {
      setTimeout(function () {
        loadJobs().then(function (jobs) { var j = jobs[tabId]; if (j && j.points) finish(tabId, okResult(j)); });
      }, RELATED_GRACE_MS);
    }
  });
}

var PANEL_URL = chrome.runtime.getURL("sidepanel/");

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !sender) return false;
  if (msg.type === "trends:fetch") {
    // 只接两处发来的取数请求：插件自己的侧边栏；seo.web.cafe 页面（经 content/site-bridge.js）。
    // 内容脚本的 sender.id 也是本插件，所以侧边栏按页面网址认，不按 id 认
    var fromPanel = sender.id === chrome.runtime.id && String(sender.url || "").indexOf(PANEL_URL) === 0;
    var fromSite = !fromPanel && !!sender.tab && sender.origin === SITE_ORIGIN;
    if (!fromPanel && !fromSite) { sendResponse({ ok: false, error: "只接受 seo.web.cafe 或插件侧边栏发起的取数" }); return false; }
    startJob(msg, fromPanel ? { panel: true, tab: sender.tab || null } : { tab: sender.tab })
      .then(function () { sendResponse({ ok: true }); }, function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true; // 异步回话
  }
  if (msg.type === "trends:captured" && sender.tab) { onCaptured(sender.tab.id, msg); return false; }
  return false;
});

// 取数的标签页被关掉了 / 被跳到了别处（manifest 只给了 trends.google.com 的站点权限：
// 谷歌的人机验证页 www.google.com/sorry 不在其中，tab.url 会是空的）
chrome.tabs.onRemoved.addListener(function (tabId) {
  loadJobs().then(function (jobs) { if (jobs[tabId]) finish(tabId, { ok: false, error: "取数的谷歌趋势标签页被关掉了" }); });
});
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== "complete") return;
  loadJobs().then(function (jobs) {
    if (!jobs[tabId]) return;
    if (!tab.url || tab.url.indexOf("https://trends.google.com/") !== 0) {
      finish(tabId, { ok: false, error: "谷歌把页面跳走了（多半是要人机验证）——已把那个标签页切到前台，验证完回对话页再问一次" }, true);
    }
  });
});

// ---------- 点插件图标：记下当前网页，打开侧边栏 ----------
// 不用 openPanelOnActionClick：自己处理点击，点击这一下会授予 activeTab，才读得到当前网页的网址；
// 这样不用申请「读取所有网页的浏览记录」那种大权限
chrome.action.onClicked.addListener(function (tab) {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(function () {});
  var url = /^https?:\/\//.test(tab.url || "") ? tab.url : "";
  chrome.storage.session.set({ lastPage: { url: url, title: tab.title || "", at: Date.now() } });
});
