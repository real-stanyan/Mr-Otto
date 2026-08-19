# ADR-0035：浏览器骑在 ExecutionWorld seam 上，人的浏览不进日志

- 状态：已接受
- 日期：2026-08-19
- 相关：ADR-0031（终端挂 world seam、不进事件日志——本 ADR 是它在浏览器上的直接延伸）、ADR-0001（渲染层只走 ShellBridge）、ADR-0006（中断语义）
- 设计文档：`docs/superpowers/specs/2026-08-19-session-embedded-browser-design.md`
- 授权：维护者 stanyan 的会话内置浏览器需求，设计已在上述 spec 中定稿

## 背景

会话里要内嵌一块真浏览器：人自己开网页、登录、看 `localhost` 上 agent 刚改出来的页面；
agent 只读地导航并抽正文（`browser_read`），不点击、不输入。

和终端（ADR-0031）是同一类问题的第二次出现：谁持有这个原生资源、它算不算「事实」、
出了问题谁兜底。但浏览器在几个关键点上和终端走了相反的路，值得单独记一份。

## 决定

### 1. `WebContentsView`，不是 `<webview>` 标签

agent 侧要走 `ExecutionWorld` seam，主进程直接持有 `webContents` 才是直路——
`executeJavaScript` 一句话就能抽正文，正好接上「hub 在主进程 + 工具走
ExecutionWorld」的既有骨架。`<webview>` 标签的话，`webContents` 长在渲染进程的
自定义元素里，主进程要拿到它得绕 `did-attach-webview` 这条侧路，路径别扭一截；
Electron 官方也长期劝退 `<webview>`。

代价明说：`WebContentsView` 是浮在 React 之上的真·图层（`win.contentView.addChildView()`），
不受 DOM 层叠上下文管辖。面板挪动、窗口 resize，矩形要靠 `ResizeObserver` 手动同步
（`src/renderer/src/components/BrowserPanel.tsx` 报坐标，`browserHub.setBounds` 落地）；
本应盖住它的弹窗、下拉菜单盖不住——这块屏幕天生浮在最上层。矩形同步是纯几何活儿，
一次写对基本不会再动，但这层"不是 DOM 的一部分"的性质是长期存在的地基事实，不是一次性成本。

### 2. 注入方向与终端相反

终端是 hub 去调 `world.openTerminal`——pty 是 `LocalWorld` 自己就能开的进程，
`ExecutionWorld` 只需要声明这个可选面，实现留给具体的 world。

浏览器不能照抄这个方向：`WebContentsView` 只有「主进程 + 一个真窗口」才造得出来，
`LocalWorld` 是纯 Node 模块，天然没有窗口，造不出这个东西。于是关系反过来——
`src/main/browserHub.ts` 在主进程里先把能力造好（`{ read }`），再用
`withBrowser(world, browser)`（`src/world/executionWorld.ts:125`）反向焊进 world。

seam 本身没有破：`browser_read` 工具（`src/tools/browserRead.ts`）从头到尾只认
`world.browser`，不知道 `browserHub` 的存在，也不 import electron——这条硬边界
和 `openTerminal` 那条一样成立，只是这次能力的建造方是 hub 而不是 world 自己。
`browser?` 依旧是可选字段（`world/executionWorld.ts:80`），理由与 `openTerminal?`
同源：旧实现和测试里的假 world 零改动，缺这个字段就是「这个世界没有浏览器」，
工具据此直接抛错（`browserRead.ts:37`）。

反面：`withAbortSignal` / `withExecOutput` 这类手写字段拷贝的装饰器，现在要多透传
一个 `browser` 字段，和当初 `openTerminal` 挖的坑是同一个坑——漏一处就静默丢能力
（`executionWorld.ts:99-102`、`:117-118` 两处都补了）。

若 v2 `SandboxWorld` 哪天要在容器里自己跑浏览器，它可以直接实现 `browser?` 这个
字段，`index.ts` 里 `withBrowser` 那条注入线自然退场——接口不用改一行。

### 3. 人的浏览不进事件日志、不进模型上下文

`browserHub` 顶注就是这句话，字面照抄 ADR-0031 的终端结论：append-only 事件日志
是唯一事实来源，但「model-visible means logged」的前提是 model-visible——人自己在
面板里点的每一次导航永远不进模型上下文，前提不成立，规则不适用。想让 Otto 看某个
页面，人得让 agent 主动去读（或者自己复制粘贴）。

agent 的 `browser_read` 不享受这个豁免：它是一次正常的工具调用，参数和返回值照
现有机制落盘，和其他工具一视同仁。

区分点不是「谁触发了导航」，而是「这次导航算不算模型看见的事实」——`browserHub`
本身不区分调用方是人（`browsers.navigate`，经 `browserNavigate` 通道）还是 agent
（`browsers.read` 内部的 `loadURL`），两条路径共用同一个 `WebContentsView`；日志
分界线画在工具调用这一层，不是画在 hub 内部。

### 4. `browser_read` 不进审批 UI，照 `web_extract`

`requiresApproval: false`（`src/tools/browserRead.ts:26`）。这是五条决定里最可能
被将来推翻的一条，代价必须写死在这里：这个工具用的是用户自己那份 `WebContentsView`，
带着登录 cookie，且够得着 `localhost` 和整个内网——比 `web_extract`（走第三方 API
抓公开网页）实质强得多。人事后能在面板里看见 agent 开了哪一页，但看见是滞后的，
不是审批那种事前挡一道。

实现过程中补的一个具体豁口，值得单独点出来：`browser_read` 工具本身拒绝 `file://`
参数（`browserRead.ts:31`），但那只挡得住「agent 直接指定 url」这一条路。工具的
「不给 url 就读当前页」这条分支毫无保留地信任当前页的内容——如果当前页是一个不可信
站点，它能自己 `window.open("file:///…")`，若 `setWindowOpenHandler` 照单全收，
新页面加载完就是本机任意文件，"读当前页"的 agent 会把它当正文读出来，等于把工具层
挡住的口子从 window.open 这条后门重新打开。`webContentsViewFactory.ts:32-42` 的
`setWindowOpenHandler` 只放行 `http:` / `https:`（`URL` 解析失败或非 http(s)
一律 `deny` 且不导航），把这条后门焊死——但这只堵住了"新开窗口"这一种载体，不改变
`browser_read` 本身不审批的决定。

改主意的改动面很小，写在这里是为了将来真要改时不用重新盘一遍：工具定义加一个
`requiresApproval: true`，再补一段审批预览文案（把 `url` 和 `title` 亮出来）。
不需要动 `browserHub` 或 `world.browser` 的任何一行——审批是工具层的开关，seam
和 hub 都不知道审批的存在。

### 5. 单一全局持久 partition `persist:otto-browser`

`webContentsViewFactory.ts:15` 里的 `partition`，跨会话、跨 app 重启存活。登录一次，
之后所有会话的 agent 都读得到——这正是设计要解决的第二个痛点（登录态 / JS 渲染页面）。
不选每会话独立 partition 的理由很直接：那样每个新会话都要重新登录一遍，登录态这件事
的价值就被拆没了。

代价明说：这是一个真·共享凭据池，会话之间没有隔离墙——任何会话的 agent 都能读到
任何一次登录之后的页面，同一个 Otto 里的水獭没有身份区隔。这个取舍在 MVP 阶段被
认下；v2 每 bot 一个 Docker 容器时，partition 自然按 bot 分家，这条代价随之消失，
不需要现在预先设计任何过渡机制。

## 后果

- 好：agent 侧的读页面能力完全经过 `ExecutionWorld` seam，工具测试可以用假 world
  跑，不需要起 Electron——`tests/tools/browserRead.test.ts` 证实了这一点。
- 好：`browserHub` 本身也不依赖 Electron（`webContentsViewFactory.ts` 是全项目
  唯一 import `WebContentsView` 的地方），`tests/main/browserHub.test.ts` 用假
  `BrowserViewHandle` 在普通 vitest 里把懒创建、后来者赢、失败/超时/中断三态、
  关面板不销毁这些行为全部钉住。
- 好：日志的纯度不被人的浏览稀释——和终端一样，日志里的每一条仍然都是模型见过的。
- 坏：`browser_read` 不审批的代价是真实的攻击面（登录 cookie + 内网可达），目前
  唯一的防线是工具参数拒绝 `file://` 和 `setWindowOpenHandler` 只放行 http(s)；
  这条防线覆盖的是"已知的具体后门"，不是"审批"那种通用挡板，下一个后门出现时
  仍然要靠人工发现再补一条特例。
- 坏：`persist:otto-browser` 是全局共享的，登录态在会话之间没有墙；v2 Docker 化
  之前，这个取舍会一直成立。
- 坏：`WebContentsView` 是浮在 React 之上的真图层，矩形同步和"弹窗盖不住"是这条
  技术路线固有的、长期存在的性质，不是一次性实现成本。
