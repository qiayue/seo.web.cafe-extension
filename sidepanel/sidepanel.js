// sidepanel/sidepanel.js — 侧边栏：一键把当前网站 / 一个新词交给 seo.web.cafe 上的哥飞 SEO Agent；直接查谷歌趋势
//
// 问 Agent 不在插件里另做一个 Agent：点按钮就是打开对话页并带上问题（/chat/?q=…，对话页会自动发出去），
// 回答、扣积分、存对话都在网站上，和平时一样。
// 直接查谷歌趋势是单独调试用的：和 Agent 取数走同一条路，结果只显示在侧边栏。
(function () {
  "use strict";
  var CHAT = "https://seo.web.cafe/chat/";
  var $ = function (id) { return document.getElementById(id); };

  function openChat(q) { chrome.tabs.create({ url: CHAT + "?q=" + encodeURIComponent(q) }); }

  /** 输入框里的东西 → { url, host }；只写了域名也行 */
  function target() {
    var raw = $("pageUrl").value.trim();
    if (!raw) return null;
    try {
      var u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
      return { url: u.href, host: u.hostname.replace(/^www\./, "") };
    } catch (e) { return null; }
  }

  var ASK = {
    traffic: function (t) { return t.host + " 这个站流量怎么起来的？"; },
    keywords: function (t) { return t.host + " 靠哪些关键词吃流量？主要落地页是哪些？"; },
    page: function (t) { return "帮我看看这个页面的 SEO 能怎么改：" + t.url; },
  };

  function need() {
    var t = target();
    if (!t) { $("pageUrl").focus(); $("pageHint").textContent = "先填一个网址或域名。"; }
    return t;
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-ask]"), function (b) {
    b.addEventListener("click", function () { var t = need(); if (t) openChat(ASK[b.getAttribute("data-ask")](t)); });
  });
  $("askCustom").addEventListener("click", function () {
    var q = $("custom").value.trim();
    if (!q) { $("custom").focus(); return; }
    var t = target();
    openChat(t ? q + "\n（我正在看的网页：" + t.url + "）" : q);
  });
  function word() { return $("word").value.replace(/\s+/g, " ").trim(); }
  $("askWord").addEventListener("click", function () {
    var w = word();
    if (!w) { $("word").focus(); return; }
    var ws = P.normKeywords(w).split(",");
    openChat(ws.length > 1 ? "用谷歌趋势把 " + ws.join("、") + " 放在同一次查询里对比一下热度，谁更热、差几倍？"
      : "「" + w + "」是不是新词？它是什么时候开始有热度的、现在还在涨吗？值不值得做？");
  });

  // ---------- 谷歌趋势：插件直接取数，显示在这里（单独调试用，不经过 Agent、不进网站缓存） ----------
  // 和对话页走同一条取数路（background.js 开标签页 → 内容脚本截数据），只是结果送回侧边栏。
  // 查到的曲线里如果有「新的一波」（之前热度很小、最近冲起来），自动按这一波出现的时间再查一次更细的：
  // 这一周起来的查过去 7 天（按小时），一个月内起来的查过去 30 天（按天），三个月内的查过去 90 天（按天）。
  // 判断规则在 lib/trends-parse.js（latestWave / finerDate），和网站那边 google_trends 工具是同一套
  var P = window.GefeiTrendsParse;
  var LABEL = { "now 7-d": "过去 7 天（按小时）", "today 1-m": "过去 30 天（按天）", "today 3-m": "过去 90 天（按天）", "today 12-m": "过去 12 个月（按周）", "today 5-y": "过去 5 年（按周）" };
  var UNIT = { "now 7-d": "小时", "today 1-m": "天", "today 3-m": "天", "today 12-m": "周", "today 5-y": "周" };
  var pending = null; // { id, keyword, geo, date, auto, timer }
  function newId() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  function setStatus(text, cls) {
    var el = $("trendsStatus");
    el.hidden = false;
    el.textContent = text;
    el.className = "status" + (cls ? " " + cls : "");
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(t, hourly) {
    var d = new Date(t * 1000);
    var day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return hourly ? day + " " + pad(d.getHours()) + ":00" : day;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function row(dl, k, v) {
    dl.appendChild(el("dt", null, k));
    var dd = el("dd");
    if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
    dl.appendChild(dd);
  }
  function list(items) {
    var ol = el("ol");
    if (!items || !items.length) { ol.appendChild(el("li", null, "（没有）")); return ol; }
    items.forEach(function (it) {
      var li = el("li", null, it.q);
      li.appendChild(el("span", null, it.v));
      ol.appendChild(li);
    });
    return ol;
  }
  function sec(ms) { return (ms / 1000).toFixed(1) + " 秒"; }

  /** 一次查询的结果卡片：曲线（没过完的那个点画虚线）、统计、相关查询、原始 JSON */
  function card(res, q) {
    var d = res.data || {}, pts = d.points || [], dbg = res.debug || {};
    var hourly = q.date === "now 7-d", unit = UNIT[q.date] || "";
    var box = el("div", "result");
    box.appendChild(el("h3", null, LABEL[q.date] + " · " + (q.geo || "全球") + (q.auto ? " · 自动补查" : "")));

    var chart = svg("svg", { viewBox: "0 0 300 100", preserveAspectRatio: "none", "aria-label": "相对热度曲线" });
    [25, 50, 75].forEach(function (y) { chart.appendChild(svg("line", { x1: 0, x2: 300, y1: y, y2: y })); });
    var n = pts.length;
    // 对比几个词：每个点带 vs（每个词一个值，同一把尺子），每个词画一条线
    var series = n && Array.isArray(pts[0].vs) ? pts[0].vs.length : 0;
    var names = series ? (d.keywords || String(d.keyword || q.keyword).split(",")).slice(0, series) : [];
    var val = function (p, k) { return series ? (p.vs[k] || 0) : p.v; };
    var partial = n && pts[n - 1].p ? pts[n - 1] : null;
    var full = partial ? pts.slice(0, n - 1) : pts;
    for (var k = Math.max(series, 1) - 1; k >= 0; k--) { // 第一个词最后画，压在最上面
      var xy = function (p, i) { return (n > 1 ? (i / (n - 1)) * 300 : 150).toFixed(1) + "," + (100 - val(p, k)).toFixed(1); };
      chart.appendChild(svg("polyline", { "class": "full s" + k, points: full.map(xy).join(" ") }));
      if (partial && n > 1) chart.appendChild(svg("polyline", { "class": "partial s" + k, points: xy(pts[n - 2], n - 2) + " " + xy(partial, n - 1) }));
    }
    box.appendChild(chart);
    if (series) {
      var legend = el("div", "legend");
      names.forEach(function (w, i) { legend.appendChild(el("span", "s" + i, w)); });
      box.appendChild(legend);
    }
    var axis = el("div", "axis");
    axis.appendChild(el("span", null, n ? fmt(pts[0].t, hourly) : ""));
    axis.appendChild(el("span", null, n ? fmt(pts[n - 1].t, hourly) : ""));
    box.appendChild(axis);

    if (series) return compareStats(box, res, q, pts, names, partial, hourly, unit);

    var dl = el("dl");
    var peak = null, first = null;
    pts.forEach(function (p) { if (!peak || p.v >= peak.v) peak = p; if (!first && p.v >= 5) first = p; });
    var half = "（这一" + unit + "还没过完，只是半截）";
    row(dl, "点数", n + " 个（按" + unit + (partial ? "，最后 1 个没过完" : "") + "）");
    if (peak) row(dl, "最高点", peak.v + "（" + fmt(peak.t, hourly) + (peak.p ? "，" + half.slice(1) : "）"));
    var wave = P.latestWave(pts);
    if (wave) row(dl, "最新一波", fmt(wave.start.t, hourly) + " 起" + (unit === "周" ? "的那一周" : "") + "（之前最高只有 " + wave.before + "）");
    // 5 以上才算「有热度」（相对峰值 5%），和网站那边的口径一致；开头就在 5 以上才说「开头就有」
    else row(dl, "第一次有热度", first ? fmt(first.t, hourly) + (first === pts[0] ? "（开头就有，不是这段时间里新冒出来的）" : "") : "整段都没到 5");
    if (n) row(dl, "最新一个点", pts[n - 1].v + "（" + fmt(pts[n - 1].t, hourly) + (partial ? "，" + half.slice(1) : "）"));
    if (dbg.ms != null) {
      var parts = [];
      if (dbg.loadMs != null) parts.push("页面加载完 " + sec(dbg.loadMs));
      if (dbg.foregroundMs != null) parts.push("切到前台 " + sec(dbg.foregroundMs));
      if (dbg.timelineMs != null) parts.push("曲线到 " + sec(dbg.timelineMs));
      if (dbg.relatedMs != null) parts.push("相关查询到 " + sec(dbg.relatedMs));
      row(dl, "耗时", sec(dbg.ms) + (parts.length ? "（" + parts.join(" · ") + "）" : "") + (dbg.related ? "" : "；相关查询没等到，只拿到曲线"));
    }
    if (dbg.url) {
      var a = el("a", null, "打开这个谷歌趋势网页");
      a.href = dbg.url; a.target = "_blank"; a.rel = "noopener";
      row(dl, "网页", a);
    }
    box.appendChild(dl);

    var rel = el("div", "rel");
    var r1 = el("div"); r1.appendChild(el("h4", null, "上升最快")); r1.appendChild(list(d.rising));
    var r2 = el("div"); r2.appendChild(el("h4", null, "热门")); r2.appendChild(list(d.top));
    rel.appendChild(r1); rel.appendChild(r2);
    box.appendChild(rel);

    var raw = el("details");
    raw.appendChild(el("summary", null, "原始数据（JSON）"));
    var copy = el("button", "small", "复制");
    copy.type = "button";
    var pre = el("pre", null, JSON.stringify(res, null, 2));
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(pre.textContent).then(function () {
        copy.textContent = "已复制";
        setTimeout(function () { copy.textContent = "复制"; }, 1500);
      }, function () {});
    });
    raw.appendChild(copy); raw.appendChild(pre);
    box.appendChild(raw);
    $("results").appendChild(box);
    $("trendsNote").hidden = false;
    return wave;
  }

  /** 对比卡片的统计：每个词的平均 / 最高，和第一个词比是几倍（同一次查询里才能这么比）；对比时不取相关查询 */
  function compareStats(box, res, q, pts, names, partial, hourly, unit) {
    var dl = el("dl"), n = pts.length;
    var full = partial ? pts.slice(0, n - 1) : pts;
    // 倍数按最近一段（后四分之一）的平均算：新词整段平均会被前面的 0 拉低；和网站那边的对比报告同一个口径
    var recentN = Math.max(3, Math.floor(full.length / 4)), recent = full.slice(-recentN);
    var mean = function (arr, k) { return arr.reduce(function (a, p) { return a + (p.vs[k] || 0); }, 0) / Math.max(1, arr.length); };
    var avg = names.map(function (_, k) { return mean(full, k); }), rec = names.map(function (_, k) { return mean(recent, k); });
    var times = function (x, b) { var r = x / b; return r >= 10 ? String(Math.round(r)) : r < 0.01 ? "不到 0.01" : r.toFixed(r < 0.1 ? 3 : 2); };
    // 倍数的基准：有 GPTs 就拿它（哥飞看新词大小的老参照词），没有就拿第一个词；按最近热度从高到低列，一眼看出谁高谁低
    var b = Math.max(0, names.indexOf("gpts"));
    var order = names.map(function (_, k) { return k; }).sort(function (x, y) { return rec[y] - rec[x] || avg[y] - avg[x]; });
    row(dl, "点数", n + " 个（按" + unit + (partial ? "，最后 1 个没过完，平均没算它" : "") + "）");
    row(dl, "谁高谁低", order.map(function (k) { return names[k]; }).join(" > ") + "（最近 " + recentN + " " + unit + "）");
    order.forEach(function (k) {
      var peak = null;
      pts.forEach(function (p) { if (!peak || p.vs[k] > peak.vs[k]) peak = p; }); // 一样高取最早那个（平的线别指到没过完的点上）
      var ratio = k === b ? "（基准）" : rec[b] > 0 ? "，是 " + names[b] + " 的 " + times(rec[k], rec[b]) + " 倍" : "";
      row(dl, names[k], "最近 " + recentN + " " + unit + "平均 " + rec[k].toFixed(1) + ratio + " · 整段平均 " + avg[k].toFixed(1) + " · 最高 " + peak.vs[k] + "（" + fmt(peak.t, hourly) + (peak.p ? "，没过完" : "") + "）");
    });
    var dbg = res.debug || {};
    if (dbg.ms != null) row(dl, "耗时", sec(dbg.ms));
    if (dbg.url) {
      var a = el("a", null, "打开这个谷歌趋势网页");
      a.href = dbg.url; a.target = "_blank"; a.rel = "noopener";
      row(dl, "网页", a);
    }
    box.appendChild(dl);
    box.appendChild(el("p", "hint", "几个词在同一次查询里：这次所有词、所有点里最高的那个记 100，所以可以直接比高低。对比时不取相关查询，要看就单独查那个词。"));
    var raw = el("details");
    raw.appendChild(el("summary", null, "原始数据（JSON）"));
    raw.appendChild(el("pre", null, JSON.stringify(res, null, 2)));
    box.appendChild(raw);
    $("results").appendChild(box);
    $("trendsNote").hidden = false;
    return null; // 对比不自动补查
  }

  function busy(on) {
    $("trendsGo").disabled = on;
    $("trendsGo").textContent = on ? "正在取…" : "查询";
  }

  function fetchTrends(q) {
    q.id = newId();
    q.timer = setTimeout(function () { done({ requestId: q.id, ok: false, error: "60 秒没等到插件后台的回音" }); }, 60000);
    pending = q;
    busy(true);
    chrome.windows.getCurrent().then(function (win) {
      return chrome.runtime.sendMessage({ type: "trends:fetch", requestId: q.id, keyword: q.keyword, geo: q.geo, date: q.date,
        keepTab: $("keepTab").checked, foreground: $("foreground").checked, windowId: win && win.id });
    }).then(function (r) {
      if (!r || !r.ok) done({ requestId: q.id, ok: false, error: (r && r.error) || "插件后台没接住请求" });
      // 接住了：结果稍后由后台广播回来（下面的 onMessage）
    }, function (e) { done({ requestId: q.id, ok: false, error: String((e && e.message) || e) }); });
  }

  function done(res) {
    var q = pending;
    if (!q || res.requestId !== q.id) return;
    clearTimeout(q.timer);
    pending = null;
    busy(false);
    if (!res.ok) {
      var box = el("div", "result");
      box.appendChild(el("h3", null, LABEL[q.date] + " · " + (q.geo || "全球") + (q.auto ? " · 自动补查" : "")));
      box.appendChild(el("p", "status err", "没取到：" + (res.error || "原因不明")));
      $("results").appendChild(box);
      setStatus(q.auto ? "补查没取到，上面那次的结果还在。" : "没取到：" + (res.error || "原因不明"), "err");
      return;
    }
    var wave = card(res, q);
    var finer = !q.auto && $("autoFiner").checked ? P.finerDate(q.date, wave, Math.floor(Date.now() / 1000)) : null;
    if (finer) {
      setStatus("最新一波从 " + fmt(wave.start.t, false) + (UNIT[q.date] === "周" ? " 那一周" : "") + " 起（之前最高只有 " + wave.before + "），接着查" + LABEL[finer] + "看它是哪天起来的……");
      fetchTrends({ keyword: q.keyword, geo: q.geo, date: finer, auto: true });
    } else {
      var kws = (res.data && res.data.keywords) || null;
      setStatus(kws ? "取到了：" + kws.join("、") + " 的对比（同一次查询，可以直接比高低）" : "取到了：" + ((res.data && res.data.keyword) || q.keyword) + (q.auto ? "（含自动补查）" : ""), "ok");
    }
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !pending || msg.requestId !== pending.id) return;
    if (msg.type === "trends:result") done(msg);
    else if (msg.type === "trends:progress" && msg.text) setStatus(msg.text);
  });

  function query() {
    var w = word();
    if (!w) { $("word").focus(); return; }
    if (pending) return;
    var geo = $("geo").value.trim().toUpperCase();
    if (geo && !/^[A-Z]{2}$/.test(geo)) { setStatus("地区要写两位国家码，比如 US、GB、IN；不填就是全球。", "err"); return; }
    var results = $("results");
    while (results.firstChild) results.removeChild(results.firstChild);
    $("trendsNote").hidden = true;
    var words = P.normKeywords(w).split(",");
    if (/[,，]/.test(w) && w.split(/[,，]/).filter(function (x) { return x.trim(); }).length > P.MAX_COMPARE) { setStatus("谷歌趋势一次最多对比 " + P.MAX_COMPARE + " 个词。", "err"); return; }
    setStatus(words.length > 1 ? "正在后台打开谷歌趋势对比「" + words.join("、") + "」（同一次查询，热度在同一把尺子上）……" : "正在后台打开谷歌趋势取「" + w + "」，一般几秒到十几秒……");
    fetchTrends({ keyword: words.length > 1 ? words.join(",") : w, geo: geo, date: $("range").value, auto: false });
  }
  $("trendsGo").addEventListener("click", query);
  $("word").addEventListener("keydown", function (e) { if (e.key === "Enter") query(); });

  // ---------- 插件正在做的事：后台的任务日志（storage.session.activity），进行中的在前、秒数实时走 ----------
  // Agent 让插件取数时用户能看见它确实在干活、到了哪一步；取不到也写明原因，不用对着「正在查询」干着急
  var activity = [];
  function ago(ms) { var s2 = Math.max(0, Math.round(ms / 1000)); return s2 < 60 ? s2 + " 秒" : Math.floor(s2 / 60) + " 分 " + (s2 % 60) + " 秒"; }
  function renderActivity() {
    var list = $("actList");
    while (list.firstChild) list.removeChild(list.firstChild);
    var running = activity.filter(function (a) { return !a.endedAt; });
    var done = activity.filter(function (a) { return a.endedAt; }).slice(0, 5);
    $("actCount").textContent = running.length ? String(running.length) : "";
    $("actEmpty").hidden = !!(running.length || done.length);
    running.concat(done).forEach(function (a) {
      var li = el("li", a.endedAt ? (a.ok ? "ok" : "bad") : "run");
      var what = el("div", "what", a.keyword || "（没有词）");
      what.appendChild(el("span", "meta", [a.range, a.geo || "全球", "来自" + (a.from || "?")].filter(Boolean).join(" · ")));
      li.appendChild(what);
      var step = a.endedAt
        ? (a.ok ? (a.text || "取到了") : "没取到：" + (a.error || "原因不明")) + "（用了 " + ago(a.endedAt - a.startedAt) + "）"
        : (a.text || "处理中…") + "（已经 " + ago(Date.now() - a.startedAt) + "）";
      li.appendChild(el("div", "step", step));
      list.appendChild(li);
    });
  }
  chrome.storage.session.get("activity").then(function (r) { activity = r.activity || []; renderActivity(); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "session" && changes.activity) { activity = changes.activity.newValue || []; renderActivity(); }
  });
  setInterval(function () { if (activity.some(function (a) { return !a.endedAt; })) renderActivity(); }, 1000);

  // ---------- 当前网页 ----------
  // 两个来源：① 点插件图标那一下（activeTab，不用额外权限，后台记在 storage.session.lastPage）；
  // ② 用户点了「自动跟随当前网页」、授权了可选权限 tabs（Chrome 会写成「读取浏览记录」）之后：本窗口里换标签页、
  //    页面跳转都自动跟上。网址只填进这个输入框，不存、不上传。seo.web.cafe 和插件开的谷歌趋势标签页不跟。
  // 输入框被用户手动改过就不覆盖，只在提示里给一个「换成它」
  var myWin = null, edited = false;
  $("pageUrl").addEventListener("input", function () { edited = true; });
  function showPage(p, auto) {
    if (!p || !p.url) return;
    var hint = $("pageHint");
    if (auto && edited && $("pageUrl").value.trim() !== p.url) {
      hint.textContent = "当前网页：" + (p.title || p.url) + " ";
      var use = el("button", "link", "换成它");
      use.type = "button";
      use.addEventListener("click", function () { edited = false; showPage(p, false); });
      hint.appendChild(use);
      return;
    }
    $("pageUrl").value = p.url;
    edited = false;
    hint.textContent = "当前网页：" + (p.title || p.url);
  }
  chrome.storage.session.get("lastPage").then(function (r) { showPage(r.lastPage, false); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "session" && changes.lastPage) showPage(changes.lastPage.newValue, false); // 点图标是明确的动作：照填
  });

  function follow(tab) {
    if (!tab || !tab.active || (myWin !== null && tab.windowId !== myWin)) return;
    var u = tab.url || ""; // 没授权时浏览器不给网址，这里自然什么都不做
    if (!/^https?:\/\//.test(u)) return;
    var h = new URL(u).hostname;
    // 自家对话页、插件开的谷歌趋势、Ahrefs 本身（切过去看 Ahrefs 时别把要问的网站换成 Ahrefs 的网址）都不跟
    if (h === "seo.web.cafe" || h === "trends.google.com" || h === "app.ahrefs.com" || h === new URL(ahrefsBase).hostname) return;
    showPage({ url: u, title: tab.title || "" }, true);
  }
  chrome.tabs.onActivated.addListener(function (info) {
    if (myWin !== null && info.windowId !== myWin) return;
    chrome.tabs.get(info.tabId).then(follow, function () {});
  });
  chrome.tabs.onUpdated.addListener(function (id, info, tab) { if (info.url || info.status === "complete") follow(tab); });
  function followState() {
    return chrome.permissions.contains({ permissions: ["tabs"] }).then(function (on) {
      $("followOn").hidden = on;
      $("followNote").textContent = on ? "已开启：换网页会自动换成新网址" : "";
      if (on) chrome.tabs.query(myWin !== null ? { active: true, windowId: myWin } : { active: true, currentWindow: true }).then(function (t) { follow(t && t[0]); });
    });
  }
  $("followOn").addEventListener("click", function () {
    chrome.permissions.request({ permissions: ["tabs"] }).then(function (ok) {
      followState().then(function () { if (!ok) $("followNote").textContent = "没授权：换网页后点一下插件图标就行"; });
    }, function () {});
  });
  if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(followState);
  if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(followState);
  chrome.windows.getCurrent().then(function (w) { myWin = w && w.id; followState(); }, followState);

  // ---------- Ahrefs：帮你在 Ahrefs 里打开这个站的 Site Explorer（用你自己登录的账号看），插件不读 Ahrefs 页面上的数据 ----------
  // 有人用的不是官方 app.ahrefs.com，而是镜像站（比如 https://ahrefs.3ue.com）：地址在「设置」里改，存在 storage.local，
  // 只留域名部分（贴进来的是 …/dashboard 也行），路径沿用官方的 /site-explorer/overview
  var AHREFS_DEFAULT = "https://app.ahrefs.com";
  var ahrefsBase = AHREFS_DEFAULT;
  /** 用户填的东西 → 规整成 https://域名；不像网址返回 null */
  function normBase(raw) {
    var s = String(raw || "").trim();
    if (!s) return AHREFS_DEFAULT;
    try {
      var u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
      if (!/^https?:$/.test(u.protocol) || !/\./.test(u.hostname)) return null;
      return u.origin;
    } catch (e) { return null; }
  }
  function showBase() {
    $("ahrefsBase").value = ahrefsBase === AHREFS_DEFAULT ? "" : ahrefsBase;
    $("openAhrefs").title = "在 " + ahrefsBase.replace(/^https?:\/\//, "") + " 打开 Site Explorer";
  }
  chrome.storage.local.get("ahrefsBase").then(function (r) { ahrefsBase = normBase(r.ahrefsBase) || AHREFS_DEFAULT; showBase(); }, showBase);
  $("saveAhrefs").addEventListener("click", function () {
    var b = normBase($("ahrefsBase").value);
    if (!b) { $("ahrefsSaved").textContent = "这不像网址，填 https://开头的域名，比如 https://ahrefs.3ue.com"; return; }
    ahrefsBase = b;
    chrome.storage.local.set({ ahrefsBase: b === AHREFS_DEFAULT ? "" : b }).then(function () {
      showBase();
      $("ahrefsSaved").textContent = "已保存：" + b.replace(/^https?:\/\//, "");
    });
  });
  $("openAhrefs").addEventListener("click", function () {
    var t = need();
    if (t) chrome.tabs.create({ url: ahrefsBase + "/site-explorer/overview?target=" + encodeURIComponent(t.host) + "&mode=subdomains" });
  });

  // 版本：本地加载的插件不会自动更新，谷歌趋势的内部接口一变就会取不到数，落后了就提示去下载新版
  var mine = chrome.runtime.getManifest().version;
  $("ver").textContent = "版本 " + mine;
  function newer(a, b) {
    var x = String(a).split("."), y = String(b).split(".");
    for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; }
    return false;
  }
  fetch("https://seo.web.cafe/extension/version.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (v && v.version && newer(v.version, mine)) {
      var el = $("update");
      el.hidden = false;
      el.textContent = "有新版本 " + v.version + "（你装的是 " + mine + "）。";
      var a = document.createElement("a");
      a.href = "https://seo.web.cafe/extension/";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "去下载";
      el.appendChild(a);
    }
  }).catch(function () {});
})();
