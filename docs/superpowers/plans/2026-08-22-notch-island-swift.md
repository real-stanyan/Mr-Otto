# 灵动岛改原生 Swift helper 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 macOS 灵动岛从 Electron 第二窗口改成原生 Swift helper（DynamicNotchKit），投影逻辑留在主进程用现成 TS 跑、推拍平快照给 Swift 纯渲染，并删除 Electron 岛全部代码。

**Architecture:** 主进程（事件日志所有者）复用现成 `reduceIsland` + `toolSummary` 算出岛投影，拍平成线上快照，经 `child_process.spawn` 的 Swift helper 的 stdin 推 NDJSON；helper 用 DynamicNotchKit 拿真实刘海几何做四态 SwiftUI 渲染，用户操作经 stdout NDJSON 写回主进程转 `sendMessage`/`decideApproval`。Swift 侧不含 reducer、不含 toolSummary 移植——verb/target 主进程算好。

**Tech Stack:** TypeScript/Electron 主进程 · Swift + SwiftUI + DynamicNotchKit（SPM，MIT，macOS 13）· NDJSON over stdio · vitest（TS gate）· swift test（Swift 侧，不进 npm gate）

**Spec:** `docs/superpowers/specs/2026-08-22-notch-island-swift-design.md`

## Global Constraints

- arm64-only、ad-hoc 签名、无公证：Swift helper 二进制随 `.app` ad-hoc 签，不新增公证流程。
- DynamicNotchKit：`https://github.com/MrKai77/DynamicNotchKit`，MIT，SPM，helper 部署目标 `macOS 13`。
- 岛无权威状态：Swift 只渲染主进程推来的拍平快照；任何显示项必须能从主进程日志投影推导。
- 不新增 SessionEvent。
- gate 不变：`npm test`（`tsc --noEmit && vitest run`）。Swift 的 `swift test` 不进这个 gate。
- ShellBridge 边界：Swift helper 非渲染进程，不受 “渲染进程只通过 ShellBridge” 约束；是主进程独占的新 seam。
- 与 spec 的两处刻意收窄：①投影既在主进程算，Swift 就**不移植** `reduceIsland`/`toolSummary`（spec 里列的 `ToolSummary.swift` 取消）；②几何交给 DynamicNotchKit，线上快照**不带 chrome**。二者都落在 spec 核心意图（“Swift 纯渲染、免两语言各写一遍 reducer”）内。
- 保留 `claude/notch-island`（Electron 兜底/参照分支）不删不合。
- 流程门：推翻 ADR-0059 需新 ADR + GitHub issue + PR；AGENTS.md「Tech stack」加 Swift 是 **L1**，合并前需 stanyan 明说 “agreed”。

---

### Task 1: 投影搬进主进程（TS，进 gate）

把现成的 `reduceIsland` + `toolSummary` 挪到主进程可用的位置，加“拍平成线上快照”的纯函数。全部纯函数，vitest 覆盖。

**Files:**
- Create: `src/main/islandProjection.ts`
- Create: `src/shared/toolSummary.ts`（从 `src/renderer/src/lib/toolSummary.ts` 移动而来）
- Delete: `src/renderer/src/lib/toolSummary.ts`
- Modify: `src/renderer/src/aui/OttoThread.tsx`、`src/renderer/src/components/Timeline.tsx`、`src/renderer/src/lib/subagentTranscript.ts`（改 `toolSummary` 的 import 路径）
- Modify: `src/shared/shellBridge.ts`（加 `IslandSnapshot` 线上类型）
- Modify: `tests/renderer/toolSummary.test.ts`（改 import 路径）
- Test: `tests/main/islandProjection.test.ts`

**Interfaces:**
- Consumes: `reduceIsland`/`initialIsland`/`IslandState`/`IslandPhase`（现存于 `src/renderer/src/island/reduceIsland.ts`，本任务把内容复制进 `src/main/islandProjection.ts`，Task 3 再删旧文件）；`toolSummary`/`toolFilePath`（`ToolCallRequest → {verb,target,stat}` / `→ string|null`）。
- Produces:
  - `src/shared/toolSummary.ts` 导出 `toolSummary(call): {verb;target;stat}`、`toolFilePath(call): string|null`、`toolPhase`、`summarizeGroup`、`OrbState`（原样搬迁，签名不变）。
  - `src/main/islandProjection.ts` 导出 `IslandPhase = "idle"|"active"|"approval"`、`IslandState`、`initialIsland`、`reduceIsland(s, input)`、`flattenSnapshot(s, model): IslandSnapshot`。
  - `src/shared/shellBridge.ts` 导出 `IslandSnapshot`（见下）。

- [ ] **Step 1: 移动 toolSummary 到 shared，修好导入**

```bash
git mv src/renderer/src/lib/toolSummary.ts src/shared/toolSummary.ts
```

改 `src/shared/toolSummary.ts` 顶部三行相对路径（从 `src/renderer/src/lib/` 变成 `src/shared/`）：

```ts
import type { ToolCallRequest } from "../session/events.js";
import { ASK_USER_TOOL_NAME, parseAskUserArgs } from "../tools/askUser.js";
import { parseTodoArgs, TODO_TOOL_NAME } from "../session/deriveTodos.js";
```

把三个 renderer 引用方与测试的 import 从 `../lib/toolSummary.js` / `./toolSummary.js` / `@/lib/toolSummary.js` 改成指向 `@/…` 之外的 shared 路径。逐个文件替换（用各文件现有的相对深度）：

- `src/renderer/src/aui/OttoThread.tsx`：`from "@/lib/toolSummary.js"` → `from "../../../shared/toolSummary.js"`
- `src/renderer/src/components/Timeline.tsx`：`from "@/lib/toolSummary.js"` → `from "../../../shared/toolSummary.js"`
- `src/renderer/src/lib/subagentTranscript.ts`：`from "./toolSummary.js"` → `from "../../../shared/toolSummary.js"`
- `tests/renderer/toolSummary.test.ts`：把被测 import 指向 `../../src/shared/toolSummary.js`

> 注：`Island.tsx` 也 import 它，但 Task 3 会整目录删除，本任务不动它——它现在的 `@/lib/toolSummary.js` 会短暂失效，等 Task 3 删除该文件即消失。为让本任务 gate 绿，先把 `Island.tsx` 那行 import 也改成 `../../../shared/toolSummary.js`（改 import 不改逻辑，Task 3 连文件一起删）。

- [ ] **Step 2: 加 IslandSnapshot 线上类型**

在 `src/shared/shellBridge.ts` 的 `IslandBoot` 附近新增（不动 `IslandBoot`，它 Task 3 再收拾）：

```ts
/** 灵动岛的线上快照:主进程(日志所有者)算好的拍平投影,推给原生 helper 纯渲染。
    不带几何(chrome)——刘海尺寸由 Swift 侧 DynamicNotchKit 从 NSScreen 拿。
    currentTool/pendingApproval 都已拍平成字符串,Swift 不需要 toolSummary 逻辑 */
export interface IslandSnapshot {
  sessionId: string | null;
  model: string | null;
  phase: "idle" | "active" | "approval";
  /** 正在跑的工具的动词+目标(空闲/无工具=null) */
  currentTool: { verb: string; target: string } | null;
  /** 这个 turn 的起点(ms epoch);helper 本地据此走计时器。没在跑=null */
  turnStartedAt: number | null;
  /** 挂起的审批(没有=null)。fullPath:带路径的工具给完整路径,否则 null */
  pendingApproval: { callId: string; verb: string; target: string; fullPath: string | null } | null;
}
```

- [ ] **Step 3: 写 islandProjection.ts（复制 reducer + 加 flatten）**

新建 `src/main/islandProjection.ts`。把 `src/renderer/src/island/reduceIsland.ts` 的 `IslandPhase`/`IslandState`/`IslandInput`/`initialIsland`/`reduceIsland` **整体复制**进来，import 路径按 `src/main/` 的深度改（`../session/events.js`、`../shared/shellBridge.js`），再追加 `flattenSnapshot`：

```ts
import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import type { ApprovalRequest, IslandBoot, IslandSnapshot, TurnStatusUpdate } from "../shared/shellBridge.js";
import { toolFilePath, toolSummary } from "../shared/toolSummary.js";

export type IslandPhase = "idle" | "active" | "approval";

export interface IslandState {
  sessionId: string | null;
  phase: IslandPhase;
  currentTool: ToolCallRequest | null;
  turnStartedAt: number | null;
  pendingApproval: ApprovalRequest | null;
  callsById: Record<string, ToolCallRequest>;
}

export type IslandInput =
  | { kind: "event"; event: SessionEvent }
  | { kind: "turnStatus"; update: TurnStatusUpdate; now: number }
  | { kind: "approvalRequest"; req: ApprovalRequest }
  | { kind: "activeSession"; boot: IslandBoot; now: number };

export const initialIsland: IslandState = {
  sessionId: null,
  phase: "idle",
  currentTool: null,
  turnStartedAt: null,
  pendingApproval: null,
  callsById: {},
};

// reduceIsland：与 src/renderer/src/island/reduceIsland.ts 逐字相同（Task 3 删旧文件后此处成唯一副本）
export function reduceIsland(s: IslandState, input: IslandInput): IslandState {
  switch (input.kind) {
    case "activeSession": {
      const { activeSessionId, running, pendingApproval } = input.boot;
      if (activeSessionId === s.sessionId) {
        if (!pendingApproval || s.pendingApproval) return s;
        return { ...s, phase: "approval", pendingApproval };
      }
      return {
        ...initialIsland,
        sessionId: activeSessionId,
        phase: pendingApproval ? "approval" : running ? "active" : "idle",
        pendingApproval,
        turnStartedAt: running ? input.now : null,
      };
    }
    case "turnStatus": {
      if (input.update.sessionId !== s.sessionId) return s;
      if (input.update.status === "running") {
        return { ...s, phase: s.pendingApproval ? "approval" : "active", turnStartedAt: s.turnStartedAt ?? input.now };
      }
      return { ...initialIsland, sessionId: s.sessionId };
    }
    case "approvalRequest":
      if (input.req.sessionId !== s.sessionId) return s;
      return { ...s, phase: "approval", pendingApproval: input.req };
    case "event": {
      const e = input.event;
      if (e.sessionId !== s.sessionId) return s;
      switch (e.type) {
        case "assistant_message": {
          if (!e.toolCalls?.length) return s;
          const callsById = { ...s.callsById };
          for (const c of e.toolCalls) callsById[c.id] = c;
          return { ...s, callsById };
        }
        case "tool_execution_started":
          return { ...s, phase: "active", currentTool: s.callsById[e.toolCallId] ?? null };
        case "tool_result":
          return s.currentTool?.id === e.toolCallId ? { ...s, currentTool: null } : s;
        case "approval_decision":
          if (s.pendingApproval?.call.id !== e.toolCallId) return s;
          return { ...s, phase: "active", pendingApproval: null };
        default:
          return s;
      }
    }
  }
}

/** IslandState → 线上快照:currentTool/pendingApproval 拍平成字符串,附上 model */
export function flattenSnapshot(s: IslandState, model: string | null): IslandSnapshot {
  const ct = s.currentTool ? toolSummary(s.currentTool) : null;
  let pending: IslandSnapshot["pendingApproval"] = null;
  if (s.pendingApproval) {
    const sum = toolSummary(s.pendingApproval.call);
    pending = {
      callId: s.pendingApproval.call.id,
      verb: sum.verb,
      target: sum.target,
      fullPath: toolFilePath(s.pendingApproval.call),
    };
  }
  return {
    sessionId: s.sessionId,
    model,
    phase: s.phase,
    currentTool: ct ? { verb: ct.verb, target: ct.target } : null,
    turnStartedAt: s.turnStartedAt,
    pendingApproval: pending,
  };
}
```

- [ ] **Step 4: 写 flatten 测试（先失败）**

新建 `tests/main/islandProjection.test.ts`。用真实 `ToolCallRequest` 形状喂一段序列，断言拍平快照。工具调用形状参考 `src/session/events.ts` 的 `ToolCallRequest`（`{ id, name, args }`）。

```ts
import { describe, expect, it } from "vitest";
import { flattenSnapshot, initialIsland, reduceIsland } from "../../src/main/islandProjection.js";

describe("flattenSnapshot", () => {
  it("空闲态：全 null，带上 model", () => {
    const snap = flattenSnapshot(initialIsland, "deepseek-chat");
    expect(snap).toEqual({
      sessionId: null,
      model: "deepseek-chat",
      phase: "idle",
      currentTool: null,
      turnStartedAt: null,
      pendingApproval: null,
    });
  });

  it("跑 bash 工具：currentTool 拍平成 终端 + 命令", () => {
    let s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "sess1", model: "m", running: false, pendingApproval: null },
      now: 1000,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: {
        type: "assistant_message",
        sessionId: "sess1",
        toolCalls: [{ id: "call1", name: "bash", args: { cmd: "npm test" } }],
      } as never,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: { type: "tool_execution_started", sessionId: "sess1", toolCallId: "call1" } as never,
    });
    const snap = flattenSnapshot(s, "m");
    expect(snap.phase).toBe("active");
    expect(snap.currentTool).toEqual({ verb: "终端", target: "npm test" });
  });

  it("挂起审批：pendingApproval 拍平，write_file 带 fullPath 完整路径", () => {
    let s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "sess1", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    s = reduceIsland(s, {
      kind: "approvalRequest",
      req: {
        sessionId: "sess1",
        call: { id: "call9", name: "write_file", args: { path: "src/foo.ts", content: "a\nb" } },
        toolDescription: "写文件",
      } as never,
    });
    const snap = flattenSnapshot(s, "m");
    expect(snap.phase).toBe("approval");
    expect(snap.pendingApproval).toEqual({
      callId: "call9",
      verb: "写入",
      target: "foo.ts",
      fullPath: "src/foo.ts",
    });
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run tests/main/islandProjection.test.ts`
Expected: FAIL（`islandProjection.js` 尚未被解析 / 断言未满足前）。若 Step 3 已写完则应直接 PASS——那也可接受，关键是 Step 6 全绿。

- [ ] **Step 6: 跑全 gate**

Run: `npm test`
Expected: PASS（tsc 无错 + 全部 vitest 绿，含新测试与改了 import 的 renderer 测试）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(island): 投影逻辑搬进主进程,加线上快照拍平

reduceIsland + toolSummary 挪到主进程可达位置(shared/toolSummary +
main/islandProjection),加 flattenSnapshot 把 currentTool/pendingApproval
拍平成字符串。为原生 helper 铺路:投影在日志所有者处算一次,Swift 纯渲染。"
```

---

### Task 2: islandBridge 协议编解码 + 子进程管理（TS，纯函数进 gate）

主进程侧的桥：把快照编成 NDJSON 行、把 helper 回来的行解成命令、管 helper 子进程生命周期与限次重启。编解码是纯函数进 gate；spawn 逻辑用可注入的 spawner 便于测重启计数。

**Files:**
- Create: `src/main/islandBridge.ts`
- Test: `tests/main/islandBridge.test.ts`

**Interfaces:**
- Consumes: `IslandSnapshot`（Task 1，`src/shared/shellBridge.ts`）。
- Produces:
  - `encodeState(snapshot: IslandSnapshot): string`（返回一行 JSON + `\n`）。
  - `IslandCommand = {type:"ready"} | {type:"send";sessionId:string;text:string} | {type:"approve";sessionId:string;callId:string;grant?:"session"} | {type:"deny";sessionId:string;callId:string}`。
  - `decodeCommand(line: string): IslandCommand | null`（坏行/未知 type → null）。
  - `createIslandBridge(opts: { binPath: string; spawn: SpawnFn; onCommand: (c: IslandCommand) => void; log?: (m: string) => void }): { pushState(s: IslandSnapshot): void; dispose(): void }`。
  - `SpawnFn = (binPath: string) => IslandChild`；`IslandChild = { stdin: { write(s: string): void }; stdout: { on(ev: "data", cb: (b: Buffer) => void): void }; on(ev: "exit", cb: () => void): void; kill(): void }`（`child_process.spawn` 的返回子集，测试用假实现替身）。

- [ ] **Step 1: 写编解码 + 重启计数测试（先失败）**

新建 `tests/main/islandBridge.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createIslandBridge, decodeCommand, encodeState } from "../../src/main/islandBridge.js";
import type { IslandSnapshot } from "../../src/shared/shellBridge.js";

const IDLE: IslandSnapshot = {
  sessionId: null, model: null, phase: "idle",
  currentTool: null, turnStartedAt: null, pendingApproval: null,
};

describe("encodeState", () => {
  it("一行 JSON 带换行结尾", () => {
    const line = encodeState(IDLE);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim()).type).toBe("state");
    expect(JSON.parse(line.trim()).state.phase).toBe("idle");
  });
});

describe("decodeCommand", () => {
  it("解 send", () => {
    expect(decodeCommand('{"type":"send","sessionId":"s","text":"hi"}')).toEqual({
      type: "send", sessionId: "s", text: "hi",
    });
  });
  it("解 approve 带 grant", () => {
    expect(decodeCommand('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}')).toEqual({
      type: "approve", sessionId: "s", callId: "c", grant: "session",
    });
  });
  it("坏 JSON → null", () => {
    expect(decodeCommand("not json")).toBeNull();
  });
  it("未知 type → null", () => {
    expect(decodeCommand('{"type":"wat"}')).toBeNull();
  });
});

function fakeChild() {
  const dataCbs: ((b: Buffer) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  return {
    stdin: { writes: [] as string[], write(s: string) { this.writes.push(s); } },
    stdout: { on(_ev: "data", cb: (b: Buffer) => void) { dataCbs.push(cb); } },
    on(ev: "exit", cb: () => void) { if (ev === "exit") exitCbs.push(cb); },
    kill: vi.fn(),
    /** 测试入口:模拟子进程退出 */
    emitExit() { exitCbs.forEach((f) => f()); },
    /** 测试入口:模拟 stdout 吐一段字节 */
    emitData(s: string) { const b = Buffer.from(s, "utf8"); dataCbs.forEach((f) => f(b)); },
  };
}

describe("createIslandBridge", () => {
  it("崩溃后重启,超过 3 次不再起", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = () => { const c = fakeChild(); children.push(c); return c as never; };
    createIslandBridge({ binPath: "/x", spawn, onCommand: () => {} });
    expect(children.length).toBe(1);
    // 每次都让"最新"那个子进程退出;初始 1 + 重启 3 = 4 个,第 4 次退出后放弃
    for (let i = 0; i < 5; i++) children[children.length - 1].emitExit();
    expect(children.length).toBe(4);
  });

  it("stdout 整行才解码,onCommand 收到 send", () => {
    let got: unknown = null;
    const c = fakeChild();
    createIslandBridge({ binPath: "/x", spawn: () => c as never, onCommand: (cmd) => { got = cmd; } });
    // 分两段喂,验证行缓冲:半行不触发,补齐换行才解码
    c.emitData('{"type":"send","sessionId":"s",');
    expect(got).toBeNull();
    c.emitData('"text":"hi"}\n');
    expect(got).toEqual({ type: "send", sessionId: "s", text: "hi" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/islandBridge.test.ts`
Expected: FAIL（`islandBridge.js` not found）。

- [ ] **Step 3: 实现 islandBridge.ts**

```ts
import type { IslandSnapshot } from "../shared/shellBridge.js";

export type IslandCommand =
  | { type: "ready" }
  | { type: "send"; sessionId: string; text: string }
  | { type: "approve"; sessionId: string; callId: string; grant?: "session" }
  | { type: "deny"; sessionId: string; callId: string };

export interface IslandChild {
  stdin: { write(s: string): void };
  stdout: { on(ev: "data", cb: (b: Buffer) => void): void };
  on(ev: "exit", cb: () => void): void;
  kill(): void;
}
export type SpawnFn = (binPath: string) => IslandChild;

export function encodeState(snapshot: IslandSnapshot): string {
  return JSON.stringify({ type: "state", state: snapshot }) + "\n";
}

export function decodeCommand(line: string): IslandCommand | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const c = o as Record<string, unknown>;
  switch (c.type) {
    case "ready":
      return { type: "ready" };
    case "send":
      return typeof c.sessionId === "string" && typeof c.text === "string"
        ? { type: "send", sessionId: c.sessionId, text: c.text }
        : null;
    case "approve":
      return typeof c.sessionId === "string" && typeof c.callId === "string"
        ? { type: "approve", sessionId: c.sessionId, callId: c.callId, ...(c.grant === "session" ? { grant: "session" as const } : {}) }
        : null;
    case "deny":
      return typeof c.sessionId === "string" && typeof c.callId === "string"
        ? { type: "deny", sessionId: c.sessionId, callId: c.callId }
        : null;
    default:
      return null;
  }
}

const MAX_RESTARTS = 3;

export function createIslandBridge(opts: {
  binPath: string;
  spawn: SpawnFn;
  onCommand: (c: IslandCommand) => void;
  log?: (m: string) => void;
}): { pushState(s: IslandSnapshot): void; dispose(): void } {
  const log = opts.log ?? (() => {});
  let child: IslandChild | null = null;
  let restarts = 0;
  let disposed = false;
  let last: IslandSnapshot | null = null;
  let buf = "";

  const start = () => {
    if (disposed) return;
    const c = opts.spawn(opts.binPath);
    child = c;
    buf = "";
    c.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const cmd = decodeCommand(line);
        if (cmd) opts.onCommand(cmd);
        else log(`岛桥:无法解析命令行 ${line.slice(0, 120)}`);
      }
    });
    c.on("exit", () => {
      if (disposed) return;
      if (restarts >= MAX_RESTARTS) {
        log(`岛桥:helper 崩溃 ${restarts} 次,放弃重启,岛不再显示`);
        child = null;
        return;
      }
      restarts += 1;
      log(`岛桥:helper 退出,第 ${restarts} 次重启`);
      start();
      // ready 握手会由 helper 侧发起并回推;这里重启后把最后一份快照也补推一次
      if (last) pushState(last);
    });
  };

  const pushState = (s: IslandSnapshot) => {
    last = s;
    if (!child) return;
    try {
      child.stdin.write(encodeState(s));
    } catch (e) {
      log(`岛桥:写 stdin 失败 ${String(e)}`);
    }
  };

  start();

  return {
    pushState,
    dispose() {
      disposed = true;
      child?.kill();
      child = null;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/islandBridge.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全 gate**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/main/islandBridge.ts tests/main/islandBridge.test.ts
git commit -m "feat(island): 主进程侧桥 —— NDJSON 编解码 + helper 子进程管理

encodeState/decodeCommand 纯函数,createIslandBridge 管 spawn/行缓冲/限次
重启(≤3)。spawner 可注入,重启计数与解码单测覆盖。"
```

---

### Task 3: 接进 index.ts，删掉 Electron 岛（TS，gate 绿）

把 `islandWindow` 那套换成 `islandBridge` + 主进程投影器；删除 Electron 岛渲染入口、旧 `islandWindow.ts`、`islandBoot`/`islandResize` 通道与 preload、构建入口、`IslandBoot` 里的渲染专用件。

**Files:**
- Modify: `src/main/index.ts`（换接线；装投影器）
- Delete: `src/main/islandWindow.ts`
- Delete: `src/renderer/island.html`
- Delete: `src/renderer/src/island/`（`Island.tsx`、`reduceIsland.ts`、`main.tsx` 整目录）
- Modify: `src/preload/index.ts`（删 `islandBoot`/`islandResize`）
- Modify: `src/shared/shellBridge.ts`（删 `islandBoot`/`islandResize`/`onActiveSessionChanged` 接口成员与 `CHANNELS.islandBoot`/`islandResize`/`activeSessionChanged`；`IslandBoot` 保留作主进程内部快照类型，因 `IslandInput.activeSession` 与 `reduceIsland` 仍用它）
- Modify: `electron.vite.config.ts`（删 island.html 的 rollup 输入）
- Modify: `tests/architecture.test.ts`（若含 island 渲染入口的断言，改成对齐新结构；见 Step 5）

**Interfaces:**
- Consumes: `createIslandBridge`（Task 2）、`reduceIsland`/`initialIsland`/`flattenSnapshot`/`IslandState`/`IslandInput`（Task 1）、`resolveIslandBinPath`（Task 7 提供；本任务先用一个本地内联函数占位——见 Step 3 说明，Task 7 再替换为正式实现）。
- Produces: 主进程在 event/turnStatus/approvalRequest/activeSession 四处 choke point 喂投影器并 `pushState`。

- [ ] **Step 1: 找准接线点**

阅读 `src/main/index.ts` 现有锚点（行号随改动漂移，按符号找）：
- `const runningSessions = new Set<string>();`
- `const send = island ? createSend(win, island) : createSend(win);`（旧的双目标 fan-out；island 是 BrowserWindow）
- `push.event = (e) => send(CHANNELS.event, e)`
- `send(CHANNELS.approvalRequest, approvalPayload(...))`
- `send(CHANNELS.turnStatus, { sessionId, status: "running"|"idle" })`（两处）
- `const islandSnapshot = (): IslandBoot => {...}`、`setActiveSession` 里 `send(CHANNELS.activeSessionChanged, islandSnapshot())`
- `ipcMain.handle(CHANNELS.islandBoot, ...)`、`ipcMain.handle(CHANNELS.islandResize, ...)`
- `island?.destroy()`（退出清理）

- [ ] **Step 2: 删除 Electron 岛窗，装投影器 + 桥**

在 `src/main/index.ts`：

1. 删掉 `import { createIslandWindow, primaryChrome, resizeIsland } from "./islandWindow.js";`，改为：
```ts
import { createIslandBridge, type IslandCommand } from "./islandBridge.js";
import { flattenSnapshot, initialIsland, reduceIsland, type IslandInput, type IslandState } from "./islandProjection.js";
import { resolveIslandBinPath } from "./islandBinPath.js"; // Task 7 提供；本任务先内联占位
```

2. 删掉 `let island: BrowserWindow | null = null;` 与创建它的整段（`island = createIslandWindow({...})`）、`island?.destroy()`。`send` 回到单目标：`const send = createSend(win);`。

3. 装投影器（放在 `runningSessions`、`activeSessionId` 声明之后，`push` 定义之前）：
```ts
let islandState: IslandState = initialIsland;
const bridge =
  process.platform === "darwin"
    ? (() => {
        const bin = resolveIslandBinPath();
        if (!bin) return null;
        return createIslandBridge({
          binPath: bin,
          spawn: (p) => {
            const cp = spawn(p, [], { stdio: ["pipe", "pipe", "inherit"] });
            return { stdin: cp.stdin!, stdout: cp.stdout!, on: cp.on.bind(cp), kill: () => cp.kill() };
          },
          onCommand: (c) => handleIslandCommand(c),
          log: (m) => console.warn(m),
        });
      })()
    : null;

const feedIsland = (input: IslandInput) => {
  if (!bridge) return;
  const next = reduceIsland(islandState, input);
  if (next === islandState) return; // reduce 返回同引用 = 无变化,不推
  islandState = next;
  const model = activeSessionId ? (agents.get(activeSessionId)?.model ?? null) : null;
  bridge.pushState(flattenSnapshot(islandState, model));
};
```
`spawn` 从 `node:child_process` import（文件顶部若无则加 `import { spawn } from "node:child_process";`）。

4. `handleIslandCommand`（放在 `sendMessage`/`decideApproval` 的 ipc handler 附近，复用它们的内部实现或直接调对应函数）：
```ts
function handleIslandCommand(c: IslandCommand): void {
  if (c.type === "ready") {
    // helper 起来了:把当前快照补推一次(等价旧 islandBoot)
    const model = activeSessionId ? (agents.get(activeSessionId)?.model ?? null) : null;
    bridge?.pushState(flattenSnapshot(islandState, model));
    return;
  }
  if (c.type === "send") {
    void handleSendMessage(c.sessionId, c.text).catch((e) => console.warn("岛发消息失败", e));
    return;
  }
  const outcome = c.type === "approve"
    ? { decision: "approved" as const, ...(c.grant ? { grant: c.grant } : {}) }
    : { decision: "denied" as const };
  void handleDecideApproval(c.sessionId, c.callId, outcome).catch((e) => console.warn("岛审批失败", e));
}
```
> `handleSendMessage`/`handleDecideApproval`：把现有 `ipcMain.handle(CHANNELS.sendMessage, ...)` 与 `CHANNELS.decideApproval` 的处理体抽成命名函数，ipc handler 与 `handleIslandCommand` 都调它，避免逻辑二写。执行者按现有 handler 的真实签名抽取。

5. 在四处 choke point 后各加一行喂投影器（原 `send(...)` 保留，投影器是并行的第二消费者）：
- `push.event` 里：`feedIsland({ kind: "event", event: e });`
- `approvalRequest` 里（`approvalPayload` 之后）：`feedIsland({ kind: "approvalRequest", req: approvalPayload(sessionId, call, tool, preview, fromAgent) });`
- 两处 turnStatus：`feedIsland({ kind: "turnStatus", update: { sessionId, status: "running"|"idle" }, now: Date.now() });`
- `setActiveSession` 里：`feedIsland({ kind: "activeSession", boot: islandSnapshot(), now: Date.now() });`（`islandSnapshot()` 仍返回 `IslandBoot`，保留该函数）

6. 删 `ipcMain.handle(CHANNELS.islandBoot, ...)` 与 `ipcMain.handle(CHANNELS.islandResize, ...)`；退出清理里把 `island?.destroy()` 换成 `bridge?.dispose()`。

- [ ] **Step 3: Task 7 依赖的占位**

Task 7 会提供 `src/main/islandBinPath.ts`。本任务先创建它的最小可编译版，Task 7 再补全打包路径逻辑：
```ts
// src/main/islandBinPath.ts —— Task 7 补全 dev/packaged 路径解析
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 找 Swift helper 二进制;找不到返回 null(岛不启动) */
export function resolveIslandBinPath(): string | null {
  // dev:swift build -c debug 的产物
  const dev = join(import.meta.dirname, "../../native/MrOttoIsland/.build/debug/MrOttoIsland");
  if (existsSync(dev)) return dev;
  return null;
}
```

- [ ] **Step 4: 删除 Electron 岛文件与通道**

```bash
git rm src/main/islandWindow.ts src/renderer/island.html
git rm -r src/renderer/src/island
```
- `src/preload/index.ts`：删 `islandBoot`/`islandResize` 两行。
- `src/shared/shellBridge.ts`：删接口里的 `islandBoot`/`islandResize`/`onActiveSessionChanged` 三个成员；删 `CHANNELS.islandBoot`/`islandResize`/`activeSessionChanged`。保留 `IslandBoot` interface（`islandProjection` 仍 import 它）。
- `electron.vite.config.ts`：删 rollup input 里 `island: .../island.html` 那条。

- [ ] **Step 5: 修 architecture 测试与类型**

Run: `npx tsc --noEmit`
逐个消除因删通道/删文件产生的类型错（未用 import、CHANNELS 少键的引用）。若 `tests/architecture.test.ts` 断言过 island 渲染入口或 `islandWindow.ts` 的越界 import，改成对齐新结构：Swift helper 不在 TS 架构断言范围内；`islandBridge.ts` 用 `node:child_process` 是主进程合法依赖（它不是工具实现，不受 ExecutionWorld 约束——若架构测试按路径白名单，把 `src/main/islandBridge.ts` 纳入允许 spawn 的主进程文件）。

- [ ] **Step 6: 跑全 gate**

Run: `npm test`
Expected: PASS（tsc 干净 + vitest 全绿）。此时 macOS 上 `resolveIslandBinPath()` 找不到二进制 → `bridge` 为 null → 岛不启动，app 照常跑，无回归。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(island): 主进程接桥+投影器,删除 Electron 岛窗

islandWindow/第二 BrowserWindow/island.html/island 渲染目录/islandBoot+
islandResize 通道全删;index.ts 在 event/turnStatus/approval/activeSession
四处喂 reduceIsland 投影器,变则 pushState 拍平快照给 helper。helper 二进制
未就绪时 bridge=null,岛静默不启,app 无回归。推翻 ADR-0059 的落地第一步。"
```

---

### Task 4: Swift 包骨架 + 桥（headless，swift test 绿）

建 SPM 可执行包，跑通 stdin/stdout NDJSON 与 Codable，先不做 UI——喂一行 state 能解码、启动发 `ready`、把解出的 phase 打到 stderr。

**Files:**
- Create: `native/MrOttoIsland/Package.swift`
- Create: `native/MrOttoIsland/Sources/MrOttoIsland/main.swift`
- Create: `native/MrOttoIsland/Sources/MrOttoIsland/Bridge.swift`
- Create: `native/MrOttoIsland/Sources/MrOttoIsland/IslandState.swift`
- Create: `native/MrOttoIsland/Tests/MrOttoIslandTests/CodableTests.swift`
- Create: `native/MrOttoIsland/.gitignore`（`.build/`）

**Interfaces:**
- Consumes: 桥协议（Task 1/2 定义的 JSON 形状）。
- Produces:
  - `IslandSnapshot`（Codable，镜像 `src/shared/shellBridge.ts` 的 `IslandSnapshot`）：`sessionId: String?`、`model: String?`、`phase: Phase`、`currentTool: ToolRef?`、`turnStartedAt: Double?`、`pendingApproval: PendingApproval?`。
  - `Inbound`（`{type:"state", state: IslandSnapshot}`）、`Outbound`（`.ready`/`.send`/`.approve`/`.deny`，编成对应 JSON）。
  - `Bridge`：`start(onSnapshot:)` 后台读 stdin；`send(_:)` 写 stdout。

- [ ] **Step 1: Package.swift**

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MrOttoIsland",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/MrKai77/DynamicNotchKit", branch: "main"),
  ],
  targets: [
    .executableTarget(
      name: "MrOttoIsland",
      dependencies: [.product(name: "DynamicNotchKit", package: "DynamicNotchKit")]
    ),
    .testTarget(name: "MrOttoIslandTests", dependencies: ["MrOttoIsland"]),
  ]
)
```

- [ ] **Step 2: IslandState.swift（Codable 协议镜像）**

```swift
import Foundation

enum Phase: String, Codable { case idle, active, approval }

struct ToolRef: Codable, Equatable { let verb: String; let target: String }

struct PendingApproval: Codable, Equatable {
  let callId: String
  let verb: String
  let target: String
  let fullPath: String?
}

struct IslandSnapshot: Codable, Equatable {
  let sessionId: String?
  let model: String?
  let phase: Phase
  let currentTool: ToolRef?
  let turnStartedAt: Double?
  let pendingApproval: PendingApproval?
}

/// 主进程 → helper
struct Inbound: Codable { let type: String; let state: IslandSnapshot }

/// helper → 主进程
enum Outbound {
  case ready
  case send(sessionId: String, text: String)
  case approve(sessionId: String, callId: String, grant: String?)
  case deny(sessionId: String, callId: String)

  func jsonLine() -> String {
    let obj: [String: Any]
    switch self {
    case .ready: obj = ["type": "ready"]
    case let .send(s, t): obj = ["type": "send", "sessionId": s, "text": t]
    case let .approve(s, c, g):
      var o: [String: Any] = ["type": "approve", "sessionId": s, "callId": c]
      if let g { o["grant"] = g }
      obj = o
    case let .deny(s, c): obj = ["type": "deny", "sessionId": s, "callId": c]
    }
    let data = try! JSONSerialization.data(withJSONObject: obj)
    return String(data: data, encoding: .utf8)! + "\n"
  }
}
```

- [ ] **Step 3: Bridge.swift**

```swift
import Foundation

final class Bridge {
  private let outLock = NSLock()

  /// 后台线程逐行读 stdin,解出 IslandSnapshot 就回调(主线程由调用方切)
  func start(onSnapshot: @escaping (IslandSnapshot) -> Void) {
    let handle = FileHandle.standardInput
    DispatchQueue.global(qos: .userInitiated).async {
      var buffer = Data()
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break } // EOF:主进程退了
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
          let lineData = buffer.subdata(in: buffer.startIndex..<nl)
          buffer.removeSubrange(buffer.startIndex...nl)
          guard !lineData.isEmpty else { continue }
          do {
            let inbound = try JSONDecoder().decode(Inbound.self, from: lineData)
            onSnapshot(inbound.state)
          } catch {
            FileHandle.standardError.write("岛 helper:解码失败 \(error)\n".data(using: .utf8)!)
          }
        }
      }
      // stdin EOF → 主进程没了,退出
      DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
    }
  }

  func send(_ out: Outbound) {
    outLock.lock(); defer { outLock.unlock() }
    FileHandle.standardOutput.write(out.jsonLine().data(using: .utf8)!)
  }
}
```

- [ ] **Step 4: main.swift（headless 版：先不建 UI，验证桥）**

```swift
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // LSUIElement:无 dock 无菜单栏

let bridge = Bridge()
bridge.start { snapshot in
  DispatchQueue.main.async {
    // Task 5 会在这里驱动 DynamicNotch;现在只回显验证桥通
    FileHandle.standardError.write("岛 helper:收到 phase=\(snapshot.phase.rawValue)\n".data(using: .utf8)!)
  }
}
bridge.send(.ready) // 启动握手:请主进程回推当前快照

app.run()
```

- [ ] **Step 5: Codable 测试**

`native/MrOttoIsland/Tests/MrOttoIslandTests/CodableTests.swift`：

```swift
import XCTest
@testable import MrOttoIsland

final class CodableTests: XCTestCase {
  func testDecodeStateLine() throws {
    let line = #"{"type":"state","state":{"sessionId":"s","model":"m","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.phase, .active)
    XCTAssertEqual(inbound.state.currentTool, ToolRef(verb: "终端", target: "npm test"))
    XCTAssertNil(inbound.state.pendingApproval)
  }

  func testDecodeApproval() throws {
    let line = #"{"type":"state","state":{"sessionId":"s","model":null,"phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c9","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.pendingApproval,
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

- [ ] **Step 6: 建 .gitignore + 跑 swift test**

`native/MrOttoIsland/.gitignore`：
```
.build/
```
Run: `cd native/MrOttoIsland && swift test`
Expected: PASS（三个测试绿）。首跑会拉 DynamicNotchKit 依赖。

- [ ] **Step 7: 冒烟验证桥（手动）**

Run: `cd native/MrOttoIsland && printf '%s\n' '{"type":"state","state":{"sessionId":"s","model":"m","phase":"active","currentTool":{"verb":"终端","target":"ls"},"turnStartedAt":1000,"pendingApproval":null}}' | swift run MrOttoIsland`
Expected: stderr 出现 `岛 helper:收到 phase=active`；stdout 出现 `{"type":"ready"}`。Ctrl-C 退出（或 stdin EOF 自动退）。

- [ ] **Step 8: Commit**

```bash
git add native/MrOttoIsland
git commit -m "feat(island): Swift helper 骨架 —— SPM 包 + stdin/stdout NDJSON 桥

Package.swift(DynamicNotchKit dep, macOS13) + Codable 协议镜像 +
后台读 stdin 逐行解 IslandSnapshot + stdout 写 Outbound + .accessory
NSApplication。headless:先回显 phase 验证桥通,UI 在下一 task。swift test
覆盖 Codable roundtrip。"
```

---

### Task 5: Swift 四态里的三态 UI —— idle/active/approval（手动冒烟）

用 DynamicNotchKit 做折叠 idle、active、审批三态渲染 + hover 展开；审批按钮写回 approve/deny。输入态留 Task 6。

**Files:**
- Create: `native/MrOttoIsland/Sources/MrOttoIsland/IslandView.swift`
- Create: `native/MrOttoIsland/Sources/MrOttoIsland/IslandModel.swift`（`ObservableObject` 持快照 + 暴露发命令回调）
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/main.swift`（装 DynamicNotch + model）

**Interfaces:**
- Consumes: `IslandSnapshot`/`Phase`/`ToolRef`/`PendingApproval`（Task 4）、`Bridge.send`（Task 4）。
- Produces: `IslandModel: ObservableObject`（`@Published var snapshot: IslandSnapshot`；`var onOutbound: (Outbound) -> Void`）；`IslandView: View`。

- [ ] **Step 1: IslandModel.swift**

```swift
import Foundation
import Combine

final class IslandModel: ObservableObject {
  @Published var snapshot = IslandSnapshot(
    sessionId: nil, model: nil, phase: .idle,
    currentTool: nil, turnStartedAt: nil, pendingApproval: nil
  )
  var onOutbound: (Outbound) -> Void = { _ in }
}
```

- [ ] **Step 2: IslandView.swift（三态）**

DynamicNotchKit 的 compact/expanded API 以其当前版本为准（README 只示 `expand()/hide()`）。执行者先 `swift package resolve` 后读 `.build/checkouts/DynamicNotchKit` 的公开 API 头，确认 compact leading/trailing + hover 的确切类型名，再落地。目标视觉：
- **idle 折叠**：贴合刘海，什么都不显（或极简一点亮线）。active 时底部一条脉动亮线。
- **active**：hover 展开显示 `currentTool.verb + target` + 本地 elapsed 计时；无 tool 显示 “思考中…”。
- **approval**：不等 hover 直接展开，显示 `verb + target` + 允许/会话/拒绝 三按钮。

```swift
import SwiftUI

struct IslandView: View {
  @ObservedObject var model: IslandModel
  @State private var now = Date()
  private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    let s = model.snapshot
    Group {
      switch s.phase {
      case .approval:
        approvalRow(s.pendingApproval)
      case .active:
        activeRow(s)
      case .idle:
        idleRow
      }
    }
    .onReceive(timer) { now = $0 }
  }

  private var idleRow: some View {
    // active 亮线交给折叠态;idle 就是刘海本身
    Color.clear.frame(width: 1, height: 1)
  }

  private func activeRow(_ s: IslandSnapshot) -> some View {
    HStack(spacing: 8) {
      Image(systemName: s.currentTool == nil ? "circle.dashed" : "terminal")
      Text(s.currentTool.map { "\($0.verb) \($0.target)" } ?? "思考中…")
        .lineLimit(1)
      if let start = s.turnStartedAt {
        Text("\(Int(now.timeIntervalSince1970 - start / 1000))s")
          .foregroundStyle(.secondary).monospacedDigit()
      }
    }.padding(.horizontal, 12).foregroundStyle(.white)
  }

  private func approvalRow(_ p: PendingApproval?) -> some View {
    HStack(spacing: 8) {
      Text("审批").foregroundStyle(.orange)
      Text(p.map { "\($0.verb) \($0.target)" } ?? "").lineLimit(1)
      if let p {
        Button { model.onOutbound(.approve(sessionId: model.snapshot.sessionId ?? "", callId: p.callId, grant: nil)) } label: { Image(systemName: "checkmark") }
        Button { model.onOutbound(.approve(sessionId: model.snapshot.sessionId ?? "", callId: p.callId, grant: "session")) } label: { Text("会话").font(.caption) }
        Button { model.onOutbound(.deny(sessionId: model.snapshot.sessionId ?? "", callId: p.callId)) } label: { Image(systemName: "xmark") }
      }
    }.padding(.horizontal, 12).foregroundStyle(.white).buttonStyle(.plain)
  }
}
```

- [ ] **Step 3: main.swift 装配 DynamicNotch**

把 headless 回显换成真 UI 驱动（DynamicNotch 的 expand/compact 调用按 resolve 出来的 API 落地）：

```swift
import AppKit
import DynamicNotchKit
import SwiftUI

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let model = IslandModel()
let bridge = Bridge()
model.onOutbound = { bridge.send($0) }

let notch = DynamicNotch { IslandView(model: model) }

bridge.start { snapshot in
  DispatchQueue.main.async {
    model.snapshot = snapshot
    Task {
      // 审批/活动 → 展开;空闲 → 收回贴合刘海(具体 API 名以 resolve 出来的为准)
      if snapshot.phase == .idle { await notch.hide() } else { await notch.expand() }
    }
  }
}
bridge.send(.ready)
app.run()
```

- [ ] **Step 4: 编译**

Run: `cd native/MrOttoIsland && swift build`
Expected: 编译通过。（DynamicNotchKit 真实 API 名若与占位不符,在此步据编译错更正。）

- [ ] **Step 5: 手动冒烟**

Run: 用一段脚本按序喂多行 state（idle→active→approval），观察刘海处渲染与展开/收回、hover、审批按钮点击后 stdout 是否出 approve/deny 行。记录在 PR 描述。
```bash
cd native/MrOttoIsland
(printf '%s\n' '{"type":"state","state":{"sessionId":"s","model":"m","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null}}';
 sleep 3;
 printf '%s\n' '{"type":"state","state":{"sessionId":"s","model":"m","phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c1","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}}';
 sleep 5) | swift run MrOttoIsland
```
Expected: 先在刘海处显示 active 行，3s 后转审批行带按钮；点“允许”后 stdout 出 `{"type":"approve",...}`。

- [ ] **Step 6: Commit**

```bash
git add native/MrOttoIsland/Sources
git commit -m "feat(island): Swift 三态 UI(idle/active/approval)+ DynamicNotch 驱动

IslandModel(ObservableObject)持快照,IslandView 按 phase 渲染,审批按钮
写回 approve/deny,main 装 DynamicNotch 按 phase 展开/收回。输入态下一 task。
手动冒烟结果贴 PR。"
```

---

### Task 6: Swift 输入态 + 焦点抢还（手动冒烟，最高风险）

岛内文本框对 Otto 打字：进输入态临时抬 activationPolicy 抢键盘、提交/Esc/失焦后放回 `.accessory` 把键盘还给用户原来的 app。

**Files:**
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/IslandView.swift`（加输入态 + 触发入口）
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/IslandModel.swift`（加 `@Published var composing`）
- Modify: `native/MrOttoIsland/Sources/MrOttoIsland/main.swift`（焦点抢还接线）

**Interfaces:**
- Consumes: `IslandModel`、`Outbound.send`。
- Produces: `IslandModel.composing: Bool`、`IslandModel.enterCompose()`/`exitCompose()`（后者触发 activationPolicy 还原回调 `onComposeChange: (Bool) -> Void`）。

- [ ] **Step 1: IslandModel 加输入态**

```swift
@Published var composing = false
var onComposeChange: (Bool) -> Void = { _ in }
func enterCompose() { composing = true; onComposeChange(true) }
func exitCompose() { composing = false; onComposeChange(false) }
```

- [ ] **Step 2: IslandView 加输入行 + 入口**

active/idle 行加一个“点一下说话”入口调 `model.enterCompose()`；`composing` 为真时渲染 `TextField`：

```swift
// 在 body 里,composing 优先于 phase:
if model.composing {
  composeRow
} else { /* switch phase … */ }

@State private var text = ""
private var composeRow: some View {
  HStack(spacing: 8) {
    TextField(model.snapshot.sessionId == nil ? "主窗里先开会话" : "对 Otto 说…", text: $text)
      .textFieldStyle(.plain).foregroundStyle(.white)
      .onSubmit { submit() }
    Button { submit() } label: { Image(systemName: "paperplane.fill") }.buttonStyle(.plain)
  }
  .padding(.horizontal, 12)
  .onExitCommand { model.exitCompose(); text = "" } // Esc
}

private func submit() {
  guard let sid = model.snapshot.sessionId, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
  model.onOutbound(.send(sessionId: sid, text: text))
  text = ""
  model.exitCompose()
}
```

- [ ] **Step 3: main.swift 焦点抢还**

```swift
model.onComposeChange = { composing in
  if composing {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  } else {
    NSApp.setActivationPolicy(.accessory) // 放回;键盘交还用户原来那个 app
  }
}
```
进输入态还需 DynamicNotch 展开且窗口 key（据 resolve 出来的 API：可能需 `notch.expand()` 后把承载窗口设为 key window 让 TextField 拿焦点）。执行者据实际 API 补全“让 TextField 真正拿到键盘焦点”这一步——这是本 task 的核心验收点。

- [ ] **Step 4: 编译**

Run: `cd native/MrOttoIsland && swift build`
Expected: 通过。

- [ ] **Step 5: 手动冒烟（核心）**

先在别的 app（如备忘录）里点一下让 Mr Otto 不在前台，再触发岛输入态，验证：①TextField 真能打字（焦点抢到了）；②Enter 后 stdout 出 `{"type":"send",...}`；③提交/Esc 后回到备忘录能继续打字（键盘还回去了，没被岛一直扣着）。结果贴 PR。

- [ ] **Step 6: Commit**

```bash
git add native/MrOttoIsland/Sources
git commit -m "feat(island): Swift 输入态 + 焦点抢还

岛内 TextField 对 Otto 打字;进输入态抬 activationPolicy(.regular)+activate
抢键盘,提交/Esc/失焦放回 .accessory 把键盘还给用户原来的 app(对齐 #175 I3
常驻置顶窗不能一直扣键盘)。焦点抢还是核心验收点,手动冒烟贴 PR。"
```

---

### Task 7: 打包 + dev 接线

出包时编 Swift helper 塞进 `.app` 并 ad-hoc 签；dev 时先 `swift build -c debug`；主进程按 dev/packaged 解析二进制路径。

**Files:**
- Create: `scripts/build-island.mjs`
- Modify: `src/main/islandBinPath.ts`（补 packaged 路径）
- Modify: `electron-builder.yml`（afterPack 钩子）
- Modify: `package.json`（`dev`/`dist:mac` 前置 build-island）

**Interfaces:**
- Consumes: Task 4 的 SPM 包（`native/MrOttoIsland`）。
- Produces: `.app/Contents/Resources/MrOttoIsland` 二进制；`resolveIslandBinPath()` dev+packaged 双分支。

- [ ] **Step 1: build-island.mjs**

```js
// 编 Swift helper。--debug 出 dev 二进制(swift build 默认 debug),否则 release。
// 打包时由 afterPack 调 release 分支并拷进 .app + ad-hoc 签。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dirname, "../native/MrOttoIsland");
const release = !process.argv.includes("--debug");
if (process.platform !== "darwin") {
  console.log("build-island:非 macOS,跳过");
  process.exit(0);
}
if (!existsSync(join(pkg, "Package.swift"))) {
  console.error("build-island:找不到 native/MrOttoIsland/Package.swift");
  process.exit(1);
}
const args = ["build", "--package-path", pkg, ...(release ? ["-c", "release"] : [])];
console.log("build-island:swift", args.join(" "));
execFileSync("swift", args, { stdio: "inherit" });
```

- [ ] **Step 2: islandBinPath.ts 补 packaged 分支**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveIslandBinPath(): string | null {
  // 打包态:electron-builder afterPack 把二进制放进 Resources
  const packaged = join(process.resourcesPath ?? "", "MrOttoIsland");
  if (existsSync(packaged)) return packaged;
  // dev:swift build -c debug 产物
  const dev = join(import.meta.dirname, "../../native/MrOttoIsland/.build/debug/MrOttoIsland");
  if (existsSync(dev)) return dev;
  return null;
}
```

- [ ] **Step 3: electron-builder afterPack 钩子**

`scripts/afterPack.cjs`：
```js
// electron-builder afterPack:把 release 版 helper 拷进 .app 并 ad-hoc 签
const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const bin = join(__dirname, "../native/MrOttoIsland/.build/release/MrOttoIsland");
  if (!existsSync(bin)) throw new Error("afterPack:helper release 二进制缺失,先跑 build-island");
  const appName = ctx.packager.appInfo.productFilename;
  const dest = join(ctx.appOutDir, `${appName}.app`, "Contents", "Resources", "MrOttoIsland");
  copyFileSync(bin, dest);
  execFileSync("codesign", ["--force", "--sign", "-", dest], { stdio: "inherit" }); // ad-hoc
  console.log("afterPack:helper 已拷入并 ad-hoc 签");
};
```
`electron-builder.yml` 加：
```yaml
afterPack: scripts/afterPack.cjs
```

- [ ] **Step 4: package.json 前置 build-island**

```json
"dev": "node scripts/build-island.mjs --debug && electron-vite dev",
"dist:mac": "node scripts/build-island.mjs && electron-vite build && electron-builder --mac --arm64"
```
> `dev` 前置在非 macOS 会被脚本自身跳过（Step 1 的 platform guard），不阻塞。

- [ ] **Step 5: 验证 dev 路径**

Run: `npm test`
Expected: PASS（纯 TS 改动,tsc + vitest 不受影响）。
Run（macOS，手动）: `node scripts/build-island.mjs --debug` 出 `.build/debug/MrOttoIsland`；启 `npm run dev`，确认主进程 spawn 到 helper、刘海处出现岛。结果贴 PR。

- [ ] **Step 6: Commit**

```bash
git add scripts/build-island.mjs scripts/afterPack.cjs src/main/islandBinPath.ts electron-builder.yml package.json
git commit -m "build(island): 打包编 Swift helper 塞进 .app + ad-hoc 签,dev 接线

build-island.mjs(dev debug/release)+afterPack 拷二进制进 Resources 并
codesign ad-hoc;resolveIslandBinPath dev/packaged 双分支;dev/dist:mac
前置 build-island(非 macOS 自跳)。"
```

---

### Task 8: ADR + AGENTS.md Tech stack（L1）+ 文档

记录决策、上调协议、补分发/冒烟文档。**含 L1 改动，合并前需 stanyan 明说 agreed。**

**Files:**
- Create: `docs/adr/00NN-灵动岛改原生-swift-helper.md`（NN = 现有最大号 +1，创建时查 `ls docs/adr/`）
- Modify: `AGENTS.md`（Tech stack 加一行；Where to find things 加 `native/MrOttoIsland`）
- Modify: `docs/distribution-macos.md`（补 helper 打包说明）
- Create: `docs/island-smoke.md`（手动冒烟清单）

**Interfaces:** 无代码接口；纯文档 + 协议。

- [ ] **Step 1: 写 ADR**

`docs/adr/00NN-灵动岛改原生-swift-helper.md`，含：背景（Electron 岛的刘海保真天花板、electron#31478）、决定（Swift helper + DynamicNotchKit + stdio 子进程桥 + 主进程算投影推拍平快照）、否决项（继续 Electron / XPC / Unix socket / Swift 侧重写 reducer）、后果（多一条 Swift 构建链、打包签名多一步、Swift 侧无权威状态）、**明写 supersedes ADR-0059**，并说明投影模型（主进程=日志所有者=权威投影，非“投影的投影”）。

- [ ] **Step 2: AGENTS.md Tech stack + 索引（L1）**

Tech stack 段加一行：
```
Swift + SwiftUI + DynamicNotchKit（native/MrOttoIsland；macOS 灵动岛原生 helper，主进程 spawn，stdio NDJSON 桥；ADR-00NN）
```
Where to find things 加：
```
- `native/MrOttoIsland/` — macOS 灵动岛原生 Swift helper（ADR-00NN，推翻 0059）
- `src/main/islandBridge.ts` / `islandProjection.ts` — 主进程侧桥与投影
```

- [ ] **Step 3: 分发文档**

`docs/distribution-macos.md` 加一节“灵动岛 helper”：出包时 `build-island.mjs` 编 release 版、afterPack 拷进 `Contents/Resources/MrOttoIsland` 并 ad-hoc 签；随主 app 同一签名策略，无独立公证；缺二进制则岛静默不启。

- [ ] **Step 4: 冒烟清单**

`docs/island-smoke.md`：四态切换、hover 展开、岛内发消息落到主窗会话、审批双向（岛点/主窗点互相收卡）、多屏/拔插、非 notch 机 floating 兜底、焦点抢还（别的 app 前台时打字/还键盘）。

- [ ] **Step 5: gate**

Run: `npm test`
Expected: PASS（纯文档,不影响）。

- [ ] **Step 6: Commit**

```bash
git add docs/adr AGENTS.md docs/distribution-macos.md docs/island-smoke.md
git commit -m "docs(island): ADR 推翻 0059 + AGENTS.md Tech stack(L1) + 分发/冒烟文档

ADR-00NN 记原生 Swift helper 决策 supersede 0059;AGENTS.md Tech stack
加 Swift 行(L1,合并前需 stanyan agreed);分发文档补 helper 打包;island-smoke
列手动验收清单。"
```

---

## 执行顺序与依赖

- Task 1 → 2 → 3 是 TS 主链，每步进 gate，Task 3 后 Electron 岛已删、app 无回归（helper 未就绪则岛静默）。
- Task 4 → 5 → 6 是 Swift 链，靠 `swift build`/`swift test`，Task 4 后桥可 headless 验证。
- Task 7 把两条链接起来（dev/打包路径）。
- Task 8 收尾协议与文档，**L1 合并门在此**。
- Task 3 依赖 Task 7 的 `islandBinPath.ts`：Task 3 先建最小占位版，Task 7 补全。二者都 import 同名 `resolveIslandBinPath`，签名一致。

## Global 自检备忘（执行者勿删测试凑绿）

- 删/改测试若无对应产品码改动 = L1（AGENTS.md 测试型门规则）。本计划只在 Task 3 因删通道而改 `architecture.test.ts`，属随产品码同 PR 的 L2 例行；须在 commit 说明动机。
- gate 全程 `npm test`，Swift 的 `swift test` 单独跑、不进这个 gate。
