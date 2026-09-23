// test/test-manifest.js — manifest 与目录结构（node test/test-manifest.js）
//
// 本地加载的插件，用户装之前会看权限清单：权限只许这么多，多一个都要想清楚。
// 另外钉住几件 Chrome 会直接拒绝加载的事：引用的文件不存在、根目录有下划线开头的文件名、引用远程脚本。
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✕ " + name + "  " + e.message); }
}
const exists = (p) => fs.existsSync(path.join(ROOT, p));

check("MV3", () => assert.equal(m.manifest_version, 3));
check("版本号是三段数字（侧边栏拿它和网站上的最新版比）", () => assert.match(m.version, /^\d+\.\d+\.\d+$/));
check("权限只有这四个：侧边栏、存进行中的取数任务、点图标时读当前网页、插件更新后把传话脚本补进已打开的对话页", () => {
  assert.deepEqual([...m.permissions].sort(), ["activeTab", "scripting", "sidePanel", "storage"]);
});
check("不申请 tabs / 全部网站 / 历史记录这类大权限", () => {
  assert.ok(!m.permissions.includes("tabs") && !m.permissions.includes("history"));
});
check("「读取标签页网址」（tabs）只作可选权限：用户在侧边栏点「自动跟随当前网页」时才要", () => {
  assert.deepEqual(m.optional_permissions, ["tabs"]);
  assert.ok(!m.permissions.includes("tabs"));
});
check("读 Ahrefs 的站点权限是可选的（https 任意站，运行时只申请你设置的那一个 Ahrefs 地址），装的时候不多问", () => {
  assert.deepEqual(m.optional_host_permissions, ["https://*/*"]);
  assert.ok(!m.host_permissions.some((h) => /ahrefs/.test(h)));
});
check("Ahrefs 的脚本不写死在 manifest 里（允许之后由后台按设置的地址注册），但文件都在", () => {
  assert.ok(!m.content_scripts.some((c) => c.matches.some((x) => /ahrefs/.test(x))));
  ["content/awake.js", "content/ahrefs-hook.js", "content/ahrefs-bridge.js", "lib/ahrefs-parse.js"].forEach((f) => assert.ok(exists(f), f));
});
check("谷歌趋势：让后台标签页照常加载的 awake.js 排在截数据脚本前面", () => {
  const hook = m.content_scripts.find((c) => c.js.includes("content/trends-hook.js"));
  assert.deepEqual(hook.js, ["content/awake.js", "content/trends-hook.js"]);
});
check("站点权限只有两个站：谷歌趋势（看得到取数标签页的网址）、seo.web.cafe（插件更新后把传话脚本补进已打开的对话页）", () => {
  // 内容脚本的 matches 不算站点权限：只有它的话，后台读 tab.url 永远是空的，每个取数标签页都会被当成「被跳走了」；
  // 也没法往已经打开的对话页里补脚本。这两个站本来就在内容脚本里，安装时不会多出新的权限提示
  assert.deepEqual([...m.host_permissions].sort(), ["https://seo.web.cafe/*", "https://trends.google.com/*"]);
});
check("内容脚本只进两个站：seo.web.cafe 与 trends.google.com", () => {
  const sites = new Set(m.content_scripts.flatMap((c) => c.matches));
  assert.deepEqual([...sites].sort(), ["https://seo.web.cafe/*", "https://trends.google.com/*"]);
});
check("截数据的脚本跑在页面自己的环境里（MAIN），并且在页面发请求之前就位（document_start）", () => {
  const hook = m.content_scripts.find((c) => c.js.includes("content/trends-hook.js"));
  assert.equal(hook.world, "MAIN");
  assert.equal(hook.run_at, "document_start");
});
check("对话页的传话脚本在页面脚本之前就位（document_start），好让页面同步认出插件", () => {
  const bridge = m.content_scripts.find((c) => c.js.includes("content/site-bridge.js"));
  assert.equal(bridge.run_at, "document_start");
});
check("引用到的文件都在", () => {
  const files = [m.background.service_worker, m.side_panel.default_path, ...Object.values(m.icons), ...Object.values(m.action.default_icon),
    ...m.content_scripts.flatMap((c) => c.js)];
  const missing = files.filter((f) => !exists(f));
  assert.deepEqual(missing, []);
});
check("后台用 importScripts 引的文件也在", () => {
  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const imported = [...bg.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((x) => [...x[1].matchAll(/"([^"]+)"/g)].map((y) => y[1]));
  assert.ok(imported.includes("lib/trends-parse.js") && imported.includes("lib/ahrefs-parse.js"), imported.join());
  assert.deepEqual(imported.filter((f) => !exists(f)), []);
});
check("根目录没有下划线开头的文件（Chrome 保留，会拒绝加载）", () => {
  const bad = fs.readdirSync(ROOT).filter((f) => f.startsWith("_"));
  assert.deepEqual(bad, []);
});
check("不引用远程脚本（MV3 不允许，也不该这么做）", () => {
  const html = fs.readFileSync(path.join(ROOT, m.side_panel.default_path), "utf8");
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
  assert.ok(!/<script>(?!\s*<\/script>)/i.test(html), "扩展页面不许写内联脚本");
});
check("最低 Chrome 版本够用 sidePanel.open（116）与 MAIN 环境内容脚本（111）", () => {
  assert.ok(Number(m.minimum_chrome_version) >= 116);
});

console.log(failed ? "\n" + failed + " 项未通过" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
