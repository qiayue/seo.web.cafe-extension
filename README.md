# 哥飞 SEO Agent 浏览器插件

配合 [seo.web.cafe](https://seo.web.cafe/) 上的 [哥飞 SEO Agent](https://seo.web.cafe/chat/) 使用的 Chrome 插件。只做两件事：

1. **替 Agent 去谷歌趋势取数。** 在对话页问一个词（比如「jev 是不是新词、值不值得做」），Agent 需要看谷歌趋势时，插件会在后台开一个 Google Trends 标签页，把网页自己加载出来的热度曲线和相关查询交回给 Agent，然后关掉那个标签页。取过的词在网站上缓存、**全站共享**：下一个人问同一个词、同一个时间范围时，直接用缓存，不用再开谷歌趋势。
2. **在任何网站上一键问 Agent。** 点工具栏上的插件图标，打开侧边栏：「这个站流量怎么起来的？」「它靠哪些词吃流量？」「这个页面的 SEO 怎么改？」，或者自己写问题。点了就会打开对话页并带上问题，回答、扣积分、存对话都和平时在网站上一样。

使用说明：<https://seo.web.cafe/extension/>

## 安装（本地加载，不上架商店）

1. 下载本仓库：[下载 zip](https://github.com/qiayue/seo.web.cafe-extension/archive/HEAD.zip) 并解压，或 `git clone https://github.com/qiayue/seo.web.cafe-extension.git`
2. 打开 `chrome://extensions`
3. 打开右上角的 **开发者模式**
4. 点 **加载已解压的扩展程序**，选解压出来的那个文件夹（里面有 `manifest.json` 的那一层）
5. 把插件固定到工具栏（拼图图标 → 图钉），方便点
6. **已经打开着的 seo.web.cafe 页面要刷新一下**，插件才会进到那个页面里

需要 Chrome 116 或更新版本。Edge 等其他 Chromium 内核浏览器大多也能这样加载，但没有测过。

## 更新

本地加载的插件**不会自动更新**。侧边栏底部会显示当前版本，有新版本时会提示。更新方法：

- 用 zip 装的：下载新 zip、解压**覆盖**原来的文件夹，然后到 `chrome://extensions` 点插件卡片上的刷新按钮
- 用 git 装的：`git pull`，然后同样点刷新按钮

更新后，已打开的 seo.web.cafe 页面要刷新一下。

谷歌趋势网页用的是没有公开文档的内部接口，谷歌一改格式，旧版插件就可能取不到数——取不到时先看看是不是有新版本。

## 权限说明

| 权限 | 用来做什么 |
| --- | --- |
| 在 `seo.web.cafe` 上运行 | 对话页和插件之间传话：告诉对话页「插件在」、接收取数请求、送回结果 |
| 在 `trends.google.com` 上运行、读写该站数据 | 截下谷歌趋势网页**自己**请求回来的曲线和相关查询；看取数标签页是不是被谷歌跳去了人机验证页 |
| `sidePanel` | 侧边栏 |
| `storage` | 记下进行中的取数任务（浏览器关掉就清空） |
| `activeTab` | **只在你点插件图标的那一下**，读当前网页的网址，填进侧边栏 |

插件**不能**读你在其他网站上的内容，也不记录浏览历史。它不会另外请求谷歌——只是在谷歌趋势网页画图时把它拿到的数据抄一份。数据只交给 seo.web.cafe 的对话页，不发去任何别的地方。

## 谷歌趋势取数是怎么走的

```
对话页问问题（请求里带上「这个浏览器装了插件」）
  → Agent 调 google_trends 工具
      → 服务器先查共享缓存，命中就直接用（不开谷歌趋势）
      → 没命中：经 SSE 给对话页发一个取数请求
  → 对话页 → 插件（content/site-bridge.js）→ 插件后台（background.js）
  → 后台在对话页旁边开一个不抢焦点的谷歌趋势标签页
  → 网页加载曲线和相关查询 → content/trends-hook.js 截下 → content/trends-bridge.js 解析后交给后台
  → 后台把结果送回对话页，关掉谷歌趋势标签页
  → 对话页把数据交给服务器 → 服务器校验后写进共享缓存 → Agent 接着回答
```

取不到的情况（被谷歌限流、要人机验证、45 秒没加载完、标签页被你关了）会把原因送回给 Agent，并把谷歌趋势标签页切到前台让你看见——多半是要点一下人机验证，点完回对话页再问一次就行。没装插件、或插件取不到时，Agent 会告诉你去谷歌趋势网页自己看，**不会编一条曲线**。

## 开发

```
npm test          # 解析与 manifest 检查（只需要 Node）
npm run e2e       # 把插件真装进 Chromium 跑一遍取数链路（需要 Playwright 与 openssl）
```

端到端测试不访问真的谷歌趋势：本机起一个 HTTPS 假站，用 `--host-resolver-rules` 把 `trends.google.com` / `seo.web.cafe` 解析过去，插件代码一行不改。真实的谷歌趋势页面是否照旧加载那两个接口，只能在真浏览器里手动验证。

```
manifest.json
background.js              后台：开 / 关谷歌趋势标签页、任务表、侧边栏
content/site-bridge.js     seo.web.cafe 页面里：对话页 ⇄ 插件
content/trends-hook.js     谷歌趋势页面里（页面自己的环境）：截下两个接口的响应
content/trends-bridge.js   谷歌趋势页面里：解析、交给后台
lib/trends-parse.js        解析谷歌趋势返回体、拼谷歌趋势网址（后台和内容脚本共用）
sidepanel/                 侧边栏
icons/
test/
```
