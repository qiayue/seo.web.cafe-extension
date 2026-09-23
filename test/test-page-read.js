// test/test-page-read.js — 用浏览器打开网页：哪些网址能开（node test/test-page-read.js）
//
// Agent 会请插件在你的浏览器里打开网页、读回页面内容——网页里的文字可能诱导 Agent 去开别的网址，
// 所以插件自己把关：只开 http / https 的公网网址，本机、局域网、带账号密码的一律不开。
"use strict";
const assert = require("node:assert/strict");
const R = require("../lib/page-read.js");
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✕ " + name + "  " + e.message); }
}
check("公网 http / https 照开，# 后面的留着（单页应用靠它分页面）", () => {
  assert.equal(R.normPageUrl("https://swmedbueei.feishu.cn/sheets/UZp?x=1#/tab"), "https://swmedbueei.feishu.cn/sheets/UZp?x=1#/tab");
  assert.equal(R.normPageUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(R.normPageUrl("https://8.8.8.8/"), "https://8.8.8.8/");
});
check("本机、局域网、内网主机名一律不开", () => {
  for (const u of ["https://localhost/x", "http://127.0.0.1:8080/", "http://192.168.1.1/admin", "https://10.0.0.5/", "http://172.16.3.4/", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/", "https://intranet/", "https://printer.local/", "https://nas.lan/", "https://[::1]/", "http://0.0.0.0/"]) assert.equal(R.normPageUrl(u), "", u);
});
check("带账号密码的、不是 http(s) 的、太长的不开", () => {
  for (const u of ["https://user:pw@example.com/", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "ftp://example.com/", "https://example.com/" + "a".repeat(2000), ""]) assert.equal(R.normPageUrl(u), "", u.slice(0, 40));
});
check("读页面的函数能单独序列化进网页执行（不引用外面的变量）", () => {
  const src = R.extractPage.toString();
  assert.ok(!/\bR\.|\bMAX_TEXT\b|\bMAX_HTML\b/.test(src));
  assert.equal(R.extractPage.length, 2);
});
console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
