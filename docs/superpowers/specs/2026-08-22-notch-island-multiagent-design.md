# 灵动岛多智能体列表设计

> 日期：2026-08-22 · 演进 ADR-0061 的单会话灵动岛 · 接续分支 `claude/notch-island-swift`（未合并）

## 目标

灵动岛展开态从"只显示主窗当前选中的单一会话状态"改成"列出所有 otto 会话、侧栏式显示每个的运行状态"；点某行选中它，对该会话就地审批/输入。推翻单 `activeSessionId` 投影模型，改成会话集合。

## 背景与动机

ADR-0061 落地的原生 Swift 灵动岛只跟主窗当前选中会话（单 `activeSessionId`）。ADR-0059 早写了失效前提：「若将来岛要聚合多会话，`activeSessionId` 单值模型要改成集合」。用户验收后要求：岛展开不能只显示单一会话，要像主窗侧栏那样列出所有会话、各自显运行状态。本设计兑现那条失效前提。

单会话原生岛（互动/焦点已真机验收 OK）从未合并上线，故直接在原分支上演进，不先合并再推翻。

## 范围

**做**：展开态列出主窗侧栏可见的全部会话（每会话一行 + 运行状态）；有 pending approval 的行高亮/置顶；点一行选中 → 下方就地展开该会话的现有四态交互（active 详情 / 审批 / 输入）；折叠态沿用（任一在跑就脉动，可选数量角标）。

**不做**：子会话独立成行（镜像侧栏——子会话只在父时间线里，不进列表）；跨会话聚合操作（批量审批等）；改动会话本身的数据模型或事件。

## Global Constraints

- **不新增 SessionEvent**：多会话状态全部由主进程从既有数据源（`store.sessions()`、`runningSessions`、每会话 reducer、各 agent 的 `approver.pendingRequest()`）投影，不落新事实。
- **复用 `reduceIsland`**：不为多会话另写 reducer；每会话一份 `IslandState`，事件按 `sessionId` 路由（`reduceIsland` 本就按 `sessionId` 过滤）。
- **镜像侧栏可见集合**：列表 = `groupSessionsByWorkspace` 的可见集合口径——`spawnedFrom === null`（非子会话）且 `workspace !== null`（非史前），按 workspace 分组、组内 `lastTs` 倒序、组序按组内最近。不自造可见性规则。
- **岛无权威状态**：Swift 仍只渲染主进程推来的拍平快照；快照里每个 agent 的状态可从日志投影推导。
- **就地操作的路由**：出向命令（send/approve/deny）已带 `sessionId`，对哪个 agent 操作由选中行的 `sessionId` 决定；主进程按 `sessionId` 分发到对应 agent（`handleSendMessage`/`handleDecideApproval` 已按 sessionId 工作）。
- **gate 不变**：`npm test`（tsc + vitest）；Swift 侧 `swift test` 不进这个 gate。
- **arm64-only、ad-hoc 签名**：沿用 ADR-0061 的打包，不变。

## 架构

### 投影：单会话 → 会话集合

主进程维护 `Map<sessionId, IslandState>` 取代单个 `islandState`：

- 每会话一份 `IslandState`（现有结构，含 `phase`/`currentTool`/`turnStartedAt`/`pendingApproval`/`callsById`）。
- `feedIsland` 的四类输入（event / turnStatus / approvalRequest / activeSession）都带 `sessionId`；路由到 `Map` 里对应那份跑 `reduceIsland`，变则重推。
- 会话删除/purge（`agents.delete` / 会话被删）→ 从 `Map` 删对应 state，重推。
- `focusedSessionId` = 主窗当前选中会话（原 `activeSessionId`），随 `setActiveSession` 更新——只用来标默认高亮行，不再是"唯一被投影的会话"。

### 线上快照：单 → 列表

`IslandSnapshot`（单会话）替换为 `IslandFleet`：

```ts
interface IslandAgent {
  sessionId: string;
  title: string;                 // 侧栏同款显示名(SessionSummary 的展示标题)
  phase: "idle" | "active" | "approval";
  currentTool: { verb: string; target: string } | null;
  turnStartedAt: number | null;
  pendingApproval: { callId: string; verb: string; target: string; fullPath: string | null } | null;
}
interface IslandFleet {
  agents: IslandAgent[];         // 侧栏可见集合口径,侧栏同序(工作区分组展平)
  focusedSessionId: string | null;
}
```

`flattenSnapshot(state, model)` → `flattenFleet(states, sessions, focusedSessionId)`：遍历侧栏可见会话，对每个取 `Map` 里的 `IslandState`（没有则 idle 默认），拍平成 `IslandAgent`，`title` 取自 `SessionSummary`。顺序 = `groupSessionsByWorkspace` 展平后的顺序。

### 折叠态

任一 agent `phase !== "idle"` 就脉动（沿用现有 active 亮点）。可选：右下角小数字角标显示"在跑几个"（`agents.filter(a => a.phase==="active").length`），为 0 不显。纯刘海形态不变。

### 展开态（侧栏式列表）

- **列表**：每个 `IslandAgent` 一行 —— 状态点（idle 灰 / active 蓝脉动 / approval 琥珀）＋ 标题 ＋（active 时当前工具动词+目标 + 本地计时）。
- **审批置顶/高亮**：`phase === "approval"` 的行排到列表顶、加琥珀高亮（要人当场动手）。
- **选中**：点一行选中它；默认选中 = `focusedSessionId`。选中行下方就地展开该会话的详情区：
  - `phase === "approval"` → 允许 / 会话 / 拒绝（对该 `sessionId` 发 approve/deny）。
  - 用户点"说话"入口 → 输入框（对该 `sessionId` 发 send），沿用 ADR-0061 的焦点抢还。
  - 否则 → active 详情（工具+计时）/ idle。
- **空列表**：无可见会话 → 展开显示一句"主窗里先开会话"（等价现单会话的空态）。

### 桥协议

- 主进程 → Swift：`{"type":"state","state": IslandFleet}`（载荷从单 snapshot 变成 fleet；`type` 仍是 `"state"`）。
- Swift → 主进程：`send`/`approve`/`deny`/`ready` **不变**（已带 `sessionId`，对选中行操作天然分发）。

### Swift UI

- `IslandModel` 持 `@Published var fleet: IslandFleet` 取代单 `snapshot`，加 `@Published var selectedSessionId: String?`（默认取 `fleet.focusedSessionId`，用户点行覆盖）。
- 展开视图：`List(fleet.agents)` 每行一个状态行视图；选中行下方嵌现有 `active/approval/compose` 详情视图（复用 ADR-0061 的 `IslandExpandedView` 拆出的详情部分）。
- 折叠 / hover / 焦点抢还逻辑不变。
- 新快照到达时：若 `selectedSessionId` 指向的会话已不在 `agents` 里（被删），回落到 `focusedSessionId` 或列表首行。

## 数据流

1. 主进程任一会话的 event/turnStatus/approval/active 变 → 路由进 `Map` 对应 `IslandState` → 变则 `flattenFleet` 重推整包 fleet。
2. 会话增删（listSessions 变、agents purge）→ 同步 `Map` → 重推。
3. Swift 收 fleet，渲染列表；选中行驱动详情区。
4. 用户在选中行审批/输入 → 出向命令带该行 `sessionId` → 主进程分发到对应 agent → 新 fleet 回流（该行 pendingApproval 清 / turn 起）。

## 错误处理 / 边界

- `Map` 与可见会话集合可能短暂不同步（会话刚建还没 reducer 状态）→ `flattenFleet` 对缺失的按 idle 默认，不崩。
- 选中行的会话中途消失 → Swift 回落选中（focused / 首行）。
- 会话很多 → 列表在刘海展开区内可滚动（SwiftUI List 自带）；审批行置顶保证要动手的不被淹。
- 快照推送频率：会话多时每次变化推整包 fleet。载荷仍小（每 agent 几个字段），沿用 ADR-0059「丢弃成本可忽略」。若实测抖动再谈增量（YAGNI，先整包）。

## 测试策略

- **TS 侧（进 gate）**：`flattenFleet` 纯函数单测（多会话 states + sessions 列表 → 有序 fleet、审批置顶、title 对齐、缺失按 idle）；`Map` 路由：事件按 sessionId 只动对应那份（vitest）。
- **Swift 侧（`swift test`，不进 npm gate）**：`IslandFleet` Codable roundtrip；列表选中/回落纯逻辑。
- **手动冒烟**（`docs/island-smoke.md` 追加多会话项）：开 2+ 会话、各自跑/挂审批 → 岛列表显各自状态；审批行置顶；点不同行切换详情、就地审批落到对的会话；一个会话删了岛列表跟着掉行。

## 流程约束

- 演进 ADR-0061 → 补一条 ADR（`docs/adr/0062`，记「单 activeSession → 会话集合」的模型变更，引用 ADR-0059 的失效前提），**不改 AGENTS.md Hard rules/Tech stack**（已在 ADR-0061 立好，本次无新 L1）。
- 接续分支 `claude/notch-island-swift`；与 ADR-0061 的单会话版一起作为同一功能的最终形态合并（单会话版未上线，不单独合）。

## Hard rules 自检

- **投影可从日志推导**：每会话状态由主进程从日志投影，Swift 无权威状态。✓
- **不新增 SessionEvent**：多会话是既有事实的另一种投影。✓
- **ShellBridge 边界**：Swift helper 仍是主进程独占的外部 seam，非渲染进程。✓
- **SessionEvent 向后兼容**：不动事件。✓
