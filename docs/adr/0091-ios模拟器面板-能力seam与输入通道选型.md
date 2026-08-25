# ADR-0091: iOS 模拟器面板——能力挂 seam / 画面走轮询截图 / 输入走自建 Swift helper

日期：2026-08-25
状态：已接受
关联：issue #401；ADR-0035（浏览器能力的注入方向）、ADR-0031（人的旁路工具不进事件日志）、ADR-0061（原生 Swift helper + stdio NDJSON 桥的先例）、ADR-0058（GUI 改动的 e2e 纪律）

## 背景

右侧栏要一块 iOS 模拟器：人能看能点，agent 能开机、装 app、起 app、看屏、点屏。macOS + Xcode 上 `xcrun simctl` 给了设备生命周期（list/boot/install/launch/openurl/screenshot），但**公开面里没有点击**——simctl 不提供 tap/swipe/键盘。这是整件事唯一的真岔路。

## 决定 1：能力挂 `ExecutionWorld.simulator?`，由组装根注入

工具只认 `world.simulator`（硬规则）。注入方向与 browser/mcp 相同（ADR-0035）：hub 要管 simctl 子进程、画面轮询、向渲染层推状态，LocalWorld 是纯 Node 模块，造不出来。

与浏览器有一处**刻意的不同**：browserHub 是一个会话一个浏览器，simulatorHub 是 **app 级单例**。理由是物理事实——一台机器只有一套模拟器，人在面板上点的和任一会话里 agent 点的必然是同一台设备；假装每个会话有自己的模拟器只会制造一个不存在的隔离感。

坐标系统一为**截图像素**（`src/shared/simulator.ts` 文件头）。三方共用同一块屏：人点的是 `<img>` 里的像素、agent 从无障碍树读到的是元素框、Swift helper 发事件用的是 macOS 屏幕坐标。挑一套当事实、其余在边界换算；选截图像素是因为它是唯一"人和 agent 都看得见"的空间。换算是纯算术，住在 hub 里可单测。

## 决定 2：画面 = 轮询截图（500ms）+ 缩到 480 宽转 JPEG，不做 recordVideo

`simctl io <udid> screenshot` 实测一帧 150~300ms、原图近 3MB。`recordVideo` 能出流畅画面，但要在主进程接一条 h264 解码/转封装链，延迟不低、测试极难，收益只有"更顺"。轮询这条路零依赖、纯 Node，能在 vitest 里假掉。

两个落地细节值得记账：`screenshot -` **不是 stdout**（simctl 会写一个名叫 `-` 的文件，实测），所以走固定临时文件读回；缩放后的尺寸就是全系统统一坐标——面板点击、describe 报的框、agent tap 全在这张缩略图的像素空间里，不存在两套分辨率。

人的这块屏不进事件日志、不进模型上下文（ADR-0031 的延伸）；agent 的每次工具调用照旧落盘。

## 决定 3：输入 = 自建 Swift helper（CGEvent + AXUIElement），不用 idb

三条路的对照：

| 路 | 代价 |
|---|---|
| **自建 Swift helper**（选中） | 零外部依赖、全公开 API；要一次「辅助功能」授权 |
| idb / idb_companion | 功能最强（含无障碍树），但要用户先 `brew install`；没装 = 整块功能不可用 |
| 只读（不做输入） | agent 只能看不能点，达不到 issue 的验收 |

选自建的决定性理由是**缺席代价的形状**：Otto 是发给普通用户的 .app，一个"要先 brew 装两个包"的前置会让这块功能在大多数机器上直接不存在；而授权是一次性的、系统级的、用户看得懂的。helper 复用 ADR-0061 的形态（`native/` 里一个 Swift 包，主进程 spawn，stdio NDJSON）——已经验证过的路子。

与岛那条桥的差别：岛是**单向推**，这条是**请求-响应**（点一下要知道点没点上），所以每条请求带自增 id、按 id 认领、带超时；helper 崩了挂起的请求立刻收人话而不是永远挂着。

**降级是分层的，不是全有全无**：CGWindowList 拿窗口矩形不需要任何授权，simctl 那一半也不需要——所以没授权的机器上"看画面 / 开关机 / 装 app / 起 app"全部照常，只有点击/打字/读屏不可用，面板上一条横幅说明原因并给授权入口。helper 二进制整个缺席（非 macOS、dev 下没 `swift build`）时同理。

## 决定 4：agent「看屏幕」的主力是无障碍树，不是像素

模型读不了工具返回里的图（tool_result 是字符串，视觉代读走的是用户附件那条路，见 ADR-0009 追记）。所以 `describe` 走 AXUIElement 读 Simulator.app 桥出来的 iOS 无障碍元素（Accessibility Inspector 同一条路），返回 `[中心坐标] 角色: 标签 = 值` 的行。这比"截图 → 视觉模型代读 → 猜坐标"准得多也便宜得多：坐标是元素自己报的，点击不用猜。`screenshot` 保留，但它的返回值明说"你读不了像素，要知道屏上有什么用 describe"。

代价记在这里：**无障碍树的质量取决于被测 app 有没有设 accessibilityLabel**。没设的 app 会 describe 出一片空标签——那时只能靠已知布局盲点。这是选择带来的真实上限，不是 bug。

## 决定 5：一把工具带 action 分发，且不过审批门

十三个动作共用同一台设备、同一套坐标系，拆成十三把工具只会让工具表膨胀十三行、每行重复解释一遍坐标系。

不要审批（`requiresApproval: false`）的理由：所有动作落在模拟器**里面**——那是一台随时能抹掉重建的虚拟设备，不是用户的机器。唯一摸到宿主的是 `install` 的路径，而它只是读一个 agent 本来就能读的目录。真正危险的动作（rm、改配置）在 bash 那边，那把仍然过门。**推翻这个决定的前提**：如果哪天模拟器能碰到宿主的钥匙串/网络凭据（例如 agent 用它登录真账号），这一条就要重估。

## 后果

- 非 macOS / 没装 Xcode 的机器上，组装根压根不焊这层能力，`simulator` 工具不进工具表——模型不会看见一把用不了的刀。
- 窗口矩形每次现问 helper、不缓存：窗口随时会被拖走，缓存旧值的代价是点歪，而且歪得没有症状（点到别的控件上），最难查。
- **欠账（真机验收）**：本次开发环境拿不到「辅助功能」授权，因此 AX 那半边（`describe` 的树形状、`rectSource: "screen"` 那条精确矩形路径、CGEvent 点击真的落进 iOS）**只验到了协议层，没做真机验收**。没授权时走的等比内切退路已按实测数据（窗口 456x972 / 截图 1206x2622）单测。授权后的真机验收进 issue #123 的欠账总账。
