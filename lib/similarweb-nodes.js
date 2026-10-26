// Optional 3ue session preparation. Uses the portal UI, never cookies or private APIs.
(function (root) {
  'use strict';
  var PORTAL = 'https://dash.3ue.com/zh-Hans/#/page/m/home';
  var BASE = 'https://sim.3ue.com';
  function nodeOrder(raw) {
    var values = String(raw == null ? '4,1,2,3' : raw).split(/[,，\s]+/).filter(Boolean);
    if (!values.length || values.some(function (v) { return !/^[1-4]$/.test(v); })) throw new Error('节点顺序只允许1至4，以逗号分隔。');
    return Array.from(new Set(values.map(Number)));
  }
  // Serialized into the portal; returns only state and node numbers, no account data.
  function portalStep(node, action) {
    var visible = function (el) { return !!(el && el.getClientRects().length); };
    var notices = Array.from(document.querySelectorAll('nb-toast, [role="alert"], nb-dialog-container')).filter(visible).map(function (e) { return e.innerText; }).join(' ');
    if (/429|403|配额.*(不足|耗尽|上限)|请求.*频繁|限流|too many requests/i.test(notices)) return { state: 'blocked' };
    var text = document.body ? document.body.innerText : '';
    if (/(?:^|\n)\s*(?:403|429)\b|forbidden|too many requests|请求过于频繁/i.test(text)) return { state: 'blocked' };
    if (visible(document.querySelector('input[type="password"]'))) return { state: 'login' };
    var cards = Array.from(document.querySelectorAll('nb-card')).filter(function (c) { return !!c.querySelector('.logo[style*="similarweb.svg"]'); });
    if (/人机验证|安全验证|验证码|verify you are human|checking your browser|just a moment/i.test(cards.length ? notices : text)
      || Array.from(document.querySelectorAll('#challenge-form, .cf-turnstile, iframe[src*="captcha"]')).some(visible)) return { state: 'challenge' };
    if (/人数.*(满|上限)|节点.*(繁忙|拥挤|不可用|维护)|服务.*(不可用|维护)|capacity|unavailable/i.test(notices)) return { state: 'busy' };
    if (cards.length !== 1) return { state: document.querySelector('input[type="password"]') ? 'login' : 'wait' };
    var card = cards[0], select = card.querySelector('nb-select[placeholder="未选择节点"] button');
    if (!select) return { state: 'wait' };
    var selected = /节点\s*(\d+)/.exec(select.innerText);
    if (action === 'status') return { state: 'wait' };
    if (action === 'open') {
      if (!selected || Number(selected[1]) !== node) return { state: 'changed' };
      var buttons = Array.from(card.querySelectorAll('button')).filter(function (b) { return b.innerText.trim() === '打开'; });
      if (buttons.length !== 1 || buttons[0].disabled) return { state: 'disabled' };
      buttons[0].click(); return { state: 'opened' };
    }
    if (selected && Number(selected[1]) === node) return { state: 'selected' };
    var options = Array.from(document.querySelectorAll('nb-option')).filter(visible);
    if (!options.length) { select.click(); return { state: 'wait' }; }
    var option = options.find(function (o) { return new RegExp('^节点\\s*' + node + '(?:\\s|$)').test(o.innerText.trim()); });
    if (!option || option.getAttribute('aria-disabled') === 'true') return { state: 'missing' };
    option.click(); return { state: 'wait' };
  }
  // Serialized into an extension-owned node tab. Do not inspect user-created tabs.
  function sourceState() {
    var text = document.body ? document.body.innerText : '';
    if (/(?:^|\s)(?:403|429)(?:\s|$)|forbidden|too many requests|请求过于频繁|配额已用完|配额不足/i.test(text)) return 'blocked';
    if (/节点.*(繁忙|拥挤|不可用|维护)|人数.*(已满|上限)|service unavailable|bad gateway|gateway timeout/i.test(text)) return 'busy';
    if (document.querySelector('input[type="password"]')) return 'login';
    var ready = document.querySelector('#react-app') && /Web Intelligence|网站分析|Website Analysis/.test(text);
    var notices = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"]')).filter(function(el){return !!el.getClientRects().length;}).map(function(el){return el.innerText;}).join(' ');
    // Report keywords may themselves mention verification; use gate UI when
    // the application is ready, rather than treating report content as a gate.
    if (/人机验证|安全验证|验证码|verify you are human|checking your browser|just a moment/i.test(ready ? notices : text)
      || Array.from(document.querySelectorAll('#challenge-form, .cf-turnstile, iframe[src*="captcha"]')).some(function(el){return !!el.getClientRects().length;})) return 'challenge';
    return ready ? 'ready' : 'wait';
  }
  async function prepare(chromeApi, config, options) {
    options = options || {};
    var delay = options.delay || function () { return new Promise(function (r) { setTimeout(r, 1000); }); };
    var limit = options.polls || 60;
    var now = options.now || Date.now;
    var foregroundAfterMs = options.foregroundAfterMs == null ? 8000 : options.foregroundAfterMs;
    var portalReloadAfterMs = options.portalReloadAfterMs == null ? 15000 : options.portalReloadAfterMs;
    var preparationReloads = 0;
    function progress(message) { if (typeof options.onProgress === 'function') options.onProgress(message); }
    var order = nodeOrder(config.similarwebNodes);
    if (!await chromeApi.permissions.contains({ origins: ['https://dash.3ue.com/*', BASE + '/*'] })) throw new Error('请在插件中允许3ue节点选择和Similarweb访问。');
    var originalTabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
    var returnTabId = originalTabs[0] ? originalTabs[0].id : null;
    var portal, children = [], selectedTab = null, foregroundAt = null;
    function created(t) { if (portal && t.openerTabId === portal.id) children.push(t.id); }
    chromeApi.tabs.onCreated.addListener(created);
    async function probe(tabId, func, args) {
      var current = await chromeApi.tabs.get(tabId);
      if (current.status === "loading") return null;
      var allowedOrigin = func === portalStep ? "https://dash.3ue.com" : BASE;
      var actualOrigin;
      try { actualOrigin = new URL(current.url || "about:blank").origin; } catch (e) { actualOrigin = "无法识别地址"; }
      if (actualOrigin !== allowedOrigin) {
        // Report only origins, never the redirect path/query (which may contain
        // a one-time login token). Keep the same fail-closed origin check.
        var stage = func === portalStep ? "3ue用户中心" : "Similarweb来源";
        var address = actualOrigin === "null" ? "空白或非网页地址" : actualOrigin;
        throw new Error("节点页面离开已授权网站：" + stage + "，当前域名：" + address + "；预期域名：" + allowedOrigin + "。请手动检查。");
      }
      var result = await chromeApi.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [] });
      return result && result[0] && result[0].result;
    }
    async function close(id) { await chromeApi.tabs.remove(id).catch(function () {}); }
    try {
      portal = await chromeApi.tabs.create({ url: PORTAL, active: false });
      for (var attempt = 0; attempt < order.length; attempt++) {
        var node = order[attempt];
        if (attempt > 0) {
          var previous = await chromeApi.tabs.get(portal.id);
          if (new URL(previous.url || "about:blank").origin === "https://dash.3ue.com") await chromeApi.tabs.reload(portal.id);
          else await chromeApi.tabs.update(portal.id, { url: PORTAL });
        }
        var state = 'wait', selectStartedAt = now(), portalForegroundTried = false, portalReloadTried = false;
        for (var i = 0; i < limit; i++) {
          state = (await probe(portal.id, portalStep, [node, 'select']) || {}).state || 'wait';
          if (['selected', 'missing', 'busy', 'blocked', 'login', 'challenge'].indexOf(state) >= 0) break;
          if (!portalForegroundTried && now() - selectStartedAt >= foregroundAfterMs) {
            await chromeApi.tabs.update(portal.id, { active: true });
            portalForegroundTried = true; foregroundAt = foregroundAt || now();
            progress('3ue用户中心加载较慢，已切到前台等待。');
          }
          if (!portalReloadTried && now() - selectStartedAt >= portalReloadAfterMs) {
            var waiting = await chromeApi.tabs.get(portal.id);
            if (new URL(waiting.url || 'about:blank').origin === 'https://dash.3ue.com') {
              portalReloadTried = true; preparationReloads++;
              progress('3ue用户中心未就绪，正在原节点自动重载一次。');
              await chromeApi.tabs.reload(portal.id);
            }
          }
          await delay();
        }
        if (state === 'blocked') throw new Error('3ue疑似被限流或配额不足，停止节点切换。');
        if (state === 'login') throw new Error('请先登录3ue用户中心。');
        if (state === 'challenge') throw new Error('3ue用户中心需要人工验证，已停止自动重载和节点切换。');
        if (state !== 'selected') {
          if (state === 'wait') throw new Error(portalReloadTried ? '3ue用户中心自动重载一次后仍未就绪，请检查页面；未切换备用节点。' : '3ue节点选择页面未就绪，请检查登录状态或页面结构。');
          continue;
        }
        children.length = 0;
        // Chrome can attribute an injected window.open to the active tab. Bring
        // our portal forward before opening so openerTabId stays verifiable.
        await chromeApi.tabs.update(portal.id, { active: true });
        foregroundAt = foregroundAt || now();
        state = (await probe(portal.id, portalStep, [node, 'open']) || {}).state || 'wait';
        if (state === 'blocked') throw new Error('3ue疑似被限流或配额不足，停止节点切换。');
        if (state !== 'opened') { if (state === 'busy') continue; throw new Error('3ue节点选择发生变化，请重试。'); }
        var ready = false, waitStartedAt = now(), foregroundTried = false, sourceReloadTried = false;
        for (var n = 0; n < limit; n++) {
          if (children.length > 1) throw new Error('3ue打开了多个窗口，停止本次任务。');
          // The portal may open a child OR navigate its own tab to Similarweb.
          // Both are ours; never discover or adopt an existing user tab.
          var tab = await chromeApi.tabs.get(children.length ? children[0] : portal.id);
          var tabOrigin; try { tabOrigin = new URL(tab.url || tab.pendingUrl || '').origin; } catch (e) { tabOrigin = ''; }
          if (children.length || tabOrigin === BASE) {
            if (tab.active && !foregroundAt) foregroundAt = now();
            var origin; try { origin = new URL(tab.url || tab.pendingUrl || '').origin; } catch (e) { origin = ''; }
            // Login flows may briefly use about:blank. Never inject into a different host.
            if (origin && origin !== 'null' && origin !== BASE) throw new Error('3ue节点跳到了其他网站，请手动检查登录。');
            if (origin === BASE) {
              // Same visible-page fallback used by capture: some app shells do not
              // finish loading while hidden. Only activate our own verified tab.
              if (!tab.active && !foregroundTried && now() - waitStartedAt >= foregroundAfterMs) {
                await chromeApi.tabs.update(tab.id, { active: true });
                foregroundTried = true; foregroundAt = foregroundAt || now();
              }
              state = await probe(tab.id, sourceState);
              if (state === 'ready') { ready = true; selectedTab = tab.id; break; }
              if (state === 'blocked') throw new Error('Similarweb疑似被限流或配额不足，停止节点切换。');
              if (state === 'login') throw new Error('请先完成Similarweb登录。');
              if (state === 'challenge') throw new Error('Similarweb需要人工验证，已停止自动重载和节点切换。');
              if (state === 'busy') break;
              if ((state === 'wait' || state == null) && !sourceReloadTried && now() - waitStartedAt >= portalReloadAfterMs) {
                sourceReloadTried = true; preparationReloads++;
                progress('Similarweb准备页面未就绪，正在原节点自动重载一次。');
                await chromeApi.tabs.reload(tab.id);
              }
            }
          } else {
            if (tab.status === 'loading') { await delay(); continue; }
            state = (await probe(portal.id, portalStep, [node, 'status']) || {}).state || 'wait';
            if (state === 'blocked') throw new Error('3ue疑似被限流或配额不足，停止节点切换。');
            if (state === 'busy') break;
          }
          await delay();
        }
        if (ready) return { tabId: selectedTab, node: node, returnTabId: returnTabId, foregroundAt: foregroundAt, preparationReloads: preparationReloads };
        for (var id of children) await close(id);
        children.length = 0;
        // Only an explicit capacity/unavailable response permits a fallback. A generic
        // timeout could be login, a challenge or a changed UI; do not cycle accounts.
        if (state !== 'busy') throw new Error('3ue节点未就绪，请手动检查；未自动切换备用节点。');
      }
      throw new Error('所选3ue节点均不可用，请稍后重试或调整节点顺序。');
    } finally {
      chromeApi.tabs.onCreated.removeListener(created);
      if (portal && portal.id !== selectedTab) await close(portal.id);
      for (var id of children) if (id !== selectedTab) await close(id);
      if (!selectedTab && foregroundAt && returnTabId) await chromeApi.tabs.update(returnTabId, { active: true }).catch(function () {});
    }
  }
  var api = { PORTAL: PORTAL, BASE: BASE, nodeOrder: nodeOrder, portalStep: portalStep, sourceState: sourceState, prepare: prepare };
  root.GefeiSimilarwebNodes = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
