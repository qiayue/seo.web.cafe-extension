// background.js — 插件后台（MV3 service worker）
//
// 两件事：
//   ① 谷歌趋势取数：对话页（经 content/site-bridge.js）说「去取 jev 过去 12 个月」→ 在对话页旁边开一个**后台**标签页
//      打开谷歌趋势 → 那个页面里的 content/trends-hook.js 截下它自己拿到的数据、trends-bridge.js 交回来 →
//      送回对话页、关掉标签页。取不到（要人机验证 / 被限流 / 超时）就把原因送回去，并把标签页切到前台让用户看见。
//      谷歌趋势的网页在后台标签页里会一直不取数（线上实测：切过去看才加载）：网址带上记号让 trends-hook.js 把它
//      「叫醒」；8 秒还没数据就把标签页短暂切到前台，取到后切回原来那个标签页。
//   ② 点插件图标：记下当前网页、打开侧边栏（侧边栏里一键问 Agent「这个站流量怎么起来的」）。
//   ③ 侧边栏自己也能发起取数（单独调试用，不经过 Agent）：走同一条取数路，结果送回侧边栏显示，不进网站缓存。
//
// 看得见在干活：每个取数任务一接单就回「收到」（对话页转给服务器——服务器 20 秒没等到「收到」就不再干等），
// 之后每一步（打开谷歌趋势 / 页面加载完 / 切到前台 / 曲线到了）都报一句进度；同时记进任务日志
// （storage.session.activity，侧边栏「插件正在做的事」照着显示），工具栏图标上的数字是正在跑的任务数。
// 用户在对话页点了停止：对话页发 trends:cancel，这里关掉那个标签页、结束任务。
//
// MV3 的 service worker 随时可能被浏览器回收：进行中的取数任务存在 chrome.storage.session 里，不放内存。
// 超时用 setTimeout，worker 被回收就丢了——对话页那边自己也有 60 秒的超时兜底，不会干等。
importScripts("lib/trends-parse.js");
var P = self.GefeiTrendsParse;

var SITE_ORIGIN = "https://seo.web.cafe";
var JOB_TIMEOUT_MS = 45000;     // 页面那边 60 秒放弃，这里先放弃、把原因说清楚
var RELATED_GRACE_MS = 2500;    // 曲线到了之后再等一会儿相关查询；等不到就只交曲线
var FOREGROUND_AFTER_MS = 8000; // 后台这么久还没等到曲线，就把标签页切到前台让它加载
var AWAKE_MARK = "#gefei-seo-agent"; // 只有带这个记号的标签页，trends-hook.js 才会让它在后台也照常加载

// ---------- 任务表（storage.session），所有改动串行，免得曲线和相关查询同时到时互相覆盖 ----------
var queue = Promise.resolve();
function serial(fn) {
  var p = queue.then(fn, fn);
  queue = p.catch(function () {});
  return p;
}
function loadJobs() { return chrome.storage.session.get("jobs").then(function (r) { return r.jobs || {}; }); }
function saveJobs(jobs) { return chrome.storage.session.set({ jobs: jobs }); }

// ---------- 任务日志 + 图标数字：侧边栏「插件正在做的事」照着它显示 ----------
var ACTIVITY_MAX = 20;
var RANGE_LABEL = { "now 7-d": "过去 7 天", "today 1-m": "过去 30 天", "today 3-m": "过去 90 天", "today 12-m": "过去 12 个月", "today 5-y": "过去 5 年" };
function logActivity(requestId, patch) {
  return serial(function () {
    return chrome.storage.session.get("activity").then(function (r) {
      var list = r.activity || [];
      var i = list.findIndex(function (a) { return a.id === requestId; });
      if (i < 0) { list.unshift(Object.assign({ id: requestId, startedAt: Date.now() }, patch)); }
      else list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() });
      list = list.slice(0, ACTIVITY_MAX);
      var running = list.filter(function (a) { return !a.endedAt; }).length;
      chrome.action.setBadgeText({ text: running ? String(running) : "" }).catch(function () {});
      return chrome.storage.session.set({ activity: list });
    });
  });
}
chrome.action.setBadgeBackgroundColor({ color: "#c9831f" }).catch(function () {});
// 后台被浏览器回收过：还挂着「进行中」的老任务其实已经没人管了（计时器随 worker 一起没了），如实收尾
serial(function () {
  return chrome.storage.session.get(["activity", "jobs"]).then(function (r) {
    var jobs = r.jobs || {}, live = {};
    Object.keys(jobs).forEach(function (k) { live[jobs[k].requestId] = true; });
    var list = (r.activity || []).map(function (a) {
      return a.endedAt || live[a.id] ? a : Object.assign({}, a, { endedAt: Date.now(), ok: false, error: "插件后台重启过，这个任务没做完" });
    });
    var running = list.filter(function (a) { return !a.endedAt; }).length;
    chrome.action.setBadgeText({ text: running ? String(running) : "" }).catch(function () {});
    return chrome.storage.session.set({ activity: list });
  });
});

/** 报一步进度：发给发起方（对话页标签页 / 侧边栏），并记进任务日志 */
function notify(job, stage, text) {
  var m = { type: "trends:progress", requestId: job.requestId, stage: stage, text: text };
  if (job.toPanel) chrome.runtime.sendMessage(m).catch(function () {});
  else if (job.originTabId != null) chrome.tabs.sendMessage(job.originTabId, m).catch(function () {});
  logActivity(job.requestId, { stage: stage, text: text });
}

/** from：{ tab }（seo.web.cafe 对话页，结果送回那个标签页）或 { panel, tab?, windowId? }（插件侧边栏，结果广播给插件页面） */
function startJob(msg, from) {
  return serial(function () {
    if (!/^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) throw new Error("取数单号不对");
    var url = P.buildTrendsUrl({ keyword: msg.keyword, geo: msg.geo, date: msg.date });
    return loadJobs().then(function (jobs) {
      // 同一张单已经在取了（对话页刷新后，服务器把还没确认接单的单子又交给了新页面）：不再开第二个标签页
      var dup = Object.keys(jobs).some(function (k) { return jobs[k].requestId === msg.requestId; });
      return dup ? null : openJob(msg, from, url);
    });
  });
}

/** 开谷歌趋势标签页、记进任务表（在 startJob 的串行队列里调用） */
function openJob(msg, from, url) {
    var winId = from.tab ? from.tab.windowId : (Number.isInteger(msg.windowId) ? msg.windowId : undefined);
    var opts = { url: url + AWAKE_MARK, active: !!(from.panel && msg.foreground) }; // 侧边栏可选「前台打开」，排查慢的时候对照用
    if (winId !== undefined) opts.windowId = winId;
    if (from.tab) opts.index = from.tab.index + 1;
    // 取完要切回哪个标签页：对话页发起的切回对话页；侧边栏发起的切回发起时正看着的那个
    var back = from.tab && !from.panel ? Promise.resolve(from.tab.id)
      : chrome.tabs.query(winId !== undefined ? { active: true, windowId: winId } : { active: true, lastFocusedWindow: true })
        .then(function (t) { return t && t[0] ? t[0].id : null; }, function () { return null; });
    return back.then(function (returnTabId) {
      return chrome.tabs.create(opts).then(function (tab) {
        return loadJobs().then(function (jobs) {
          jobs[tab.id] = {
            requestId: msg.requestId, url: url, returnTabId: returnTabId,
            originTabId: from.panel ? null : from.tab.id, toPanel: !!from.panel,
            keepTab: !!(from.panel && msg.keepTab), // 调试用：取完不关，方便对照网页核对
            keyword: String(msg.keyword || "").replace(/\s+/g, " ").trim().toLowerCase(),
            startedAt: Date.now(), points: null, top: null, rising: null,
            loadedAt: null, timelineAt: null, relatedAt: null, foregroundAt: opts.active ? Date.now() : null,
          };
          return saveJobs(jobs);
        }).then(function () {
          logActivity(msg.requestId, { keyword: String(msg.keyword || "").trim(), range: RANGE_LABEL[msg.date] || "", geo: msg.geo || "",
            from: from.panel ? "侧边栏" : "对话页", stage: "opened", text: "已打开谷歌趋势，等页面加载…" });
          setTimeout(function () { toForeground(tab.id); }, FOREGROUND_AFTER_MS);
          setTimeout(function () {
            finish(tab.id, { ok: false, error: (JOB_TIMEOUT_MS / 1000) + " 秒内没取到数据（谷歌趋势页面可能没加载完，或要求人机验证）——已把那个标签页切到前台，看一眼就知道" }, true);
          }, JOB_TIMEOUT_MS);
        });
      });
    });
}

/** 后台叫不醒的兜底：还没等到曲线，就把标签页切到前台（看得见的页面谷歌才加载），取到后在 finish 里切回去 */
function toForeground(tabId) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job || job.points || job.foregroundAt) return null;
      job.foregroundAt = Date.now();
      return saveJobs(jobs).then(function () { return job; });
    });
  }).then(function (job) {
    if (!job) return;
    chrome.tabs.update(tabId, { active: true }).catch(function () {});
    notify(job, "foreground", "后台 " + (FOREGROUND_AFTER_MS / 1000) + " 秒没动静，已切到前台让它加载，取到后自动切回");
  });
}

/** 结束一个任务：结果送回对话页。成功就关掉谷歌趋势标签页；失败就把它切到前台让用户看见（多半是要人机验证） */
function finish(tabId, result, reveal, cancelled) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job) return;
      delete jobs[tabId];
      return saveJobs(jobs).then(function () {
        var at = function (x) { return x ? x - job.startedAt : null; };
        var msg = { type: "trends:result", requestId: job.requestId, ok: !!result.ok, data: result.data || null, error: result.error || "",
          // 给侧边栏调试看的：打开的网址、总耗时和分段（页面加载完 / 曲线到 / 相关查询到 / 切到前台），相关查询到没到
          // （对话页那边用不上，传过去也不碍事）
          debug: { url: job.url, ms: Date.now() - job.startedAt, related: job.rising !== null,
            loadMs: at(job.loadedAt), timelineMs: at(job.timelineAt), relatedMs: at(job.relatedAt), foregroundMs: at(job.foregroundAt) } };
        if (job.toPanel) chrome.runtime.sendMessage(msg).catch(function () {}); // 侧边栏关了就没人收，无所谓
        else chrome.tabs.sendMessage(job.originTabId, msg).catch(function () {});
        logActivity(job.requestId, { endedAt: Date.now(), ok: !!result.ok, error: result.error || "", stage: result.ok ? "done" : "failed",
          text: result.ok ? "取到了（" + ((result.data && result.data.points) || []).length + " 个点）" : "" });
        if (result.ok && job.keepTab) chrome.tabs.update(tabId, { active: true }).catch(function () {});
        else if (result.ok || cancelled) {
          // 被切到过前台的：先切回原来那个标签页，再关（直接关的话浏览器会跳到旁边随便一个标签页）
          var back = job.foregroundAt && job.returnTabId ? chrome.tabs.update(job.returnTabId, { active: true }).catch(function () {}) : Promise.resolve();
          back.then(function () { chrome.tabs.remove(tabId).catch(function () {}); });
        }
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
        job.timelineAt = Date.now();
        return saveJobs(jobs).then(function () { return job.rising ? { done: okResult(job) } : { grace: true, job: job }; });
      }
      if (msg.kind === "related" && !job.rising) {
        job.top = msg.top || [];
        job.rising = msg.rising || [];
        job.relatedAt = Date.now();
        return saveJobs(jobs).then(function () { return job.points ? { done: okResult(job) } : null; });
      }
      return null;
    });
  }).then(function (next) {
    if (!next) return;
    if (next.done) return finish(tabId, next.done, next.reveal);
    if (next.grace) {
      notify(next.job, "timeline", "曲线到了，再等一下相关查询…");
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
  if (msg.type === "trends:cancel" && /^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) {
    // 对话页点了停止（或侧边栏取消）：结束这张单、关掉它开的标签页。只认同样两处发来的
    var okSender = (sender.id === chrome.runtime.id && String(sender.url || "").indexOf(PANEL_URL) === 0) || (!!sender.tab && sender.origin === SITE_ORIGIN);
    if (okSender) loadJobs().then(function (jobs) {
      Object.keys(jobs).forEach(function (k) { if (jobs[k].requestId === msg.requestId) finish(Number(k), { ok: false, error: "已取消（点了停止）" }, false, true); });
    });
    return false;
  }
  return false;
});

// 取数的标签页被关掉了 / 被跳到了别处（manifest 只给了 trends.google.com 的站点权限：
// 谷歌的人机验证页 www.google.com/sorry 不在其中，tab.url 会是空的）
chrome.tabs.onRemoved.addListener(function (tabId) {
  loadJobs().then(function (jobs) { if (jobs[tabId]) finish(tabId, { ok: false, error: "取数的谷歌趋势标签页被关掉了" }); });
});
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== "complete") return;
  serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job) return false;
      if (!tab.url || tab.url.indexOf("https://trends.google.com/") !== 0) return true;
      if (!job.loadedAt) { job.loadedAt = Date.now(); return saveJobs(jobs).then(function () { return job.points ? false : job; }); }
      return false;
    });
  }).then(function (redirected) {
    if (redirected && redirected !== true) { notify(redirected, "loaded", "页面加载完了，等它出数据…"); return; }
    if (redirected) finish(tabId, { ok: false, error: "谷歌把页面跳走了（多半是要人机验证）——已把那个标签页切到前台，验证完回对话页再问一次" }, true);
  });
});

// ---------- 插件装好 / 更新 / 重新加载：把传话脚本补进已经打开的 seo.web.cafe 页面 ----------
// Chrome 不会把内容脚本塞进已经打开的页面：插件一更新，对话页里那份旧脚本就失效了，新的又进不来，
// 这一轮就当「没装插件」。所以后台每次起来（装好、更新、重新加载，以及被回收后重启）都挨个问一声对话页里的传话脚本：
// 回不上话的（失效的旧脚本回不了，也可能压根没有）就补一份进去。页面马上收到 hello、报给服务器，
// 服务器那边等插件的工具就接着干活，不用用户刷新。活着的不重复补
function ensureBridges() {
  chrome.tabs.query({ url: "https://seo.web.cafe/*" }).then(function (tabs) {
    tabs.forEach(function (t) {
      chrome.tabs.sendMessage(t.id, { type: "bridge:ping" }).then(function (r) {
        if (!r || !r.ok) throw new Error("no bridge");
      }).catch(function () {
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content/site-bridge.js"] }).catch(function () {});
      });
    });
  }, function () {});
}
ensureBridges(); // 后台脚本每次起来都跑一遍（装好 / 更新 / 重新加载都会让它起来）；不另挂 onInstalled，免得同一刻补两份

// ---------- 点插件图标：记下当前网页，打开侧边栏 ----------
// 不用 openPanelOnActionClick：自己处理点击，点击这一下会授予 activeTab，才读得到当前网页的网址；
// 这样不用申请「读取所有网页的浏览记录」那种大权限
chrome.action.onClicked.addListener(function (tab) {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(function () {});
  var url = /^https?:\/\//.test(tab.url || "") ? tab.url : "";
  chrome.storage.session.set({ lastPage: { url: url, title: tab.title || "", at: Date.now() } });
});
