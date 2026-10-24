// Exercise the actual background capture/serialization functions with synthetic
// Chrome storage and parsed Similarweb pages. No browser, account or network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("../lib/agent-jobs.js");
const background = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const apiUrl = "https://sim.3ue.com/api/websiteanalysis/GetOutgoingTable?key=checkout.stripe.com&latest=28d";
function backgroundFunction(name, end) {
  const start = background.indexOf("function " + name + "(");
  const stop = background.indexOf(end, start);
  assert.ok(start >= 0 && stop > start);
  return background.slice(start, stop);
}
function harness(jobOverrides = {}) {
  let jobs = { 7: { kind: "capture", requestId: "a".repeat(32), url: "https://sim.3ue.com/#/referrals", extract: "sw_referrals",
    match: "GetOutgoingTable", minMs: 0, quietMs: 4000, maxItems: 30, pager: { times: 19 },
    items: [], seen: [], bytes: 0, pagesDone: 0, pagerEnd: "", ...jobOverrides } };
  const results = [], posts = [];
  const context = { URL, Date: class extends Date { constructor(...args) { super(...(args.length ? args : ["2026-10-20T08:00:00Z"])); } },
    G, loadJobs: async () => structuredClone(jobs), saveJobs: async value => { jobs = structuredClone(value); },
    serial: callback => Promise.resolve().then(callback), notify() {}, scheduleCaptureCheck() {}, setTimeout() {},
    chrome: { tabs: { get: async () => ({ url: "https://sim.3ue.com/#/referrals", title: "Synthetic report" }) },
      storage: { session: { get: async () => ({}), remove: async () => {}, set: async () => {} } } },
    agentApi: async (method, body) => { assert.equal(method, "POST"); posts.push(structuredClone(body)); return { ok: true }; },
    agentStatus() {}, THROTTLE_COOLDOWN_MS: 1000,
    finish: async (tabId, result) => { results.push(structuredClone(result)); delete jobs[tabId]; await context.agentDone("a".repeat(32), result); },
  };
  vm.runInNewContext(backgroundFunction("onCaptureItem", "/** 过一会儿看一眼") + "\n" +
    backgroundFunction("finishCapture", "/** fetch：") + "\n" + backgroundFunction("agentDone", "var polling = false;"), context);
  return { context, results, posts, job: () => jobs[7], page: async (number, records) => {
    jobs[7].pagesDone = number - 1;
    const body = JSON.stringify({ TotalCount: 2000, TotalVisits: 5000, Records: records });
    assert.ok(body.length <= G.MAX_ITEM_BODY, "individual source response fits the original capture limit");
    await context.onCaptureItem(7, { url: apiUrl, status: 200, ct: "application/json", body });
  } };
}
function rows(page, large = false) {
  return Array.from({ length: 100 }, (_, i) => ({ Domain: `p${page}-site${i}.example`, TotalVisits: i,
    ...(large ? { Children: Array.from({ length: 30 }, (_, j) => ({
      Domain: `p${page}r${i}c${j}.` + "a".repeat(60) + "." + "b".repeat(60) + ".example",
      TotalVisits: j, Category: "c".repeat(100),
    })) } : {}) }));
}
test("parsed data exceeding the real size limit fails without uploading partial rows", async () => {
  const h = harness();
  for (let page = 1; page <= 20 && !h.results.length; page++) await h.page(page, rows(page, true));
  assert.equal(h.results.length, 1, "actual size-limit branch stopped capture before the configured twenty-page limit");
  const result = h.results[0];
  // Optional local cross-repository replay evidence from the unfixed implementation.
  if (process.env.CAPTURE_LIMIT_LEGACY_REPORT && result.ok) fs.writeFileSync(process.env.CAPTURE_LIMIT_LEGACY_REPORT, JSON.stringify(h.posts[0]));
  assert.equal(result.ok, false, "partial capture must not be returned as success");
  assert.match(result.error, /数据量到上限/);
  assert.equal(h.posts[0].ok, false);
  assert.equal(h.posts[0].data, null, "wire result contains no partial rows");
});
for (const pages of [10, 20]) test(`normal ${pages}-page capture remains successful with all rows`, async () => {
  const h = harness({ pager: { times: pages - 1 } });
  for (let page = 1; page <= pages; page++) await h.page(page, rows(page));
  await h.context.finishCapture(7, false);
  assert.equal(h.results[0].ok, true);
  assert.equal(h.results[0].data.pages, pages);
  assert.equal(h.results[0].data.pagerEnd, "翻够了");
  assert.equal(h.posts[0].data.rows.length, pages * 100);
});
test("persisted size-limit failure cannot become success during later finalization", async () => {
  const parsed = G.EXTRACTORS.sw_referrals.page(JSON.stringify({ Records: rows(1) }), apiUrl);
  const h = harness({ captureError: "数据量到上限（已整理 1 页），停止翻页", pagerEnd: "数据量到上限（已整理 1 页），停止翻页", items: [{ url: apiUrl, page: 0, parsed }] });
  await h.context.finishCapture(7, false);
  assert.equal(h.posts[0].ok, false);
  assert.equal(h.posts[0].data, null);
});
test("serialized finalization rejects a stale successful result after the job exceeded its limit", async () => {
  const h = harness({ toAgent: true, captureError: "数据量到上限（已整理 3 页），停止翻页" });
  h.context.logActivity = () => {};
  h.context.chrome.tabs.remove = async () => {};
  vm.runInNewContext(backgroundFunction("finish", "function okResult("), h.context);
  await h.context.finish(7, { ok: true, data: { rows: [{ domain: "partial.test" }] } });
  assert.equal(h.posts[0].ok, false);
  assert.equal(h.posts[0].data, null);
  assert.match(h.posts[0].error, /数据量到上限/);
});

async function hookedResponse(body, via = "xhr", url = apiUrl, ct = "application/json") {
  const events = [];
  let control;
  const window = { addEventListener: (type, fn) => { control = fn; }, postMessage: data => events.push(data) };
  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  XHR.prototype.setRequestHeader = function () {};
  XHR.prototype.addEventListener = function (type, fn) { this.loaded = fn; };
  XHR.prototype.getResponseHeader = () => ct;
  const pending = [];
  window.fetch = async () => ({ url, status: 200, headers: { get: () => ct }, clone: () => ({ text: () => { const p = Promise.resolve(body); pending.push(p); return p; } }) });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content/capture-hook.js"), "utf8"), { window, location: { origin: "https://sim.3ue.com", href: "https://sim.3ue.com/" }, URL, XMLHttpRequest: XHR });
  control({ source: window, data: { source: "gefei-seo-capture-ctl", on: true } });
  if (via === "xhr") {
    const xhr = new XHR(); xhr.open("GET", url); xhr.responseType = "text"; xhr.responseText = body; xhr.responseURL = url; xhr.status = 200; xhr.send(); xhr.loaded();
  } else { await window.fetch(url); await Promise.all(pending); await Promise.resolve(); }
  // Run the real isolated-world bridge as well; it explicitly whitelists forwarded fields.
  let receive, forwarded;
  const bridgeWindow = { addEventListener: (type, fn) => { receive = fn; }, postMessage() {} };
  const chrome = { runtime: { sendMessage: (msg, callback) => { if (msg.type === "capture:hello") callback({ job: true }); else if (msg.type === "capture:item") forwarded = msg; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content/capture-bridge.js"), "utf8"), { window: bridgeWindow, chrome, location: { origin: "https://sim.3ue.com" }, setTimeout() {} });
  receive({ source: bridgeWindow, origin: "https://sim.3ue.com", data: events[0] });
  assert.equal(forwarded.type, "capture:item");
  return forwarded;
}
for (const via of ["xhr", "fetch"]) test(`raw oversized ${via} response fails the whole capture without sending earlier pages`, async () => {
  const h = harness(); await h.page(1, rows(1));
  const body = JSON.stringify({ Records: rows(2), TopCategories: "x".repeat(6000001) });
  const event = await hookedResponse(body, via);
  assert.equal(event.body, null); assert.ok(event.size > 6000000); assert.match(event.captureError, /数据量到上限/);
  await h.context.onCaptureItem(7, event);
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].ok, false); assert.equal(h.posts[0].data, null);
  assert.match(h.posts[0].error, /原始响应正文过大/);
});
test("hook preserves the exact size boundary and ignores unrelated or non-JSON oversize responses", async () => {
  const boundary = await hookedResponse("x".repeat(6000000));
  assert.equal(boundary.body.length, 6000000); assert.equal(boundary.captureError, undefined);
  const h = harness(); await h.page(1, rows(1));
  await h.context.onCaptureItem(7, await hookedResponse("x".repeat(6000001), "xhr", "https://sim.3ue.com/unrelated"));
  await h.context.onCaptureItem(7, await hookedResponse("x".repeat(6000001), "xhr", apiUrl, "text/html"));
  assert.equal(h.posts.length, 0); assert.equal(h.job().captureError, undefined);
  await h.context.finishCapture(7, false); assert.equal(h.posts[0].ok, true); assert.equal(h.posts[0].data.rows.length, 100);
});
