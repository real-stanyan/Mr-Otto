# 会话内置浏览器 — 设计

日期：2026-08-19
状态：已定稿，待实现

## 一、要解决什么

两件事，都是 `web_extract`（走 anysearch 第三方 API 抓正文）够不着的：

1. **看 agent 改出来的页面** —— 水獭改了前端，直接在 Otto 里开 `localhost:xxxx` 看效果，不用切出去开 Chrome。
2. **登录态 / JS 页面** —— 需要登录后或重度 JS 渲染的页面，anysearch 抓不到。人先在面板里登录，agent 再读。

人和 agent 共用同一个浏览器：人能自己开网页，agent 也能读它。agent 侧**只读**（导航 + 读正文），不点击、不输入。

## 二、技术路线：WebContentsView

`WebContentsView` 挂在主窗口（Electron 43，`win.contentView.addChildView()`），主进程按渲染层上报的矩形定位。

选它而不选 `<webview>` 标签：agent 侧和 world seam 是这个功能的硬骨头，主进程直接持有 webContents 让它变成直路（`executeJavaScript` 一句话），正好接上「hub 在主进程 + 工具走 ExecutionWorld」的既有骨架。webview 的话，agent 要绕 `did-attach-webview` 才拿得到 webContents，路径别扭，且 Electron 官方长期劝退。

代价，明说：它是浮在 React 之上的真·图层，面板拖动 / 窗口 resize 要同步矩形，弹窗和下拉菜单盖不住它（要么让路，要么临时隐藏）。矩形同步是纯几何活儿，一次写对就不再动。

不选的第三条路（人看 webview + agent 读隐藏 webContents）：登录态要跨两个 webContents 共享，且「人看到的页面」和「agent 读到的页面」不是同一个 —— 直接把痛点 2 拆散。

## 三、模块与边界

| 文件 | 职责 |
|---|---|
| `src/shared/browser.ts` | `BrowserTabInfo { id, url, title, loading, canGoBack, canGoForward }` —— 渲染层要画的数据形状，零运行时依赖 |
| `src/main/browserHub.ts` | 主进程的 `WebContentsView` 注册表：开 / 关 / 导航 / 定位矩形 / 读页面。持有 webContents，是人和 agent 共用的唯一真身 |
| `src/shared/shellBridge.ts` | 新增一面：`browserOpen` / `browserNavigate` / `browserSetBounds` / `browserClose` / `browserBack` / `browserForward` / `browserReload`，push 事件 `onBrowserState` |
| `src/renderer/src/components/BrowserPanel.tsx` | URL 栏 + 前进后退刷新 + 占位 div，`ResizeObserver` 把矩形报给主进程 |
| `src/tools/browserRead.ts` | agent 工具 `browser_read`，只读 |

### 三条硬边界

1. **webContents 归主进程独占。** 渲染层永远只发坐标和指令、只拿回状态快照 —— `ShellBridge` 硬规则原样成立，渲染层碰不到任何 Node / Electron API。
2. **工具不 import electron。** `ExecutionWorld` 加可选能力 `browser?`，照 `openTerminal?` 的先例（可选 = 旧实现和测试里的假 world 零改动；缺这个字段 = 该世界没有浏览器，UI 与工具据此降级）。实现由 `src/main/index.ts` 注入，和 `TerminalHubDeps.openTerminal` 同一套路 —— v2 换 SandboxWorld 时浏览器能跟着进容器。
3. **一个会话一个浏览器，不做多标签。** 终端有多标签是因为 shell 天然并行；浏览器 MVP 是「人看一眼 + agent 读一页」，多标签是 YAGNI。tab id 仍留在 schema 里，将来加不破坏兼容。

### 登录态

全局持久 partition `persist:otto-browser`，跨会话跨重启。登录一次，之后所有会话的 agent 都读得到 —— 痛点 2 要的正是这个。

反面：它是个真·共享凭据池，会话之间没有隔离墙。MVP 认这个取舍；v2 Docker 时它自然按 bot 分家。

### 事件日志

人自己浏览**不进事件日志、不进模型上下文** —— 照 ADR-0031 终端先例：它是人的旁路工具，不是某个事实的投影，日志推不出它也不需要推出它。

agent 的 `browser_read` 是工具调用，本来就按现有机制落盘。「model-visible means logged」原样成立。

## 四、数据流

### 人这一侧

```
BrowserPanel --browserNavigate(sessionId, url)--> browserHub --> view.webContents.loadURL
             <--onBrowserState({id,url,title,loading,canGoBack,canGoForward})--
                (did-navigate / page-title-updated / did-start-loading / did-stop-loading)
```

矩形单独走 `browserSetBounds(sessionId, {x,y,width,height})`，由占位 div 的 `ResizeObserver` + 窗口 resize 触发。

面板收起 = 报一个空矩形，hub 把 view 从 `contentView` 摘下来，**不销毁 webContents** —— 照终端「关面板不杀进程」的前提：重开时页面还在，登录态还在。

### agent 这一侧

```
browser_read({url?}) --> world.browser.read(...) --> hub.read(sessionId, url?)
    url 给了 → loadURL + 等 did-finish-load（超时 30s）
    url 没给 → 直接读当前页
    → executeJavaScript 抽正文 → { url, title, text }
```

正文抽取：`document.body.innerText`，先摘掉 `script` / `style` / `noscript`。截断上限 ~50k 字符，截了就在返回里明说截了。不上 Readability —— 那是独立的一层，真需要再加，接口不变。

### 懒创建

view 在人第一次开面板、或 agent 第一次调工具时创建，谁先来谁触发。agent 先来时 view 存在但没挂到窗口上（零矩形），人一开面板就看到 agent 刚读的那页。

## 五、并发与失败

1. **后来者赢，不加锁。** agent 导航直接改人正在看的那一页 —— 这是特性不是 bug：人看得见它去了哪。人同时手打 URL 撞上了，最后一个 `loadURL` 生效，不排队不报错。
2. **失败即抛。** `did-fail-load` / 超时 / `executeJavaScript` 抛 —— 工具直接 throw，`errorCode` 与 URL 原样带上，不返回一个假装成功的空字符串。
3. **中断即 reject。** `AbortSignal` 焊进去（ADR-0006 语义），中止不伪装成页面自己的失败。

## 六、审批

`browser_read` **不进审批 UI**，照 `web_extract`（纯读不落地）。

已知代价，明记在此：它带着用户的登录 cookie，且够得着 `localhost` 和内网 —— 比 `web_extract` 实质更强。人看得见 agent 开了哪一页，但是事后才看见。这是本设计里唯一一个被明确讨论后接受的安全取舍；改主意的话，改动面是工具的 `requiresApproval` 一个字段加一段审批预览文案。

## 七、测试

`tests/` 镜像 `src/`，不与源码同目录。

- `tests/main/browserHub.test.ts` —— 主战场。注入假 view 工厂（假 webContents：`loadURL` / `executeJavaScript` / 事件发射器都是 spy）。断言：懒创建只建一次；关面板报空矩形不销毁 webContents；`did-fail-load` 让 `read()` 抛且带 errorCode；超时抛；abort 走 AbortError 语义、不伪装成加载失败；后来者赢（连发两次 navigate，最终 URL 是后一个）。
- `tests/tools/browserRead.test.ts` —— 假 world：给了 `browser` 能力就正常返回；没给就抛「这个世界没有浏览器」；截断时返回里带截断标记。
- `tests/world/executionWorld.test.ts` 补一条：`withAbortSignal` / `withExecOutput` 透传 `browser` 字段（照 `openTerminal` 现有那条的写法）—— 装饰器漏字段是这套 seam 的经典坑。
- 渲染层：`BrowserPanel` 的矩形上报（`ResizeObserver` 触发一次、面板收起报空矩形）。webContents 本身不在渲染层，没得测也不该测。

## 八、落地顺序

每步自己是绿的：

1. `shared/browser.ts` + `ExecutionWorld.browser?` + shellBridge 面 —— 纯类型，无行为
2. `browserHub` + 主进程注入接线（先只有导航和状态推送，没有 `read`）
3. `BrowserPanel` + 矩形同步 —— 到这儿人已经能用了，可先合一次
4. `hub.read()` + `browser_read` 工具 + 注册进工具表 —— agent 侧接上

## 九、协议动作

- 开一个 Task issue 挂这个功能
- `docs/adr/0033-*.md` 记两个决定：WebContentsView 而非 webview；浏览器骑 world seam、人的浏览不进日志（ADR-0031 的延伸）
  - 注：`docs/adr/` 里 0031 已撞号（terminal 与 thinking 各一份），本次不顺手改别人的编号，新 ADR 直接走 0033
- 分支 PR，CI 绿了再合

## 十、明确不做（YAGNI）

- 多标签
- agent 点击 / 输入 / 滚动（本期只读；工具名 `browser_read` 已经把这条界划在名字里）
- Readability 级正文抽取
- 每会话独立 cookie 隔离（等 v2 Docker）
- 下载、打印、devtools 面板
