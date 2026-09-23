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
//   ④ 读 Ahrefs（0.8.0 起）：Agent 要看一个站的外链 / 流量增长趋势时，在你设置的 Ahrefs 地址（官方或镜像站）开这个站的
//      Site Explorer，用你自己登录的账号；content/ahrefs-hook.js 截下页面自己加载的 JSON、ahrefs-bridge.js 认出曲线和指标，
//      连同页面文字交回对话页。要你先在侧边栏「设置」里点一下「允许读 Ahrefs 数据」（Chrome 的站点权限），之后才注册这两个脚本。
//   ⑤ 用浏览器打开网页读回来（0.9.0 起）：网站那边抓不到的网页（跳转太多、403、要登录、要执行 JS、人机验证），
//      在后台开一个标签页，等页面渲染完读标题 / 正文 / 链接 / 表格 / 渲染后的 HTML，读完关掉。每个网站第一次要你点「允许」。
//
// 看得见在干活：每个取数任务一接单就回「收到」（对话页转给服务器——服务器 20 秒没等到「收到」就不再干等），
// 之后每一步（打开谷歌趋势 / 页面加载完 / 切到前台 / 曲线到了）都报一句进度；同时记进任务日志
// （storage.session.activity，侧边栏「插件正在做的事」照着显示），工具栏图标上的数字是正在跑的任务数。
// 用户在对话页点了停止：对话页发 trends:cancel，这里关掉那个标签页、结束任务。
//
// MV3 的 service worker 随时可能被浏览器回收：进行中的取数任务存在 chrome.storage.session 里，不放内存。
// 超时用 setTimeout，worker 被回收就丢了——对话页那边自己也有 60 秒的超时兜底，不会干等。
importScripts("lib/trends-parse.js", "lib/ahrefs-parse.js", "lib/page-read.js");
var P = self.GefeiTrendsParse;
var A = self.GefeiAhrefsParse;
var R = self.GefeiPageRead;

var SITE_ORIGIN = "https://seo.web.cafe";
var JOB_TIMEOUT_MS = 45000;     // 页面那边 60 秒放弃，这里先放弃、把原因说清楚
var RELATED_GRACE_MS = 2500;    // 曲线到了之后再等一会儿相关查询；等不到就只交曲线
var FOREGROUND_AFTER_MS = 8000; // 后台这么久还没等到曲线，就把标签页切到前台让它加载
var AWAKE_MARK = "#gefei-seo-agent"; // 只有带这个记号的标签页，awake.js 才会让它在后台也照常加载
var AHREFS_QUIET_MS = 4000;     // Ahrefs 页面拿到曲线和文字之后，再这么久没有新数据就算加载完了
var PAGE_POLL_MS = 1500;        // 打开的网页加载完之后，每隔这么久读一次，正文长度两次一样就算渲染完了
var PAGE_MAX_MS = 25000;        // 加载完之后最多再等这么久（人机验证页一般几秒内自己跳过去）

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
  if (msg.kind === "ahrefs") return startAhrefsJob(msg, from);
  if (msg.kind === "page") return startPageJob(msg, from);
  return serial(function () {
    if (!/^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) throw new Error("取数单号不对");
    var url = P.buildTrendsUrl({ keyword: msg.keyword, geo: msg.geo, date: msg.date });
    return loadJobs().then(function (jobs) {
      // 同一张单已经在取了（对话页刷新后，服务器把还没确认接单的单子又交给了新页面）：不再开第二个标签页
      var dup = Object.keys(jobs).some(function (k) { return jobs[k].requestId === msg.requestId; });
      return dup ? null : openJob(msg, from, url, {
        fields: { keyword: P.normKeywords(msg.keyword), points: null, top: null, rising: null, timelineAt: null, relatedAt: null }, // 对比几个词时是「词1,词2」，和曲线接口里读出来的写法一致
        label: { keyword: String(msg.keyword || "").trim(), range: RANGE_LABEL[msg.date] || "", geo: msg.geo || "" },
        opened: "已打开谷歌趋势，等页面加载…",
      });
    });
  });
}

/** 读 Ahrefs：在你设置的 Ahrefs 地址开这个站的 Site Explorer。
 *  还没允许读这个地址：不马上说失败，而是在旁边打开「允许读 Ahrefs 数据」页面等你点（见 waitForAllow），点了接着读 */
function startAhrefsJob(msg, from) {
  if (!/^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) return Promise.reject(new Error("取数单号不对"));
  var target = A.normTarget(msg.target);
  if (!target) return Promise.reject(new Error("要看的网站不像域名：" + String(msg.target || "").slice(0, 60)));
  return ahrefsBase().then(function (base) {
    return chrome.permissions.contains({ origins: [base + "/*"] }).then(function (ok) {
      if (!ok) return waitForAllow(msg, from, base, target);
      return ensureAhrefsScripts().then(function () { return openAhrefsJob(msg, from, base, target); });
    });
  });
}
function openAhrefsJob(msg, from, base, target) {
  var host = base.replace(/^https:\/\//, "");
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var dup = Object.keys(jobs).some(function (k) { return jobs[k].requestId === msg.requestId; });
      return dup ? null : openJob(msg, from, A.siteExplorerUrl(base, target), {
        fields: { kind: "ahrefs", target: target, home: base + "/", series: [], metrics: {}, text: "", title: "", lastAt: null, firstDataAt: null },
        label: { keyword: target, range: "Ahrefs · " + host, geo: "" },
        opened: "已在 " + host + " 打开 " + target + " 的 Site Explorer，等页面加载…",
        onTimeout: function (tabId) { finishAhrefs(tabId, true); },
      });
    });
  });
}

// ---------- 还没允许读 Ahrefs：在对话页旁边打开「允许」页面，等你点（最多 2 分钟） ----------
// Chrome 的权限弹窗只能由用户在插件自己的页面里点出来（后台、内容脚本都弹不了）。以前这里直接说「没允许」，
// 对话里的 Agent 就转头拿别的数据凑了一篇；现在停下来等你：点了「允许」接着读，点「不允许」/ 关掉页面 / 2 分钟没点才算没读成。
// 等待中的单子记在 storage.session.allows（按「允许」页面的标签页号），后台被回收了也接得上
var ALLOW_WAIT_MS = 120000;
var ALLOW_URL = chrome.runtime.getURL("allow/allow.html");
function loadAllows() { return chrome.storage.session.get("allows").then(function (r) { return r.allows || {}; }); }
function saveAllows(a) { return chrome.storage.session.set({ allows: a }); }
/** 给发起方（对话页标签页 / 侧边栏）发一条消息 */
function tellFrom(from, m) {
  if (from.panel) chrome.runtime.sendMessage(m).catch(function () {});
  else if (from.tabId != null) chrome.tabs.sendMessage(from.tabId, m).catch(function () {});
}
function waitForAllow(msg, from, base, target, kind) {
  var host = base.replace(/^https:\/\//, "");
  var who = { panel: !!from.panel, tabId: from.tab ? from.tab.id : null, windowId: from.tab ? from.tab.windowId : (Number.isInteger(msg.windowId) ? msg.windowId : null) };
  return serial(function () {
    return loadAllows().then(function (allows) {
      // 同一张单已经在等（对话页刷新后又转来一次）：不再开第二个页面
      if (Object.keys(allows).some(function (k) { return allows[k].msg.requestId === msg.requestId; })) return null;
      var opts = { url: ALLOW_URL + "?kind=" + (kind === "page" ? "page" : "ahrefs") + "&origin=" + encodeURIComponent(base) + "&target=" + encodeURIComponent(target), active: true };
      if (who.windowId != null) opts.windowId = who.windowId;
      if (from.tab) opts.index = from.tab.index + 1;
      return chrome.tabs.create(opts).then(function (tab) {
        allows[tab.id] = { msg: msg, from: who, base: base, target: target, at: Date.now() };
        return saveAllows(allows).then(function () { return tab; });
      });
    });
  }).then(function (tab) {
    if (!tab) return;
    var text = "还没允许插件读 " + host + "：已在旁边打开「允许」页面，点了就接着读（等你 2 分钟）";
    tellFrom(who, { type: "trends:progress", requestId: msg.requestId, stage: "allow", text: text });
    logActivity(msg.requestId, { keyword: kind === "page" ? host : target, range: kind === "page" ? "打开网页" : "Ahrefs · " + host, geo: "", from: who.panel ? "侧边栏" : "对话页", stage: "allow", text: "等你允许读 " + host + "…" });
    setTimeout(function () { endAllow(tab.id, false, "2 分钟内没点「允许」"); }, ALLOW_WAIT_MS);
  });
}
/** 等待结束：允许了就回到对话页、接着去 Ahrefs 读；没允许就把原因交回去（对话里的 Agent 会停下来说明） */
function endAllow(allowTabId, granted, why) {
  return serial(function () {
    return loadAllows().then(function (allows) {
      var a = allows[allowTabId];
      if (!a) return null;
      delete allows[allowTabId];
      return saveAllows(allows).then(function () { return a; });
    });
  }).then(function (a) {
    if (!a) return;
    chrome.tabs.remove(allowTabId).catch(function () {});
    var host = a.base.replace(/^https:\/\//, "");
    var originTab = a.from.tabId != null ? chrome.tabs.get(a.from.tabId).catch(function () { return null; }) : Promise.resolve(null);
    return originTab.then(function (tab) {
      if (!a.from.panel && !tab) return; // 对话页已经关了：没人收
      var from = a.from.panel ? { panel: true, tab: null } : { tab: tab };
      var fail = function (error) {
        tellFrom(a.from, { type: "trends:result", requestId: a.msg.requestId, ok: false, data: null, error: error });
        logActivity(a.msg.requestId, { endedAt: Date.now(), ok: false, error: error, stage: "failed", text: "" });
      };
      if (!granted) return fail("没允许插件读 " + host + " 的页面（" + why + "），这次没读" + (a.msg.kind === "page" ? "这个网页" : " Ahrefs"));
      if (tab) chrome.tabs.update(tab.id, { active: true }).catch(function () {}); // 回到对话页，看着它接着读
      return startJob(a.msg, from).catch(function (e) { fail(String((e && e.message) || e)); });
    });
  });
}
/** 权限加上了（在「允许」页面点的，或者在侧边栏「设置」里点的）：所有在等这个地址的单子接着读 */
function onAllowGranted() {
  return loadAllows().then(function (allows) {
    Object.keys(allows).forEach(function (k) {
      chrome.permissions.contains({ origins: [allows[k].base + "/*"] }).then(function (ok) { if (ok) endAllow(Number(k), true); }, function () {});
    });
  });
}

/** 开取数标签页、记进任务表（在 startJob 的串行队列里调用）。spec：fields（这类任务自己的字段）、label（任务日志里怎么写）、
 *  opened（开好之后报的第一句）、onTimeout（到点还没交：默认当失败） */
function openJob(msg, from, url, spec) {
    var winId = from.tab ? from.tab.windowId : (Number.isInteger(msg.windowId) ? msg.windowId : undefined);
    // 记号只给谷歌趋势 / Ahrefs：随便一个网页加上 #记号，靠 # 分页面的单页应用会被带错页
    var opts = { url: url + (spec.noMark ? "" : AWAKE_MARK), active: !!(from.panel && msg.foreground) }; // 侧边栏可选「前台打开」，排查慢的时候对照用
    if (winId !== undefined) opts.windowId = winId;
    if (from.tab) opts.index = from.tab.index + 1;
    // 取完要切回哪个标签页：对话页发起的切回对话页；侧边栏发起的切回发起时正看着的那个
    var back = from.tab && !from.panel ? Promise.resolve(from.tab.id)
      : chrome.tabs.query(winId !== undefined ? { active: true, windowId: winId } : { active: true, lastFocusedWindow: true })
        .then(function (t) { return t && t[0] ? t[0].id : null; }, function () { return null; });
    return back.then(function (returnTabId) {
      return chrome.tabs.create(opts).then(function (tab) {
        return loadJobs().then(function (jobs) {
          jobs[tab.id] = Object.assign({
            requestId: msg.requestId, url: url, returnTabId: returnTabId,
            originTabId: from.panel ? null : from.tab.id, toPanel: !!from.panel,
            keepTab: !!(from.panel && msg.keepTab), // 调试用：取完不关，方便对照网页核对
            startedAt: Date.now(), loadedAt: null, foregroundAt: opts.active ? Date.now() : null,
          }, spec.fields);
          return saveJobs(jobs);
        }).then(function () {
          logActivity(msg.requestId, Object.assign({ from: from.panel ? "侧边栏" : "对话页", stage: "opened", text: spec.opened }, spec.label));
          setTimeout(function () { toForeground(tab.id); }, FOREGROUND_AFTER_MS);
          setTimeout(function () {
            if (spec.onTimeout) return spec.onTimeout(tab.id);
            finish(tab.id, { ok: false, error: (JOB_TIMEOUT_MS / 1000) + " 秒内没取到数据（谷歌趋势页面可能没加载完，或要求人机验证）——已把那个标签页切到前台，看一眼就知道" }, true);
          }, JOB_TIMEOUT_MS);
        });
      });
    });
}

function hasData(job) {
  if (job.kind === "ahrefs") return !!(job.series && job.series.length);
  if (job.kind === "page") return !!(job.page && job.page.textChars > 200);
  return !!job.points;
}
/** 后台叫不醒的兜底：还没等到曲线，就把标签页切到前台（看得见的页面谷歌才加载），取到后在 finish 里切回去 */
function toForeground(tabId) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job || hasData(job) || job.foregroundAt) return null;
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
          debug: job.kind === "page" ? { url: job.url, ms: Date.now() - job.startedAt, loadMs: at(job.loadedAt), foregroundMs: at(job.foregroundAt), polls: job.polls || 0 }
            : job.kind === "ahrefs" ? { url: job.url, ms: Date.now() - job.startedAt, loadMs: at(job.loadedAt), dataMs: at(job.firstDataAt), foregroundMs: at(job.foregroundAt) }
            : { url: job.url, ms: Date.now() - job.startedAt, related: job.rising !== null,
              loadMs: at(job.loadedAt), timelineMs: at(job.timelineAt), relatedMs: at(job.relatedAt), foregroundMs: at(job.foregroundAt) } };
        if (job.toPanel) chrome.runtime.sendMessage(msg).catch(function () {}); // 侧边栏关了就没人收，无所谓
        else chrome.tabs.sendMessage(job.originTabId, msg).catch(function () {});
        logActivity(job.requestId, { endedAt: Date.now(), ok: !!result.ok, error: result.error || "", stage: result.ok ? "done" : "failed",
          text: !result.ok ? "" : job.kind === "page" ? "读到了（正文 " + ((result.data && result.data.textChars) || 0) + " 字）" : job.kind === "ahrefs" ? "读到了（" + ((result.data && result.data.series) || []).length + " 条曲线、" + Object.keys((result.data && result.data.metrics) || {}).length + " 个指标）"
            : "取到了（" + ((result.data && result.data.points) || []).length + " 个点）" });
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
  var data = { keyword: job.keyword, points: job.points, top: job.top || [], rising: job.rising || [] };
  if (isCompare(job)) data.keywords = job.keyword.split(",");
  return { ok: true, data: data };
}
// 对比几个词：谷歌给每个词单独出一份相关查询，这里不取（要看相关查询就单独查那个词），曲线一到就交
function isCompare(job) { return String(job.keyword || "").indexOf(",") >= 0; }

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
        return saveJobs(jobs).then(function () { return job.rising || isCompare(job) ? { done: okResult(job) } : { grace: true, job: job }; });
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

// ---------- 用浏览器打开网页读回来 ----------
/** 网页：网址不对 / 是本机或局域网就不开；这个网站还没允许读，就在旁边打开「允许」页面等你点 */
function startPageJob(msg, from) {
  if (!/^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) return Promise.reject(new Error("取数单号不对"));
  var url = R.normPageUrl(msg.url);
  if (!url) return Promise.reject(new Error("这个网址插件不开（只开 http / https 的公网网址，本机和局域网的不开）：" + String(msg.url || "").slice(0, 80)));
  var origin = new URL(url).origin;
  return chrome.permissions.contains({ origins: [origin + "/*"] }).then(function (ok) {
    if (!ok) return waitForAllow(msg, from, origin, url, "page");
    var host = new URL(url).host;
    return serial(function () {
      return loadJobs().then(function (jobs) {
        var dup = Object.keys(jobs).some(function (k) { return jobs[k].requestId === msg.requestId; });
        return dup ? null : openJob(msg, from, url, {
          noMark: true,
          // minMs：加载完之后至少再等这么久才算读完（GSC 这类一块一块填数据的报告页用，最多 15 秒）
          fields: { kind: "page", origin: origin, page: null, polls: 0, lastLen: -1, minMs: Math.max(0, Math.min(15000, Number(msg.minMs) || 0)) },
          label: { keyword: host, range: "打开网页", geo: "" },
          opened: "已在后台打开 " + host + "，等页面加载…",
          onTimeout: function (tabId) { finishPage(tabId, true); },
        });
      });
    });
  });
}
/** 读一次页面（在网页里执行 extractPage）；正文长度连着两次一样、而且不是人机验证页，就算渲染完了 */
function schedulePagePoll(tabId) {
  setTimeout(function () {
    loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job || job.kind !== "page") return;
      chrome.scripting.executeScript({ target: { tabId: tabId }, func: R.extractPage, args: [R.MAX_TEXT, R.MAX_HTML] }).then(function (res) {
        var page = res && res[0] && res[0].result;
        return serial(function () {
          return loadJobs().then(function (jobs2) {
            var j = jobs2[tabId];
            if (!j) return null;
            j.polls = (j.polls || 0) + 1;
            var settled = Date.now() >= (j.loadedAt || j.startedAt) + (j.minMs || 0);
            var stable = page && page.textChars > 0 && page.textChars === j.lastLen && !page.challenge && !page.busy && settled;
            j.lastLen = page ? page.textChars : -1;
            j.page = page || j.page;
            return saveJobs(jobs2).then(function () { return { job: j, stable: stable, page: page }; });
          });
        });
      }, function (e) {
        // 读不了：多半是页面跳到了别的网站（登录页、换了域名），插件没有那个网站的权限
        finish(tabId, { ok: false, error: "页面跳到了插件没被允许读的网址（多半要登录，或换了域名）：" + String((e && e.message) || e).slice(0, 120) }, true);
        return null;
      }).then(function (st) {
        if (!st) return;
        var waited = Date.now() - (st.job.loadedAt || st.job.startedAt);
        if (st.stable || (st.page && (st.page.login || st.page.canvas) && st.job.polls >= 2) || waited >= PAGE_MAX_MS) return finishPage(tabId, false);
        if (st.job.polls === 1) notify(st.job, "reading", "读到页面了，等它渲染完…");
        schedulePagePoll(tabId);
      });
    });
  }, PAGE_POLL_MS);
}
function finishPage(tabId, timedOut) {
  return loadJobs().then(function (jobs) {
    var job = jobs[tabId];
    if (!job) return;
    if (job.page) return finish(tabId, { ok: true, data: Object.assign({ kind: "page", url: job.url }, job.page) }, !!(job.page.login || job.page.challenge));
    return finish(tabId, { ok: false, error: (timedOut ? (JOB_TIMEOUT_MS / 1000) + " 秒内" : "") + "页面没加载出来——已把那个标签页切到前台，看一眼就知道" }, true);
  });
}

// ---------- Ahrefs：页面交上来的曲线 / 指标 / 文字攒在任务里，攒够了再安静 4 秒就交 ----------
function ahrefsResult(job) {
  return { ok: true, data: { kind: "ahrefs", target: job.target, url: job.url, title: job.title || "", series: job.series || [], metrics: job.metrics || {}, text: job.text || "" } };
}
/** 到点（或安静下来）：有曲线或文字就交（能读到多少交多少），什么都没有才算失败 */
function finishAhrefs(tabId, timedOut) {
  return loadJobs().then(function (jobs) {
    var job = jobs[tabId];
    if (!job) return;
    if ((job.series && job.series.length) || job.text) return finish(tabId, ahrefsResult(job));
    return finish(tabId, { ok: false, error: (timedOut ? (JOB_TIMEOUT_MS / 1000) + " 秒内" : "") + "没从 Ahrefs 页面读到数据（页面可能没加载完、没登录，或者 Ahrefs 改了版）——已把那个标签页切到前台，看一眼就知道" }, true);
  });
}
function onAhrefsCaptured(tabId, msg) {
  return serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job || job.kind !== "ahrefs") return null; // 不是插件开的标签页：什么都不做
      if (msg.kind === "login") return { login: true };
      var first = !job.firstDataAt;
      if (msg.kind === "json") {
        (msg.series || []).forEach(function (sr) {
          if (!sr || typeof sr.name !== "string" || !Array.isArray(sr.points)) return;
          var i = job.series.findIndex(function (x) { return x.name === sr.name; });
          if (i >= 0) { if (sr.points.length > job.series[i].points.length) job.series[i] = sr; }
          else if (job.series.length < A.MAX_SERIES) job.series.push(sr);
        });
        Object.keys(msg.metrics || {}).forEach(function (k) {
          if (job.metrics[k] === undefined && Object.keys(job.metrics).length < 80) job.metrics[k] = msg.metrics[k];
        });
      } else if (msg.kind === "page") {
        job.text = String(msg.text || "").slice(0, A.MAX_TEXT);
        job.title = String(msg.title || "").slice(0, 200);
      } else return null;
      job.lastAt = Date.now();
      if (first) job.firstDataAt = job.lastAt;
      return saveJobs(jobs).then(function () { return { job: job, first: first }; });
    });
  }).then(function (next) {
    if (!next) return;
    if (next.login) return finish(tabId, { ok: false, error: "Ahrefs 要你先登录（这个浏览器里没登录或登录过期了）——已把那个标签页切到前台，登录后回对话页再问一次" }, true);
    if (next.first) notify(next.job, "data", "读到数据了，等页面加载完…");
    // 曲线和文字都有了，再安静一会儿（没有新数据进来）就交；还有数据陆续进来就接着等
    setTimeout(function () {
      loadJobs().then(function (jobs) {
        var j = jobs[tabId];
        if (j && j.series.length && j.text && Date.now() - j.lastAt >= AHREFS_QUIET_MS - 50) finishAhrefs(tabId, false);
      });
    }, AHREFS_QUIET_MS);
  });
}

// ---------- Ahrefs 的两个脚本：你允许了读哪个 Ahrefs 地址，就只给那个地址注册 ----------
function ahrefsBase() {
  return chrome.storage.local.get("ahrefsBase").then(function (r) { return A.normBase(r.ahrefsBase) || A.DEFAULT_BASE; }, function () { return A.DEFAULT_BASE; });
}
var AHREFS_IDS = ["gefei-ahrefs-main", "gefei-ahrefs-bridge"];
function ensureAhrefsScripts() {
  return ahrefsBase().then(function (base) {
    var origins = [base + "/*"];
    return chrome.permissions.contains({ origins: origins }).then(function (ok) {
      return chrome.scripting.getRegisteredContentScripts({ ids: AHREFS_IDS }).then(function (regs) {
        var same = regs.length === AHREFS_IDS.length && regs.every(function (r) { return r.matches && r.matches.join() === origins.join(); });
        if (ok && same) return true;
        var drop = regs.length ? chrome.scripting.unregisterContentScripts({ ids: regs.map(function (r) { return r.id; }) }) : Promise.resolve();
        return drop.then(function () {
          if (!ok) return false;
          return chrome.scripting.registerContentScripts([
            { id: AHREFS_IDS[0], matches: origins, js: ["content/awake.js", "content/ahrefs-hook.js"], runAt: "document_start", world: "MAIN" },
            { id: AHREFS_IDS[1], matches: origins, js: ["lib/ahrefs-parse.js", "content/ahrefs-bridge.js"], runAt: "document_start" },
          ]).then(function () { return true; });
        });
      });
    });
  }).catch(function () { return false; });
}
ensureAhrefsScripts();
if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(function () { ensureAhrefsScripts().then(onAllowGranted); });
if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(function () { ensureAhrefsScripts(); });
chrome.storage.onChanged.addListener(function (changes, area) { if (area === "local" && changes.ahrefsBase) ensureAhrefsScripts(); });

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
  if (msg.type === "ahrefs:captured" && sender.tab) { onAhrefsCaptured(sender.tab.id, msg); return false; }
  if ((msg.type === "ahrefs:allowed" || msg.type === "ahrefs:denied") && sender.tab && sender.id === chrome.runtime.id && String(sender.url || "").indexOf(ALLOW_URL) === 0) {
    // 「允许」页面的两个按钮：允许了（权限已经加上）→ 接着读；不允许 → 这次不读
    if (msg.type === "ahrefs:allowed") ensureAhrefsScripts().then(function () { endAllow(sender.tab.id, true); });
    else endAllow(sender.tab.id, false, "你点了「不允许」");
    return false;
  }
  if (msg.type === "ahrefs:hello" && sender.tab) {
    // Ahrefs 页面里的脚本问「我是不是你开的取数标签页」：不是就什么都别发
    loadJobs().then(function (jobs) { var j = jobs[sender.tab.id]; sendResponse({ job: !!(j && j.kind === "ahrefs") }); }, function () { sendResponse({ job: false }); });
    return true;
  }
  if (msg.type === "trends:cancel" && /^[a-f0-9]{32}$/.test(String(msg.requestId || ""))) {
    // 对话页点了停止（或侧边栏取消）：结束这张单、关掉它开的标签页。只认同样两处发来的
    var okSender = (sender.id === chrome.runtime.id && String(sender.url || "").indexOf(PANEL_URL) === 0) || (!!sender.tab && sender.origin === SITE_ORIGIN);
    if (okSender) loadJobs().then(function (jobs) {
      Object.keys(jobs).forEach(function (k) { if (jobs[k].requestId === msg.requestId) finish(Number(k), { ok: false, error: "已取消（点了停止）" }, false, true); });
    });
    // 还在等「允许」的：关掉那个页面，单子作废
    if (okSender) loadAllows().then(function (allows) {
      Object.keys(allows).forEach(function (k) { if (allows[k].msg.requestId === msg.requestId) endAllow(Number(k), false, "点了停止"); });
    });
    return false;
  }
  return false;
});

// 取数的标签页被关掉了 / 被跳到了别处（manifest 只给了 trends.google.com 的站点权限：
// 谷歌的人机验证页 www.google.com/sorry 不在其中，tab.url 会是空的）
chrome.tabs.onRemoved.addListener(function (tabId) {
  loadJobs().then(function (jobs) { if (jobs[tabId]) finish(tabId, { ok: false, error: jobs[tabId].kind === "ahrefs" ? "读 Ahrefs 的标签页被关掉了" : "取数的谷歌趋势标签页被关掉了" }); });
  endAllow(tabId, false, "「允许」页面被关掉了"); // 不是「允许」页面就什么都不做
});
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== "complete") return;
  serial(function () {
    return loadJobs().then(function (jobs) {
      var job = jobs[tabId];
      if (!job) return false;
      if (job.kind === "page") {
        // 网页可能跳到别处（登录页、换了域名）：不算失败，读的时候看读不读得到
        if (!job.loadedAt) { job.loadedAt = Date.now(); return saveJobs(jobs).then(function () { return job; }); }
        return false;
      }
      if (!tab.url || tab.url.indexOf(job.home || "https://trends.google.com/") !== 0) return job.kind === "ahrefs" ? "ahrefs" : true;
      if (!job.loadedAt) { job.loadedAt = Date.now(); return saveJobs(jobs).then(function () { return hasData(job) ? false : job; }); }
      return false;
    });
  }).then(function (redirected) {
    if (redirected && typeof redirected === "object") {
      if (redirected.kind === "page") { notify(redirected, "loaded", "页面加载完了，等它渲染…"); schedulePagePoll(tabId); return; }
      notify(redirected, "loaded", "页面加载完了，等它出数据…"); return;
    }
    if (redirected) finish(tabId, { ok: false, error: redirected === "ahrefs" ? "Ahrefs 把页面跳到了别的网址（多半是没登录或登录过期）——已把那个标签页切到前台，登录后回对话页再问一次"
      : "谷歌把页面跳走了（多半是要人机验证）——已把那个标签页切到前台，验证完回对话页再问一次" }, true);
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
