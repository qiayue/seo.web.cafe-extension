// lib/agent-jobs.js — 远程任务（0.11.0 起）的纯逻辑：云端派来的任务怎么认、开哪个网址、在网页里怎么请求、怎么翻页
//
// 云端（NewTrend）把取数任务派到 new.web.cafe，插件每分钟去领一张（background.js agentPoll），在你的浏览器里用你登录着的账号做完，
// 把结果交回 new.web.cafe。任务里只写「哪个网站 + 路径」，不写域名：域名用你在侧边栏「设置」里填的地址
// （Similarweb 默认官方 https://pro.similarweb.com；填成共享账号的镜像站就用共享账号抓）。
// 不认识的网站一律不开——任务是从云端来的，别让它借你的登录状态去开别的网站。new.web.cafe 那边 src/utils/extAgent.ts 是同一套规矩。
//
// 同时被后台 service worker（importScripts）、侧边栏和 Node 测试（require）用到；fetchInPage / clickNext 还会被整个序列化进网页里执行。
(function (root) {
  "use strict";

  /** 远程任务能开的网站：key → 名字、默认地址、设置里存地址的键 */
  var SITES = {
    similarweb: { name: "Similarweb", defaultBase: "https://pro.similarweb.com", storeKey: "similarwebBase" },
  };
  var KINDS = ["page", "capture", "fetch"];
  var AGENT_SERVERS = ["https://new.web.cafe"]; // 只认这个网站发的任务、只往这里交结果
  var MAX_ITEM_BODY = 1500000;  // 一段截下来 / 请求回来的数据最多多大
  var MAX_TOTAL = 3800000;      // 一个任务交回去的数据合计最多多大（new.web.cafe 收 4MB）
  var MAX_SEEN = 400;           // capture 记下的「页面请求过哪些接口」最多几条

  // ---------- 解析器：在浏览器里就把截到的数据整理成一行一行（哥飞 2026-10-05：「你需要用插件提取有效的数据，
  // 做好格式化处理后返回给你，而不是整个 html 都给你」）。capture 任务带 extract 时，交回去的只有整理好的行，不带原始数据 ----------
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; } // null 不能当 0（被锁的行点击数是 null）
  /** 一行是不是被锁了（账号权限不够：网址打码、点击数没有、写着要升级）。
   *  哥飞 2026-10-05：「如果发现拿到的数据是不完整的，提示有些列需要升级才能看到数据，那么你就停止翻页，并且当前页不完整数据都丢弃」 */
  function swRowLocked(r) {
    var url = String(r && r.Url || "");
    if (!url || /\*{2,}|upgrade|locked/i.test(url)) return true;
    if (num(r.Clicks) == null) return true;
    try { if (/upgrade|locked|paywall/i.test(JSON.stringify(r))) return true; } catch (e) {}
    return false;
  }
  /** Similarweb「着陆页」的一页数据完不完整：有两成以上的行被锁，就算这一页起要升级才看得到 */
  function swPageCheck(json) {
    var data = json && Array.isArray(json.Data) ? json.Data : [];
    var locked = data.filter(swRowLocked).length;
    return { rows: data.length, locked: locked, complete: data.length > 0 && locked < data.length * 0.2 };
  }
  /** Similarweb「着陆页」（websiteOrganicLandingPagesV2）的一页 → 行（被锁的行不要） */
  function swLandingRows(json) {
    var data = json && Array.isArray(json.Data) ? json.Data : [];
    return data.filter(function (r) { return !swRowLocked(r); }).map(function (r) {
      var url = String(r && r.Url || "").slice(0, 500);
      var trend = r && r.Trend && typeof r.Trend === "object" ? Object.keys(r.Trend).sort().map(function (d) { return [d, num(r.Trend[d])]; }) : [];
      return {
        url: url,
        host: url.split(/[/?#]/)[0].toLowerCase(),
        clicks: num(r.Clicks), desktopClicks: num(r.DesktopClicks), prevClicks: num(r.PrevClicks),
        change: num(r.ClicksChange), share: num(r.ClicksShare), state: String(r.ChangeState || ""),
        keywords: num(r.KeywordsCount), topKeyword: String(r.TopKeyword || "").slice(0, 200),
        position: num(r.PositionOverall), trend: trend,
      };
    }).filter(function (r) { return r.url; });
  }
  var EXTRACTORS = {
    sw_landing: {
      match: /websiteOrganicLandingPages/i,
      /** 每到一页先看完不完整（后台据此决定停不停翻页、这一页要不要） */
      check: function (body) { var j; try { j = JSON.parse(body); } catch (e) { return null; } return swPageCheck(j); },
      /** 一页 → 整理好的行 + 这一页的元信息（后台每到一页就整理，只留行，不留原始数据，省地方也能翻得更深） */
      page: function (body, url) {
        var json = JSON.parse(body), period = null;
        try {
          var q = new URL(url).searchParams;
          period = { from: q.get("from") || "", to: q.get("to") || "", latest: q.get("latest") || "", isWindow: q.get("isWindow") === "true", key: q.get("key") || "" };
        } catch (e) {}
        return { total: json && json.TotalCount != null ? num(json.TotalCount) : null, period: period, rows: swLandingRows(json) };
      },
      /** 截到的几页 → { total, rows（按 url 去重，保留先到的）, period（接口上的 from / to / latest） } */
      run: function (items) {
        var rows = [], seen = {}, total = null, period = null;
        items.forEach(function (it) {
          if (it.parsed) { // 后台已经按页整理过
            if (total == null) total = it.parsed.total;
            if (!period) period = it.parsed.period;
            it.parsed.rows.forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; r.page = it.page; rows.push(r); } });
            return;
          }
          var json;
          try { json = JSON.parse(it.body); } catch (e) { return; }
          if (total == null && json && json.TotalCount != null) total = num(json.TotalCount);
          if (!period) {
            try {
              var q = new URL(it.url).searchParams;
              period = { from: q.get("from") || "", to: q.get("to") || "", latest: q.get("latest") || "", isWindow: q.get("isWindow") === "true", key: q.get("key") || "" };
            } catch (e) {}
          }
          swLandingRows(json).forEach(function (r) { if (!seen[r.url]) { seen[r.url] = 1; r.page = it.page; rows.push(r); } });
        });
        return { total: total, period: period, rows: rows };
      },
    },
  };

  /** 用户填的网站地址 → https://域名（官方或镜像站）；不像网址返回 null，空的回默认 */
  function normBase(raw, dflt) {
    var s = String(raw || "").trim();
    if (!s) return dflt || null;
    try {
      var u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
      if (u.protocol !== "https:" || !/\./.test(u.hostname) || u.username || u.password) return null;
      return u.origin;
    } catch (e) { return null; }
  }
  /** 站内路径：以 / 开头（# 后面的单页应用路由照留），不许带协议和域名；不对返回 "" */
  function cleanPath(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (s.charAt(0) !== "/" || s.charAt(1) === "/" || s.length > 2000 || /[\u0000-\u001f\s]/.test(s)) return "";
    try { return new URL(s, "https://x.invalid").origin === "https://x.invalid" ? s : ""; } catch (e) { return ""; }
  }
  function clampInt(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }
  var HEADER_RE = /^[a-z0-9-]{1,60}$/i;
  var HEADER_BLOCK = /^(cookie|authorization|host|origin|referer|content-length|proxy-.*|sec-.*)$/i;

  /** 云端派来的一张任务 + 各网站的地址（{ similarweb: "https://…" }）→ 插件要做的事；不合规抛错（错误原样交回云端）。
   *  返回 { requestId, kind, site, base, url, …这类任务自己的参数 } */
  function normAgentJob(job, bases) {
    var id = String(job && job.requestId || "");
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("任务单号不对");
    var kind = String(job.kind || "");
    if (KINDS.indexOf(kind) < 0) throw new Error("插件不认识这类任务：" + kind.slice(0, 20));
    var site = String(job.site || "");
    if (!Object.prototype.hasOwnProperty.call(SITES, site)) throw new Error("插件不开这个网站：" + site.slice(0, 30));
    var base = normBase(bases && bases[site], SITES[site].defaultBase);
    if (!base) throw new Error(SITES[site].name + " 地址设置得不对，打开插件侧边栏「设置」检查一下");
    var path = cleanPath(job.path || "/");
    if (!path) throw new Error("路径不对（要以 / 开头，不能带域名）");
    var out = { requestId: id, kind: kind, site: site, base: base, url: base + path };
    if (kind === "page") { out.minMs = clampInt(job.minMs, 0, 15000, 0); out.around = String(job.around || "").slice(0, 100); return out; }
    if (kind === "capture") {
      var match = String(job.match || "").slice(0, 300);
      if (match) { try { new RegExp(match); } catch (e) { throw new Error("match 不是合法的正则"); } }
      out.match = match;
      out.minMs = clampInt(job.minMs, 0, 60000, 3000);
      out.quietMs = clampInt(job.quietMs, 1000, 20000, 5000);
      out.timeoutMs = clampInt(job.timeoutMs, 15000, 1800000, 90000); // 一直往后翻的任务可能要十几分钟
      out.maxItems = clampInt(job.maxItems, 1, 400, 40);
      out.extract = job.extract ? String(job.extract) : "";
      if (out.extract && !EXTRACTORS[out.extract]) throw new Error("插件不认识这个解析器：" + out.extract.slice(0, 30));
      if (out.extract && !out.match) out.match = EXTRACTORS[out.extract].match.source;
      out.pager = null;
      if (job.pager) {
        // 翻页按钮：selector（CSS 选择器），或者 near（翻页条上的一段文字，比如 "out of"：点它后面的第一个箭头）
        var sel = String(job.pager.selector || "").trim().slice(0, 300), near = String(job.pager.near || "").trim().slice(0, 40);
        if (!sel && !near) throw new Error("翻页要给按钮的选择器，或者翻页条上的一段文字");
        out.pager = { selector: sel, near: near, times: clampInt(job.pager.times, 1, 400, 4), waitMs: clampInt(job.pager.waitMs, 1000, 20000, 4000) };
      }
      return out;
    }
    var list = Array.isArray(job.requests) ? job.requests : [];
    if (!list.length || list.length > 60) throw new Error("requests 要有 1~60 个");
    out.requests = list.map(function (r, i) {
      var p = cleanPath(typeof r === "string" ? r : r && r.path);
      if (!p) throw new Error("requests[" + i + "] 要是同一个网站的路径");
      var headers = {};
      var h = r && typeof r === "object" && r.headers && typeof r.headers === "object" ? r.headers : {};
      Object.keys(h).slice(0, 10).forEach(function (name) {
        if (!HEADER_RE.test(name) || HEADER_BLOCK.test(name)) throw new Error("requests[" + i + "] 不能带请求头 " + name);
        headers[name] = String(h[name] == null ? "" : h[name]).slice(0, 500);
      });
      return { url: base + p, headers: headers };
    });
    out.delayMs = clampInt(job.delayMs, 300, 15000, 1500);
    out.transport = job.transport === "xhr" ? "xhr" : "fetch"; // xhr：走页面自己的 XMLHttpRequest（有的镜像站只给 XHR 加认证）
    out.timeoutMs = clampInt(job.timeoutMs, 15000, 300000, 120000);
    return out;
  }

  /** 各网站现在用的地址（侧边栏「设置」里存的，没设就是默认）：{ similarweb: "https://…" } */
  function basesFrom(stored) {
    var out = {};
    Object.keys(SITES).forEach(function (k) { out[k] = normBase(stored && stored[SITES[k].storeKey], SITES[k].defaultBase) || SITES[k].defaultBase; });
    return out;
  }

  /** 在网页里执行（world: MAIN）：带着浏览器自己的登录态，依次请求同一个网站的接口，原样交回。
   *  只能用自己里面的东西，不能引用外面的变量 */
  function fetchInPage(requests, delayMs, maxBody, maxTotal, transport) {
    var out = [], total = 0;
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var run = function (i) {
      if (i >= requests.length) return Promise.resolve(out);
      var r = requests[i];
      var pre = i ? wait(delayMs) : Promise.resolve();
      return pre.then(function () {
        if (new URL(r.url, location.href).origin !== location.origin) { out.push({ url: r.url, status: 0, error: "不是同一个网站" }); return; }
        var go = transport === "xhr" ? new Promise(function (resolve, reject) {
          var x = new XMLHttpRequest();
          x.open("GET", r.url);
          x.withCredentials = true;
          Object.keys(r.headers || {}).forEach(function (k) { try { x.setRequestHeader(k, r.headers[k]); } catch (e) {} });
          x.onload = function () { resolve({ url: x.responseURL, status: x.status, ct: x.getResponseHeader("content-type") || "", text: String(x.responseText || "") }); };
          x.onerror = function () { reject(new Error("XHR 出错")); };
          x.send();
        }) : fetch(r.url, { credentials: "include", headers: r.headers || {} }).then(function (res) {
          return res.text().then(function (text) { return { url: res.url, status: res.status, ct: res.headers.get("content-type") || "", text: text }; });
        });
        return go.then(function (res) {
          return Promise.resolve(res.text).then(function (body) {
            var item = { url: r.url, finalUrl: res.url, status: res.status, contentType: res.ct, bytes: body.length };
            if (body.length > maxBody) { item.truncated = true; body = body.slice(0, maxBody); }
            if (total + body.length > maxTotal) { item.dropped = true; body = ""; }
            total += body.length;
            item.body = body;
            out.push(item);
          });
        }, function (e) { out.push({ url: r.url, status: 0, error: String((e && e.message) || e).slice(0, 200) }); });
      }).then(function () { return run(i + 1); });
    };
    return run(0);
  }

  /** 在网页里执行：点一下「下一页」按钮。selector 直接指定；或者 near：找到页面上这段文字（翻页条上的 "out of"），
   *  点它后面的第一个按钮 / 箭头图标（翻页条一般是「|< < [3] out of 944 > >|」）。找不到、被禁用了返回 { ok: false, why } */
  function clickNext(selector, near) {
    var visible = function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    var el = null;
    if (selector) {
      var list = Array.prototype.slice.call(document.querySelectorAll(selector));
      el = list.filter(visible)[0] || list[0] || null;
    } else if (near) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), node, anchor = null;
      while ((node = walker.nextNode())) {
        if (String(node.nodeValue || "").indexOf(near) >= 0 && node.parentElement && visible(node.parentElement)) { anchor = node.parentElement; break; }
      }
      if (!anchor) return { ok: false, why: "页面上找不到「" + near + "」（翻页条）" };
      var box = anchor;
      for (var up = 0; box && up < 6 && !el; up++) {
        var cands = Array.prototype.slice.call(box.querySelectorAll("button, [role=button], a, svg")).filter(function (c) {
          return visible(c) && (anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) && !anchor.contains(c);
        });
        if (cands.length) el = cands[0].tagName.toLowerCase() === "svg" ? (cands[0].closest("button, [role=button], a") || cands[0].parentElement) : cands[0];
        box = box.parentElement;
      }
    }
    if (!el) return { ok: false, why: "找不到翻页按钮" };
    var cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || "");
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(cls)) return { ok: false, why: "已经是最后一页" };
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    // 有的网站把点击挂在 div 上、不是 button：派一整套鼠标事件，比单调 click() 稳
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    });
    return { ok: true };
  }

  /** 按解析器整理截到的数据（后台 finishCapture 用） */
  function runExtract(name, items) { return EXTRACTORS[name] ? EXTRACTORS[name].run(items) : null; }

  var api = { SITES: SITES, EXTRACTORS: EXTRACTORS, runExtract: runExtract, swLandingRows: swLandingRows, swRowLocked: swRowLocked, swPageCheck: swPageCheck, KINDS: KINDS, AGENT_SERVERS: AGENT_SERVERS, MAX_ITEM_BODY: MAX_ITEM_BODY, MAX_TOTAL: MAX_TOTAL, MAX_SEEN: MAX_SEEN,
    normBase: normBase, cleanPath: cleanPath, normAgentJob: normAgentJob, basesFrom: basesFrom, fetchInPage: fetchInPage, clickNext: clickNext };
  root.GefeiAgentJobs = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
