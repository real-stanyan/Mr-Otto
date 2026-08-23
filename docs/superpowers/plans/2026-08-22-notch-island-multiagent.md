# 灵动岛多智能体列表 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 灵动岛展开态从单会话状态改成侧栏式列出所有会话+各自运行态，点行选中就地审批/输入；主进程投影从单 `activeSessionId` 改成 `Map<sessionId,IslandState>` 会话集合。

**Architecture:** 主进程每会话一份 `IslandState`（复用 `reduceIsland`，事件按 `sessionId` 路由），拍平成 `IslandFleet{agents[],focusedSessionId}` 整包推给 Swift；Swift 展开视图 `List(agents)`，选中行下方嵌现有四态详情。桥出向命令已带 sessionId，不改。

**Tech Stack:** TypeScript/Electron 主进程 · Swift + SwiftUI + DynamicNotchKit · NDJSON over stdio · vitest（TS gate）· swift test（Swift 侧）

**Spec:** `docs/superpowers/specs/2026-08-22-notch-island-multiagent-design.md`

## Global Constraints

- 不新增 SessionEvent；多会话状态全从既有数据源（`store.sessions()`/`runningSessions`/每会话 reducer/各 agent `approver.pendingRequest()`）投影。
- 复用 `reduceIsland`，不另写 reducer；每会话一份 `IslandState`，事件按 `sessionId` 路由。
- 镜像侧栏可见集合：`spawnedFrom === null` 且 `workspace !== null`，按 workspace 分组、组内 `lastTs` 倒序、组序按组内最近 `lastTs` 倒序，展平成列表。
- 岛无权威状态；快照每 agent 状态可从日志推导。
- 出向命令 send/approve/deny 已带 `sessionId`，主进程按 sessionId 分发（`handleSendMessage`/`handleDecideApproval` 已如此）。
- gate 不变 `npm test`（tsc + vitest）；Swift `swift test` 不进 gate。
- 接续分支 `claude/notch-island-swift`（含 ADR-0061 单会话版，未合并）。补 ADR-0062，无新 L1。

---

### Task 1: 线上类型 + flattenFleet（TS，纯加法进 gate）

新增会话集合的线上类型与拍平纯函数，与现有单会话 `IslandSnapshot`/`flattenSnapshot` **并存**（Task 2 再切换并删旧），保证本任务 gate 绿。

**Files:**
- Modify: `src/shared/shellBridge.ts`（加 `IslandAgent`、`IslandFleet`；保留 `IslandSnapshot`）
- Modify: `src/main/islandProjection.ts`（加 `orderedVisibleSessions`、`flattenAgent`、`flattenFleet`；保留 `flattenSnapshot`）
- Test: `tests/main/islandFleet.test.ts`

**Interfaces:**
- Consumes: `IslandState`/`reduceIsland`/`initialIsland`（现存 `islandProjection.ts`）；`SessionSummary`（`src/session/store.ts`：`{sessionId, events, startedTs, lastTs, workspace: string|null, title: string|null, spawnedFrom: string|null}`）；`toolSummary`/`toolFilePath`（`src/shared/toolSummary.ts`）。
- Produces:
  - `src/shared/shellBridge.ts`：`IslandAgent`、`IslandFleet`（见下）。
  - `src/main/islandProjection.ts`：
    - `orderedVisibleSessions(sessions: SessionSummary[]): SessionSummary[]`
    - `flattenAgent(state: IslandState | undefined, session: SessionSummary): IslandAgent`
    - `flattenFleet(states: ReadonlyMap<string, IslandState>, sessions: SessionSummary[], focusedSessionId: string | null): IslandFleet`

- [ ] **Step 1: 加线上类型**

在 `src/shared/shellBridge.ts` 的 `IslandSnapshot` 附近新增（保留 `IslandSnapshot` 不动）：

```ts
/** 灵动岛列表里的一个会话（一行）。字段全是拍平后的字符串/枚举,Swift 纯渲染 */
export interface IslandAgent {
  sessionId: string;
  /** 侧栏同款显示名(SessionSummary.title);null 兜底成短标签由渲染侧处理 */
  title: string | null;
  phase: "idle" | "active" | "approval";
  currentTool: { verb: string; target: string } | null;
  turnStartedAt: number | null;
  pendingApproval: { callId: string; verb: string; target: string; fullPath: string | null } | null;
}

/** 灵动岛线上快照(多会话):侧栏可见集合每会话一行 + 主窗当前选中(默认高亮行) */
export interface IslandFleet {
  agents: IslandAgent[];
  focusedSessionId: string | null;
}
```

- [ ] **Step 2: 写 flattenFleet 测试（先失败）**

新建 `tests/main/islandFleet.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { flattenFleet, orderedVisibleSessions, initialIsland, reduceIsland } from "../../src/main/islandProjection.js";
import type { IslandState } from "../../src/main/islandProjection.js";

// 造 SessionSummary 的小工具(只填 flattenFleet/排序用到的字段)
const sess = (id: string, over: Partial<{ title: string | null; workspace: string | null; lastTs: number; spawnedFrom: string | null }> = {}) => ({
  sessionId: id, events: 0, startedTs: 0,
  lastTs: over.lastTs ?? 0,
  workspace: over.workspace ?? "/w/a",
  title: over.title ?? id,
  spawnedFrom: over.spawnedFrom ?? null,
});

describe("orderedVisibleSessions", () => {
  it("滤掉子会话和无 workspace,按工作区分组、组内 lastTs 倒序、组序按最近", () => {
    const list = [
      sess("s1", { workspace: "/w/a", lastTs: 10 }),
      sess("s2", { workspace: "/w/b", lastTs: 50 }),
      sess("s3", { workspace: "/w/a", lastTs: 30 }),
      sess("sub", { workspace: "/w/a", lastTs: 99, spawnedFrom: "s1" }), // 子会话滤掉
      sess("old", { workspace: null, lastTs: 99 }),                        // 无 workspace 滤掉
    ];
    const ids = orderedVisibleSessions(list).map((s) => s.sessionId);
    // /w/b 组最近(50) 在前;/w/a 组内 s3(30)>s1(10)
    expect(ids).toEqual(["s2", "s3", "s1"]);
  });
});

describe("flattenFleet", () => {
  it("每会话拍平;有 reducer 状态取之,无则 idle 默认;focusedSessionId 透传", () => {
    let running: IslandState = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "s2", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    const states = new Map<string, IslandState>([["s2", running]]);
    const sessions = [sess("s1", { lastTs: 10 }), sess("s2", { lastTs: 50 })];
    const fleet = flattenFleet(states, sessions, "s1");
    expect(fleet.focusedSessionId).toBe("s1");
    // s2 组不同? 这里同 workspace, s2 lastTs 大在前
    expect(fleet.agents.map((a) => a.sessionId)).toEqual(["s2", "s1"]);
    const a2 = fleet.agents.find((a) => a.sessionId === "s2")!;
    expect(a2.phase).toBe("active");
    const a1 = fleet.agents.find((a) => a.sessionId === "s1")!;
    expect(a1.phase).toBe("idle"); // 无 reducer 状态 → idle 默认
    expect(a1.title).toBe("s1");
  });

  it("审批态会话排到列表最前", () => {
    let approving = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "s1", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    approving = reduceIsland(approving, {
      kind: "approvalRequest",
      req: { sessionId: "s1", call: { id: "c1", name: "write_file", args: { path: "a.ts", content: "x" } }, toolDescription: "d" } as never,
    });
    const states = new Map<string, IslandState>([["s1", approving]]);
    // s2 的 lastTs 更大,正常会排前;但 s1 挂审批 → 置顶
    const sessions = [sess("s1", { lastTs: 10 }), sess("s2", { lastTs: 99 })];
    const fleet = flattenFleet(states, sessions, "s2");
    expect(fleet.agents[0].sessionId).toBe("s1");
    expect(fleet.agents[0].pendingApproval).toEqual({ callId: "c1", verb: "写入", target: "a.ts", fullPath: "a.ts" });
  });
});
```

- [ ] **Step 3: 实现 orderedVisibleSessions / flattenAgent / flattenFleet**

在 `src/main/islandProjection.ts` 末尾追加（`flattenSnapshot` 保留）。补 import：

```ts
import type { SessionSummary } from "../session/store.js";
import type { IslandAgent, IslandFleet } from "../shared/shellBridge.js";
```

```ts
/** 侧栏可见集合口径 + 同序:滤掉子会话(spawnedFrom!=null)/无 workspace,
    按 workspace 分组、组内 lastTs 倒序、组序按组内最近 lastTs 倒序,展平。
    与 renderer 的 groupSessionsByWorkspace 同规则(那份带 UI 标签,这里只要顺序) */
export function orderedVisibleSessions(sessions: SessionSummary[]): SessionSummary[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.workspace === null || s.spawnedFrom !== null) continue;
    const bucket = byDir.get(s.workspace);
    if (bucket) bucket.push(s);
    else byDir.set(s.workspace, [s]);
  }
  return [...byDir.values()]
    .map((list) => [...list].sort((a, b) => b.lastTs - a.lastTs))
    .sort((ga, gb) => (gb[0]?.lastTs ?? 0) - (ga[0]?.lastTs ?? 0))
    .flat();
}

/** 一份 IslandState(可能没有,按 idle)+ SessionSummary → 拍平成一行 IslandAgent */
export function flattenAgent(state: IslandState | undefined, session: SessionSummary): IslandAgent {
  const s = state ?? initialIsland;
  const ct = s.currentTool ? toolSummary(s.currentTool) : null;
  let pending: IslandAgent["pendingApproval"] = null;
  if (s.pendingApproval) {
    const sum = toolSummary(s.pendingApproval.call);
    pending = { callId: s.pendingApproval.call.id, verb: sum.verb, target: sum.target, fullPath: toolFilePath(s.pendingApproval.call) };
  }
  return {
    sessionId: session.sessionId,
    title: session.title,
    phase: s.phase,
    currentTool: ct ? { verb: ct.verb, target: ct.target } : null,
    turnStartedAt: s.turnStartedAt,
    pendingApproval: pending,
  };
}

/** 会话集合 → 线上 fleet。顺序 = 侧栏序,但审批态置顶(要人当场动手,不被淹) */
export function flattenFleet(
  states: ReadonlyMap<string, IslandState>,
  sessions: SessionSummary[],
  focusedSessionId: string | null
): IslandFleet {
  const ordered = orderedVisibleSessions(sessions);
  const agents = ordered.map((sess) => flattenAgent(states.get(sess.sessionId), sess));
  // 审批置顶:稳定排序,审批在前,其余保持侧栏序
  agents.sort((a, b) => Number(b.phase === "approval") - Number(a.phase === "approval"));
  return { agents, focusedSessionId };
}
```

> `Array.prototype.sort` 在 V8/Node 是稳定排序,`Number(b===approval)-Number(a===approval)` 只把审批行提前、其余相对序不变——满足"审批置顶,其余侧栏序"。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/islandFleet.test.ts`
Expected: PASS。

- [ ] **Step 5: 全 gate**

Run: `npm test`
Expected: PASS（新类型是纯加法,旧 IslandSnapshot/flattenSnapshot 仍在,不破坏现有）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/shellBridge.ts src/main/islandProjection.ts tests/main/islandFleet.test.ts
git commit -m "feat(island): 加多会话线上类型 IslandFleet + flattenFleet

IslandAgent/IslandFleet + orderedVisibleSessions(镜像侧栏序)+ flattenAgent
+ flattenFleet(审批置顶)。与单会话 IslandSnapshot 并存,下一步切换。"
```

---

### Task 2: 主进程切到会话集合 + 桥换 fleet（TS，gate 绿）

把 `let islandState` 换成 `Map<sessionId,IslandState>`，`feedIsland` 按 sessionId 路由，推整包 fleet；islandBridge 的线上类型从 `IslandSnapshot` 换成 `IslandFleet`；删除 `flattenSnapshot`/`IslandSnapshot`。

**Files:**
- Modify: `src/main/index.ts`（Map 投影、feedIsland 路由、pushFleet、deleteSession 剪枝、会话增改重推）
- Modify: `src/main/islandBridge.ts`（`encodeState`/`pushState`/`createIslandBridge`/`last` 的类型 `IslandSnapshot` → `IslandFleet`）
- Modify: `src/main/islandProjection.ts`（删 `flattenSnapshot`）
- Modify: `src/shared/shellBridge.ts`（删 `IslandSnapshot`）
- Modify: `tests/main/islandBridge.test.ts`（fixture 从 IslandSnapshot 改 IslandFleet）
- Modify: `tests/main/islandProjection.test.ts`（删/改 flattenSnapshot 相关用例——它测的能力已由 islandFleet.test.ts 覆盖；若该文件仅测 flattenSnapshot 则整体删，动机写进 commit）

**Interfaces:**
- Consumes: `flattenFleet`/`IslandState`/`reduceIsland`/`initialIsland`（Task 1 + 现存）；`IslandFleet`（Task 1）；`store.sessions()`（现存，返回 `SessionSummary[]`）。
- Produces: 主进程投影 `islandStates: Map<string, IslandState>`；`pushFleet()`；bridge 收发 `IslandFleet`。

- [ ] **Step 1: islandBridge 换类型**

`src/main/islandBridge.ts`：把所有 `IslandSnapshot` 换成 `IslandFleet`（import、`encodeState(fleet: IslandFleet)`、`createIslandBridge` 返回的 `pushState(s: IslandFleet)`、`let last: IslandFleet | null`）。函数体不变（`encodeState` 仍是 `JSON.stringify({ type: "state", state }) + "\n"`）。

```ts
import type { IslandFleet } from "../shared/shellBridge.js";
export function encodeState(fleet: IslandFleet): string {
  return JSON.stringify({ type: "state", state: fleet }) + "\n";
}
// ...createIslandBridge(...): { pushState(s: IslandFleet): void; dispose(): void }
// let last: IslandFleet | null = null;  pushState(s: IslandFleet) { ... }
```

- [ ] **Step 2: 改 islandBridge 测试 fixture**

`tests/main/islandBridge.test.ts`：把 `IDLE` 从单会话 `IslandSnapshot` 改成一个空 fleet：

```ts
import type { IslandFleet } from "../../src/shared/shellBridge.js";
const IDLE: IslandFleet = { agents: [], focusedSessionId: null };
// encodeState 测试断言改:
//   JSON.parse(line.trim()).state.agents 存在(而非 .phase)
//   expect(JSON.parse(line.trim()).type).toBe("state");
//   expect(Array.isArray(JSON.parse(line.trim()).state.agents)).toBe(true);
```
decode/重启相关用例不涉及 snapshot 内部形状，保持不变。

- [ ] **Step 3: index.ts 换 Map 投影**

在 `src/main/index.ts`：

1. import 调整：把 `flattenSnapshot` 换成 `flattenFleet`：
```ts
import { flattenFleet, initialIsland, reduceIsland, type IslandInput, type IslandState } from "./islandProjection.js";
```

2. 投影状态：把 `let islandState: IslandState = initialIsland;`（约 358 行）换成
```ts
const islandStates = new Map<string, IslandState>();
```

3. 加 `pushFleet` + 改 `feedIsland` 按 sessionId 路由（替换现有 `feedIsland`，约 379-386 行）：
```ts
// 整包推当前会话集合(侧栏可见会话 × 各自 reducer 状态)。会话多时也只是几字段/行,
// 沿用 ADR-0059 的"丢弃成本可忽略"
const pushFleet = (): void => {
  if (!bridge) return;
  bridge.pushState(flattenFleet(islandStates, store.sessions(), activeSessionId));
};

/** 投影器入口:四类输入都带 sessionId,路由到 Map 里对应那份 IslandState 跑
    reduceIsland;变了就重推整包 fleet。activeSession 输入顺便更新 focused */
const feedIsland = (input: IslandInput): void => {
  if (!bridge) return;
  const sid = islandInputSessionId(input);
  if (sid) {
    const cur = islandStates.get(sid) ?? initialIsland;
    const next = reduceIsland(cur, input);
    if (next !== cur) islandStates.set(sid, next);
  }
  pushFleet();
};

/** 从 IslandInput 取它作用的 sessionId(activeSession 用 boot.activeSessionId) */
function islandInputSessionId(input: IslandInput): string | null {
  switch (input.kind) {
    case "event": return input.event.sessionId;
    case "turnStatus": return input.update.sessionId;
    case "approvalRequest": return input.req.sessionId;
    case "activeSession": return input.boot.activeSessionId;
  }
}
```
> 保留现有六处 `feedIsland({...})` 调用点不动（event/approvalRequest/两组 turnStatus/两处 activeSession）——它们的入参形状没变，只是 `feedIsland` 内部改成路由。`activeSession` 分支里 `activeSessionId` 已在调用前被赋值（`setActiveSession` 先 `activeSessionId = sessionId` 再 `feedIsland`），故 `pushFleet` 读到的 `activeSessionId` 是新值。

4. `handleIslandCommand` 的 `ready` 分支（现在推 `flattenSnapshot`）改推 fleet：
```ts
if (c.type === "ready") { pushFleet(); return; }
```
（删掉原来那两行取 model + `bridge?.pushState(flattenSnapshot(...))`。）

5. `deleteSession`（约 1225 行）里 `agents.delete(id)` 附近加剪枝 + 重推：
```ts
islandStates.delete(id);
```
该 handler 末尾已有 `feedIsland({ kind: "activeSession", ... })`（约 1254），它会 `pushFleet`——删完再推即反映掉行。确认删的是被删会话的 id（该 handler 里遍历要删的会话集合，对每个 id 都 `islandStates.delete(id)`）。

6. 会话新建 / 改名 → 重推（新会话要在列表冒出来）：找 `session_created` / `session_renamed` 落事件后 `send(CHANNELS.event, ...)` 的位置——它们会走 `push.event` → `feedIsland({kind:"event"})` → `pushFleet`，故**已自动覆盖**（任何事件都触发 pushFleet，flattenFleet 每次现读 `store.sessions()`）。无需额外挂点。仅需确认 `feedIsland` 对 `event` 输入始终 `pushFleet`（Step 3 的实现是"路由后无条件 pushFleet"，满足）。

- [ ] **Step 4: 删旧单会话投影**

- `src/main/islandProjection.ts`：删 `flattenSnapshot` 函数。
- `src/shared/shellBridge.ts`：删 `IslandSnapshot` interface。
- 确认无残留引用：`git grep -n "flattenSnapshot\|IslandSnapshot" src/ tests/` 应为空。
- `tests/main/islandProjection.test.ts`：该文件原测 `flattenSnapshot`。其能力（拍平 currentTool/pendingApproval）已由 `tests/main/islandFleet.test.ts` 的 flattenAgent/flattenFleet 覆盖 → 删除该文件；**动机写进 commit**（"flattenSnapshot 已删,其覆盖迁移到 islandFleet.test.ts,非删测试凑绿"）。若该文件还测了 `reduceIsland` 本身，则只删 flattenSnapshot 相关 describe、保留 reduceIsland 用例。

- [ ] **Step 5: tsc + 全 gate**

Run: `npx tsc --noEmit`
Expected: 0 错（IslandSnapshot/flattenSnapshot 全删干净,islandBridge/index 都用 IslandFleet）。
Run: `npm test`
Expected: PASS。此时 macOS 上若 helper 二进制在,主进程推的是 fleet；旧 Swift 还只认单 snapshot（下一 task 改），但 TS 侧自洽、gate 绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(island): 主进程投影单会话→会话集合,推整包 fleet

islandState 单值换成 Map<sessionId,IslandState>,feedIsland 按 sessionId 路由,
pushFleet 推 flattenFleet(store.sessions() 现读);deleteSession 剪枝;ready 推
fleet。删 flattenSnapshot/IslandSnapshot(覆盖迁到 islandFleet.test.ts)。
兑现 ADR-0059 失效前提。"
```

---

### Task 3: Swift 协议镜像换 IslandFleet + Model（swift test 绿）

Swift 侧 Codable 从单 `IslandSnapshot` 换成 `IslandFleet`/`IslandAgent`；`IslandModel` 持 fleet + 选中态。

**Files:**
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/IslandState.swift`（`IslandSnapshot` → `IslandAgent` + `IslandFleet`；`Inbound.state` 变 `IslandFleet`）
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/IslandModel.swift`（`fleet` + `selectedSessionId`）
- Modify: `native/MrOttoIsland/Tests/MrOttoIslandTests/CodableTests.swift`（改测 IslandFleet 解码）

**Interfaces:**
- Consumes: 桥协议 `{"type":"state","state": IslandFleet}`（Task 1/2）。
- Produces:
  - `IslandAgent`（Codable：`sessionId: String`、`title: String?`、`phase: Phase`、`currentTool: ToolRef?`、`turnStartedAt: Double?`、`pendingApproval: PendingApproval?`）。
  - `IslandFleet`（Codable：`agents: [IslandAgent]`、`focusedSessionId: String?`）。
  - `IslandModel`：`@Published var fleet: IslandFleet`、`@Published var selectedSessionId: String?`、`var onOutbound`；`selectedAgent: IslandAgent?` 计算属性。

- [ ] **Step 1: IslandState.swift 换结构**

保留 `Phase`/`ToolRef`/`PendingApproval` 不变。把 `struct IslandSnapshot` 换成：

```swift
struct IslandAgent: Codable, Equatable, Identifiable {
  let sessionId: String
  let title: String?
  let phase: Phase
  let currentTool: ToolRef?
  let turnStartedAt: Double?
  let pendingApproval: PendingApproval?
  var id: String { sessionId }
}

struct IslandFleet: Codable, Equatable {
  let agents: [IslandAgent]
  let focusedSessionId: String?
}

/// 主进程 → helper
struct Inbound: Codable { let type: String; let state: IslandFleet }
```
`Outbound` 不变（send/approve/deny/ready）。

- [ ] **Step 2: IslandModel.swift**

```swift
import Foundation
import Combine

@MainActor
final class IslandModel: ObservableObject {
  @Published var fleet = IslandFleet(agents: [], focusedSessionId: nil)
  /// 用户点选的行;nil = 跟随 fleet.focusedSessionId
  @Published var selectedSessionId: String?
  @Published var composing = false
  var onOutbound: (Outbound) -> Void = { _ in }
  var onComposeChange: (Bool) -> Void = { _ in }

  /// 当前详情区对准的会话:用户选中优先,否则主窗聚焦,再否则列表首行
  var selectedAgent: IslandAgent? {
    let id = selectedSessionId ?? fleet.focusedSessionId
    return fleet.agents.first(where: { $0.id == id }) ?? fleet.agents.first
  }

  /// 新 fleet 到达:若选中行已不在列表(会话被删),清掉手动选中回落到 focused/首行
  func apply(_ next: IslandFleet) {
    fleet = next
    if let sel = selectedSessionId, !next.agents.contains(where: { $0.id == sel }) {
      selectedSessionId = nil
    }
  }

  func enterCompose() { guard !composing else { return }; composing = true; onComposeChange(true) }
  func exitCompose() { composing = false; onComposeChange(false) }
}
```

- [ ] **Step 3: Codable 测试改 IslandFleet**

`native/MrOttoIsland/Tests/MrOttoIslandTests/CodableTests.swift` 换成解 fleet：

```swift
import XCTest
@testable import MrOttoIsland

final class CodableTests: XCTestCase {
  func testDecodeFleet() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":"改点东西","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null},{"sessionId":"s2","title":null,"phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c9","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}],"focusedSessionId":"s1"}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents.count, 2)
    XCTAssertEqual(inbound.state.focusedSessionId, "s1")
    XCTAssertEqual(inbound.state.agents[0].currentTool, ToolRef(verb: "终端", target: "npm test"))
    XCTAssertNil(inbound.state.agents[1].title)
    XCTAssertEqual(inbound.state.agents[1].pendingApproval,
                   PendingApproval(callId: "c9", verb: "写入", target: "foo.ts", fullPath: "src/foo.ts"))
  }

  func testOutboundJSON() throws {
    let line = Outbound.approve(sessionId: "s", callId: "c", grant: "session").jsonLine()
    let o = try JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as! [String: Any]
    XCTAssertEqual(o["type"] as? String, "approve")
    XCTAssertEqual(o["grant"] as? String, "session")
  }
}
```

> **本 task 的编译约束**：改 `IslandModel`（去掉 `snapshot`）后 `IslandView`/`main.swift` 会编不过。所以 Step 4 在**同一 task 内**做最小编译修复（把 UI 对 `model.snapshot` 的引用改成 `model.selectedAgent`/`model.fleet`，列表 UI 留到 Task 4），Step 5 才跑 `swift build`/`swift test` 验证。**不要**在 Step 4 之前单独跑 swift test（此刻必编译失败）。

- [ ] **Step 4: 最小编译修复(main.swift / IslandView.swift)**

把 `IslandView`/`main.swift` 里读 `model.snapshot`（单会话）的地方改成读 `model.selectedAgent`（`IslandAgent?`）与 `model.fleet`：
- `main.swift` 的 `bridge.start { snapshot in ... model.snapshot = snapshot }` 改成 `model.apply(fleet)`：
```swift
bridge.start { fleet in
  DispatchQueue.main.async { MainActor.assumeIsolated { model.apply(fleet) } }
}
```
- `desiredState` 的入参从单 phase 改成读 fleet：任一 agent `.approval` 或 composing → `.expanded`；任一 `.active` 且 hover → `.expanded`；否则 `.compact`。先给能编译的最小版（Task 4 精化）：
```swift
func desiredState(fleet: IslandFleet, composing: Bool, hovering: Bool) -> NotchState {
  if composing { return .expanded }
  if fleet.agents.contains(where: { $0.phase == .approval }) { return .expanded }
  if hovering && fleet.agents.contains(where: { $0.phase != .idle }) { return .expanded }
  return .compact
}
```
- `IslandView` 里原来 `switch model.snapshot.phase` 的详情渲染改成 `if let agent = model.selectedAgent { ...按 agent.phase 渲染... }`；审批/输入的 sessionId 用 `agent.sessionId`。列表先不做（Task 4）。
- 折叠态脉动条件：`model.fleet.agents.contains { $0.phase == .active }`。

- [ ] **Step 5: swift build + test**

Run: `cd native/MrOttoIsland && swift build && swift test`
Expected: 编译通过 + 改后的 Codable 测试绿。

- [ ] **Step 6: Commit**

```bash
git add native/MrOttoIsland/Sources native/MrOttoIsland/Tests
git commit -m "feat(island): Swift 协议换 IslandFleet + Model 持 fleet/选中态

IslandSnapshot→IslandAgent+IslandFleet;IslandModel 持 fleet+selectedSessionId
+selectedAgent+apply(回落选中)。main/IslandView 暂只渲染 selectedAgent 保编译,
列表 UI 下一 task。swift test 改测 fleet 解码。"
```

---

### Task 4: Swift 列表 UI + 选中行详情（手动冒烟）

展开态渲染 `List(fleet.agents)`，每行状态；点行选中；选中行下方嵌现有四态详情（active/approval/compose）。折叠态脉动按任一在跑。

**Files:**
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/IslandView.swift`（列表 + 行视图 + 选中行详情）
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/main.swift`（desiredState 精化,不变则沿用 Task 3）

**Interfaces:**
- Consumes: `IslandModel`（`fleet`/`selectedAgent`/`selectedSessionId`/`composing`，Task 3）；`Outbound`。
- Produces: 列表展开视图；行点击设 `model.selectedSessionId`。

- [ ] **Step 1: 行视图 + 列表**

`IslandView.swift` 展开视图改成列表 + 选中行详情：

```swift
struct AgentRow: View {
  let agent: IslandAgent
  let selected: Bool
  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(agent.phase == .approval ? Color.orange : agent.phase == .active ? Color.blue : Color.gray)
        .frame(width: 6, height: 6)
        .opacity(agent.phase == .active ? 0.9 : 0.6)
      Text(agent.title ?? "未命名会话").lineLimit(1).foregroundStyle(.white)
      Spacer(minLength: 8)
      if agent.phase == .active, let t = agent.currentTool {
        Text("\(t.verb) \(t.target)").lineLimit(1).font(.caption).foregroundStyle(.white.opacity(0.6))
      }
    }
    .padding(.horizontal, 10).padding(.vertical, 4)
    .background(selected ? Color.white.opacity(0.08) : Color.clear)
    .contentShape(Rectangle())
  }
}
```

展开容器：列表在上，选中行详情在下（详情复用 Task 3 已把 `IslandExpandedView` 的详情部分改成吃 `IslandAgent`）：

```swift
struct IslandExpandedView: View {
  @ObservedObject var model: IslandModel
  var body: some View {
    VStack(spacing: 2) {
      if model.fleet.agents.isEmpty {
        Text("主窗里先开会话").font(.caption).foregroundStyle(.white.opacity(0.5)).padding(8)
      } else {
        ScrollView { // 会话多时可滚
          VStack(spacing: 0) {
            ForEach(model.fleet.agents) { agent in
              AgentRow(agent: agent, selected: agent.id == (model.selectedSessionId ?? model.fleet.focusedSessionId))
                .onTapGesture { model.selectedSessionId = agent.id }
            }
          }
        }.frame(maxHeight: 180)
        Divider().overlay(Color.white.opacity(0.1))
        if let agent = model.selectedAgent { detail(agent) }
      }
    }
  }
  // detail(agent):按 agent.phase / model.composing 渲染 —— 复用 Task 3 里已按 agent 改过的
  //   审批行(允许/会话/拒绝,sessionId=agent.sessionId)/ compose 输入 / active 详情
  @ViewBuilder private func detail(_ agent: IslandAgent) -> some View { /* Task 3 的详情视图,入参 agent */ }
}
```

> 详情区（审批按钮 / compose 输入 / active 行）在 Task 3 已改成吃 `IslandAgent`；本 task 把它放到列表下方。审批/发送用 `agent.sessionId`。

- [ ] **Step 2: 折叠 + 选中默认**

- 折叠态脉动：`model.fleet.agents.contains { $0.phase == .active }`（Task 3 已改）。
- 选中默认：`selectedAgent` 计算属性已处理（selectedSessionId ?? focusedSessionId ?? 首行）。
- `main.swift` 的 `desiredState`：审批置顶已在数据侧（flattenFleet），UI 上有审批→展开；沿用 Task 3 的 desiredState 即可，无需再改（除非要"有审批自动展开"——Task 3 版已含 `contains approval → .expanded`）。

- [ ] **Step 3: 编译**

Run: `cd native/MrOttoIsland && swift build`
Expected: 通过。

- [ ] **Step 4: 手动冒烟**

喂多会话 fleet，观察列表 + 选中 + 详情：
```bash
cd native/MrOttoIsland
(printf '%s\n' '{"type":"state","state":{"agents":[{"sessionId":"s1","title":"会话甲","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null},{"sessionId":"s2","title":"会话乙","phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c1","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}],"focusedSessionId":"s1"}}';
 sleep 8) | swift run MrOttoIsland
```
Expected：展开区列出两行（会话乙审批态置顶+琥珀点、会话甲蓝点+"终端 npm test"）；点会话乙 → 下方出允许/会话/拒绝，点允许 → stdout 出 `{"type":"approve","sessionId":"s2","callId":"c1"}`。观察结果记 PR。

- [ ] **Step 5: Commit**

```bash
git add native/MrOttoIsland/Sources
git commit -m "feat(island): Swift 展开态列表 + 选中行详情

List(fleet.agents) 每行状态点+标题+当前工具,点行选中,选中行下方嵌四态详情
(审批/输入对该 agent.sessionId)。折叠脉动按任一在跑。手动冒烟贴 PR。"
```

---

### Task 5: ADR-0062 + 冒烟文档 + spec 收尾

记模型变更，补多会话冒烟项。

**Files:**
- Create: `docs/adr/0062-灵动岛多智能体列表.md`
- Modify: `docs/island-smoke.md`（追加多会话验收项）
- Modify: `AGENTS.md`（"Where to find things" 那条 islandBridge 描述可补"多会话 fleet"，可选；**不动 Tech stack / Hard rules**）

**Interfaces:** 无代码接口。

- [ ] **Step 1: ADR-0062**

`docs/adr/0062-灵动岛多智能体列表.md`：背景（ADR-0061 单会话 + 用户验收要多会话；引用 ADR-0059 的失效前提"聚合多会话→单值改集合"）、决定（`Map<sessionId,IslandState>` 复用 reduceIsland 路由；`IslandFleet` 整包推；镜像侧栏可见集合；审批置顶；就地操作按 sessionId 分发）、否决（Swift 侧聚合 / 增量推送——先整包 YAGNI）、后果（推送载荷随会话数长,但每行几字段可忽略；选中态在 Swift 本地）。**明写"演进 ADR-0061,兑现 ADR-0059 失效前提"**（不是推翻 0061,是继续）。

- [ ] **Step 2: 冒烟文档追加**

`docs/island-smoke.md` 加"多会话"节：开 2+ 会话各自跑/挂审批 → 岛列表显各自状态；审批行置顶；点不同行切详情、就地审批落到对的会话；删一个会话岛列表掉行；`focusedSessionId`（主窗切会话）默认高亮跟随。

- [ ] **Step 3: gate**

Run: `npm test`
Expected: PASS（纯文档）。

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0062-灵动岛多智能体列表.md docs/island-smoke.md AGENTS.md
git commit -m "docs(island): ADR-0062 多智能体列表 + 多会话冒烟项

演进 ADR-0061:单会话→会话集合,兑现 ADR-0059 失效前提。冒烟补多会话验收。"
```

---

## 执行顺序与依赖

- Task 1（纯加法类型+flattenFleet）→ Task 2（主进程切 Map + 桥换 fleet + 删旧）：TS 主链,每步 gate 绿。Task 2 后 TS 侧推 fleet,旧 Swift 还认单 snapshot——但 TS 自洽、gate 绿(gate 不含 Swift)。
- Task 3（Swift 协议+Model 换 fleet,最小编译修复）→ Task 4（Swift 列表 UI）：Swift 链,swift build/test。Task 3 后 Swift 认 fleet、渲染选中单行；Task 4 加列表。
- Task 5：ADR + 文档收尾。
- 端到端（主进程推 fleet ↔ Swift 列表）在 Task 4 后由手动冒烟 + 真机 `npm run dev` 验（多开会话看列表）。

## Global 自检备忘

- Task 2 删 `tests/main/islandProjection.test.ts`（若仅测 flattenSnapshot）属"删测试"，动机（覆盖迁移到 islandFleet.test.ts,非凑绿）必须写进 commit（AGENTS.md 测试型门规则）。
- 不新增 SessionEvent、不改 Tech stack/Hard rules → 本计划无新 L1。
