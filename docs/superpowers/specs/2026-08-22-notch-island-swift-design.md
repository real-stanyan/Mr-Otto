# 灵动岛改原生 Swift helper 设计

> 日期：2026-08-22 · 推翻 ADR-0059（Electron 第二窗口）

## 目标

macOS 灵动岛（刘海岛）改用原生 Swift helper 实现，达到 NotchNook/Alcove 档次的刘海贴合与手感；删除现有 Electron 第二窗口实现。

## 背景与动机

ADR-0059 用第二个透明 `BrowserWindow` 贴顶居中做灵动岛，随 PR #181 合入 main。实测折叠态即使按机型查表拿到刘海宽（16" = 220pt）盖住物理刘海，仍到不了原生水准：

- Electron 无 `NSScreen.auxiliaryTopLeftArea/auxiliaryTopRightArea` API，拿不到精确刘海几何（electron#31478 仍开着），只能按机型硬编码查表——换台机器就错。
- 凹角过渡（刘海两侧的 concave flare）、展开/收起的 spring 物理手感，CSS 到不了原生 SwiftUI + Core Animation 的水平。
- 用户反复否决"药丸感"，明确要求"真正融入 macOS 刘海"。

原生 Swift 还顺带降运行时压力：去掉一个 Chromium 渲染进程（约 60–150MB），换成一个约 5–15MB 的原生进程。代价在工程：多一条 Swift 构建链、跨进程 IPC 桥、打包时随 app 签名。

## 范围

**做**：四态（idle 折叠 / active / 审批 / 输入）全部原生；hover 展开详情；岛内直接对 Otto 打字；非 notch 机走 DynamicNotchKit 的 `.floating` 兜底；删除 Electron 岛全部代码。

**不做**：多会话聚合（沿用 0059 的单 `activeSessionId` 模型）；Intel/x86_64（沿用 arm64-only 分发）；岛的持久化状态（岛无权威状态，只渲染主进程推来的快照）。

## Global Constraints

- **arm64-only、ad-hoc 签名、无公证**：Swift helper 二进制随 `.app` 一起 ad-hoc 签，不引入独立公证流程（沿用 docs/distribution-macos.md 现状）。
- **DynamicNotchKit**：`https://github.com/MrKai77/DynamicNotchKit`，MIT，SPM，最低 macOS 13。helper 部署目标 macOS 13+。
- **岛无权威状态**：Swift 岛只持有渲染缓存，权威投影由主进程（事件日志所有者）算好推送。任何岛上显示的东西必须能从主进程的日志投影推导（对齐 AGENTS.md Hard rule "投影可从日志推导"）。
- **不新增 SessionEvent**：沿用既有事件流；桥协议是投影的传输格式，不是新事实。
- **gate 不变**：`npm test`（tsc --noEmit + vitest run）。Swift 侧 `swift test` 不进这个 gate。
- **ShellBridge 边界**：Swift helper 不是 Electron 渲染进程，不受 "渲染进程只通过 ShellBridge" 约束；它是主进程驱动的外部原生 helper，是一条新的、由主进程独占的 seam。

## 架构

```
Electron 主进程 (事件日志所有者 = 唯一事实源)
  │  child_process.spawn 一个 LSUIElement GUI helper
  │  helper.stdin  ← 主进程写 NDJSON 状态快照
  │  helper.stdout → 主进程读 NDJSON 用户命令
  ▼
MrOttoIsland (Swift executable + DynamicNotchKit)
  拿 NSScreen 真实刘海几何、spring 动画、四态 SwiftUI 渲染
  用户操作(发消息/审批/输入)写回 stdout
```

### 投影模型（核心决策，新 ADR 立此条）

岛的投影在**主进程**算好，作为整包快照推给 Swift；Swift 是纯渲染层，不持有权威状态。

- 这**不是** ADR-0059 否决的"投影的投影"。0059 否的是**主窗**（一个渲染进程/投影）再算状态转发给岛——主窗一关岛就瞎。这里算投影的是**主进程**，它本身就是事件日志的所有者、唯一事实源。在源头算一次投影推出去，是权威投影，不是二次投影。
- 好处：Swift 侧免了把 `reduceIsland` 用 TS + Swift 各写一遍再手动保持同步（跨语言重复 reducer 是维护地雷）。主进程已经在跟踪 running/pendingApproval，只需补上 `phase`/`currentTool`/`turnStartedAt` 三个字段即可算出完整岛快照。

## 组件与文件

### Swift 侧（新目录 `native/MrOttoIsland/`）

- `Package.swift` —— SPM 清单，`dependencies` 含 DynamicNotchKit，`products` 是一个 executable target `MrOttoIsland`；`platforms: [.macOS(.v13)]`。
- `Sources/MrOttoIsland/main.swift` —— 进程入口：建 `NSApplication`，`setActivationPolicy(.accessory)`（LSUIElement，无 dock 无菜单栏），装配 Bridge + DynamicNotch，`app.run()`。
- `Sources/MrOttoIsland/Bridge.swift` —— IPC：后台线程逐行读 `FileHandle.standardInput`，`JSONDecoder` 解码成 `Inbound`，`DispatchQueue.main.async` 派发给状态持有者；`send(_ outbound:)` 把 `Outbound` 编码成一行 JSON 写 `FileHandle.standardOutput`（加锁串行化，防交错）。解析失败：`FileHandle.standardError` 记一行、跳过该行、保持管道。
- `Sources/MrOttoIsland/IslandState.swift` —— Codable 结构镜像桥协议：`Inbound`（`state`）、`Outbound`（`send`/`approve`/`deny`/`ready`）、`IslandSnapshot`、`Chrome`、`ToolRef`、`PendingApproval`。
- `Sources/MrOttoIsland/IslandView.swift` —— SwiftUI 视图：四态（idle 折叠、active、审批、输入），`@Published` 驱动，hover 展开；从 `IslandSnapshot` 派生 view-state 的纯函数 `viewState(for:)`。
- `Sources/MrOttoIsland/ToolSummary.swift` —— 移植 `src/renderer/src/lib/toolSummary.ts` 的 verb/target 逻辑（read_file/write_file/bash… 到中文动词+目标）。
- `Tests/MrOttoIslandTests/` —— `swift test`：`Inbound`/`Outbound` Codable roundtrip、`ToolSummary` 各工具映射、`viewState(for:)` 四态判定。

### Electron 侧

- **新增** `src/main/islandBridge.ts` —— 替换 `src/main/islandWindow.ts`：
  - `spawnIslandHelper(binPath)`：`child_process.spawn`，`stdio: ['pipe','pipe','pipe']`；管理生命周期与限次重启（≤3，退避）。
  - `pushState(snapshot)`：`JSON.stringify` + `\n` 写 helper.stdin。
  - 解析 helper.stdout 逐行 NDJSON → `Outbound`，回调转发（`send`→`sendMessage`，`approve`/`deny`→`decideApproval`）。
  - `ready` 命令 → 回推当前快照。
  - **纯函数抽出来单测**：`encodeState(snapshot): string`、`decodeCommand(line): Outbound | null`。
- **改** `src/main/index.ts`：把 `createIslandWindow/resizeIsland/primaryChrome` 那套换成 `islandBridge`；`islandSnapshot()` 补 `phase: "idle"|"active"|"approval"`、`currentTool: ToolRef | null`、`turnStartedAt: number | null`（这三个字段主进程已有足够信息算出：running + pending + 当前工具调用跟踪）；helper 只在 `process.platform === "darwin"` 且二进制存在时起。
- **改** `src/shared/shellBridge.ts`：`IslandBoot` 扩三个字段（phase/currentTool/turnStartedAt）；删 `islandResize`、`islandBoot`、`activeSessionChanged` 里 renderer 专用的部分（岛不再是 renderer）。保留供内部快照类型复用。
- **删**：`src/renderer/island.html`、`src/renderer/src/island/`（`Island.tsx`、`reduceIsland.ts`、`main.tsx`）、`src/main/islandWindow.ts`、preload 里的 `islandBoot`/`islandResize`、CHANNELS 里对应通道、`electron-vite`/vite 配置里 island.html 的 rollup input。

### 打包

- `electron-builder.yml` 加 `afterPack` 钩子（`scripts/build-island.mjs`）：
  1. `swift build -c release --package-path native/MrOttoIsland`（arm64）
  2. 拷 `native/MrOttoIsland/.build/release/MrOttoIsland` 进 `<app>/Contents/Resources/MrOttoIsland`
  3. `codesign` ad-hoc 签该二进制（与 app 同签名策略）
- `dev` 模式：`scripts/build-island.mjs --debug` 先 `swift build`，主进程从 `native/MrOttoIsland/.build/debug/MrOttoIsland` 找二进制（打包态从 `process.resourcesPath` 找）。

## 桥协议（NDJSON over stdio，一行一个 JSON 对象）

### 主进程 → Swift（写 helper.stdin）

```json
{"type":"state","state":{
  "sessionId": "abc" | null,
  "model": "deepseek-chat" | null,
  "chrome": {"notchWidth": 220, "menuBarHeight": 37},
  "phase": "idle" | "active" | "approval",
  "currentTool": {"verb":"运行","target":"npm test"} | null,
  "turnStartedAt": 1692700000000 | null,
  "pendingApproval": {"callId":"c1","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"} | null
}}
```

- 全量快照，非增量。任一相关变化都重推一整包（变化频率低，一天几十次，小 JSON，成本可忽略——对齐 0059 "丢弃成本可忽略"）。

### Swift → 主进程（写 helper.stdout）

```json
{"type":"ready"}
{"type":"send","sessionId":"abc","text":"帮我改下…"}
{"type":"approve","sessionId":"abc","callId":"c1"}
{"type":"approve","sessionId":"abc","callId":"c1","grant":"session"}
{"type":"deny","sessionId":"abc","callId":"c1"}
```

- `ready`：helper 启动握手，主进程收到后回推当前 `state`（解决"helper 在 turn 跑到一半才起来"——它一 ready 就拿到完整快照，等价于 0059 的 islandBoot）。

## 数据流

1. 主进程在以下时刻算 `islandSnapshot()` 并 `pushState`：active session 变、turnStatus 变、工具开始/结束、审批请求/裁决、model 变。
2. 序列化成一行写 helper.stdin。
3. Swift 解码，diff 上一次快照，驱动 `DynamicNotch.expand()/hide()` 与视图态切换。elapsed 计时器在 Swift 本地跑（不靠推送）。
4. 用户点岛输入 → 打字 → Enter → Swift 写 `{"type":"send"}` → 主进程 `sendMessage`。
5. 审批点击 → Swift 写 `approve`/`deny` → 主进程 `decideApproval` → 新快照回流（pendingApproval 变 null，按钮态清）。

## 几何 / 刘海

DynamicNotchKit 独占几何：拿 `NSScreen` 真实刘海尺寸，非 notch 机自动 `.floating`。**彻底删掉** `notchWidthForModel` 机型查表——那个查表正是这次重写要消灭的东西。`chrome.notchWidth` 仍随快照带过去（供渲染微调/日志），但几何主导权在库。

## 焦点 / 输入（最高风险）

- helper 常态 `.accessory`（LSUIElement），不抢焦点、不进 dock。
- 进输入态：临时 `NSApp.setActivationPolicy(.regular)` + `NSApp.activate(ignoringOtherApps: true)` 让文本框拿到键盘焦点；退出输入态（Enter 提交 / Esc / 失焦）后放回 `.accessory` 并 resign，把键盘交还用户原来那个 app（对齐 Electron 版 #175 I3：常驻置顶窗不能一直扣着键盘）。
- DynamicNotchKit 管面板展开动画；文本框（`NSTextField`/SwiftUI `TextField`）焦点由我们接。
- 计划里单列一 task 隔离这块，先跑通再谈观感。

## 生命周期 / 错误处理

- helper 随 app `ready` 起（仅 darwin 且二进制存在）；子进程，Electron 退时自动被回收。
- helper 崩：主进程限次重启（≤3，指数退避）；超限记一行、不亮岛、app 照常跑（用户选了删 Electron 兜底，**无降级**）。
- 二进制缺失 / spawn 失败：记一行，app 无岛运行。
- stdin/stdout 解析错（两侧）：记一行、跳该行、保管道不崩。
- Swift 解码失败：忽略该行，保留上一份好状态。

## 测试策略

- **TS 侧（进 gate）**：`islandBridge` 的 `encodeState` / `decodeCommand` 纯函数 vitest 单测（快照→行、行→命令、坏行→null）；spawn 逻辑注入一个可替身的 spawner 以便测生命周期/重启计数。
- **Swift 侧（不进 `npm test` gate）**：`swift test` —— `Inbound`/`Outbound` Codable roundtrip、`ToolSummary` 映射、`viewState(for:)` 四态。CI 另开 macOS job 跑（现有 CI 已在 macOS 上跑 electron mac app，可加一步）；若 CI 非 macOS 则文档化为手动。
- **e2e**：原生 notch Playwright 测不到；手动冒烟清单文档化（像 tests/e2e 今天那样，不进 gate）：四态切换、hover 展开、岛内发消息落到主窗会话、审批双向、多屏/拔插、非 notch 机 floating。

## 流程约束

- 推翻 ADR-0059 → 新项目 ADR `docs/adr/006X-灵动岛改原生-swift-helper.md`（记动机、stdio 子进程桥、快照推送投影模型、DynamicNotchKit 依赖、打包）+ GitHub issue（Task）+ 分支 PR。ADR 标注 supersedes 0059。
- **AGENTS.md「Tech stack」加一行 Swift helper（native/MrOttoIsland，SPM + DynamicNotchKit）—— 这是 L1 改动**（Tech stack = L1，ADR-0006/0010），合并前需 stanyan 明确 "agreed"（单人 repo：session 内或 PR 评论均可）。这条随主 PR 走，或单开一个 L1 PR，需在计划里点明。
- 保留 `claude/notch-island`（Electron 兜底/参照分支）不删不合。

## Hard rules 自检

- **append-only 日志唯一事实源、投影可从日志推导**：快照由主进程从日志算，Swift 无权威状态。✓
- **渲染进程只通过 ShellBridge**：Swift helper 非渲染进程，不适用；它是主进程独占的新 seam，ADR 明记。✓
- **工具实现只依赖 ExecutionWorld**：不涉及。✓
- **SessionEvent schema 向后兼容**：不新增事件。✓
