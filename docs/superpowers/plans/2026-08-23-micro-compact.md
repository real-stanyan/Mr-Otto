# 微压缩（micro-compaction）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置开启时，每个 turn 收口后把最老的一个未吸收 exchange（assistant/tool 部分）交给便宜模型并入 running summary，落一条 `micro_compacted` 事件；投影把被吸收的 assistant/tool 事件替换成一条摘要消息，user_message 原文永不吸收。

**Architecture:** 三层：① `src/session/microCompact.ts` 纯函数——选 exchange、算"已吸收集合"（投影与用量估算共用同一把尺子）；② `src/loop/microCompact.ts` 跑一次压缩（adapter 注入，可测），defrag 超 2000 token 的摘要；③ `src/main/index.ts` 在 turn 锁外、与分区分类同构地排队执行，便宜模型走 `src/main/cheapAdapter.ts`（从 sectionClassifier / followUpSuggester 抽出来的同一条 adapter 路）。设置开关挂在现有 `auto-compact.json` 的 `micro` 字段上，默认关。

**Tech Stack:** TypeScript strict、vitest（tests/ 镜像 src/）、better-sqlite3 EventStore、React + shadcn Switch。

**Spec:** `docs/superpowers/specs/2026-08-22-memory-design.md` §四。

## Global Constraints

- append-only 日志是唯一事实：微压缩 = **追加** `micro_compacted` 事件 + 投影替换；任何事件不改不删。
- 模型可见的必须先落盘：摘要出自模型（不确定）→ 必须是事件；投影是纯函数（同 events 同输出）。
- SessionEvent schema 只加不改；老日志投影逐字节不变（没有 `micro_compacted` 事件时 `deriveMessages` 输出与现在完全一致）。
- 渲染进程只经 `window.otter`（ShellBridge）；工具只依赖 ExecutionWorld；`src/loop/` 不 import `src/main/`。
- `user_message` 永不吸收；保护区 = 最新 `context_compacted` 之后的第一个 exchange + 尾部 `DEFAULT_COMPRESSION.keepRecentTurns`（=2）个 turn。
- `coversUpTo` 存 **seq**（不是数组下标）：seq 是事件的稳定身份（ADR 记这条裁定）。
- 事件 `micro_compacted { summary: string; coversUpTo: number; model: string; usage?: TokenUsage }`，投影消息文案 `[对话摘要]\n<summary>`，角色 assistant。
- defrag 阈值：`estimateTokens(summary) > 2000`。
- 设置开关默认关；文案逐字：「每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。」
- 只认最新一条 `micro_compacted`。`context_compacted` 之后的投影清场，之前的 micro 摘要随之作废；选 exchange 也只看最新 `context_compacted` 之后的事件。
- 微压缩永不抛、永不拖 turn：跑在 turn 锁外；失败不落事件，下一 turn 自愈。用户中断（`turn_ended.outcome === "aborted"`）后不跑。
- 测试放 `tests/` 镜像 `src/`；门禁 `npm test`（tsc + vitest）。
- ADR 编号在合并时定：当前预计 `docs/adr/0063-微压缩是追加事件加投影替换.md`。

---

### Task 1: 事件类型 + 设置字段

**Files:**
- Modify: `src/session/events.ts`（额外 17；union 加入）
- Modify: `src/shared/autoCompact.ts`（`micro?: boolean`）
- Modify: `src/main/autoCompactStore.ts`（normalise 认 `micro`）
- Test: `tests/main/autoCompactStore.test.ts`（追加用例）

**Interfaces:**
- Produces: `MicroCompactedEvent`（type `"micro_compacted"`，字段 `summary: string; coversUpTo: number; model: string; usage?: TokenUsage`）；`AutoCompactSettings.micro?: boolean`（缺省 = 关）。

- [ ] **Step 1: 加事件类型**

在 `src/session/events.ts` 的 `MemoryNudgeEvent`（额外 16）之后追加：

```ts
/** 额外 17：微压缩（ADR-0063）。设置开启时每个 turn 收口后落一条：把最老的一个
    未吸收 exchange 的 assistant/tool 部分并进 running summary。投影只认最新一条：
    seq ≤ coversUpTo 的 assistant_message / tool_result 被替换成一条
    `[对话摘要]` assistant 消息，user_message 原文永不吸收。
    旧摘要被新摘要包含（running summary），所以旧事件只是历史，不再参与投影。
    coversUpTo 存 seq（事件的稳定身份），不是数组下标 */
export interface MicroCompactedEvent extends SessionEventBase {
  type: "micro_compacted";
  summary: string;       // running summary 全文（含之前所有被吸收的 exchange）
  coversUpTo: number;    // 被吸收的最后一个事件的 seq
  model: string;         // 摘要出自哪个（便宜）模型
  usage?: TokenUsage;    // 本次（含 defrag 那次）烧的 token
}
```

并把 `| MicroCompactedEvent` 加进文件底部的 `SessionEvent` union（挨着 `MemoryNudgeEvent`）。

- [ ] **Step 2: 设置字段**

`src/shared/autoCompact.ts` 的接口改为：

```ts
export interface AutoCompactSettings {
  enabled: boolean;
  /** 用户覆盖（0.3–0.9）。缺省 = 按窗口两档 */
  threshold?: number;
  /** 微压缩（ADR-0063）：每 turn 收口后把最老的 exchange 并进摘要。缺省 = 关——
      每轮改写已发送的历史会让前缀缓存每轮失效，只在上下文小、对话长时值得 */
  micro?: boolean;
}
```

`DEFAULT_AUTO_COMPACT` 不变（`{ enabled: true }`，micro 缺省即关）。

- [ ] **Step 3: 写失败测试**

`tests/main/autoCompactStore.test.ts` 末尾追加：

```ts
describe("micro 字段", () => {
  it("micro:true 才落盘；非 true 一律省略（缺省 = 关）", () => {
    expect(normaliseAutoCompact({ enabled: true, micro: true })).toEqual({ enabled: true, micro: true });
    expect(normaliseAutoCompact({ enabled: true, micro: false })).toEqual({ enabled: true });
    expect(normaliseAutoCompact({ enabled: true, micro: "yes" })).toEqual({ enabled: true });
    expect(normaliseAutoCompact({ enabled: false, threshold: 0.5, micro: true })).toEqual({
      enabled: false, threshold: 0.5, micro: true,
    });
  });
});
```

（若文件没 import `normaliseAutoCompact`，补上。）

- [ ] **Step 4: 跑测试，确认失败**

Run: `npx vitest run tests/main/autoCompactStore.test.ts`
Expected: FAIL（`micro` 被剥掉）

- [ ] **Step 5: normalise 认 micro**

`src/main/autoCompactStore.ts` 的 `normaliseAutoCompact` 改为：

```ts
export function normaliseAutoCompact(input: unknown): AutoCompactSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const enabled = typeof obj["enabled"] === "boolean" ? obj["enabled"] : true;
  const threshold =
    typeof obj["threshold"] === "number" && Number.isFinite(obj["threshold"])
      ? Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, obj["threshold"]))
      : undefined;
  // micro 只在明确为 true 时落盘：缺省 = 关（ADR-0063），false 和缺省是同一个意思，
  // 不写 `micro: false` 免得文件里多一个"看着像开关其实等于没写"的键
  const micro = obj["micro"] === true;
  return {
    enabled,
    ...(threshold === undefined ? {} : { threshold }),
    ...(micro ? { micro: true } : {}),
  };
}
```

- [ ] **Step 6: 跑全套门禁**

Run: `npm test`
Expected: PASS（tsc 会逼出所有 switch 缺口——本任务只加 union 成员，`deriveMessages`/`contextEstimate` 的 switch 没有 default-never，不会红；若红了，按 Task 3 的写法补 case）

- [ ] **Step 7: Commit**

```bash
git add src/session/events.ts src/shared/autoCompact.ts src/main/autoCompactStore.ts tests/main/autoCompactStore.test.ts
git commit -m "feat(events): 微压缩事件 micro_compacted + 设置字段 micro（默认关）

ADR-0063 的数据形状先落：事件存 running summary 与 coversUpTo（seq），
设置挂在 auto-compact.json 同一文件上——同一栏目的两个开关不该分两个文件。"
```

---

### Task 2: 纯函数层——选 exchange、算吸收集合

**Files:**
- Create: `src/session/microCompact.ts`
- Test: `tests/session/microCompact.test.ts`

**Interfaces:**
- Consumes: `MicroCompactedEvent`（Task 1）、`SessionEvent`。
- Produces:
  - `latestMicroCompacted(events: SessionEvent[]): MicroCompactedEvent | null` —— 最新一条，且必须在最新 `context_compacted` 之后（否则视为作废 → null）。
  - `absorbedIndexes(events: SessionEvent[]): { absorbed: Set<number>; summaryAt: number } | null` —— 被最新 micro 吸收的事件**数组下标**集合（只含 `assistant_message` / `tool_result`，seq ≤ coversUpTo，且在最新 `context_compacted` 之后）；`summaryAt` = 摘要消息该插在哪个下标**之前**（= 最后一个被吸收事件的下标 + 1，即紧跟在被吸收区之后）。没有可用 micro 事件 → null。
  - `nextMicroExchange(events: SessionEvent[], keepRecentTurns: number): { start: number; end: number; coversUpTo: number; runningSummary: string } | null` —— 最老的未吸收 exchange 的下标区间 `[start, end]`（start 是 user_message 下标，end 是下一个 user_message 之前的最后一个下标），`coversUpTo = events[end].seq`，`runningSummary` = 最新 micro 的 summary（没有 = ""）。

- [ ] **Step 1: 写失败测试**

`tests/session/microCompact.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  absorbedIndexes,
  latestMicroCompacted,
  nextMicroExchange,
} from "../../src/session/microCompact.js";

let seq = 0;
const base = () => ({ seq: seq++, sessionId: "s", ts: seq });
const user = (content: string): SessionEvent => ({ ...base(), type: "user_message", content });
const assistant = (content: string, toolCalls?: { id: string; name: string; args: unknown }[]): SessionEvent => ({
  ...base(), type: "assistant_message", content, model: "m", ...(toolCalls ? { toolCalls } : {}),
});
const tool = (id: string, output: string): SessionEvent => ({
  ...base(), type: "tool_result", toolCallId: id, status: "ok", output,
});
const ended = (): SessionEvent => ({ ...base(), type: "turn_ended", outcome: "completed" });
const micro = (summary: string, coversUpTo: number): SessionEvent => ({
  ...base(), type: "micro_compacted", summary, coversUpTo, model: "cheap",
});
const compacted = (summary: string): SessionEvent => ({
  ...base(), type: "context_compacted", summary, model: "m", trigger: "manual",
});

/** 5 个 exchange：u0 a0 | u1 a1 t1 | u2 a2 | u3 a3 | u4 a4 */
function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "t1"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}

describe("nextMicroExchange", () => {
  it("跳过第一个 exchange（保护区），选第二个；尾部 keepRecentTurns 个 turn 不碰", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2);
    expect(pick).not.toBeNull();
    expect(events[pick!.start]).toMatchObject({ type: "user_message", content: "u1" });
    expect(events[pick!.end]).toMatchObject({ type: "turn_ended" });
    expect(pick!.coversUpTo).toBe(events[pick!.end]!.seq);
    expect(pick!.runningSummary).toBe("");
  });

  it("已有 micro：从 coversUpTo 之后接着选，带上 running summary", () => {
    const events = fiveTurns();
    const first = nextMicroExchange(events, 2)!;
    events.push(micro("S1", first.coversUpTo));
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u2" });
    expect(pick.runningSummary).toBe("S1");
  });

  it("只剩保护区和保真区：返回 null", () => {
    const events = fiveTurns();
    // u1、u2 已吸收；剩 u3、u4 是最近 2 turn → 没得选
    const u2End = events.findIndex((e) => e.type === "user_message" && e.content === "u3") - 1;
    events.push(micro("S", events[u2End]!.seq));
    expect(nextMicroExchange(events, 2)).toBeNull();
    // 短会话：只有 3 个 turn（第 1 个保护，后 2 个保真）
    const short = fiveTurns().slice(0, 12);
    expect(nextMicroExchange(short, 2)).toBeNull();
  });

  it("没有 assistant/tool 可吸收的 exchange 跳过，并入下一个的 coversUpTo 范围", () => {
    seq = 0;
    const events: SessionEvent[] = [
      { ...base(), type: "session_created", workspace: "/w" },
      user("u0"), assistant("a0"), ended(),
      user("u1"), ended(), // 空 turn（比如被中断、什么也没产出）
      user("u2"), assistant("a2"), ended(),
      user("u3"), assistant("a3"), ended(),
      user("u4"), assistant("a4"), ended(),
    ];
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "u2" });
  });

  it("context_compacted 之后重新计数：其后第一个 exchange 是新的保护区，旧 micro 作废", () => {
    const events = fiveTurns();
    events.push(micro("old", events[7]!.seq));
    events.push(compacted("C"));
    seq = events.length;
    events.push(user("v0"), assistant("b0"), ended());
    events.push(user("v1"), assistant("b1"), ended());
    events.push(user("v2"), assistant("b2"), ended());
    events.push(user("v3"), assistant("b3"), ended());
    const pick = nextMicroExchange(events, 2)!;
    expect(events[pick.start]).toMatchObject({ content: "v1" });
    expect(pick.runningSummary).toBe("");
  });
});

describe("latestMicroCompacted / absorbedIndexes", () => {
  it("无事件 → null；投影集合只含 assistant/tool，user 与 turn_ended 不在内", () => {
    const events = fiveTurns();
    expect(latestMicroCompacted(events)).toBeNull();
    expect(absorbedIndexes(events)).toBeNull();
    const first = nextMicroExchange(events, 2)!;
    events.push(micro("S1", first.coversUpTo));
    const got = absorbedIndexes(events)!;
    const types = [...got.absorbed].map((i) => events[i]!.type);
    expect(types.sort()).toEqual(["assistant_message", "tool_result"]);
    // 只吸收 u1 那一段：a0 在保护区不在集合里
    expect(got.absorbed.has(2)).toBe(false);
    expect(got.summaryAt).toBe(first.end + 1);
  });

  it("只认最新一条；最新一条在 context_compacted 之前则作废", () => {
    const events = fiveTurns();
    events.push(micro("S1", events[7]!.seq));
    events.push(micro("S2", events[10]!.seq));
    expect(latestMicroCompacted(events)!.summary).toBe("S2");
    expect(absorbedIndexes(events)!.absorbed.size).toBe(3); // a1 t1 a2
    events.push(compacted("C"));
    expect(latestMicroCompacted(events)).toBeNull();
    expect(absorbedIndexes(events)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/session/microCompact.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/session/microCompact.ts`：

```ts
// microCompact — 微压缩的纯函数层（ADR-0063）。
// 两个消费者共用同一把尺子：deriveMessages（投影替换）和 contextEstimate（用量估算）
// 都从 absorbedIndexes 拿"哪些事件已被摘要替代"；engine 外挂从 nextMicroExchange
// 拿"下一个该吸收谁"。全是纯函数：同 events 同输出，重放可还原模型视野。

import type { MicroCompactedEvent, SessionEvent } from "./events.js";

/** 最新 context_compacted 的下标；没有 = -1。compact 清场后此前一切投影作废，
    微压缩的计数（保护区、running summary）也从这之后重新开始 */
function lastContextCompacted(events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "context_compacted") return i;
  }
  return -1;
}

/** 最新一条 micro_compacted，且必须在最新 context_compacted 之后——
    compact 之前的微摘要描述的是已被 compact 摘要替换掉的历史，再用就是重复记忆 */
export function latestMicroCompacted(events: SessionEvent[]): MicroCompactedEvent | null {
  const floor = lastContextCompacted(events);
  for (let i = events.length - 1; i > floor; i--) {
    const e = events[i];
    if (e?.type === "micro_compacted") return e;
  }
  return null;
}

/** 被最新 micro 摘要替代的事件下标集合（只含 assistant_message / tool_result：
    user_message 永不吸收，其余事件本来就不进投影或各有自己的去留规则）。
    summaryAt = 摘要消息该插在哪个下标之前：紧跟被吸收区之后，所有被吸收的
    user_message 都已经按原文出现过，摘要读起来才是"这些请求的处理经过" */
export function absorbedIndexes(
  events: SessionEvent[]
): { absorbed: Set<number>; summaryAt: number } | null {
  const latest = latestMicroCompacted(events);
  if (!latest) return null;
  const floor = lastContextCompacted(events);
  const absorbed = new Set<number>();
  let last = -1;
  for (let i = floor + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq > latest.coversUpTo) break;
    if (e.type === "assistant_message" || e.type === "tool_result") {
      absorbed.add(i);
      last = i;
    }
  }
  if (absorbed.size === 0) return null; // 指向一段没内容的区间：当它不存在
  return { absorbed, summaryAt: last + 1 };
}

/** 倒数第 keepRecentTurns 个 user_message 的下标（同 deriveMessages.fidelityBoundary
    的定义：之前 = 可压，之后 = 保真）。不足 K 个 = 0（全保真）。K ≤ 0 = events.length */
function fidelityBoundary(events: SessionEvent[], keepRecentTurns: number, floor: number): number {
  if (keepRecentTurns <= 0) return events.length;
  let seen = 0;
  for (let i = events.length - 1; i > floor; i--) {
    if (events[i]?.type === "user_message" && ++seen === keepRecentTurns) return i;
  }
  return floor + 1;
}

export interface MicroExchange {
  /** user_message 的下标 */
  start: number;
  /** 下一个 user_message 之前的最后一个下标（含） */
  end: number;
  /** events[end].seq——落进事件的 coversUpTo */
  coversUpTo: number;
  /** 最新 micro 摘要；没有 = "" */
  runningSummary: string;
}

/** 最老的未吸收 exchange。规则（spec §四）：
    ① 只看最新 context_compacted 之后；② 其后第一个 exchange 是保护区不碰；
    ③ 尾部 keepRecentTurns 个 turn 保真不碰；④ 上一条 micro 的 coversUpTo 之后接着数；
    ⑤ 没有 assistant/tool 可吸收的 exchange 直接跳过（它的 user_message 反正原样保留）*/
export function nextMicroExchange(events: SessionEvent[], keepRecentTurns: number): MicroExchange | null {
  const floor = lastContextCompacted(events);
  const latest = latestMicroCompacted(events);
  const boundary = fidelityBoundary(events, keepRecentTurns, floor);
  const userIdx: number[] = [];
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message") userIdx.push(i);
  }
  // 第一个 exchange 永远保护（任务起点）；之后从 coversUpTo 后第一个 user_message 起
  for (let k = 1; k < userIdx.length; k++) {
    const start = userIdx[k]!;
    if (latest && events[start]!.seq <= latest.coversUpTo) continue;
    if (start >= boundary) return null; // 进了保真区
    const next = userIdx[k + 1];
    if (next === undefined) return null; // 最后一个 exchange 总在保真区内（K≥1）；K=0 时也不吸收进行中的 turn
    const end = next - 1;
    let hasBody = false;
    for (let i = start + 1; i <= end; i++) {
      const t = events[i]!.type;
      if (t === "assistant_message" || t === "tool_result") { hasBody = true; break; }
    }
    if (!hasBody) continue;
    return {
      start,
      end,
      coversUpTo: events[end]!.seq,
      runningSummary: latest?.summary ?? "",
    };
  }
  return null;
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/session/microCompact.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/microCompact.ts tests/session/microCompact.test.ts
git commit -m "feat(session): 微压缩纯函数层——选 exchange、算已吸收集合

投影和用量估算要用同一把尺子判断"哪些事件已被摘要替代"，所以集合算法
只写这一处；保护区/保真区/coversUpTo 接力的规则全在 nextMicroExchange 里，
engine 外挂只负责叫模型。"
```

---

### Task 3: 投影替换 + 用量估算对齐

**Files:**
- Modify: `src/session/deriveMessages.ts`（`deriveMessages` 主循环 + 新 case）
- Modify: `src/shared/contextEstimate.ts`（`pendingAfter`）
- Test: `tests/session/deriveMessages.micro.test.ts`
- Test: `tests/shared/contextEstimate.test.ts`（追加一例）

**Interfaces:**
- Consumes: `absorbedIndexes`（Task 2）。
- Produces: 投影里被吸收区之后插入 `{ role: "assistant", content: "[对话摘要]\n" + summary }`；`micro_compacted` 事件本身是 no-op case（摘要的位置由 absorbedIndexes.summaryAt 决定，不是事件所在位置）。

- [ ] **Step 1: 写失败测试**

`tests/session/deriveMessages.micro.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION } from "../../src/session/deriveMessages.js";
import { nextMicroExchange } from "../../src/session/microCompact.js";

let seq = 0;
const base = () => ({ seq: seq++, sessionId: "s", ts: seq });
const user = (content: string): SessionEvent => ({ ...base(), type: "user_message", content });
const assistant = (content: string, toolCalls?: { id: string; name: string; args: unknown }[]): SessionEvent => ({
  ...base(), type: "assistant_message", content, model: "m", ...(toolCalls ? { toolCalls } : {}),
});
const tool = (id: string, output: string): SessionEvent => ({
  ...base(), type: "tool_result", toolCallId: id, status: "ok", output,
});
const ended = (): SessionEvent => ({ ...base(), type: "turn_ended", outcome: "completed" });
const micro = (summary: string, coversUpTo: number): SessionEvent => ({
  ...base(), type: "micro_compacted", summary, coversUpTo, model: "cheap",
});

function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "t1"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}
const texts = (events: SessionEvent[]) =>
  deriveMessages(events, DEFAULT_COMPRESSION).map((m) => `${m.role}:${typeof m.content === "string" ? m.content : "?"}`);

describe("微压缩投影", () => {
  it("没有 micro 事件：投影逐字节不变", () => {
    const events = fiveTurns();
    const before = JSON.stringify(deriveMessages(events, DEFAULT_COMPRESSION));
    expect(JSON.stringify(deriveMessages(events, DEFAULT_COMPRESSION))).toBe(before);
    expect(texts(events)).toContain("assistant:a1");
  });

  it("被吸收的 assistant/tool 换成一条摘要；user 原文保留；保护区与保真区原样", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("S1", pick.coversUpTo));
    const t = texts(events);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      "user:u0", "assistant:a0",
      "user:u1", "assistant:[对话摘要]\nS1",
      "user:u2", "assistant:a2",
      "user:u3", "assistant:a3",
      "user:u4", "assistant:a4",
    ]);
    // 被吸收的 tool_calls 整体消失：不能留下没有 tool 回应的 assistant（悬空自愈不该介入）
    const msgs = deriveMessages(events, DEFAULT_COMPRESSION);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
    expect(msgs.some((m) => m.role === "assistant" && "tool_calls" in m)).toBe(false);
  });

  it("只认最新一条：第二条 micro 的摘要替代前两段，旧摘要不再出现", () => {
    const events = fiveTurns();
    const p1 = nextMicroExchange(events, 2)!;
    events.push(micro("S1", p1.coversUpTo));
    const p2 = nextMicroExchange(events, 2)!;
    events.push(micro("S1+S2", p2.coversUpTo));
    const t = texts(events);
    expect(t.filter((x) => x.startsWith("assistant:[对话摘要]"))).toEqual(["assistant:[对话摘要]\nS1+S2"]);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      "user:u0", "assistant:a0",
      "user:u1", "user:u2", "assistant:[对话摘要]\nS1+S2",
      "user:u3", "assistant:a3",
      "user:u4", "assistant:a4",
    ]);
  });

  it("与 context_compacted 共存：compact 清场后旧 micro 作废，新 micro 接着用", () => {
    const events = fiveTurns();
    events.push(micro("old", events[7]!.seq));
    events.push({ ...base(), type: "context_compacted", summary: "C", model: "m", trigger: "manual" });
    events.push(user("v0"), assistant("b0"), ended());
    events.push(user("v1"), assistant("b1"), ended());
    events.push(user("v2"), assistant("b2"), ended());
    events.push(user("v3"), assistant("b3"), ended());
    let t = texts(events);
    expect(t.some((x) => x.includes("old"))).toBe(false);
    expect(t[1]).toMatch(/^user:\[上下文已压缩/);
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("N", pick.coversUpTo));
    t = texts(events);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      expect.stringMatching(/^user:\[上下文已压缩/),
      "user:v0", "assistant:b0",
      "user:v1", "assistant:[对话摘要]\nN",
      "user:v2", "assistant:b2",
      "user:v3", "assistant:b3",
    ]);
  });

  it("不带压缩档（replay 全量投影）同样替换——模型视野只有一种", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("S1", pick.coversUpTo));
    const t = deriveMessages(events).map((m) => m.content);
    expect(t).toContain("[对话摘要]\nS1");
    expect(t).not.toContain("a1");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/session/deriveMessages.micro.test.ts`
Expected: FAIL（a1 仍在投影里）

- [ ] **Step 3: 投影实现**

`src/session/deriveMessages.ts`：

1. 顶部 import 加 `import { absorbedIndexes } from "./microCompact.js";`
2. 在 `deriveMessages` 里 `const barren = barrenEventIndexes(events);` 之后加：

```ts
  // 微压缩（ADR-0063）：最新 micro_compacted 吸收的 assistant/tool 事件不进投影，
  // 在被吸收区之后插一条摘要 assistant 消息。user_message 永不吸收——它们照常
  // 落在各自的位置，摘要读起来就是"这些请求的处理经过"。
  // 规则和用量估算共用 absorbedIndexes：圆环和真实 prompt 一把尺子
  const micro = absorbedIndexes(events);
```

3. 主循环 `for (const [i, event] of events.entries()) {` 开头、`if (barren.has(i)) continue;` 之前加：

```ts
    if (micro && i === micro.summaryAt) {
      messages.push({ role: "assistant", content: `[对话摘要]\n${latestMicroSummary(events)}` });
    }
    if (micro?.absorbed.has(i)) continue;
```

   并在循环结束后（`const startedIds = …` 之前）补尾插：

```ts
  // summaryAt 可能 === events.length（被吸收区是日志尾巴）——循环里插不到，这里补
  if (micro && micro.summaryAt >= events.length) {
    messages.push({ role: "assistant", content: `[对话摘要]\n${latestMicroSummary(events)}` });
  }
```

   其中 `latestMicroSummary` 直接用 Task 2 的 `latestMicroCompacted(events)!.summary`（import 它，写成一个两行的本地 helper 或内联——两处同一文案，提成文件内 `const MICRO_SUMMARY_PREFIX = "[对话摘要]\n"`）。

4. switch 里加 no-op case（挨着 `context_compacted` 之后）：

```ts
      case "micro_compacted":
        // 事件本身不投影：它的效果是"吸收集合 + 摘要消息"，位置由 absorbedIndexes
        // 决定（紧跟被吸收区），不是事件落盘的位置（那总在日志尾巴）
        break;
```

注意：`context_compacted` 清场 `messages.length = 0` 在 micro 之后出现时，micro 摘要若已插入会被清掉——这是对的（absorbedIndexes 已保证 micro 在最新 compact 之后，所以插入位置也在 compact 之后，实际不会被清；旧 micro 直接 null）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/session/deriveMessages.micro.test.ts tests/session/`
Expected: PASS（含既有投影测试逐字节不变）

- [ ] **Step 5: 用量估算对齐——失败测试**

`tests/shared/contextEstimate.test.ts` 末尾追加（沿用该文件已有的事件构造风格；若没有 helper 就内联对象）：

```ts
describe("微压缩后的估算", () => {
  it("被吸收的事件不再计入 pending，摘要计入", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 0, type: "user_message", content: "u0" },
      { seq: 2, sessionId: "s", ts: 0, type: "assistant_message", content: "a0", model: "m" },
      { seq: 3, sessionId: "s", ts: 0, type: "user_message", content: "u1" },
      { seq: 4, sessionId: "s", ts: 0, type: "tool_result", toolCallId: "c", status: "ok", output: "x".repeat(4000) },
      { seq: 5, sessionId: "s", ts: 0, type: "user_message", content: "u2" },
      { seq: 6, sessionId: "s", ts: 0, type: "user_message", content: "u3" },
    ];
    const before = contextUsed(events);
    const after = contextUsed([
      ...events,
      { seq: 7, sessionId: "s", ts: 0, type: "micro_compacted", summary: "短摘要", coversUpTo: 4, model: "cheap" },
    ]);
    expect(after).toBeLessThan(before - 900); // 4000 字符 ≈ 1000 token 被摘要替掉
    expect(after).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: 跑测试，确认失败**

Run: `npx vitest run tests/shared/contextEstimate.test.ts`
Expected: FAIL（after === before）

- [ ] **Step 7: pendingAfter 实现**

`src/shared/contextEstimate.ts`：import `absorbedIndexes, latestMicroCompacted` from `../session/microCompact.js`；`pendingAfter` 改为：

```ts
function pendingAfter(events: SessionEvent[], anchorIdx: number): number {
  let pending = 0;
  const barren = barrenEventIndexes(events);
  // 微压缩（ADR-0063）：被吸收的 assistant/tool 不会进下一次 prompt，换成一条摘要——
  // 和 deriveMessages 同一个 absorbedIndexes。锚点之前的事件本来就不计（账单里已含），
  // 只有锚点之后、被吸收的那些要从估算里扣掉；摘要只在锚点之后有 micro 事件时才加
  const micro = absorbedIndexes(events);
  const latestMicro = latestMicroCompacted(events);
  for (let i = anchorIdx + 1; i < events.length; i++) {
    if (barren.has(i)) continue;
    if (micro?.absorbed.has(i)) continue;
    const e = events[i]!;
    switch (e.type) {
      // …既有 case 原样保留…
      case "micro_compacted":
        // 只有最新一条进投影；旧的被新摘要包含
        if (e === latestMicro) pending += estimateTokens(e.summary);
        break;
    }
  }
  return pending;
}
```

（既有 switch 若有 `default`/穷举要求，按文件现状处理；`micro_compacted` case 放在既有 case 之后。）

- [ ] **Step 8: 跑全套门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/session/deriveMessages.ts src/shared/contextEstimate.ts tests/session/deriveMessages.micro.test.ts tests/shared/contextEstimate.test.ts
git commit -m "feat(session): 微压缩投影替换——被吸收的 assistant/tool 换成一条摘要

日志一字不改，模型视野从投影改：只认最新 micro_compacted，user_message 原文
照旧。用量估算走同一个 absorbedIndexes，圆环不会在微压缩后虚高。"
```

---

### Task 4: 便宜模型 adapter 抽出 + 跑一次微压缩（adapter 注入）

**Files:**
- Create: `src/main/cheapAdapter.ts`
- Modify: `src/main/sectionClassifier.ts`、`src/main/followUpSuggester.ts`（改用 cheapAdapter，行为不变）
- Create: `src/loop/microCompact.ts`
- Test: `tests/loop/microCompact.test.ts`

**Interfaces:**
- Consumes: `nextMicroExchange`（Task 2）、`ModelAdapter`、`estimateTokens`（`src/shared/contextEstimate.ts`）、`DEFAULT_COMPRESSION.keepRecentTurns`。
- Produces:
  - `createCheapAdapter(modelId: string, timeoutMs: number): { adapter: ModelAdapter; signal: AbortSignal } | null`（没配 key / 型号不在目录 → null）。
  - `microCompactOnce(events: SessionEvent[], adapter: ModelAdapter, opts?: { signal?: AbortSignal; keepRecentTurns?: number }): Promise<{ summary: string; coversUpTo: number; usage?: TokenUsage } | null>` —— 没可吸收的 exchange / 模型空回 / 抛错 → null，**永不抛**。
  - `MICRO_DEFRAG_TOKENS = 2000`、`MICRO_MODEL = SECTION_MODEL`。

- [ ] **Step 1: 抽 cheapAdapter**

`src/main/cheapAdapter.ts`：

```ts
// cheapAdapter — 三个 turn 后外挂（分区分类 / 跟进建议 / 微压缩）共用的便宜模型通道。
// 规矩一处写：型号从目录查、没配 key 就不出门（空 Bearer 是每 turn 一次必 401 的往返）、
// thinking 显式关（glm-4.5-flash 默认开，实测四个字烧 1452 个 completion token）、
// 带超时信号（openaiCompatible 走裸 fetch 没有任何超时，一条卡死的 TCP 会让 await 永远不回）。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import type { ModelAdapter } from "../model/adapter.js";
import { findModel } from "../shared/modelCatalog.js";

export function createCheapAdapter(
  modelId: string,
  timeoutMs: number
): { adapter: ModelAdapter; signal: AbortSignal } | null {
  const choice = findModel(modelId);
  if (!choice) return null;
  const apiKey = process.env[choice.apiKeyEnv] ?? "";
  if (apiKey === "") return null;
  const adapter = createOpenAICompatibleAdapter({
    baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
    apiKey,
    model: choice.model,
    vision: false,
    // 方言从目录里查，别自己拍一个（ADR-0031）
    thinking: { mode: "off", wire: choice.thinking.wire },
  });
  return { adapter, signal: AbortSignal.timeout(timeoutMs) };
}
```

`sectionClassifier.ts` 的 `classifySection`：把 `findModel` / apiKey 闸门 / `createOpenAICompatibleAdapter` 那段换成

```ts
  const cheap = createCheapAdapter(SECTION_MODEL, CLASSIFY_TIMEOUT_MS);
  if (!cheap) return null;
  try {
    const reply = await cheap.adapter.chat(
      [{ role: "user", content: buildPrompt(currentTitle, summary) }],
      undefined,
      undefined,
      cheap.signal
    );
```

（`currentTitle` 的取值挪到 try 之前；删掉不再用的 import。）`followUpSuggester.ts` 同样改法（`SUGGEST_MODEL` / `SUGGEST_TIMEOUT_MS`）。既有的长注释搬进 cheapAdapter.ts，原处留一句"见 cheapAdapter.ts"。

Run: `npx vitest run tests/main/sectionClassifier.test.ts tests/main/followUpSuggester.test.ts`
Expected: PASS（行为不变）

- [ ] **Step 2: 写失败测试**

`tests/loop/microCompact.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import type { ChatMessage, ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import { MICRO_DEFRAG_TOKENS, microCompactOnce } from "../../src/loop/microCompact.js";

let seq = 0;
const base = () => ({ seq: seq++, sessionId: "s", ts: seq });
const user = (content: string): SessionEvent => ({ ...base(), type: "user_message", content });
const assistant = (content: string, toolCalls?: { id: string; name: string; args: unknown }[]): SessionEvent => ({
  ...base(), type: "assistant_message", content, model: "m", ...(toolCalls ? { toolCalls } : {}),
});
const tool = (id: string, output: string): SessionEvent => ({
  ...base(), type: "tool_result", toolCallId: id, status: "ok", output,
});
const ended = (): SessionEvent => ({ ...base(), type: "turn_ended", outcome: "completed" });

function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "T1-OUTPUT"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}

/** 脚本化 adapter：按顺序吐回复，记下每次收到的 prompt */
function scripted(replies: (string | Error)[]) {
  const prompts: string[] = [];
  let i = 0;
  const adapter = {
    model: "cheap",
    async chat(messages: ChatMessage[]) {
      const last = messages.at(-1)!;
      prompts.push(typeof last.content === "string" ? last.content : "");
      const r = replies[i++]!;
      if (r instanceof Error) throw r;
      return { content: r, usage: { promptTokens: 10, completionTokens: 5 } } as ModelReply;
    },
  } as unknown as ModelAdapter;
  return { adapter, prompts };
}

describe("microCompactOnce", () => {
  it("定位到第二个 exchange：prompt 带 user 原话、assistant 正文、工具名与输出；落 coversUpTo = 该段末尾 seq", async () => {
    const events = fiveTurns();
    const { adapter, prompts } = scripted(["S1"]);
    const got = await microCompactOnce(events, adapter);
    expect(got).toEqual({ summary: "S1", coversUpTo: 7, usage: { promptTokens: 10, completionTokens: 5 } });
    expect(prompts[0]).toContain("u1");
    expect(prompts[0]).toContain("a1");
    expect(prompts[0]).toContain("bash");
    expect(prompts[0]).toContain("T1-OUTPUT");
    expect(prompts[0]).not.toContain("a0");
    expect(prompts[0]).not.toContain("a2");
  });

  it("running summary 进 prompt；coversUpTo 接着上一条", async () => {
    const events = fiveTurns();
    events.push({ ...base(), type: "micro_compacted", summary: "PREV", coversUpTo: 7, model: "cheap" });
    const { adapter, prompts } = scripted(["S2"]);
    const got = await microCompactOnce(events, adapter);
    expect(got?.coversUpTo).toBe(10);
    expect(prompts[0]).toContain("PREV");
  });

  it("摘要超 defrag 阈值：再让模型整理一次，落整理后的；usage 合计两次", async () => {
    const events = fiveTurns();
    const fat = "长".repeat(Math.ceil(MICRO_DEFRAG_TOKENS / 0.6) + 10);
    const { adapter, prompts } = scripted([fat, "瘦"]);
    const got = await microCompactOnce(events, adapter);
    expect(got?.summary).toBe("瘦");
    expect(got?.usage).toEqual({ promptTokens: 20, completionTokens: 10 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(fat);
  });

  it("没可吸收的段 / 模型空回 / 抛错：一律 null，不抛", async () => {
    const short = fiveTurns().slice(0, 12);
    expect(await microCompactOnce(short, scripted(["x"]).adapter)).toBeNull();
    expect(await microCompactOnce(fiveTurns(), scripted(["   "]).adapter)).toBeNull();
    expect(await microCompactOnce(fiveTurns(), scripted([new Error("boom")]).adapter)).toBeNull();
  });

  it("defrag 那次空回：保留未整理的原摘要（宁可胖也别丢）", async () => {
    const events = fiveTurns();
    const fat = "长".repeat(Math.ceil(MICRO_DEFRAG_TOKENS / 0.6) + 10);
    const got = await microCompactOnce(events, scripted([fat, ""]).adapter);
    expect(got?.summary).toBe(fat);
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `npx vitest run tests/loop/microCompact.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`src/loop/microCompact.ts`：

```ts
// microCompact — 跑一次微压缩（ADR-0063）：最老的未吸收 exchange + running summary
// → 便宜模型 → 新 summary。adapter 注入：谁来摘要是装配的事（main 里用 cheapAdapter），
// 这里只管"喂什么、收什么"。永不抛：微压缩是锦上添花，失败 = 不落事件，下一 turn 自愈。
// 住在 src/loop 而不是 engine 里：它不在 turn 的闭环上（turn 锁外跑），和 engine 只共享投影规则。

import type { SessionEvent, TokenUsage } from "../session/events.js";
import type { ChatMessage, ModelAdapter } from "../model/adapter.js";
import { DEFAULT_COMPRESSION } from "../session/deriveMessages.js";
import { nextMicroExchange } from "../session/microCompact.js";
import { estimateTokens } from "../shared/contextEstimate.js";
import { SECTION_MODEL } from "../main/sectionClassifier.js"; // ← 见下方说明，不允许：改成常量复制

/** 摘要超过这个估算 token 数就先让模型整理一次再落（spec §四 第 4 条） */
export const MICRO_DEFRAG_TOKENS = 2000;
/** 整理目标：defrag 后希望落在这个量级以下（提示词里的目标，不是硬断言） */
const MICRO_DEFRAG_TARGET = 1200;
/** 单条消息进 prompt 的截断：工具输出要留够模型看出"做了什么、结果如何"，
    但几万字的 bash 输出没必要全喂 */
const PER_EVENT_CHARS = 1500;

export interface MicroCompactResult {
  summary: string;
  coversUpTo: number;
  usage?: TokenUsage;
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens };
}

function clip(s: string): string {
  return s.length > PER_EVENT_CHARS ? s.slice(0, PER_EVENT_CHARS) + `…[截断，原 ${s.length} 字符]` : s;
}

/** 把一个 exchange 转成给摘要人看的文字。user 原话也给（摘要要知道在回应什么），
    但提示词明说不要复述它——投影里 user_message 会原文保留 */
function renderExchange(events: SessionEvent[], start: number, end: number): string {
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    const e = events[i]!;
    if (e.type === "user_message") lines.push(`用户：${clip(e.content)}`);
    else if (e.type === "assistant_message") {
      if (e.content.trim()) lines.push(`助手：${clip(e.content)}`);
      for (const c of e.toolCalls ?? []) lines.push(`助手调用 ${c.name}：${clip(JSON.stringify(c.args))}`);
    } else if (e.type === "tool_result") {
      lines.push(`工具 ${e.toolCallId} 返回（${e.status}）：${clip(e.output)}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(runningSummary: string, exchange: string): string {
  return (
    "你在为一个 AI 助手维护一份「对话摘要」，它会替代已发生对话的助手回复和工具调用，" +
    "作为助手之后回看历史的唯一依据。用户的原话会另外原文保留，摘要里不要复述用户说了什么，" +
    "只记助手做了什么、用了哪些工具、得到什么结果、做了什么决定（含文件路径、命令、关键数字）。\n" +
    (runningSummary ? `当前摘要：\n---\n${runningSummary}\n---\n` : "当前还没有摘要。\n") +
    `新增的一段对话：\n---\n${exchange}\n---\n` +
    "把新增内容并进当前摘要，输出更新后的完整摘要。条目式、按时间顺序、不要开场白、不要围栏。"
  );
}

function buildDefragPrompt(summary: string): string {
  return (
    `下面这份对话摘要太长了，请整理：合并重复、去掉已被后续内容推翻的条目、压缩措辞，` +
    `目标不超过约 ${MICRO_DEFRAG_TARGET} 个 token，但文件路径、命令、关键数字和未完成事项一个都不能丢。` +
    `直接输出整理后的摘要，不要开场白、不要围栏。\n---\n${summary}\n---`
  );
}

async function ask(adapter: ModelAdapter, prompt: string, signal?: AbortSignal) {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  return adapter.chat(messages, undefined, undefined, signal);
}

/** 跑一次。null = 这次没东西可做 / 失败（不落事件）。永不抛 */
export async function microCompactOnce(
  events: SessionEvent[],
  adapter: ModelAdapter,
  opts: { signal?: AbortSignal; keepRecentTurns?: number } = {}
): Promise<MicroCompactResult | null> {
  const pick = nextMicroExchange(events, opts.keepRecentTurns ?? DEFAULT_COMPRESSION.keepRecentTurns);
  if (!pick) return null;
  try {
    const reply = await ask(adapter, buildPrompt(pick.runningSummary, renderExchange(events, pick.start, pick.end)), opts.signal);
    let summary = reply.content.trim();
    if (!summary) return null;
    let usage = reply.usage;
    if (estimateTokens(summary) > MICRO_DEFRAG_TOKENS) {
      const tidy = await ask(adapter, buildDefragPrompt(summary), opts.signal);
      usage = addUsage(usage, tidy.usage);
      // defrag 空回：留着胖的——丢摘要比摘要胖代价大得多
      if (tidy.content.trim()) summary = tidy.content.trim();
    }
    return { summary, coversUpTo: pick.coversUpTo, ...(usage ? { usage } : {}) };
  } catch {
    return null; // 限流 / 断网 / 超时：无害，下一 turn 自愈
  }
}
```

**注意**：上面那行 `import { SECTION_MODEL } from "../main/sectionClassifier.js"` 是反面示例——`src/loop/` **禁止** import `src/main/`（tests/architecture.test.ts 会红）。实现时**删掉那行**，型号常量放在 Task 5 的 index.ts 接线处：`const MICRO_MODEL = SECTION_MODEL;`。

- [ ] **Step 5: 跑测试 + 门禁**

Run: `npx vitest run tests/loop/microCompact.test.ts && npm test`
Expected: PASS（含 architecture.test.ts）

- [ ] **Step 6: Commit**

```bash
git add src/main/cheapAdapter.ts src/main/sectionClassifier.ts src/main/followUpSuggester.ts src/loop/microCompact.ts tests/loop/microCompact.test.ts
git commit -m "feat(loop): 微压缩跑一次——exchange 喂便宜模型并进 running summary，超 2000 token 先 defrag

便宜模型通道从分类员/建议员里抽成 cheapAdapter：三个外挂同一套
key 闸门 / thinking 关 / 超时，不再各抄一份。"
```

---

### Task 5: 接线（turn 收口外挂）+ 设置开关 + 时间线行 + 文档

**Files:**
- Modify: `src/main/index.ts`（新外挂 `microCompactAndAppend` + 串行队列 + 收口处调用）
- Modify: `src/renderer/src/components/AutoCompactSettings.tsx`（开关）
- Modify: `src/renderer/src/lib/autoCompactCopy.ts`（文案常量 + 时间线行标题）
- Modify: `src/renderer/src/components/Timeline.tsx`（`micro_compacted` 审计行）
- Modify: `CONTEXT.md`（微压缩词条）
- Create: `docs/adr/0063-微压缩是追加事件加投影替换.md`
- Test: `tests/renderer/autoCompactCopy.test.ts`（追加）

**Interfaces:**
- Consumes: `microCompactOnce`、`createCheapAdapter`（Task 4）、`loadAutoCompact(autoCompactPath).micro`（Task 1）。

- [ ] **Step 1: 文案 + 失败测试**

`src/renderer/src/lib/autoCompactCopy.ts` 追加：

```ts
/** 微压缩开关的说明（spec §四 原文，逐字） */
export const MICRO_COMPACT_HINT =
  "每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。";

/** 时间线微压缩行标题 */
export function microCompactedHeadline(summaryTokens: number): string {
  return `一段对话并入摘要（摘要约 ${summaryTokens} tokens）`;
}
```

`tests/renderer/autoCompactCopy.test.ts` 追加：

```ts
import { MICRO_COMPACT_HINT, microCompactedHeadline } from "../../src/renderer/src/lib/autoCompactCopy.js";

describe("微压缩文案", () => {
  it("开关说明逐字对齐 spec", () => {
    expect(MICRO_COMPACT_HINT).toBe("每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。");
  });
  it("时间线行带摘要体积", () => {
    expect(microCompactedHeadline(321)).toBe("一段对话并入摘要（摘要约 321 tokens）");
  });
});
```

Run: `npx vitest run tests/renderer/autoCompactCopy.test.ts` → FAIL，再实现 → PASS。

- [ ] **Step 2: index.ts 外挂**

在 `nudgeMemory` 定义之后加：

```ts
  // 微压缩（ADR-0063）：第四条 turn 后外挂，与分区分类同构——turn 锁外、永不抛、
  // 会话被 purge 就不落。**必须串行**（同 sectionQueues 的理由）：两次并发的
  // microCompactOnce 各自看不到对方的 micro_compacted，会对同一个 exchange 摘两次、
  // 后落的那条 running summary 丢掉先落那条的内容。
  const MICRO_MODEL = SECTION_MODEL;
  const MICRO_TIMEOUT_MS = 30_000;
  const microQueues = new Map<string, Promise<void>>();
  const microCompactAndAppend = async (sessionId: string): Promise<void> => {
    if (!loadAutoCompact(autoCompactPath).micro) return; // 现读：设置页一关当场停
    const cheap = createCheapAdapter(MICRO_MODEL, MICRO_TIMEOUT_MS);
    if (!cheap) return;
    const result = await microCompactOnce(store.load(sessionId), cheap.adapter, { signal: cheap.signal });
    if (!result) return;
    if (!agents.has(sessionId)) return; // 同 classifyAndAppend：别往 purge 过的会话上 append
    const event = store.append({
      sessionId, ts: Date.now(), type: "micro_compacted",
      summary: result.summary, coversUpTo: result.coversUpTo, model: MICRO_MODEL,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    send(CHANNELS.event, event);
  };
  const enqueueMicroCompact = (sessionId: string): void => {
    const prev = microQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => microCompactAndAppend(sessionId))
      .catch((err) => console.error("微压缩失败", err));
    microQueues.set(sessionId, next);
    void next.then(() => {
      if (microQueues.get(sessionId) === next) microQueues.delete(sessionId);
    });
  };
```

（对照 `enqueueSectionClassify` 的排空写法，保持一致。）import：`createCheapAdapter` from `./cheapAdapter.js`，`microCompactOnce` from `../loop/microCompact.js`，`SECTION_MODEL` 已有或补 import。

收口处（`if (!aborted) { enqueueSectionClassify(sessionId); … }` 块内末尾）加：

```ts
        // 微压缩同理：只在正常收口后跑；自己内部读设置，关着就立刻返回
        enqueueMicroCompact(sessionId);
```

- [ ] **Step 3: 设置页开关**

`AutoCompactSettings.tsx`：import `MICRO_COMPACT_HINT`；在阈值滑块那块 `</div>`（`flex flex-col gap-2` 结束）之后、外层卡片结束之前加：

```tsx
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">微压缩</span>
              <p className={HINT}>每轮收口后把最老的一段对话并进摘要，用户原话保留。</p>
              <p className={HINT}>{MICRO_COMPACT_HINT}</p>
            </div>
            <Switch checked={settings.micro === true} onCheckedChange={onMicroChange} disabled={disabled} />
          </div>
```

handler（放在 `onEnabledChange` 旁）：

```tsx
  const onMicroChange = (micro: boolean) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // exactOptionalPropertyTypes：关 = 键消失，不是 micro:false
    const { micro: _drop, ...rest } = settings;
    const next: AutoCompactSettingsValue = micro ? { ...rest, micro: true } : rest;
    setSettings(next);
    persist(next);
  };
```

（注意：`restoreDefault` 构造 `{ enabled: settings.enabled }` 会把 micro 丢掉——改成 `const { threshold: _t, ...next } = settings;`，保留 micro。）

- [ ] **Step 4: 时间线审计行**

`Timeline.tsx` 的 `EventRow` switch 里 `context_compacted` case 之后加：

```tsx
    case "micro_compacted":
      return (
        <div className={AUDIT}>
          ✻ {microCompactedHeadline(estimateTokens(event.summary))}（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );
```

import `microCompactedHeadline` 与 `estimateTokens`（`../../../shared/contextEstimate.js`）。若 `toThreadMessages.ts` 的 `isAuditEvent` 是白名单列表，把 `"micro_compacted"` 加进去（和 `context_compacted` 同列）；若是 default 兜底则不动。`replay/trajectory.ts` 若有穷举 switch 则加一行 `case "micro_compacted": return \`micro_compacted ${clip(e.summary, 80)}\`;`。

- [ ] **Step 5: CONTEXT.md + ADR**

`CONTEXT.md` 在「自动压缩」行之后加：

```
| 微压缩（micro compact） | 设置开启时每 turn 收口后（turn 锁外、串行）把最老的未吸收 exchange 的 assistant/tool 部分并进 running summary，落 `micro_compacted{summary, coversUpTo(seq)}`；投影只认最新一条，把被吸收事件换成一条 `[对话摘要]` assistant 消息，user_message 永不吸收；保护区 = 最新 context_compacted 后第一个 exchange + 尾部 keepRecentTurns；摘要 >2000 token 先 defrag；默认关（每轮改写历史会让前缀缓存失效） | ADR-0063 |
```

`docs/adr/0063-微压缩是追加事件加投影替换.md`（对照 0062 的格式：状态 / 背景 / 决定 / 后果）。要点：
- 背景：hermes 的 micro-compaction 是原地改写历史；这里的硬规则是 append-only + 投影可推导。
- 决定：微压缩 = 追加 `micro_compacted` 事件 + 投影替换；只认最新一条（running summary）；`coversUpTo` 存 seq 不存下标（稳定身份，fork/过滤不影响）；吸收集合与用量估算共用 `absorbedIndexes`；跑在 turn 锁外、按会话串行；便宜模型通道抽成 `cheapAdapter`；开关挂在 `auto-compact.json.micro`，默认关。
- 裁定记录：摘要消息插在被吸收区**之后**（让所有被吸收的 user 原话先出现）；user_message 之外的 user-角色注入（skill_invoked / image_described / subagent_briefed）不吸收；没有 assistant/tool 的 exchange 跳过；测试路径为 `tests/session/microCompact.test.ts` / `tests/loop/microCompact.test.ts`（spec 写的 `engine.micro.test.ts` 因为逻辑不在 engine 里）。
- 后果：每轮前缀缓存失效（所以默认关）；圆环在下一次账单前按估算扣除；编号 0063 是因为 0061 被 #189 占、0062 是自动压缩。

- [ ] **Step 6: 门禁 + e2e**

Run: `npm test`
Expected: PASS

Run: `npm run e2e`（不在 gate 里，GUI 改动的 PR 贴结果；splash 用例 #191 已知不稳）

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/renderer/src/components/AutoCompactSettings.tsx src/renderer/src/lib/autoCompactCopy.ts src/renderer/src/components/Timeline.tsx CONTEXT.md docs/adr/0063-微压缩是追加事件加投影替换.md tests/renderer/autoCompactCopy.test.ts
git commit -m "feat(micro-compact): turn 收口外挂接线 + 设置开关（默认关）+ 时间线行 + ADR-0063

跑在 turn 锁外、按会话串行（两次并发会对同一段摘两次）；开关现读，
关了当场停。"
```

---

## Self-review

- Spec 覆盖：事件 ✅(T1) 流程 1-5 ✅(T2 选段 / T4 喂模型+defrag / T5 接线) 投影 ✅(T3) 设置 ✅(T1+T5) ADR ✅(T5) 测试 ✅(路径偏差已在 ADR 记裁定)。
- 占位扫描：无 TBD；T4 代码块里那个反面 import 已明确要求删除。
- 类型一致性：`MicroCompactedEvent.coversUpTo: number`(seq) ↔ `nextMicroExchange().coversUpTo = events[end].seq` ↔ `absorbedIndexes` 比较 `e.seq > latest.coversUpTo` ✅；`AutoCompactSettings.micro?: boolean` ↔ normalise 只落 true ↔ 设置页 `settings.micro === true` ✅；`microCompactOnce(events, adapter, {signal, keepRecentTurns})` ↔ index.ts 调用 ✅。
