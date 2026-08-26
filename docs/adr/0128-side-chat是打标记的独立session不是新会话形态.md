# ADR-0128：side chat 是打了标记的独立 session，不是一种新会话形态

日期：2026-08-26
状态：已接受
相关：issue #502、ADR-0047（spawnedBy 子会话——同款隐身手法）、ADR-0087（归档的列表过滤）

## 背景

/btw 要一个「顺手聊两句」的浮窗：不打断主时间线、可拖动、可关闭、窄窗口不显示。决策已由用户拍板（#502 正文）：底层新建独立 session、打标记并对侧栏/⌘K 隐身、自由漂浮不进右侧互斥面板槽、宽度阈值复用 `sidebarNarrow.ts`。

本 ADR 记录的是落地时的三个结构性选择。

## 决定

### 一、标记 = `session_created` 第 0 条上的可选字段 `sideChat: true`

与 `spawnedBy`（ADR-0047）完全同款：事实写进日志第 0 条，`EventStore.sessions()` 用 `json_extract` 投影成 `SessionSummary.sideChat`，过滤发生在消费端（`sessionGroups.ts` 一处同时管侧栏和 ⌘K）。旧日志无此字段 → false，向后兼容硬规则成立。

**被否掉的路——系统归档（`session_archived reason:"system"`，`sys-memory-edits` 的手法）**：它把会话从 `sessions()` 和跨会话召回**两边**一起藏掉。side chat 只需要对列表隐身；它是用户真实说过的话，被 `session_search` 召回是特性不是泄漏。借归档等于为省一个字段把召回也陪葬。

**刻意只滤两处**：侧栏 + ⌘K（issue 点名的）。灵动岛 fleet、设置页热力图、各模型用量照常算上 side chat——它们统计的是「真实活动」，不是「可打开的会话列表」。

### 二、独立 IPC（`startSideSession`），不复用 `startSession`

`startSession` 的合同里有一条隐含副作用：`currentSessionId = agent.sessionId`（`bootInfo()`、`sendToolDefs()`、历史召回的排除集都读它）。side chat 恰恰**不能**动它——主时间线原地不动是这个功能的全部意义。往 `StartSessionOptions` 里加 flag 让同一个 handler 两副面孔，不如开一条窄通道：收 workspace、回 `{ sessionId }`，别的什么都不碰。

装配走 `createSessionAgent` 主路径（全套工具、审批门、检查点）——side chat 的 agent 不是收权的子 agent，它替用户干活，只是换了个小窗口。

### 三、浮窗时间线在渲染层单独攒（`sideChatEvents`），不进主 `events`

`absorbEvent` 对非当前会话的事件一律丢（DB 是缓冲区，切回去时 `resumeSession` 全量带回）。side chat 没有这个兜底——它对列表隐身，切不回去。所以分流点在丢弃之前：`e.sessionId === sideChatSessionId` 的进 `sideChatEvents`。流式 delta 不用分流：`streamingBySession` 本来就按 sessionId 分桶。

**审批卡的必然推论**：主视图只渲染 `approvals[当前会话]`，side session 的审批卡不给出口就是一张看不见的卡、一个永远挂着的工具。浮窗里因此有一排最小审批行（批/拒两档；长期授权这类重决定不在小窗里做）。

### 生命周期（v1 边界）

一次 app 运行一个 side session：首次 /btw 创建，之后复用；关浮窗不丢状态；重启后下次 /btw 建新的。历史都在日志里（append-only 照常成立），但浮窗从空白开始——**跨重启接续旧 side 会话不做**：那需要一条绕过列表隐身的 resume 通道（`resumeSession` 会切主视图，`readSessionEvents` 只授权子会话），为 v1 加这条通道的收益配不上它的权限面。真有需求时再开（推翻前提：用户反馈"重启后找不回昨天 side chat 里说的话"成为常态）。

## 后果

- `SessionSummary` 消费方新增一个必填布尔字段；两处测试 fixture 补了默认 false。
- 浮窗拖拽是手写 pointer capture（仓库无拖拽库；GSAP 在场但 Draggable 插件未确认打包），几何抽在 `lib/sideChatWindow.ts` 纯函数里单测。
- side chat 的 turn 与主会话并行（`runningSessions` 本就按会话上锁），模型/审批模式用默认值——浮窗里不提供切换。
