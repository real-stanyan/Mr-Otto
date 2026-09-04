# 工作区多智能体 · 切片 1a（骨架·服务端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一条工作区云会话从「一台 engine」变成「N 台 engine + 一条串行队列」，@ 谁谁答；服务端跑得起来，界面上还看不见。

**Architecture:** 每只 agent 一台 `LoopEngine`（自己的 system prompt / adapter / 工具表）。上下文隔离靠**构造**：抽一个窄读接口 `EventLog`，`agentView(store, agentId)` 是它的第二个实现，engine 装配那一刻拿到的就是变换过的日志，engine 内部三处 model-facing 读一个都不改。@ 路由靠一份两端共用的纯逻辑。

**Tech Stack:** TypeScript (strict) / vitest / better-sqlite3 / Supabase (PostgREST + RLS)

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`

## Global Constraints

- **append-only 事件日志是唯一事实来源**；投影必须可从日志推导。
- **SessionEvent schema 变更必须向后兼容**：只加**可选**字段，旧日志必须永远可重放。
- **渲染进程只经 `ShellBridge`**；工具只依赖 `ExecutionWorld`。本切片不碰渲染层。
- 门禁 = `npm test`（`pretest` + 3× `tsc --noEmit` + `vitest run`）。每个 Task 收尾前它必须全绿。
- 测试统一放 `tests/`，镜像 `src/` 结构，**不与源码同目录**。
- 提交信息说**为什么**，不只说做了什么。
- 本切片**一行渲染层代码都不写**，`mentions` 缺席时行为与今天逐字节相同。

---

### Task 1: 事件加可选 `agentId`

turn 期的七个事件各加一个可选 `agentId`。缺席 = 单 agent 会话（旧日志、本机会话全在这一档）。

**注意：本仓没有 `tool_call` 事件** —— 工具调用内嵌在 `AssistantMessageEvent.toolCalls` 里。

**Files:**
- Modify: `src/session/events.ts`（`AssistantMessageEvent` / `ToolResultEvent` / `ToolExecutionStartedEvent` / `ApprovalRequestEvent` / `ApprovalDecisionEvent` / `RequestEnvelopeEvent` / `TurnEndedEvent`）
- Test: `tests/session/agentIdField.test.ts`

**Interfaces:**
- Produces: 七个事件接口上的 `agentId?: string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/agentIdField.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import { tempDir } from "../helpers/tempDir.js";

describe("事件的 agentId 字段（#928 切片 1a）", () => {
  it("带 agentId 落盘后原样读得回来", () => {
    const store = new EventStore(join(tempDir("mrotto-agentid-"), "s.db"));
    store.append({
      sessionId: "s1",
      ts: 1,
      type: "assistant_message",
      content: "查了，下滑 12%",
      model: "m",
      agentId: "ops",
    });
    const [e] = store.load("s1");
    expect(e).toMatchObject({ type: "assistant_message", agentId: "ops" });
  });

  it("不带 agentId 照常落盘——缺席就是单 agent 会话，全部旧日志都在这一档", () => {
    const store = new EventStore(join(tempDir("mrotto-agentid-"), "s.db"));
    store.append({ sessionId: "s1", ts: 1, type: "assistant_message", content: "hi", model: "m" });
    const [e] = store.load("s1");
    expect(e).toMatchObject({ type: "assistant_message" });
    expect("agentId" in e).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/session/agentIdField.test.ts
```

预期：TS 报 `Object literal may only specify known properties, and 'agentId' does not exist in type ...`

- [ ] **Step 3: 加字段**

七个接口里各插一段。文字只写一遍（第一个），其余六个复制同一段注释的第一行 + 字段：

```ts
  /** 这条是哪只工作区 agent 干的（#928）。**缺席 = 单 agent 会话**——旧日志、
      本机会话、云会话在多智能体上线前落的那些，全在这一档，照常重放。
      落盘由 engine 的 env() 统一供料，不是每个 append 点各写一遍 */
  agentId?: string;
```

- [ ] **Step 4: 跑测试，确认绿**

```
npx vitest run tests/session/agentIdField.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/session/events.ts tests/session/agentIdField.test.ts
git commit -m "feat(events): turn 期七个事件加可选 agentId（#928）

多智能体会话里同一份日志装着好几只 agent 的发言与工具痕迹,
「这条是谁干的」日志推不出来 —— 必须落盘。

可选而不是必填:缺席 = 单 agent 会话,旧日志与全部本机会话都在这一档,
照常重放(SessionEvent schema 向后兼容硬规则)。

本仓没有 tool_call 事件 —— 工具调用内嵌在 assistant_message.toolCalls,
所以是七个事件不是三个。"
```

---

### Task 2: `EventLog` 窄读接口

`LoopEngine` 与 `boundedContextEvents` 的 `store` 参数从具体类 `EventStore` 收窄成接口。

**为什么必须先做这一步**：`EventStore` 是 `class` 且有 `private` 成员（`db` / `stmts` / `prep` / `loadRaw`），一个裸包一层的普通对象**过不了 TypeScript 的结构类型检查**。没有这个接口，Task 3 的 `agentView` 写不出来。

**Files:**
- Create: `src/session/eventLog.ts`
- Modify: `src/session/store.ts`（`export class EventStore implements EventLog {`）
- Modify: `src/loop/engine.ts:47`（`store: EventStore` → `store: EventLog`）
- Modify: `src/session/modelContextScan.ts:37`（参数类型同上）
- Test: `tests/session/eventLog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `agentId?`（无直接依赖，但同一份 `SessionEvent`）
- Produces: `EventLog` 接口，五个方法：`append` / `load` / `forkOrigin` / `lastOfType` / `ofType`

- [ ] **Step 1: 写失败测试**

判据是**一个手写对象能当 store 用**——这正是 `agentView` 将来要做的事。

```ts
// tests/session/eventLog.test.ts
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import type { EventLog } from "../../src/session/eventLog.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 内存版 EventLog —— 不是 EventStore 的子类，就是一个普通对象。
    它能编译通过本身就是这个 Task 的判据 */
function memoryLog(): EventLog & { all: SessionEvent[] } {
  const all: SessionEvent[] = [];
  return {
    all,
    append(e) {
      const full = { ...e, seq: all.length } as SessionEvent;
      all.push(full);
      return full;
    },
    load: (_s, opts) => all.filter((e) => e.seq > (opts?.afterSeq ?? -1)),
    forkOrigin: () => null,
    lastOfType: (_s, type) => all.filter((e) => e.type === type).at(-1) ?? null,
    ofType: (_s, type) => all.filter((e) => e.type === type),
  };
}

describe("EventLog 窄读接口（#928 切片 1a）", () => {
  it("一个手写对象就能当 LoopEngine 的 store —— 不需要继承 EventStore", async () => {
    const log = memoryLog();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({
      store: log,
      adapter,
      tools: [],
      world,
      sessionId: "s1",
    });
    await engine.runTurn("在吗");
    expect(log.all.map((e) => e.type)).toContain("assistant_message");
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/session/eventLog.test.ts
```

预期：`Cannot find module '../../src/session/eventLog.js'`

- [ ] **Step 3: 建接口 + 三处收窄**

```ts
// src/session/eventLog.ts
// EventLog —— LoopEngine 与 boundedContextEvents 需要的那几个读写口,抽成接口(#928)。
//
// 为什么要这个接口:多智能体会话里,同一份日志装着好几只 agent 的痕迹,而一只
// agent 不该看见别人的工具调用与结果。隔离必须**靠构造**——装配那一刻递给 engine
// 一份变换过的日志,而不是在 engine 内部每处读点补一道过滤:model-facing 的读有
// 三处(snapshot 首圈 / snapshot 增量圈 / compactInner 全量),漏一处就安静地
// 把别人的上下文灌进模型(ADR-0047 否掉「子 agent 事件写进父日志」的同一条理由)。
//
// 为什么不能裸包一层 EventStore:它是 class 且有 private 成员(db / stmts /
// prep / loadRaw),结构类型检查过不了——必须有一个双方都实现的接口。
//
// 五个方法是实测出来的,不是照着 EventStore 的公开面抄的:engine.ts 只碰
// append / load,另外三个来自 boundedContextEvents(它也收 store)。接口窄一分,
// agentView 那侧要负责的语义就少一分。

import type { SessionEvent } from "./events.js";
import type { NewSessionEvent } from "./store.js";

export interface EventLog {
  append(event: NewSessionEvent): SessionEvent;
  load(sessionId: string, opts?: { afterSeq?: number; untilSeq?: number }): SessionEvent[];
  forkOrigin(sessionId: string): { sessionId: string; endSeq: number } | null;
  lastOfType(
    sessionId: string,
    type: SessionEvent["type"],
    opts?: { beforeSeq?: number }
  ): SessionEvent | null;
  ofType(
    sessionId: string,
    type: SessionEvent["type"],
    opts?: { beforeSeq?: number }
  ): SessionEvent[];
}
```

`src/session/store.ts`：

```ts
import type { EventLog } from "./eventLog.js";
// …
export class EventStore implements EventLog {
```

`src/loop/engine.ts` 的 import 与 `LoopEngineOptions.store`：

```ts
import type { EventLog } from "../session/eventLog.js";
// …
  store: EventLog;
```

`src/session/modelContextScan.ts`：

```ts
import type { EventLog } from "./eventLog.js";
// …
export function boundedContextEvents(store: EventLog, sessionId: string): SessionEvent[] | null {
```

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npx vitest run tests/session/eventLog.test.ts && npm test
```

全量是必须的：这一步改了两个热门文件的参数类型，别处可能有把 `EventStore` 独有方法当 store 用的调用点。真有的话就地把接口补宽（并在接口注释里说明它是谁要的），不要把类型改回 `EventStore`。

- [ ] **Step 5: 提交**

```bash
git add src/session/eventLog.ts src/session/store.ts src/loop/engine.ts src/session/modelContextScan.ts tests/session/eventLog.test.ts
git commit -m "refactor(session): 抽 EventLog 窄读接口,engine 与 boundedContextEvents 收窄到它（#928）

多智能体会话要让一只 agent 看不见别人的工具调用,而隔离必须靠构造:
装配那一刻递给 engine 一份变换过的日志。engine 内部 model-facing 的读有
三处(snapshot 首圈 / snapshot 增量圈 / compactInner 全量),挨个补过滤
漏一处就安静地把别人的上下文灌进模型 —— ADR-0047 否掉「子 agent 事件写进
父日志」时给过同一条理由。

不能裸包一层 EventStore:它是 class 且有 private 成员(db/stmts/prep/loadRaw),
结构类型检查过不了。所以先有接口,才写得出 agentView。

五个方法是实测的,不是抄公开面:engine 只碰 append/load,另外三个来自
boundedContextEvents。接口窄一分,第二个实现要负责的语义就少一分。

纯重构,行为零变化。"
```

---

### Task 3: `agentView` —— 变换，不是过滤

**这是本切片唯一一处不小心就会安静出错的地方。**

只按 `agentId` 丢事件是**错的**：别人的 `assistant_message.toolCalls` 会留下，而配对的 `tool_result` 被丢掉，于是 `deriveMessages` 的悬空工具调用自愈（ADR-0005 保命层，`src/session/deriveMessages.ts:351`）替它**造一条「没执行」的 tool 消息**塞进我的上下文——别人明明跑成功了，我的模型读到的是它没执行。不是崩溃，是凭空捏造的事实。

**Files:**
- Create: `src/session/agentView.ts`
- Test: `tests/session/agentView.test.ts`

**Interfaces:**
- Consumes: `EventLog`（Task 2）、`agentId?`（Task 1）
- Produces:
  - `projectForAgent(events: SessionEvent[], agentId: string): SessionEvent[]`
  - `agentView(store: EventLog, agentId: string): EventLog`

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/agentView.test.ts
import { describe, it, expect } from "vitest";
import { projectForAgent } from "../../src/session/agentView.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"]; seq: number }): SessionEvent {
  return { sessionId: "s1", ts: 0, ...partial } as SessionEvent;
}

describe("projectForAgent（#928 切片 1a）", () => {
  it("别人的 assistant_message 剥掉 toolCalls —— 留着它会让悬空自愈捏造一条「没执行」", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "查了，下滑 12%", model: "m", agentId: "ops",
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
      ev({ seq: 1, type: "tool_result", toolCallId: "c1", status: "ok", output: "12%", agentId: "ops" } as never),
    ];
    const out = projectForAgent(log, "ads");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "assistant_message", content: "查了，下滑 12%" });
    expect("toolCalls" in out[0]).toBe(false);
  });

  it("别人纯工具调用那一轮（content 为空）整条丢弃 —— 它没说话", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ops",
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });

  it("自己的事件一条不动 —— 含 toolCalls / reasoning / usage", () => {
    const mine = ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ads",
                      toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never);
    expect(projectForAgent([mine], "ads")).toEqual([mine]);
  });

  it("没有 agentId 的事件一律放行 —— 那是全场共有的（chat_message / user_message / session_created）", () => {
    const shared = [
      ev({ seq: 0, type: "session_created", workspace: null } as never),
      ev({ seq: 1, type: "user_message", content: "[alice]: 看下销量" } as never),
      ev({ seq: 2, type: "chat_message", fromUid: "u1", label: "alice", content: "顺便看下投放", mention: false } as never),
    ];
    expect(projectForAgent(shared, "ads")).toEqual(shared);
  });

  it("别人的 turn 期事件整条丢弃", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "tool_execution_started", toolCallId: "c1", agentId: "ops" } as never),
      ev({ seq: 1, type: "tool_result", toolCallId: "c1", status: "ok", output: "x", agentId: "ops" } as never),
      ev({ seq: 2, type: "turn_ended", agentId: "ops" } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/session/agentView.test.ts
```

预期：`Cannot find module '../../src/session/agentView.js'`

- [ ] **Step 3: 写实现**

```ts
// src/session/agentView.ts
// agentView —— 群聊云会话里,一只 agent 看得见日志的哪一部分(#928)。
// 设计出处:docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md §5。
//
// 判据一句话:**群里我听得见你说话,看不见你在你电脑上敲了什么**。
//
// 这是**变换**不是过滤,区别是要命的:只按 agentId 丢事件的话,别人的
// assistant_message.toolCalls 会留下、配对的 tool_result 被丢掉,于是
// deriveMessages 的悬空工具调用自愈(ADR-0005 保命层,deriveMessages.ts:351)
// 替它造一条「没执行」的 tool 消息塞进我的上下文 —— 别人明明跑成功了,我的
// 模型读到的是它没执行。安静地捏造事实,比 400 难查。
//
// reasoning / usage 一并剥掉:前者 API 明令禁止塞回上下文,后者是账不是话。

import type { EventLog } from "./eventLog.js";
import type { SessionEvent } from "./events.js";

/** 别人干活留下的痕迹 —— 整条不进我的上下文 */
const OTHERS_TURN_EVENTS: ReadonlySet<SessionEvent["type"]> = new Set([
  "tool_result",
  "tool_execution_started",
  "approval_request",
  "approval_decision",
  "request_envelope",
  "turn_ended",
]);

export function projectForAgent(events: SessionEvent[], agentId: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const e of events) {
    const owner = "agentId" in e ? e.agentId : undefined;
    // 没有 agentId = 全场共有(session_created / user_message / chat_message /
    // memory_loaded / context_compacted …),或者这是一条单 agent 会话的旧事件
    if (owner === undefined || owner === agentId) {
      out.push(e);
      continue;
    }
    if (OTHERS_TURN_EVENTS.has(e.type)) continue;
    if (e.type === "assistant_message") {
      const { toolCalls: _tc, reasoning: _r, usage: _u, ...spoken } = e;
      // 纯工具调用那一轮它没说话,剥完就是一条空消息 —— 不该占我上下文一格
      if (spoken.content.trim() === "") continue;
      out.push(spoken);
      continue;
    }
    out.push(e);
  }
  return out;
}

/** 把一份日志包成「这只 agent 眼里的日志」。写路径原样转发 —— 只有读要隔离 */
export function agentView(store: EventLog, agentId: string): EventLog {
  return {
    append: (e) => store.append(e),
    load: (sessionId, opts) => projectForAgent(store.load(sessionId, opts), agentId),
    forkOrigin: (sessionId) => store.forkOrigin(sessionId),
    // **压缩检查点必须按 agent 分格**:摘要是按 view 生成的(ADR-0003),运营那只
    // 压缩之后,广告那只若捡到运营的检查点,就会把运营视角的摘要当成自己的历史 ——
    // 上下文串台,而且安静。boundedContextEvents 正是靠 lastOfType 找检查点的。
    // user_message 不带 agentId(那是人说的话),照旧原样转发 —— 它回的是定位用的
    // seq,过滤反而会让后续按 seq 取的范围错位
    lastOfType: (sessionId, type, opts) => {
      const hit = store.lastOfType(sessionId, type, opts);
      if (!hit) return null;
      const owner = "agentId" in hit ? hit.agentId : undefined;
      return owner === undefined || owner === agentId ? hit : null;
    },
    ofType: (sessionId, type, opts) => projectForAgent(store.ofType(sessionId, type, opts), agentId),
  };
}
```

- [ ] **Step 4: 跑测试，确认绿**

```
npx vitest run tests/session/agentView.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/session/agentView.ts tests/session/agentView.test.ts
git commit -m "feat(session): agentView —— 一只 agent 眼里的日志（#928）

判据:群里我听得见你说话,看不见你在你电脑上敲了什么。别人的
assistant_message 只留 content,别人的 turn 期事件整条不进。

这是变换不是过滤,区别是要命的:只按 agentId 丢事件的话,别人的
assistant_message.toolCalls 会留下而配对的 tool_result 被丢掉,于是
deriveMessages 的悬空工具调用自愈(ADR-0005 保命层)替它造一条「没执行」
的 tool 消息 —— 别人明明跑成功了,我的模型读到的是它没执行。安静地捏造
事实,比 400 难查。测试第一条钉的就是这个。

forkOrigin/lastOfType 原样转发:它们回的是定位用的 seq,过滤会让后续按
seq 取的范围错位。"
```

---

### Task 4: engine 落 `agentId`

engine 自己 append 的事件要带上「这是哪只干的」。落料点只有一个：`env()`。

**Files:**
- Modify: `src/loop/engine.ts`（`LoopEngineOptions` 加 `agentId?`；`env()` 带上它）
- Test: `tests/loop/engineAgentId.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `agentId?`
- Produces: `LoopEngineOptions.agentId?: string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/loop/engineAgentId.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { tempDir } from "../helpers/tempDir.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };

describe("LoopEngine 的 agentId（#928 切片 1a）", () => {
  it("配了 agentId,engine 落的事件都带上它", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("在吗");
    const kinds = store.load("s1").filter((e) => e.type === "assistant_message" || e.type === "turn_ended");
    expect(kinds.length).toBeGreaterThan(0);
    for (const e of kinds) expect(e).toMatchObject({ agentId: "ops" });
  });

  it("没配就一个字段都不加 —— 单 agent 会话的日志与今天逐字节相同", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("在吗");
    for (const e of store.load("s1")) expect("agentId" in e).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/loop/engineAgentId.test.ts
```

预期：第一条红在 `'agentId' does not exist in type 'LoopEngineOptions'`

- [ ] **Step 3: 实现**

`LoopEngineOptions` 里加：

```ts
  /** 这台 engine 代表哪只工作区 agent(#928)。给了就随 env() 缝进每条落盘事件。
      不给 = 单 agent 会话,一个字段都不加 —— 本机会话的日志与改动前逐字节相同 */
  agentId?: string;
```

**九个类型带 agentId，`user_message` 不带。** `env()` 实测喂 9 种事件，其中
`user_message` 是**人说的话**（还有后台任务回注、循环护栏注话），标成「某只 agent
干的」是假的——它要一个不含 `agentId` 的信封。

`env()` 改成：

```ts
  private env() {
    const base = { sessionId: this.opts.sessionId, ts: Date.now() };
    // 展开而不是恒定写 agentId: undefined —— 后者过不了 exactOptionalPropertyTypes
    //(tsconfig.json:26):把 undefined 塞进 agentId?: string 的值域是 TS2379,直接编译不过。
    //(JSON.stringify 那边其实无所谓:对象属性值为 undefined 时整个 key 会被丢掉,
    // 不会写成 null —— 实测 {"sessionId":"s1","ts":1}。挡住这种写法的是类型不是序列化)
    return this.opts.agentId ? { ...base, agentId: this.opts.agentId } : base;
  }
```

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npx vitest run tests/loop/engineAgentId.test.ts && npm test
```

- [ ] **Step 5: 提交**

```bash
git add src/loop/engine.ts tests/loop/engineAgentId.test.ts
git commit -m "feat(engine): 可选 agentId,随 env() 缝进每条落盘事件（#928）

落料点只有一个(env),不是每个 append 点各写一遍 —— 后者迟早漏一处,
而漏掉的那条事件会被 agentView 当成「全场共有」放行给所有 agent。

不给 agentId 时一个字段都不加(展开而不是恒定写 undefined):
单 agent 会话的日志与改动前逐字节相同。"
```

---

### Task 5: `agent_briefed` —— 这只 agent 是谁，群里还有谁

没有它，一只「agent」就只是换了个型号的默认水獭 —— 它不知道自己管哪块业务，
也不知道群里还有谁可以 @。

**为什么是新事件而不是复用 `subagent_briefed`**：那条的投影文案写着「你是 subagent
「X」，以下是你的指令，请在完成任务时遵循」——它把模型的最终一段文本定义成**返回值**
（ADR-0047 的 `DEFAULT_PREAMBLE`）。群聊里这是错的：agent 说的话是说给群里的人听的，
不是交回给谁的返回值。复用它等于给模型灌一句关于自己身份的假话。

**为什么是 user 消息不是 system**：手法同 `subagent_briefed` / `skill_invoked` ——
中途插 system 消息各家方言兼容性参差（ADR-0047 决定 1 的原话）。

**Files:**
- Modify: `src/session/events.ts`（新 `AgentBriefedEvent` + 进 union）
- Modify: `src/session/deriveMessages.ts`（`case "agent_briefed"`）
- Modify: `src/session/agentView.ts`（别人的 briefing 不进我的上下文）
- Test: `tests/session/agentBriefed.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `agentId?`、Task 3 的 `projectForAgent`
- Produces:

```ts
export interface AgentBriefedEvent extends SessionEventBase {
  type: "agent_briefed";
  agentId: string;
  name: string;
  /** 派活时刻的全文快照。同 subagent_briefed：定义在库里、随时会改，
      快照记的是"当时给的是这句"，不是"现在库里写着什么" */
  instructions: string;
  /** 群里此刻还有谁（名字 + 一句话职责）。@ 得着谁,这份名单说了算 */
  roster: { name: string; description: string }[];
}
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/agentBriefed.test.ts
import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { projectForAgent } from "../../src/session/agentView.js";
import type { SessionEvent } from "../../src/session/events.js";

const brief = (agentId: string, name: string): SessionEvent => ({
  sessionId: "s1", seq: 0, ts: 0, type: "agent_briefed", agentId, name,
  instructions: "你管店铺运营",
  roster: [{ name: "广告", description: "管投放" }],
} as never);

describe("agent_briefed（#928 切片 1a）", () => {
  it("投影成一条 user 消息，带上自己的职责和群里还有谁", () => {
    const msgs = deriveMessages([brief("ops", "运营")]);
    const mine = msgs.find((m) => m.role === "user");
    expect(mine?.content).toContain("运营");
    expect(mine?.content).toContain("你管店铺运营");
    expect(mine?.content).toContain("广告");
    expect(mine?.content).toContain("管投放");
  });

  it("**不说自己是 subagent，也不说最终文本是返回值** —— 那是另一种 agent", () => {
    const mine = deriveMessages([brief("ops", "运营")]).find((m) => m.role === "user");
    expect(mine?.content).not.toContain("subagent");
    expect(mine?.content).not.toContain("返回值");
  });

  it("别人的 briefing 不进我的上下文 —— 我要知道群里有广告这个人，不要读它的提示词", () => {
    const out = projectForAgent([brief("ops", "运营")], "ads");
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/session/agentBriefed.test.ts
```

- [ ] **Step 3: 实现**

`src/session/events.ts`：加上面那个接口，并把 `AgentBriefedEvent` 加进 `SessionEvent` union。

`src/session/deriveMessages.ts`，紧挨着 `case "subagent_briefed"`：

```ts
      case "agent_briefed": {
        // 注入为 user 消息，手法同 subagent_briefed / skill_invoked
        //（中途插 system 各家方言兼容性参差，ADR-0047 决定 1）。
        // **措辞刻意与 subagent 那条不同**：群聊里这只 agent 说的话是说给群里的
        // 人听的，不是交回给谁的返回值。照抄那条会给模型灌一句关于自己身份的假话
        const others = event.roster.length
          ? `群里还有：${event.roster.map((r) => `${r.name}（${r.description}）`).join("、")}。` +
            `要谁搭手就在你的回复里 @ 他的名字。`
          : "";
        messages.push({
          role: "user",
          content: `[你是这个工作区里的「${event.name}」。${others}]\n${event.instructions}`,
        });
        break;
      }
```

`src/session/agentView.ts` 的 `OTHER_AGENT_VERDICTS` 加一笔：

```ts
  // 别人的 briefing 不进我的上下文：我需要知道群里有「广告」这个人
  // （那来自我自己 briefing 里的 roster），不需要读它的提示词
  agent_briefed: "drop",
```

> **注意**：那张表是 `Record<SessionEvent["type"], OtherAgentVerdict>`（穷举，Task 3
> 的修复轮换掉了原来的 `Set`）。所以给 union 加了 `agent_briefed` 之后**不写这一笔就编译不过**
> —— 这正是它被设计成 Record 的原因，你不用记得来改，tsc 会拦住你。

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npx vitest run tests/session/agentBriefed.test.ts && npm test
```

全量必须跑：`SessionEvent` union 加了成员，**两张**穷举 `Record` 会因为少一笔而
编译不过——`PRIVACY_VERDICTS`（`src/shared/sessionPackage.ts`，分享会话的隐私闸）补
`agent_briefed: "keep"`（它说的是「这段对话」，不是发送方的私事）；`OTHER_AGENT_VERDICTS`
（`src/session/agentView.ts`）补 `agent_briefed: "drop"`（理由见上）。
新事件类型的检查清单还有另外六处（`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、
`persistencePolicy`、`deriveMessages`、`deriveSections`、`threadGroups.isInvisible`、
`deriveUsage`），`tsc` 会挨个把它们打红，跟着报错走。

- [ ] **Step 5: 提交**

```bash
git add src/session/events.ts src/session/deriveMessages.ts src/session/agentView.ts src/shared/sessionPackage.ts tests/session/agentBriefed.test.ts
git commit -m "feat(session): agent_briefed —— 这只 agent 是谁,群里还有谁（#928）

没有它,一只 agent 就只是换了个型号的默认水獭:不知道自己管哪块业务,
也不知道群里还有谁可以 @。

新事件而不是复用 subagent_briefed:那条的投影文案把模型的最终一段文本
定义成**返回值**(ADR-0047 的 DEFAULT_PREAMBLE)。群聊里这是错的 ——
agent 说的话是说给群里的人听的,不是交回给谁的返回值。复用它等于给模型
灌一句关于自己身份的假话,而且这句假话会稳定地改变它怎么说话。

user 消息不是 system:手法同 subagent_briefed / skill_invoked,
中途插 system 各家方言兼容性参差。

别人的 briefing 不进我的上下文 —— 我需要知道群里有「广告」这个人
(那来自我自己 briefing 里的 roster),不需要读它的提示词。"
```

---

### Task 6: `agentMention` —— @ 解析纯逻辑，两端共用

客户端要它（打字时出 chip），服务端也要它（agent 输出的是文本，只能服务端认）。**一份，不是两份**：两处各写一条正则迟早分家（`SUBAGENT_NAME_RE` 那次就是，见 `src/shared/subagent.ts` 的注释）。

**Files:**
- Create: `src/shared/remote/agentMention.ts`
- Test: `tests/shared/agentMention.test.ts`

**Interfaces:**
- Produces: `parseMentions(text: string, names: readonly {agentId: string; name: string}[]): string[]`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/agentMention.test.ts
import { describe, it, expect } from "vitest";
import { parseMentions } from "../../src/shared/remote/agentMention.js";

const roster = [
  { agentId: "admin", name: "管理员" },
  { agentId: "ops", name: "运营" },
  { agentId: "ads", name: "广告" },
  { agentId: "ops2", name: "运营助理" },
];

describe("parseMentions（#928 切片 1a）", () => {
  it("认中文名", () => {
    expect(parseMentions("@运营 看下这周销量", roster)).toEqual(["ops"]);
  });

  it("同一句里多个 @,按出现顺序,去重", () => {
    expect(parseMentions("@运营 和 @广告 一起看，@运营 你先", roster)).toEqual(["ops", "ads"]);
  });

  it("最长匹配优先 —— 「运营助理」不该被切成「运营」加两个字", () => {
    expect(parseMentions("@运营助理 帮个忙", roster)).toEqual(["ops2"]);
  });

  it("名单里没有的名字不认,也不报错", () => {
    expect(parseMentions("@张三 在吗", roster)).toEqual([]);
  });

  it("邮箱地址里的 @ 不算 —— @ 前面得是行首或空白", () => {
    expect(parseMentions("发到 rick@运营 那个邮箱", roster)).toEqual([]);
  });

  it("没有 @ 就是空数组 —— 调用方据此走「谁都没点名」那条路", () => {
    expect(parseMentions("大家好", roster)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/shared/agentMention.test.ts
```

- [ ] **Step 3: 实现**

```ts
// src/shared/remote/agentMention.ts
// 「这句话点了谁的名」——@ 解析的唯一正文(#928)。
//
// 两端共用一份,纪律同 wire.ts:客户端要它(用户打字时出 chip,看得见自己
// @ 到了谁),服务端也要它(agent 输出的是**文本**,只能服务端按名单匹配)。
// 两处各写一条正则迟早分家 —— SUBAGENT_NAME_RE 那次就是(渲染层挡住了中文,
// 主进程那侧把中文 replace 成 "-",「搜索员」塌成 "---" 照样建出来)。
//
// 不用正则切词:agent 名字允许中文,而中文没有词边界,\b 在这儿是假的。
// 改成「按名单逐个试最长匹配」——名单是现成的,一个工作区几只到几十只,
// O(文本长度 × 名单) 完全够用,且行为可解释。

export interface MentionCandidate {
  agentId: string;
  name: string;
}

/** @ 前面必须是行首、或一个**非构词字符** —— 否则 "rick@运营" 这种邮箱地址会被当成点名。
    判据不是「是空白」而是「不是构词字符」:中文标点后不加空格是中文里最普通的句子形状
    (「你好，@运营 帮我看下」),按空白判会让整句静默变成「没人被点名」——不是少匹配一个
    候选,是整句失效。邮箱那条不受影响:rick@ 的 'k' 属于 \p{L},仍然不算边界 */
function isBoundary(text: string, at: number, lastMatchEnd: number): boolean {
  if (at === 0) return true;
  // 刚匹配完的位置也算边界:"@运营@广告" 里第二个 @ 前面是「营」,按字符判会被拒,
  // 于是静默少派一个人(与上面同一类失败)
  if (at === lastMatchEnd) return true;
  return !/[\p{L}\p{N}_]/u.test(text[at - 1]!);
}

/**
 * 按出现顺序返回被点名的 agentId,去重。
 * 名字长的先试(最长匹配):名单里同时有「运营」和「运营助理」时,
 * "@运营助理" 该认成后者,而不是前者加两个多余的字。
 */
export function parseMentions(text: string, names: readonly MentionCandidate[]): string[] {
  const byLength = [...names].sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isBoundary(text, i)) continue;
    for (const c of byLength) {
      if (!text.startsWith(c.name, i + 1)) continue;
      if (!seen.has(c.agentId)) {
        seen.add(c.agentId);
        out.push(c.agentId);
      }
      i += c.name.length; // 跳过已匹配的部分,别在名字内部再找 @
      break;
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试，确认绿**

```
npx vitest run tests/shared/agentMention.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/shared/remote/agentMention.ts tests/shared/agentMention.test.ts
git commit -m "feat(remote): @ 解析纯逻辑,桌面与 runtime 共用一份（#928）

客户端要它(打字时出 chip,用户看得见自己 @ 到了谁),服务端也要它
(agent 输出的是文本,只能服务端按名单匹配)。两处各写一条规则迟早分家 ——
SUBAGENT_NAME_RE 那次就是:渲染层挡住了中文,主进程把中文 replace 成 '-',
「搜索员」塌成 '---' 照样建出来。

不用正则切词:agent 名字允许中文,中文没有词边界,\\b 在这儿是假的。
改成按名单逐个试最长匹配 —— 名单是现成的,行为可解释,且「运营助理」
不会被切成「运营」加两个字。"
```

---

### Task 7: `cs_say` 加 `mentions`

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`（`CsUp` 的 `say` 变体 + 它的 parser）
- Test: `tests/shared/cloudSessionFrames.test.ts`（若已存在则追加；否则新建）

**Interfaces:**
- Produces: `{ t: "say"; text: string; mention: boolean; mentions?: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
// 追加进 tests/shared/cloudSessionFrames.test.ts（没有就新建）
import { describe, it, expect } from "vitest";
import { encodeCs, decodeCsUp } from "../../src/shared/remote/cloudSession.js";

/** 帧走 base64（encodeCs 的格式），不是裸 JSON。畸形用例编不出来，手工造一条 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

describe("cs_say 的 mentions（#928 切片 1a）", () => {
  it("带 mentions 解得出来", () => {
    const frame = encodeCs({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
    expect(decodeCsUp(frame)).toEqual({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
  });

  it("不带 mentions 照常解 —— 手机端和旧桌面还在发布尔那一版", () => {
    expect(decodeCsUp(encodeCs({ t: "say", text: "在吗", mention: true })))
      .toEqual({ t: "say", text: "在吗", mention: true });
  });

  it("mentions 不是字符串数组就整帧拒掉,不是悄悄丢字段", () => {
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: [1, 2] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: "ops" }))).toBeNull();
  });
});
```


- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/shared/cloudSessionFrames.test.ts
```

- [ ] **Step 3: 实现**

类型：

```ts
  /** mentions = 这句话点了哪几只 agent(#928,agentMention.parseMentions 的产物)。
      **布尔那个 mention 留着**:线协议三端共用一份,手机端和旧桌面还在发它。
      mentions 缺席时按老语义(true = 唤醒这条会话的默认那只) */
  | { t: "say"; text: string; mention: boolean; mentions?: string[] }
```

parser 那段：

```ts
    if (t === "say") {
      if (typeof obj.text === "string" && typeof obj.mention === "boolean") {
        if (obj.mentions === undefined) return { t: "say", text: obj.text, mention: obj.mention };
        // 形状不对就整帧拒掉,不是悄悄把字段丢了当没带 —— 后者会让一句
        // "@运营" 静默变成"谁都没点名",而那两件事该做的动作不一样
        if (!Array.isArray(obj.mentions) || obj.mentions.some((m) => typeof m !== "string")) return null;
        return { t: "say", text: obj.text, mention: obj.mention, mentions: obj.mentions as string[] };
      }
      return null;
    }
```

- [ ] **Step 4: 跑测试，确认绿**

```
npx vitest run tests/shared/cloudSessionFrames.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/shared/remote/cloudSession.ts tests/shared/cloudSessionFrames.test.ts
git commit -m "feat(cloudSession): cs_say 加可选 mentions（#928）

布尔那个 mention 留着不动:线协议三端共用一份,手机端和旧桌面还在发它,
mentions 缺席时按老语义。

形状不对整帧拒掉而不是悄悄丢字段:后者会让一句 @运营 静默变成
「谁都没点名」,而那两件事该做的动作不一样。"
```

---

### Task 8: `turnCoordinator` 从互斥锁换成串行队列

今天 `onChat(mention)` 在 turn 跑着时一律回 `logged_only`（无隐形队列，ADR-0199）。多智能体之后要能排队：@ 了运营，运营跑着时 @ 广告，广告得排上而不是被丢。

**这是换掉那台状态机，不是在旁边加一台。** `onChat` / `turnStarted` / `turnEnded` 的生产调用方只有 `sessionService.say()` 一处（实测），而 Task 9 正好把它整段重写。留着它就是在一个对象里养两台状态机共用同一个 `state`，互相踩。`isRunning()` 留着——`daemon.ts:634` 经 `session.isRunning()` 在用。

**Files:**
- Modify: `services/runtime/src/turnCoordinator.ts`（整体重写）
- Test: `tests/runtime/turnCoordinator.test.ts`（整体重写，现有 5 条 `onChat` 测试跟着换）

**Interfaces:**
- Produces:

```ts
export interface TurnJob {
  agentId: string;
  fromUid: string;
  label: string;
  text: string;
}
export type EnqueueDecision = "start_turn" | "queued" | "logged_only";
export interface TurnCoordinator {
  /** 一条已落盘的发言进来:点火 / 排队 / 只落盘。**回 start_turn 时任务也已经在队里**——
      调用方不是拿着手上这个 job 去跑,而是开始 while (nextJob()) 排空队列 */
  enqueue(job: TurnJob): EnqueueDecision;
  /** 取下一个要跑的。队空 = 归 idle,回 null */
  nextJob(): TurnJob | null;
  isRunning(): boolean;
}
```

- [ ] **Step 1: 重写测试**

```ts
// tests/runtime/turnCoordinator.test.ts（整份替换）
import { describe, it, expect } from "vitest";
import { createTurnCoordinator, type TurnJob } from "../../services/runtime/src/turnCoordinator.js";

const job = (agentId: string): TurnJob => ({ agentId, fromUid: "u1", label: "alice", text: "干活" });

/** 调用方的标准消费形状 —— 测试里复用它,免得每条各写一遍 */
function drain(c: ReturnType<typeof createTurnCoordinator>): string[] {
  const ran: string[] = [];
  let j: TurnJob | null;
  while ((j = c.nextJob()) !== null) ran.push(j.agentId);
  return ran;
}

describe("turnCoordinator 串行队列（#928 切片 1a）", () => {
  it("空闲时第一条回 start_turn,且它本身也在队里", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(drain(c)).toEqual(["ops"]);
  });

  it("排空之前进来的排队,按先来后到跑", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(c.enqueue(job("ads"))).toBe("queued");
    expect(drain(c)).toEqual(["ops", "ads"]);
  });

  it("没点名的发言不进队 —— 它只落 chat_message,靠投影天然生效", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue({ ...job("ops"), agentId: "" })).toBe("logged_only");
    expect(drain(c)).toEqual([]);
  });

  it("同一只已经在队里就不重复排 —— 连点三下 @运营 不该跑三遍", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(c.enqueue(job("ops"))).toBe("logged_only");
    expect(drain(c)).toEqual(["ops"]);
  });

  it("排空之后再来一条,又是 start_turn —— 一轮结束协调器归 idle", () => {
    const c = createTurnCoordinator();
    c.enqueue(job("ops"));
    drain(c);
    expect(c.isRunning()).toBe(false);
    expect(c.enqueue(job("ads"))).toBe("start_turn");
  });

  it("isRunning 在排空期间为真 —— daemon 用它判「这个工作区此刻在跑吗」", () => {
    const c = createTurnCoordinator();
    c.enqueue(job("ops"));
    expect(c.isRunning()).toBe(true);
    expect(c.nextJob()).toMatchObject({ agentId: "ops" });
    expect(c.isRunning()).toBe(true); // 还没排空,这一轮还在跑
    expect(c.nextJob()).toBeNull();
    expect(c.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/runtime/turnCoordinator.test.ts
```

- [ ] **Step 3: 重写实现**

```ts
// 云 runtime 的 turn 协调器:@ 点名、串行队列(#928,原为 ADR-0199 的单 turn 互斥)
//
// 换掉而不是并列:onChat 那台状态机的生产调用方只有 sessionService.say() 一处,
// 而多智能体版把它整段重写了。两台状态机共用同一个 state 会互相踩。

export interface TurnJob {
  agentId: string;
  fromUid: string;
  label: string;
  text: string;
}

export type EnqueueDecision = "start_turn" | "queued" | "logged_only";

export interface TurnCoordinator {
  enqueue(job: TurnJob): EnqueueDecision;
  nextJob(): TurnJob | null;
  isRunning(): boolean;
}

export function createTurnCoordinator(): TurnCoordinator {
  const queue: TurnJob[] = [];
  let running = false;

  return {
    enqueue(job: TurnJob): EnqueueDecision {
      // 没点名任何人:只落 chat_message,靠 engine 每轮从日志重新投影天然生效
      //(ADR-0199 的既有语义,不变)
      if (!job.agentId) return "logged_only";
      // 同一只已经在队里就不重复排。连点三下 @运营 不该跑三遍 —— 它这一轮
      // 开跑时读的是整份日志,三句话都在里面
      if (queue.some((q) => q.agentId === job.agentId)) return "logged_only";
      queue.push(job);
      // **回 start_turn 时任务也已经在队里**:调用方开始 while (nextJob()) 排空,
      // 不是拿着手上这个 job 去跑。两种写法差一个 job,而那正是最容易错的地方
      if (running) return "queued";
      running = true;
      return "start_turn";
    },

    nextJob(): TurnJob | null {
      const next = queue.shift() ?? null;
      if (!next) running = false;
      return next;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
```

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npx vitest run tests/runtime/turnCoordinator.test.ts && npm test
```

`npm test` 这一步预期会红在 `services/runtime/src/sessionService.ts`——它还在调已经删掉的 `onChat` / `turnStarted` / `turnEnded`。**这是预期的**：Task 9 修它。为了让本 Task 自己能收在绿上，在 `sessionService.ts` 里做最小适配（`coordinator.onChat(mention)` 换成 `coordinator.enqueue({ agentId: mention ? "default" : "", fromUid, label, text })`，`turnStarted()` / `turnEnded()` 两行删掉，起跑后补一句 `coordinator.nextJob()` 取出它自己排的那个 job），**行为与改动前等价**（单 agent、一次一个）。Task 9 再把这段整体换掉。

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/turnCoordinator.ts services/runtime/src/sessionService.ts tests/runtime/turnCoordinator.test.ts
git commit -m "refactor(runtime): turnCoordinator 从互斥锁换成串行队列（#928）

多智能体之后 @ 了运营、运营跑着时又 @ 广告,广告得排上而不是被丢掉。

换掉而不是并列:onChat 那台状态机的生产调用方只有 sessionService.say()
一处,而多智能体版会把它整段重写。留着它就是在一个对象里养两台状态机
共用同一个 state,互相踩。isRunning 留着 —— daemon 经 session.isRunning()
在用它判「这个工作区此刻在跑吗」。

一处刻意的语义:enqueue 回 start_turn 时,那个 job **也已经在队里**。
调用方开始 while (nextJob()) 排空,不是拿着手上这个 job 去跑。两种写法
差一个 job,而那正是最容易错的地方。

同一只已经在队里就不重复排:连点三下 @运营 不该跑三遍 —— 它这一轮开跑时
读的是整份日志,三句话都在里面。

sessionService 这次只做等价适配(单 agent、一次一个),多智能体装配在下一步。"
```

---

### Task 9: `CloudSession` 一台 engine → N 台

**Files:**
- Modify: `services/runtime/src/sessionService.ts`
- Test: `tests/runtime/sessionService.test.ts`（追加）

**Interfaces:**
- Consumes: `agentView`（T3）、`LoopEngineOptions.agentId`（T4）、`agent_briefed`（T5）、`parseMentions`（T6）、队列（T8）
- Produces: `CloudSessionOpts` 加 `agents: () => Promise<AgentSpec[]>` 与 `adapterFor: (a: AgentSpec) => ModelAdapter`；`say()` 签名加 `mentions?: string[]`

```ts
export interface AgentSpec {
  agentId: string;
  name: string;
  /** 一句话职责。进别人 briefing 的 roster —— 「@ 得着谁、他管什么」 */
  description: string;
  instructions: string;
  /** 允许的逻辑型号；[0] 是默认。空 = 用工作区那份（ADR-0202） */
  models: string[];
}
```

- [ ] **Step 1: 写失败测试**

```ts
// 追加进 tests/runtime/sessionService.test.ts（沿用文件顶部已有的 fakeWorld / px / newStore）
import { describe, it, expect } from "vitest";

const AGENTS = [
  { agentId: "ops", name: "运营", description: "管店铺运营", instructions: "你管店铺运营", models: ["m-ops"] },
  { agentId: "ads", name: "广告", description: "管投放", instructions: "你管投放", models: ["m-ads"] },
];

describe("多智能体云会话（#928 切片 1a）", () => {
  it("@运营 只让运营那只跑,落盘事件带 agentId=ops", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: `${a.name}答` }; } }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    await session.say("u1", "alice", "@运营 看下销量", true, ["ops"]);

    expect(seen).toEqual(["ops"]);
    const am = events.filter((e) => e.type === "assistant_message");
    expect(am).toHaveLength(1);
    expect(am[0]).toMatchObject({ agentId: "ops", content: "运营答" });
  });

  it("@ 两只 —— 串行跑完,顺序按 mentions 给的顺序", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: `${a.name}答` }; } }),
      onEvent: () => {}, onUsage: () => {},
    });

    await session.say("u1", "alice", "@运营 @广告 一起看", true, ["ops", "ads"]);

    expect(seen).toEqual(["ops", "ads"]);
  });

  it("广告那只看不见运营的工具痕迹,只看得见它说的话", async () => {
    const store = newStore();
    const prompts: Record<string, string> = {};
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat(messages) {
          prompts[a.agentId] = JSON.stringify(messages);
          return { content: `${a.name}答` };
        },
      }),
      onEvent: () => {}, onUsage: () => {},
    });

    // 先手工塞一条运营的工具痕迹,再让广告跑
    store.append({ sessionId: "s1", ts: 1, type: "assistant_message", content: "查了",
                   model: "m-ops", agentId: "ops",
                   toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] });
    store.append({ sessionId: "s1", ts: 2, type: "tool_result", toolCallId: "c1",
                   status: "ok", output: "机密的 12 行查询结果", agentId: "ops" });

    await session.say("u1", "alice", "@广告 看投放", true, ["ads"]);

    expect(prompts.ads).toContain("查了");                    // 说的话进来了
    expect(prompts.ads).not.toContain("机密的 12 行查询结果");  // 工具输出没进来
  });

  it("mentions 缺席但正文里有 @ —— 服务端用同一份纯逻辑自己认出来", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
      onEvent: () => {}, onUsage: () => {},
    });
    // 手机端只发得出布尔那一版
    await session.say("u1", "alice", "@广告 看投放", true);
    expect(seen).toEqual(["ads"]); // 不是名单第一只的 ops
  });

  it("mentions 缺席、正文也没 @ —— 老语义:唤醒名单第一只", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
      onEvent: () => {}, onUsage: () => {},
    });
    await session.say("u1", "alice", "在吗", true);
    expect(seen).toEqual(["ops"]); // 名单第一只 = 默认那只
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/runtime/sessionService.test.ts
```

- [ ] **Step 3: 实现**

改 `CloudSessionOpts`：删掉 `adapter: ModelAdapter`，加

```ts
  /** 这个工作区此刻有哪几只 agent。**每 turn 现取一次**,同 hostUids ——
      建/改 agent 下一 turn 生效,不用重开会话 */
  agents: () => Promise<AgentSpec[]>;
  /** 按 agent 造 adapter(型号来自它的白名单)。daemon 给 */
  adapterFor: (agent: AgentSpec) => ModelAdapter;
```

`say` 签名加 `mentions?: string[]`。内部：

1. 先把「这句话点了谁」解出来。**三级**，缺一不可：

```ts
  /** 这句话点了哪几只。三级:
      ① 客户端算好的 mentions —— 新版桌面走这条,用户看得见自己 @ 到了谁;
      ② 客户端没算但正文里有 @ —— 手机端和旧桌面只发布尔那一版,
         服务端用同一份纯逻辑自己认(Task 6 的 parseMentions);
      ③ 都没有但 mention=true —— 老语义:唤醒默认那只(名单第一只)。
      少了②那一级,一台没更新的手机发 "@运营 看下销量" 会被派给管理员,
      而用户看见的回复署着别人的名字 —— 比不回还糟 */
  function resolveTargets(text: string, mention: boolean, mentions: string[] | undefined, roster: AgentSpec[]): string[] {
    const known = new Set(roster.map((a) => a.agentId));
    if (mentions?.length) return mentions.filter((id) => known.has(id));
    const parsed = parseMentions(text, roster.map((a) => ({ agentId: a.agentId, name: a.name })));
    if (parsed.length) return parsed;
    return mention && roster[0] ? [roster[0].agentId] : [];
  }
```

2. 解出来的每一只按顺序 `coordinator.enqueue({ agentId, fromUid, label, text })`；空数组 = 只落 `chat_message`，不起 turn（`enqueue` 的 `agentId: ""` 那条路，或者干脆不调它）。
3. engine 改成按需建、按 agentId 缓存：

```ts
  const engines = new Map<string, LoopEngine>();

  function engineFor(spec: AgentSpec): LoopEngine {
    const hit = engines.get(spec.agentId);
    if (hit) return hit;
    const engine = new LoopEngine({
      // 隔离靠构造:这台 engine 从头到尾只看得见它自己的痕迹 + 全场的发言。
      // engine 内部三处 model-facing 的读一个都不用改(ADR-0047 的教训:
      // 挨个补过滤漏一处就安静地灌错上下文)
      store: agentView(store, spec.agentId),
      adapter: opts.adapterFor(spec),
      agentId: spec.agentId,
      tools: () => [readFileTool, writeFileTool, bashTool, ...cachedPxTools],
      world: opts.world,
      sessionId,
      approver: router,
      onEvent: notify,
      middlewares: [],
    });
    engines.set(spec.agentId, engine);
    return engine;
  }
```

4. 跑完一个 job 后取 `coordinator.nextJob()`，非 null 就接着跑（`while` 循环，串行）。
   **这个循环必须跑到 null，且必须在 `finally` 里**——不变量是「拿到 `start_turn` 的那一方
   负责把队列排空到 null」。`nextJob()` 是唯一能让协调器归 idle 的入口（队列空了才归），
   少排一次就把 `running` 永久钉在 true：此后每一条 `enqueue` 都回 `queued`，这条会话
   再也起不了 turn。Task 8 的适配就在这儿栽过一次（只调了一次，两个成员并发 @ 即复现）。
5. **那只 agent 的 `instructions` 靠 Task 5 的 `agent_briefed` 进上下文**，不碰 system 消息（云会话的 system 只从 `session_created.workspace` 产出，那是会话级围栏，不是 agent 级身份）。落盘时机：

```ts
  /** 这只 agent 在这条会话里有没有被介绍过、介绍的还是不是现在这份指令。
      两个判据缺一不可:只判"有没有"的话,用户改完提示词要重开会话才生效;
      每 turn 都落一条的话,日志里堆满同一段文字,而且模型每轮都被重新
      自我介绍一遍 */
  function briefIfNeeded(spec: AgentSpec, roster: AgentSpec[]): void {
    // **裸 store,不是 agentView 包过的那份**。理由不是"包过的会回空"——那句话
    // 不准确:projectForAgent 对 owner === agentId 的事件有提前放行分支,
    // 拿自己的 view 查自己的 brief 其实查得到。真正的理由是**这是记账判断,
    // 该读事实的原始来源**:agentView 的裁决表是为"模型看得见什么"设计的,
    // 不是为这里的判断设计的。哪天那张表为了模型可见性调整一下(比如把
    // agent_briefed 改成对自己也 drop),这里就会安静地每 turn 重新 brief 一遍
    const already = store
      .ofType(sessionId, "agent_briefed")
      .filter((e) => e.type === "agent_briefed" && e.agentId === spec.agentId)
      .at(-1);
    if (already && already.type === "agent_briefed" && already.instructions === spec.instructions) return;
    notify(
      store.append({
        sessionId,
        ts: Date.now(),
        type: "agent_briefed",
        agentId: spec.agentId,
        name: spec.name,
        instructions: spec.instructions,
        roster: roster
          .filter((r) => r.agentId !== spec.agentId)
          .map((r) => ({ name: r.name, description: r.description })),
      })
    );
  }
```

在 `engineFor(spec)` 拿到 engine、跑 `runTurn` **之前**调它——事件必须先落盘，engine 这一轮的 `snapshot()` 才读得到它。

> `AgentSpec` 因此要带 `description`（roster 那一行用它）。上面 Interfaces 里的定义补一个 `description: string`。

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npx vitest run tests/runtime/sessionService.test.ts && npm test
```

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/sessionService.ts tests/runtime/sessionService.test.ts
git commit -m "feat(runtime): 一条云会话 N 台 engine,@ 谁谁答（#928）

每只 agent 一台 LoopEngine:自己的 instructions、自己的 adapter(型号来自
它的白名单)、自己的 agentId。复用整台 engine 而不是换人格 —— engine 持有
每会话状态(loopFingerprints 退化循环护栏、todo、压缩标记),换人格不换这些
就串味,运营那只的护栏指纹会算进广告那只。

上下文隔离靠构造:装配那一刻递 agentView(store, agentId),engine 内部三处
model-facing 的读一个都不改。挨个补过滤漏一处就安静地灌错上下文,
ADR-0047 否掉「子 agent 事件写进父日志」时给过同一条理由。

agents() 每 turn 现取一次(同 hostUids):建/改 agent 下一 turn 生效,
不用重开会话。mentions 缺席时走名单第一只 —— 与改动前行为相同。"
```

---

### Task 10: migration `0021_workspace_agents.sql`

**Files:**
- Create: `supabase/migrations/0021_workspace_agents.sql`

**Interfaces:**
- Produces: `public.workspace_agents` 表 + RLS + `seed_workspace_admin_agent` 触发器

- [ ] **Step 1: 写 migration**

照 `0015_workspaces.sql` 的形状（幂等、`drop policy if exists` 后重建）：

```sql
-- 0021_workspace_agents.sql —— 工作区里的智能体名单（#928）。幂等，重跑不炸。
--
-- 与 0015 同一约定：在 Supabase SQL editor 手动执行一次。
--
-- agent_id 与 name 拆开：name 是 @ 打的那个词、随时会改；agent_id 是记忆和
-- 用量归因的键。合成一个的话，改个名字等于换了一只 agent——记忆和账一起断，
-- 而且是安静地断。

create table if not exists public.workspace_agents (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     text not null,
  name         text not null check (char_length(name) between 1 and 32),
  description  text not null default '',
  instructions text not null default '',
  models       text[] not null default '{}',
  tools        jsonb not null default '[]',   -- [] = 整池放行（workspace_connectors 同口径）
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
-- name 是 @ 的寻址依据，一个工作区里不许重名
create unique index if not exists workspace_agents_name
  on public.workspace_agents (workspace_id, name);

alter table public.workspace_agents enable row level security;

-- 成员可读
drop policy if exists wsa_select_member on public.workspace_agents;
create policy wsa_select_member on public.workspace_agents for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));

-- 任何成员可建（对称于 workspace_connectors 的「贡献不是 owner 的特权」）
drop policy if exists wsa_insert_member on public.workspace_agents;
create policy wsa_insert_member on public.workspace_agents for insert to authenticated
  with check (created_by = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));

-- 建的人或 owner 可改（对称于 workspace_sessions 的发布者可改）
-- with check 补在籍：不许把自己的行改挂到别人的工作区（0015 审查发现过的同型越权路）
drop policy if exists wsa_update_owner_or_creator on public.workspace_agents;
create policy wsa_update_owner_or_creator on public.workspace_agents for update to authenticated
  using (created_by = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()))
  with check (public.is_ws_member(workspace_id, auth.uid()));

-- 建的人或 owner 可删，但**管理员那只谁都删不掉**——一个 agent 都没有的
-- 工作区 @ 不到任何人，是死局
drop policy if exists wsa_delete_owner_or_creator on public.workspace_agents;
create policy wsa_delete_owner_or_creator on public.workspace_agents for delete to authenticated
  using (agent_id <> 'admin'
     and (created_by = auth.uid()
       or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid())));

-- 建工作区时种一只「管理员」。用触发器而不是让客户端插第二条：
-- 客户端插会有一段「群建好了但一只 agent 都没有」的窗口，而那个状态
-- 界面上和「建失败了」长得一样（#843 症状 1 的同一种病）
create or replace function public.seed_workspace_admin_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by)
  values (new.id, 'admin', '管理员', '这个工作区的默认智能体', '', new.owner_uid)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists workspaces_seed_admin on public.workspaces;
create trigger workspaces_seed_admin after insert on public.workspaces
  for each row execute function public.seed_workspace_admin_agent();
```

- [ ] **Step 2: 在真库跑一次**

Supabase SQL editor 贴上去执行（幂等，重跑不炸），或走 Management API：

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
case "$TOKEN" in go-keyring-base64:*) TOKEN=$(printf '%s' "${TOKEN#go-keyring-base64:}" | base64 -d);; esac
curl -sS -X POST "https://api.supabase.com/v1/projects/kpeemypbhkynapkjzewr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "$(python3 -c 'import json,sys;print(json.dumps({"query":open(sys.argv[1]).read()}))' supabase/migrations/0021_workspace_agents.sql)"
```

- [ ] **Step 3: 验一眼种子生效了**

```sql
select workspace_id, agent_id, name from public.workspace_agents where agent_id = 'admin' limit 5;
```

存量工作区没有触发器覆盖到（触发器只管新建的），补一次：

```sql
insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by)
select w.id, 'admin', '管理员', '这个工作区的默认智能体', '', w.owner_uid from public.workspaces w
on conflict do nothing;
```

- [ ] **Step 4: 提交**

```bash
git add supabase/migrations/0021_workspace_agents.sql
git commit -m "feat(db): workspace_agents 表 + RLS + 种管理员（#928）

agent_id 与 name 拆开:name 是 @ 打的那个词、随时会改;agent_id 是记忆和
用量归因的键。合成一个的话改个名字等于换了一只 agent —— 记忆和账一起断,
而且是安静地断。

权限照 workspace_sessions 抄:任何成员可建,建的人或 owner 可改删。
管理员那只谁都删不掉 —— 一个 agent 都没有的工作区 @ 不到任何人,是死局。

种子走触发器而不是让客户端插第二条:客户端插会有一段「群建好了但一只
agent 都没有」的窗口,而那个状态界面上和「建失败了」长得一样(#843 症状 1
的同一种病)。"
```

---

### Task 11: daemon 装配 + frameHandler 透传

**Files:**
- Modify: `services/runtime/src/daemon.ts`（查 `workspace_agents`；`adapterFor` 收 agent；`createCloudSession` 调用点）
- Modify: `services/runtime/src/frameHandler.ts`（`say` 分支把 `msg.mentions` 递下去）
- Test: `tests/runtime/frameHandler.test.ts`（追加）

**Interfaces:**
- Consumes: T9 的 `CloudSessionOpts.agents` / `adapterFor` / `AgentSpec`（从 `./sessionService.js` import）、T7 的 `mentions`

- [ ] **Step 1: 写失败测试（frameHandler 那一半）**

```ts
// 追加进 tests/runtime/frameHandler.test.ts（沿用该文件已有的夹具与建 handler 的写法）
it("say 帧的 mentions 原样递给 session.say（#928）", async () => {
  const said: unknown[] = [];
  // …按文件里现有的方式造 deps，其中 sessions.get 回一个假 session：
  //   say: async (...args) => { said.push(args); }
  await handler.onSessionFrame("w1", "s1", cid,
    JSON.stringify({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] }));
  expect(said[0]).toEqual(["u1", "alice", "@运营 看下销量", true, ["ops"]]);
});
```

- [ ] **Step 2: 跑它，确认红**

```
npx vitest run tests/runtime/frameHandler.test.ts
```

- [ ] **Step 3: 实现**

`frameHandler.ts` 的 `say` 分支最后一行：

```ts
          await session.say(entry.uid, entry.label, msg.text, msg.mention, msg.mentions);
```

`daemon.ts`：

```ts
  /** 这个工作区此刻的 agent 名单。**不缓存** —— 同 queryMemberUids,
      sessionService 的设计就是要「这一刻的名单」,建/改 agent 下一 turn 生效 */
  async function queryAgents(workspaceId: string): Promise<AgentSpec[]> {
    const { data, error } = await supabase
      .from("workspace_agents")
      .select("agent_id,name,description,instructions,models")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(
      (r: { agent_id: string; name: string; description: string; instructions: string; models: string[] }) => ({
        agentId: r.agent_id, name: r.name, description: r.description, instructions: r.instructions,
        models: r.models ?? [],
      })
    );
  }
```

`adapterFor` 加一个 agent 参数，型号取 `agent.models[0]`，为空时回落工作区配置（ADR-0202 的既有那条路）：

```ts
  function adapterFor(workspaceId: string, sessionId: string, ownerUid: string, agent: AgentSpec): ModelAdapter {
    return createHostedRuntimeAdapter({
      edgeBase: config.edgeBase,
      runtimeSecret: config.runtimeSecret,
      probe: hostedProbe,
      // agent 的型号白名单第一个就是它的默认;空白名单 = 用工作区那份(ADR-0202)。
      // **不做 env 兜底**,理由同 ADR-0202:兜底 = 忘了配的工作区默默烧维护者的钱
      cfg: () => {
        const ws = workspaceConfigStore.load(workspaceId)?.model ?? null;
        const pick = agent.models[0];
        return pick && ws ? { ...ws, modelId: pick } : ws;
      },
      ownerUid, workspaceId, sessionId,
    });
  }
```

`createCloudSession` 调用点：删 `adapter: perSessionAdapter`，加

```ts
      agents: () => queryAgents(workspaceId),
      adapterFor: (a) => withUsage(adapterFor(workspaceId, sessionId, ownerUid, a), recordUsage),
```

`perSessionAdapter` 那个 `let` 整个删掉，它的 usage 回调提成一个具名函数（口径一个字不改——`initiatorUid()` 记的还是「谁动的手」，扣的还是 ownerUid）：

```ts
    // 原来是 perSessionAdapter 里那个闭包。现在每只 agent 一个 adapter，
    // 回调得能复用 —— 提成具名函数，记账口径原样不动
    const recordUsage = (usage: TokenUsage, model: string): void => {
      const uid = session.initiatorUid();
      if (!uid) return; // usage 只在 chat() resolve 时产生，chat() 只在 turn 里被调
      store.append({
        sessionId,
        ts: Date.now(),
        type: "model_usage",
        ignorable: true,
        uid,
        workspaceId,
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
    };
```

> `model_usage` 的字段按 `daemon.ts:415-421` 现有那段原样搬，别改它记的东西。

- [ ] **Step 4: 跑测试 + 全量门禁**

```
npm test
```

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/daemon.ts services/runtime/src/frameHandler.ts tests/runtime/frameHandler.test.ts
git commit -m "feat(runtime): daemon 按 agent 装 adapter,frameHandler 透传 mentions（#928）

agent 名单每 turn 现查一次不缓存(同 queryMemberUids):建/改 agent
下一 turn 生效,不用重开会话。

型号取那只 agent 白名单的第一个,白名单为空时回落工作区配置(ADR-0202)。
仍然不做 env 兜底 —— 兜底 = 忘了配的工作区默默烧维护者的钱,而那个失败
模式是静默的,只有账单会说话。"
```

---

### Task 12: 架构断言 —— 云会话的 engine 必须拿变换过的日志

「漏一处」的失败模式是安静的：今天读得对，不保证明天有人加一处读点时还对。

**Files:**
- Modify: `tests/architecture.test.ts`
- Test: 同上（这个 Task 的产出就是测试）

- [ ] **Step 1: 写断言**

```ts
// 追加进 tests/architecture.test.ts
it("云会话给 LoopEngine 的 store 必须是 agentView 的产物（#928）", () => {
  const src = readFileSync("services/runtime/src/sessionService.ts", "utf8");
  // 判据取「new LoopEngine 那一段里 store: 后面跟的是什么」——不是全文搜
  // agentView（那样把它写在注释里也能骗过去）
  const block = src.slice(src.indexOf("new LoopEngine("));
  const storeLine = block.slice(0, block.indexOf("})")).match(/store:\s*([^,\n]+)/)?.[1] ?? "";
  expect(storeLine).toContain("agentView(");
});
```

- [ ] **Step 2: 跑它，确认绿（T8 已经实现了）**

```
npx vitest run tests/architecture.test.ts
```

若红，说明 T9 的接法与断言不符——**改的是 T9 不是断言**。

- [ ] **Step 3: 反向验一次（确认这条断言不是摆设）**

临时把 `sessionService.ts` 里的 `agentView(store, spec.agentId)` 改成 `store`，跑上面那条，确认变红，然后改回来。

- [ ] **Step 4: 提交**

```bash
git add tests/architecture.test.ts
git commit -m "test(arch): 云会话的 engine 必须拿 agentView 的产物（#928）

上下文隔离靠构造,而「构造」这件事没有任何机制保证下一个人还照做。
漏一处的失败模式是安静的:模型读到别人的工具输出,界面上不报任何错。

判据取 new LoopEngine 那一段里 store: 后面跟的是什么,不是全文搜
agentView —— 后者把它写在注释里也能骗过去。"
```

---

### Task 13: 收工 —— 门禁 + PR

- [ ] **Step 1: 全量门禁**

```
npm test
```

- [ ] **Step 2: 开 PR**

```bash
git push -u origin HEAD
gh pr create --title "工作区多智能体 · 切片 1a：骨架·服务端（#928）" --body "..."
```

PR body 要点：本切片**零用户可见变化**（`mentions` 缺席走老语义、`agentId` 缺席走单 agent），点亮在 1b；`EventLog` 是纯重构；最要命的一条是 `agentView` 剥 `toolCalls`（不剥就让悬空自愈捏造事实）。

- [ ] **Step 3: 合并 + 清 lane**

```bash
gh pr merge <N> --merge --delete-branch
npm run lane:prune -- --apply
```
