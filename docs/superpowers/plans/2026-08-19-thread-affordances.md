# 会话区交互补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 照 assistant-ui 的 primitive 清单，把 Otto 消息区缺的 8 项交互补齐：粘性滚动、回到最新、工具调用折叠组、消息复制/重试、代码块复制、错误行重试、思考耗时、划词引用。

**Architecture:** 不引入 `@assistant-ui/react`（它自带消息树状态层，和 Otto「投影必须可从日志推导」的硬规则冲突），只搬交互行为。所有跨事件的推导逻辑落成 `lib/` 下的纯函数并单测；UI 落成新组件；把 2538 行的 `App.tsx` 里的消息区（`EventRow` / `ToolRow`）搬进 `components/Timeline.tsx`。唯一跨进程的改动是给 `AssistantMessageEvent` 加可选字段 `reasoningMs`（schema 只加不改）。

**Tech Stack:** Electron + React 19 + Zustand + Tailwind 4 + shadcn/radix + lucide-react + react-markdown/rehype-highlight，测试 vitest。

## Global Constraints

- **测试环境是 node，没有 jsdom**（`vitest.config.ts` 只 `include: ["tests/**/*.test.ts"]`，`.tsx` 根本不被发现）。**所有测试必须是纯 TS 逻辑，不许碰 DOM、不许渲染组件。** 需要被测的逻辑一律抽成 `lib/` 下的纯函数。
- 测试放 `tests/`，镜像 `src/` 结构，文件名 `*.test.ts`。import 路径带 `.js` 后缀（NodeNext 解析），例如 `../../src/renderer/src/lib/threadGroups.js`。
- 硬门禁：`npm test` 全绿。每个任务结束前跑一次。
- 事件 schema 只加不改，新字段必须可选，旧日志必须照常重放（AGENTS.md 硬规则）。
- 渲染进程禁止直接碰 Node API，只走 `ShellBridge`。
- 注释写「为什么」不写「是什么」，中文，跟现有代码同一密度。commit message 用中文，格式 `type(scope): 说明`。
- 本仓库同时有另外 3 个 agent 在改 `App.tsx`。**对 `App.tsx` 的改动只做两件事：删掉搬走的代码、替换消息区那一段。** 不要顺手重排、不要格式化整个文件。
- 新组件的样式跟现有代码同一套：Tailwind 类名，颜色只用语义 token（`text-muted-foreground` / `text-err` / `text-ok` / `border-border` / `bg-card`），不写死十六进制。

---

### Task 1: `reasoningMs` —— 让「想了多久」成为日志事实

思考耗时现在推不出来：日志里只有 `assistant_message.ts`（消息落盘时刻），拿它减前一条事件的 ts 得到的是整次模型调用耗时（思考 + 正文生成），叫它「思考耗时」就是 UI 在猜。硬规则要求投影可从日志推导 —— 那就把这个事实写进日志。

测量点：`onAssistantDelta(text, kind)` 已经按 `kind: "content" | "reasoning"` 分频道，第一个 reasoning 碎片到第一个 content 碎片之间就是纯思考时间。

**Files:**
- Create: `src/loop/reasoningClock.ts`
- Create: `tests/loop/reasoningClock.test.ts`
- Modify: `src/session/events.ts`（`AssistantMessageEvent`，约 60-72 行）
- Modify: `src/loop/engine.ts:196-217`
- Create: `docs/adr/0032-reasoning-duration-is-a-logged-fact.md`

**Interfaces:**
- Consumes: `DeltaKind` from `src/model/adapter.js`（`"content" | "reasoning"`）
- Produces: `createReasoningClock(now?: () => number): ReasoningClock`，其中 `ReasoningClock = { observe(kind: DeltaKind): void; finish(): number | null }`；`AssistantMessageEvent.reasoningMs?: number`（Task 9 读它）

- [ ] **Step 1: 写失败的测试**

Create `tests/loop/reasoningClock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createReasoningClock } from "../../src/loop/reasoningClock.js";

/** 可控时钟:按序吐出预设时刻,用尽后停在最后一个。
    断言的是差值,不是墙上时间——真实时间进测试就等于引入不确定性 */
function fakeClock(ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)]!;
}

describe("createReasoningClock", () => {
  it("一个碎片都没有 = 没思考过,返回 null", () => {
    const clock = createReasoningClock(fakeClock([100]));
    expect(clock.finish()).toBeNull();
  });

  it("只有正文碎片 = 没开思考频道,返回 null", () => {
    const clock = createReasoningClock(fakeClock([100, 200]));
    clock.observe("content");
    clock.observe("content");
    expect(clock.finish()).toBeNull();
  });

  it("思考到正文的那一刻 = 纯思考耗时", () => {
    const clock = createReasoningClock(fakeClock([100, 600]));
    clock.observe("reasoning");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("多个思考碎片只认第一个", () => {
    const clock = createReasoningClock(fakeClock([100, 200, 300, 600]));
    clock.observe("reasoning");
    clock.observe("reasoning");
    clock.observe("reasoning");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("多个正文碎片只认第一个——后面的正文是生成时间,不是思考时间", () => {
    const clock = createReasoningClock(fakeClock([100, 600, 900, 1500]));
    clock.observe("reasoning");
    clock.observe("content");
    clock.observe("content");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("思考完直接收工(纯工具调用,无正文):用结束时刻兜底", () => {
    const clock = createReasoningClock(fakeClock([100, 700]));
    clock.observe("reasoning");
    expect(clock.finish()).toBe(600);
  });

  it("正文之后又冒出思考碎片,不重新计时", () => {
    const clock = createReasoningClock(fakeClock([100, 600, 800, 999]));
    clock.observe("reasoning");
    clock.observe("content");
    clock.observe("reasoning");
    expect(clock.finish()).toBe(500);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/loop/reasoningClock.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/loop/reasoningClock.js"`

- [ ] **Step 3: 写实现**

Create `src/loop/reasoningClock.ts`:

```ts
// 纯思考耗时的测量器 —— 从流式碎片的频道切换里读出「想了多久」。
//
// 为什么这个数必须落日志:日志里只有 assistant_message.ts(消息落盘时刻),
// 推不出思考从哪一刻开始。UI 若拿"上一条事件的 ts"去减,得到的是整次模型
// 调用耗时(思考 + 正文生成),标成"思考耗时"就是 UI 在编。硬规则要求投影
// 可从日志推导 —— 那就把事实写进日志,而不是让投影层猜(ADR-0032)。

import type { DeltaKind } from "../model/adapter.js";

export interface ReasoningClock {
  /** 每来一个流式碎片喂一次(只看频道,不看内容) */
  observe(kind: DeltaKind): void;
  /** 本次调用的纯思考耗时(ms)。没开过思考频道 = 没思考过 → null */
  finish(): number | null;
}

/** now 可注入:测试要确定的时钟。默认 Date.now */
export function createReasoningClock(now: () => number = Date.now): ReasoningClock {
  let start: number | null = null;
  let end: number | null = null;
  return {
    observe(kind) {
      // 每次都读一次时钟:?? = 会短路掉 now(),而"读时钟"这件事
      // 本身要发生在每个碎片上(注入的假时钟按调用次数走)
      const t = now();
      if (kind === "reasoning") {
        // 只认第一个:正文之后又冒出思考碎片时不重新计时,
        // 否则一次调用会算出好几段"思考",拼不成一个数
        if (start === null) start = t;
        return;
      }
      // 第一个正文碎片 = 思考结束那一刻。之后的正文是生成时间,不再改写
      if (start !== null && end === null) end = t;
    },
    finish() {
      if (start === null) return null;
      // 思考完直接收工(纯工具调用,一个正文碎片都没有):用收工时刻兜底
      return (end ?? now()) - start;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/loop/reasoningClock.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 给事件 schema 加字段**

In `src/session/events.ts`, `AssistantMessageEvent` 里 `reasoning?: string;` 这一行**后面**加：

```ts
  /** 纯思考耗时(ms):第一个 reasoning 碎片到第一个 content 碎片之间(reasoningClock)。
      日志推不出这个事实(只有消息落盘时刻),而 UI 不许猜 —— 所以落盘(ADR-0032)。
      非流式路径(没传 onAssistantDelta)测不到 → 字段缺席,不是 0。
      可选 = 旧日志照常重放 */
  reasoningMs?: number;
```

- [ ] **Step 6: 引擎接线**

In `src/loop/engine.ts`：

顶部 import 区加一行（放在 `import { createApprovalGate }` 那组附近）：

```ts
import { createReasoningClock } from "./reasoningClock.js";
```

把 `loop()` 里 `const reply = await this.adapter.chat(...)` 那一段（约 196-206 行）替换为：

```ts
      // 思考耗时只有在碎片流里才测得到:包一层记下频道切换的时刻,原回调原样透传
      const clock = createReasoningClock();
      const onDelta = this.opts.onAssistantDelta;
      const reply = await this.adapter.chat(
        messages,
        this.opts.tools.map((t) => t.def),
        onDelta
          ? (text, kind) => {
              clock.observe(kind);
              onDelta(text, kind);
            }
          : undefined, // 非流式路径:测不到就不测,字段缺席
        signal // 中断从这穿进 fetch / SSE 读流
      );
      const reasoningMs = clock.finish();
```

再把紧随其后的 `this.append({...})` 里 `...(reply.reasoning ? { reasoning: reply.reasoning } : {}),` 这一行**后面**加：

```ts
        // 耗时只在真有思考内容时才有意义(空思考的耗时是噪音)
        ...(reply.reasoning && reasoningMs !== null ? { reasoningMs } : {}),
```

- [ ] **Step 7: 跑全量测试**

Run: `npm test`
Expected: PASS（`tests/loop/engine.test.ts` 等既有测试不受影响——新字段可选，不传 `onAssistantDelta` 时完全不出现）

- [ ] **Step 8: 写 ADR**

Create `docs/adr/0032-reasoning-duration-is-a-logged-fact.md`:

```markdown
# ADR-0032：思考耗时是日志事实，不是 UI 的推算

日期：2026-08-19
状态：已接受

## 背景

会话区的思考折叠头要显示「想了多久」（对照 assistant-ui 的 "Thought for Xs"）。
折起来时只写「思考过程」，用户不知道里面有多少东西、模型卡了多久。

日志里现有的时间信息只有 `assistant_message.ts` —— 消息落盘的时刻。
UI 若拿它减去前一条事件的 ts，得到的是**整次模型调用耗时**（思考 + 正文生成 +
网络往返），把这个数标成「思考耗时」是 UI 在编一个日志里不存在的事实。

AGENTS.md 硬规则：任何投影（模型上下文 / UI）必须可从日志推导。
「推导」不包括「估一个差不多的」。

## 决策

给 `AssistantMessageEvent` 加可选字段 `reasoningMs?: number`。

测量点在 `src/loop/engine.ts`：流式回调 `onAssistantDelta(text, kind)` 本来就按
`kind: "content" | "reasoning"` 分频道，引擎包一层（`src/loop/reasoningClock.ts`）
记下**第一个 reasoning 碎片**与**第一个 content 碎片**的时刻，差值即纯思考耗时；
没有正文碎片（纯工具调用）时用调用结束时刻兜底。

## 后果

- schema **只加不改**，旧日志无此字段照常重放（向后兼容硬规则满足）。
- 非流式路径（`onAssistantDelta` 未传）测不到 → **字段缺席，不是 0**。
  缺席的语义是「这条日志没有这个事实」，UI 退回只显示字数。
- 耗时只在 `reasoning` 非空时写入：空思考的耗时是噪音。
- 代价：这是本轮 UI 工作里唯一溢出到主进程的改动。接受，因为替代方案
  （UI 拿 ts 差值猜）直接违反硬规则。

## 备选方案

**UI 用 `assistant_message.ts − 前一条事件.ts`，标签写实成「本轮 6.2s」。**
零内核改动，但把「模型调用总耗时」摆在思考折叠头上，读者只会理解成思考耗时。
标签写得再实，位置本身就在说谎。否决。

**只显示字数不显示时间。** 不违规，但丢掉了这条交互一半的价值——
字数说明有多少内容，时间说明模型卡在哪。否决。
```

- [ ] **Step 9: 提交**

```bash
git add src/loop/reasoningClock.ts tests/loop/reasoningClock.test.ts src/session/events.ts src/loop/engine.ts docs/adr/0032-reasoning-duration-is-a-logged-fact.md
git commit -m "feat(log): 思考耗时落成日志事实 reasoningMs

日志里只有消息落盘时刻,推不出思考从哪刻开始。UI 拿 ts 差值去减得到的是
整次调用耗时(思考+正文生成),标成思考耗时就是编。硬规则要求投影可从日志
推导——那就把事实写进去。

测量点在流式碎片的频道切换:第一个 reasoning 碎片到第一个 content 碎片。
非流式路径测不到,字段缺席(不是 0)。ADR-0032。"
```

---

### Task 2: `threadGroups.ts` —— 事件流到渲染项的分组投影

现在 `EventRow` 把每个 `toolCalls` 项渲染成一行 `ToolRow`，全程平铺。一个 turn 读 12 个文件就是 12 行，把真正的模型回复顶出屏外。

对应 assistant-ui 的 `MessagePrimitive.GroupedParts`：相邻的工具调用合成一组。这一步只做**纯投影**，不碰任何 UI。

**Files:**
- Create: `src/renderer/src/lib/threadGroups.ts`
- Create: `tests/renderer/threadGroups.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`、`ToolCallRequest` from `src/session/events.js`
- Produces: `groupThread(events: SessionEvent[]): ThreadItem[]`，其中
  `ThreadItem = { kind: "event"; key: number; event: SessionEvent } | { kind: "toolGroup"; key: string; calls: ToolCallRequest[] }`
  （Task 5 拿它渲染）

- [ ] **Step 1: 写失败的测试**

Create `tests/renderer/threadGroups.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupThread } from "../../src/renderer/src/lib/threadGroups.js";
import type { SessionEvent, ToolCallRequest } from "../../src/session/events.js";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1000 + seq });

const call = (id: string, name = "read_file"): ToolCallRequest => ({ id, name, args: {} });

/** 纯工具调用的 assistant 消息(content 为空串) */
const tools = (...calls: ToolCallRequest[]): SessionEvent =>
  ({ ...env(), type: "assistant_message", content: "", model: "m", toolCalls: calls }) as SessionEvent;

const says = (content: string, ...calls: ToolCallRequest[]): SessionEvent =>
  ({
    ...env(),
    type: "assistant_message",
    content,
    model: "m",
    ...(calls.length ? { toolCalls: calls } : {}),
  }) as SessionEvent;

const result = (toolCallId: string, status: "ok" | "error" = "ok"): SessionEvent =>
  ({ ...env(), type: "tool_result", toolCallId, status, output: "" }) as SessionEvent;

const started = (toolCallId: string): SessionEvent =>
  ({ ...env(), type: "tool_execution_started", toolCallId }) as SessionEvent;

const user = (content: string): SessionEvent =>
  ({ ...env(), type: "user_message", content }) as SessionEvent;

const approval = (decision: "approved" | "denied"): SessionEvent =>
  ({ ...env(), type: "approval_decision", toolCallId: "x", decision }) as SessionEvent;

const turnEnded = (outcome: "completed" | "error" | "aborted"): SessionEvent =>
  ({ ...env(), type: "turn_ended", outcome, ...(outcome === "error" ? { error: "炸了" } : {}) }) as SessionEvent;

describe("groupThread", () => {
  it("空日志出空数组", () => {
    expect(groupThread([])).toEqual([]);
  });

  it("单个工具调用也成组——是否加折叠壳由渲染层按 calls.length 决定", () => {
    const items = groupThread([tools(call("a"))]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "toolGroup", key: "a" });
    expect((items[0] as { calls: ToolCallRequest[] }).calls).toHaveLength(1);
  });

  it("跨事件的连续工具调用合成一组——agent 循环里这本来就是一段连续动作", () => {
    const items = groupThread([
      tools(call("a")),
      started("a"),
      result("a"),
      tools(call("b")),
      started("b"),
      result("b"),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("同一条消息里的多个调用进同一组", () => {
    const items = groupThread([tools(call("a"), call("b"), call("c"))]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("模型正文打断分组:正文前后各一组", () => {
    const items = groupThread([tools(call("a")), result("a"), says("先看了下", call("b")), result("b")]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a"]);
    expect((items[2] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["b"]);
  });

  it("思考内容也算正文,一样打断分组", () => {
    const thinking = {
      ...env(),
      type: "assistant_message",
      content: "",
      model: "m",
      reasoning: "想想",
      toolCalls: [call("b")],
    } as SessionEvent;
    const items = groupThread([tools(call("a")), result("a"), thinking]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("用户发话打断分组", () => {
    const items = groupThread([tools(call("a")), result("a"), user("再来"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("时间线上看不见的事件不打断分组:tool_result / 执行开始 / 已批准 / turn 正常结束", () => {
    const items = groupThread([
      tools(call("a")),
      started("a"),
      approval("approved"),
      result("a"),
      turnEnded("completed"),
      tools(call("b")),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("turn 正常收工(completed)看不见,不打断分组——'ok' 不是这个字段的合法值", () => {
    const items = groupThread([tools(call("a")), result("a"), turnEnded("completed"), tools(call("b"))]);
    expect(items).toHaveLength(1);
    expect((items[0] as { calls: ToolCallRequest[] }).calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("被拒绝的审批看得见,打断分组", () => {
    const items = groupThread([tools(call("a")), approval("denied"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("turn 失败看得见,打断分组", () => {
    const items = groupThread([tools(call("a")), result("a"), turnEnded("error"), tools(call("b"))]);
    expect(items.map((i) => i.kind)).toEqual(["toolGroup", "event", "toolGroup"]);
  });

  it("纯正文的 assistant 消息不产生空组", () => {
    const items = groupThread([says("说完了")]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("event");
  });

  it("组的 key 取组内第一个调用的 id,事件项的 key 取 seq", () => {
    const u = user("hi");
    const items = groupThread([u, tools(call("first"), call("second"))]);
    expect(items[0]!.key).toBe(u.seq);
    expect(items[1]!.key).toBe("first");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/threadGroups.test.ts`
Expected: FAIL —— 解析不到 `threadGroups.js`

- [ ] **Step 3: 写实现**

Create `src/renderer/src/lib/threadGroups.ts`:

```ts
// 事件流 → 渲染项的分组投影。
//
// 为什么要分组:agent 一个 turn 里"调工具 → 拿结果 → 再调工具"是一段连续动作,
// 平铺开就是十几行工具调用,把真正的模型回复顶出屏外。相邻的调用合成一组,
// 跑完折起来只占一行(assistant-ui 的 GroupedParts 同款)。
//
// 纯函数,不碰 React:分组规则是日志的投影,该能单独验。

import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";

export interface EventItem {
  kind: "event";
  key: number; // event.seq —— 会话内唯一
  event: SessionEvent;
}

export interface ToolGroupItem {
  kind: "toolGroup";
  key: string; // 组内第一个调用的 id —— 组的边界会随新事件变,但头一个不会
  calls: ToolCallRequest[];
}

export type ThreadItem = EventItem | ToolGroupItem;

/** 时间线上渲染成 null 的事件。这份名单必须和 Timeline 的 EventRow 一一对应:
    看不见的东西不该打断分组(否则每个 tool_result 都把组切成一段) */
function isInvisible(e: SessionEvent): boolean {
  switch (e.type) {
    case "tool_result":              // 已被工具行吸收(按 toolCallId 配对)
    case "tool_execution_started":   // lifecycle 事件,只在回放里看
      return true;
    case "approval_decision":
      return e.decision === "approved"; // 批准只是正常放行,拒绝才是事实
    case "turn_ended":
      // "completed" 是这个字段的正常态字面量(events.ts:158),不是 "ok"
      return e.outcome === "completed";  // 正常收工不留痕,失败/中断留
    default:
      return false;
  }
}

/** 相邻的工具调用合成一组。相邻 = 中间没有任何"看得见的东西"隔开 */
export function groupThread(events: SessionEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let calls: ToolCallRequest[] = [];

  const flush = (): void => {
    if (calls.length === 0) return;
    items.push({ kind: "toolGroup", key: calls[0]!.id, calls });
    calls = [];
  };

  for (const e of events) {
    if (isInvisible(e)) continue;

    if (e.type === "assistant_message") {
      // 正文或思考 = 看得见的内容,先把前面攒的组收口再放它
      if (e.content.trim() !== "" || (e.reasoning ?? "") !== "") {
        flush();
        items.push({ kind: "event", key: e.seq, event: e });
      }
      // 本条消息带的调用开启(或续上)下一组
      calls.push(...(e.toolCalls ?? []));
      continue;
    }

    flush();
    items.push({ kind: "event", key: e.seq, event: e });
  }

  flush();
  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/threadGroups.test.ts`
Expected: PASS，13 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/threadGroups.ts tests/renderer/threadGroups.test.ts
git commit -m "feat(ui): 事件流到渲染项的分组投影——相邻工具调用合成一组

agent 一个 turn 里调十几次工具,平铺开就把模型回复顶出屏外。
相邻调用(中间没有看得见的东西隔开)合成一组,渲染层再决定折不折。

isInvisible 那份名单必须和 EventRow 渲染 null 的分支一一对应:
看不见的事件不该打断分组,否则每个 tool_result 都把组切成一段。"
```

---

### Task 3: 把消息区从 `App.tsx` 搬出来（纯搬运，零行为变化）

`App.tsx` 已经 2538 行，后面 6 个任务都要改消息区。先做一次无行为变化的搬运，把 `EventRow` / `ToolRow` / `toolSummary` / `toolPhase` 和它们的样式常量分离出去，后面的任务就不用再挤 `App.tsx`。

**这一步不许改任何渲染结果。** 搬完 UI 必须一模一样。

**Files:**
- Create: `src/renderer/src/timelineStyles.ts`
- Create: `src/renderer/src/lib/toolSummary.ts`
- Create: `src/renderer/src/components/Timeline.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Produces:
  - `timelineStyles.ts`: `ROW`, `CHIP`, `AUDIT`, `THINKING_DETAILS`, `THINKING_SUMMARY`, `THINKING_BODY`, `TOOL_SEC`, `TOOL_PRE`（都是 `string`）
  - `lib/toolSummary.ts`: `toolSummary(call: ToolCallRequest): { verb: string; target: string; stat: string }`、`toolPhase(name: string): { orb: OrbState; label: string }`
  - `components/Timeline.tsx`: `EventRow({ event, all }: { event: SessionEvent; all: SessionEvent[] })`、`ToolRow({ call, all }: { call: ToolCallRequest; all: SessionEvent[] })`

- [ ] **Step 1: 抽样式常量**

Create `src/renderer/src/timelineStyles.ts`：把 `App.tsx:122-131` 和 `165-167` 的常量原样搬过来（值一个字符都不改），加 `export`：

```ts
/* 消息区共享的 className 组合。
   从 App.tsx 抽出来:Timeline 和 App 两边都用,谁也不该 import 谁 */

export const ROW = "max-w-[76%] whitespace-pre-wrap break-words";
export const CHIP = `${ROW} self-start text-[12.5px] font-mono border border-border rounded-lg px-[9px] py-[5px] text-muted-foreground`;
export const AUDIT = `${ROW} self-center text-xs text-muted-foreground`;
/* 思考/skill 注入行:档案气质——降调、小字、细左边线,折叠头是唯一交互点 */
export const THINKING_DETAILS = "self-stretch max-w-full border-l-2 border-border py-[2px] pl-[10px] group";
export const THINKING_SUMMARY =
  "cursor-pointer text-muted-foreground text-xs select-none list-none [&::-webkit-details-marker]:hidden before:content-['▸_'] group-open:before:content-['▾_']";
export const THINKING_BODY = "mt-1 text-muted-foreground text-[12.5px] leading-[1.55] whitespace-pre-wrap";
/* 工具详情面板的小节标题与代码块(.hl = 自研高亮器配色作用域,见 app.css) */
export const TOOL_SEC = "text-[11px] text-muted-foreground uppercase tracking-[0.05em] mt-2 mb-1";
export const TOOL_PRE =
  "hl m-0 px-[10px] py-2 rounded-lg bg-[var(--pre-bg)] font-mono text-xs leading-normal whitespace-pre-wrap break-all max-h-60 overflow-auto";
```

从 `App.tsx` 删掉 `ROW` / `CHIP` / `AUDIT` / `THINKING_DETAILS` / `THINKING_SUMMARY` / `THINKING_BODY` / `TOOL_SEC` / `TOOL_PRE` 这 8 个 `const` 定义（连同它们上面那两行注释），在 import 区加：

```ts
import { CHIP, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY } from "./timelineStyles.js";
```

（`App.tsx` 只还用到这 4 个：`CHIP` 在 2313 行的错误行，`THINKING_*` 在 2318-2320 行的直播思考。）

- [ ] **Step 2: 抽 `toolSummary` / `toolPhase`**

Create `src/renderer/src/lib/toolSummary.ts`：把 `App.tsx` 的 `toolPhase`（约 666-675 行）和 `toolSummary`（约 676-716 行）**函数体原样**搬过来，加 `export`，补上 import：

```ts
// 工具调用的一行摘要 —— 从 args 里挑出人看得懂的那一点。
// 从 App.tsx 抽出来:工具行和工具折叠组都要用,谁也不该 import 谁

import type { ToolCallRequest } from "../../../session/events.js";
import { ASK_USER_TOOL_NAME, parseAskUserArgs } from "../../../tools/askUser.js";
import { parseTodoArgs, TODO_TOOL_NAME } from "../../../session/deriveTodos.js";

/** orb 的几档状态。原本是 App.tsx 里的局部 type(645 行),
    toolPhase 搬过来就跟着搬——agentPhase 还留在 App.tsx,从这里 import 回去 */
export type OrbState =
  | "listening"
  | "searching"
  | "working"
  | "composing"
  | "solving"
  | "breathing";
```

然后是 `toolPhase` 和 `toolSummary` 两个函数（函数体原样，加 `export`）。

从 `App.tsx` 删掉三处定义：`type OrbState`（645 行）、`toolPhase`、`toolSummary`，在 import 区加：

```ts
import { toolPhase, type OrbState } from "./lib/toolSummary.js";
```

（`App.tsx` 里 `agentPhase` 用到 `toolPhase` 和 `OrbState`；`toolSummary` 只在 `ToolRow` 里用，跟着搬走。）

- [ ] **Step 3: 建 Timeline.tsx**

Create `src/renderer/src/components/Timeline.tsx`：把 `App.tsx` 的 `ToolRow`（约 718-801 行）和 `EventRow`（约 803-922 行）**原样**搬过来，加 `export`。文件头：

```tsx
// 消息区的两个渲染单元:一次工具调用一行,一条事件一行。
// 都是事件日志的直接投影——UI 不持有自己的对话状态。
// 从 App.tsx 抽出来:那个文件 2500+ 行,消息区的改动全挤在里面没法看

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ThinkingOrb } from "thinking-orbs";
import type {
  SessionEvent,
  ToolCallRequest,
  ToolExecutionStartedEvent,
  ToolResultEvent,
} from "../../../session/events.js";
import { useChat } from "../store.js";
import { Hl } from "../replay/Replay.js";
import { UserAttachments } from "./UserAttachments.js";
import { toolPhase, toolSummary } from "../lib/toolSummary.js";
import { AUDIT, CHIP, ROW, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY, TOOL_PRE, TOOL_SEC } from "../timelineStyles.js";
```

从 `App.tsx` 删掉这两个函数，在 import 区加：

```ts
import { EventRow } from "./components/Timeline.js";
```

清掉 `App.tsx` 里因此不再使用的 import（`ToolExecutionStartedEvent` / `ToolResultEvent` / `UserAttachments` / `Hl` 等——以 tsc 报的未使用为准，别凭猜删）。

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: 无类型错误，测试全绿

> tsconfig 文件名以仓库实际为准（先 `ls tsconfig*.json`）；若有多份，跑 electron-vite 用的那份，或直接 `npm run build` 代替。

- [ ] **Step 5: 跑起来肉眼验收**

Run: `npm run dev`
Expected: 会话区渲染跟搬运前**完全一致** —— 用户气泡、模型正文、思考折叠、工具行展开、审计行。任何一处不一样都说明搬漏了。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/timelineStyles.ts src/renderer/src/lib/toolSummary.ts src/renderer/src/components/Timeline.tsx src/renderer/src/App.tsx
git commit -m "refactor(ui): 消息区从 App.tsx 搬进 Timeline.tsx

零行为变化的纯搬运。App.tsx 2500+ 行,接下来六项消息区交互全要改它,
先把 EventRow/ToolRow 和它们的样式常量、摘要函数分出去,后面的改动
才落得进独立文件。

样式常量和 toolSummary 各自单独成文件:Timeline 和 App 两边都用,
谁也不该 import 谁。"
```

---

### Task 4: 代码块复制键

桌面 agent 工具里「把模型给的命令抠出来」是最高频的动作，现在只能鼠标刷选。

**Files:**
- Create: `src/renderer/src/components/CopyButton.tsx`
- Create: `src/renderer/src/components/CodeBlock.tsx`
- Modify: `src/renderer/src/components/Timeline.tsx`
- Modify: `src/renderer/src/App.tsx`（直播那段 Markdown）

**Interfaces:**
- Produces:
  - `CopyButton({ text, label?, className? }: { text: string | (() => string); label?: string; className?: string })` —— Task 7 也用它
  - `CodeBlock` —— react-markdown 的 `pre` 覆盖组件
  - `MD_COMPONENTS`（从 `CodeBlock.tsx` 导出的 `{ pre: CodeBlock }` 常量，模块级单例，避免每次渲染重建）

- [ ] **Step 1: 写 CopyButton**

Create `src/renderer/src/components/CopyButton.tsx`:

```tsx
// 复制键 —— 三处共用(代码块、模型回复、工具输出)。
// 反馈走图标切换而不是 toast:复制是微动作,值不上一次全局打断。
// 失败也一样(Electron 里罕见但可能):闪一下叉,1.5s 后自己复原

import { useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function CopyButton({
  text,
  label = "复制",
  className = "",
}: {
  /** 传函数 = 点的时候才求值(代码块要从 DOM 读 textContent,渲染时还没有) */
  text: string | (() => string);
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setState("done");
    } catch {
      setState("fail");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={
        "w-auto h-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] " +
        className
      }
      onClick={() => void copy()}
    >
      {state === "done" ? (
        <Check className="size-3.5 text-ok" />
      ) : state === "fail" ? (
        <X className="size-3.5 text-err" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}
```

- [ ] **Step 2: 写 CodeBlock**

Create `src/renderer/src/components/CodeBlock.tsx`:

```tsx
// markdown 代码块的 pre 覆盖 —— 右上角挂复制键,hover 才现身。
//
// 复制的内容从 DOM 的 textContent 读,不去翻 react-markdown 的 children:
// 高亮之后 children 是一棵嵌套的 span 树,重新拼回原文既麻烦又容易错一个字符;
// textContent 拿到的就是渲染出来的那份纯文本,和用户刷选复制的结果一致

import { useRef } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { CopyButton } from "./CopyButton.js";

export function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="relative group/code">
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      <CopyButton
        text={() => ref.current?.textContent ?? ""}
        label="复制代码"
        className="absolute top-2 right-2 bg-card/80 backdrop-blur-sm opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
      />
    </div>
  );
}

/** 模块级单例:每次渲染新建对象会让 react-markdown 整棵子树重挂 */
export const MD_COMPONENTS = { pre: CodeBlock } as const;
```

- [ ] **Step 3: 接进三处 Markdown**

In `src/renderer/src/components/Timeline.tsx`，import 加：

```ts
import { MD_COMPONENTS } from "./CodeBlock.js";
```

把 `EventRow` 里 `assistant_message` 分支的 `<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>` 改成：

```tsx
<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS}>
```

In `src/renderer/src/App.tsx`，直播那段（约 2325 行）同样加 `components={MD_COMPONENTS}`，import 加 `import { MD_COMPONENTS } from "./components/CodeBlock.js";`

- [ ] **Step 4: 跑起来验收**

Run: `npm run dev`
Expected:
- 让模型输出一段带代码块的回复 → 悬停代码块，右上角出现复制键 → 点击变勾号 → 1.5s 后复原 → 粘贴出来的是代码原文（不含高亮标记）
- 流式输出中的半截代码块同样有复制键
- 不悬停时按钮不可见，键盘 Tab 聚焦到它时可见

- [ ] **Step 5: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/components/CopyButton.tsx src/renderer/src/components/CodeBlock.tsx src/renderer/src/components/Timeline.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): 代码块右上角复制键

桌面 agent 里把模型给的命令抠出来是最高频动作,之前只能鼠标刷选。
内容从 DOM textContent 读——高亮后的 children 是嵌套 span 树,
重拼原文既麻烦又容易错字符。

复制反馈走图标切换不走 toast:微动作值不上一次全局打断,失败同理。"
```

---

### Task 5: 工具调用折成一组

**Files:**
- Create: `src/renderer/src/components/ToolGroup.tsx`
- Modify: `src/renderer/src/lib/toolSummary.ts`（加 `summarizeGroup`）
- Modify: `tests/renderer/toolSummary.test.ts`（新建）
- Modify: `src/renderer/src/components/Timeline.tsx`（`EventRow` 不再渲染 `toolCalls`）
- Modify: `src/renderer/src/App.tsx`（消息区改用 `groupThread`）

**Interfaces:**
- Consumes: `groupThread` / `ThreadItem`（Task 2）、`ToolRow` / `EventRow`（Task 3）、`toolSummary`（Task 3）
- Produces: `summarizeGroup(calls: ToolCallRequest[]): string`、`ToolGroup({ calls, all }: { calls: ToolCallRequest[]; all: SessionEvent[] })`

- [ ] **Step 1: 写 `summarizeGroup` 的失败测试**

Create `tests/renderer/toolSummary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { summarizeGroup } from "../../src/renderer/src/lib/toolSummary.js";
import type { ToolCallRequest } from "../../src/session/events.js";

const read = (path: string): ToolCallRequest => ({ id: path, name: "read_file", args: { path } });
const write = (path: string): ToolCallRequest => ({
  id: "w" + path,
  name: "write_file",
  args: { path, content: "x" },
});
const bash = (cmd: string): ToolCallRequest => ({ id: "b" + cmd, name: "bash", args: { cmd } });

describe("summarizeGroup", () => {
  it("空组给空串", () => {
    expect(summarizeGroup([])).toBe("");
  });

  it("同一种动作归并计数", () => {
    expect(summarizeGroup([read("a"), read("b"), read("c")])).toBe("读取 ×3");
  });

  it("多种动作按首次出现的顺序排,不重排", () => {
    expect(summarizeGroup([write("a"), read("b"), read("c")])).toBe("写入 ×1 · 读取 ×2");
  });

  it("认不出的工具用工具名当动作", () => {
    expect(summarizeGroup([{ id: "x", name: "web_search", args: {} }])).toBe("web_search ×1");
  });

  it("终端调用归在一起", () => {
    expect(summarizeGroup([bash("ls"), bash("pwd")])).toBe("终端 ×2");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/toolSummary.test.ts`
Expected: FAIL —— `summarizeGroup` is not exported

- [ ] **Step 3: 实现 `summarizeGroup`**

在 `src/renderer/src/lib/toolSummary.ts` 末尾加：

```ts
/** 折叠头的摘要:按动作归并计数。
    "读取 ×5 · 写入 ×2" 比 "7 个工具调用" 有信息量——折着也知道这一段干了什么。
    顺序按首次出现,不按字母/数量重排:那是动作发生的顺序,读者按这个顺序理解 */
export function summarizeGroup(calls: ToolCallRequest[]): string {
  const byVerb = new Map<string, number>();
  for (const c of calls) {
    const { verb } = toolSummary(c);
    byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1);
  }
  return [...byVerb].map(([verb, n]) => `${verb} ×${n}`).join(" · ");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/toolSummary.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 写 ToolGroup 组件**

Create `src/renderer/src/components/ToolGroup.tsx`:

```tsx
// 连续工具调用的折叠组(assistant-ui 的 GroupedParts 同款)。
//
// 三条规矩:
// 1) 执行中自动展开——正在跑的东西必须看得见进度
// 2) 全部完成自动收起——跑完了它就是过程档案,不该继续占版面
// 3) 有失败就不自动收,且失败数染红——错误绝不能因为折叠被藏掉
// 用户手动点过之后就不再自动驱动:自动行为不该抢用户已经表达过的意图

import { useState } from "react";
import type { SessionEvent, ToolCallRequest, ToolResultEvent } from "../../../session/events.js";
import { summarizeGroup } from "../lib/toolSummary.js";
import { ToolRow } from "./Timeline.js";
import { ROW } from "../timelineStyles.js";

/** 组的墙上耗时:第一次开跑到最后一个结果落盘。
    不是各调用耗时之和——并发时那个数会大于实际经过的时间 */
function groupElapsed(calls: ToolCallRequest[], all: SessionEvent[]): number | null {
  const ids = new Set(calls.map((c) => c.id));
  let first: number | null = null;
  let last: number | null = null;
  for (const e of all) {
    if (e.type === "tool_execution_started" && ids.has(e.toolCallId)) {
      first ??= e.ts;
    } else if (e.type === "tool_result" && ids.has(e.toolCallId)) {
      last = e.ts;
    }
  }
  if (first === null || last === null || last < first) return null;
  return last - first;
}

export function ToolGroup({ calls, all }: { calls: ToolCallRequest[]; all: SessionEvent[] }) {
  const results = new Map<string, ToolResultEvent>();
  for (const e of all) {
    if (e.type === "tool_result") results.set(e.toolCallId, e);
  }

  const running = calls.some((c) => !results.has(c.id));
  const failed = calls.filter((c) => {
    const r = results.get(c.id);
    return r !== undefined && r.status !== "ok";
  }).length;

  // touched = 用户点过折叠头。点过之后 open 只听 manual,自动规则彻底让位
  const [touched, setTouched] = useState(false);
  const [manual, setManual] = useState(false);
  const open = touched ? manual : running || failed > 0;

  const elapsed = groupElapsed(calls, all);

  return (
    <div className={`${ROW} p-0`}>
      <button
        type="button"
        className="flex items-center gap-2 text-left bg-transparent border-none rounded-lg py-[5px] px-2 -mx-2 w-[calc(100%+16px)] text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/5"
        aria-expanded={open}
        onClick={() => {
          setManual(!open);
          setTouched(true);
        }}
      >
        <span className="font-[550] shrink-0 text-foreground">{summarizeGroup(calls)}</span>
        {failed > 0 && <span className="text-deny shrink-0">{failed} 个失败</span>}
        {!running && elapsed !== null && (
          <span className="tabular-nums shrink-0">{(elapsed / 1000).toFixed(1)}s</span>
        )}
        {running && <span className="shimmer shrink-0">执行中</span>}
        <span
          className={
            "ml-auto shrink-0 transition-transform duration-150 ease-strong motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
        >
          ›
        </span>
      </button>
      {open && (
        <div className="pl-3 border-l border-border ml-[2px] flex flex-col">
          {calls.map((c) => (
            <ToolRow key={c.id} call={c} all={all} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: `EventRow` 不再渲染 toolCalls**

In `src/renderer/src/components/Timeline.tsx`，`EventRow` 的 `assistant_message` 分支里删掉这三行：

```tsx
          {event.toolCalls?.map((c) => (
            <ToolRow key={c.id} call={c} all={all} />
          ))}
```

在该 `case` 上方的注释里补一句说明：

```tsx
    case "assistant_message":
      // 工具调用不在这渲染:它们被 groupThread 抽出去按"相邻成组"重新编排了
      // (同一条消息的调用可能和下一条消息的调用属于同一组)
```

`all` 在 `EventRow` 里**只**被刚删掉的那三行用过（其余分支都只读 `event`），所以签名跟着收窄：

```tsx
export function EventRow({ event }: { event: SessionEvent }) {
```

`App.tsx` 的调用点同步去掉 `all={events}`（见下一步的新写法）。`ToolRow` 的 `all` 不动——它要靠它按 `toolCallId` 找结果。

- [ ] **Step 7: 消息区接上分组**

In `src/renderer/src/App.tsx`：

import 加：

```ts
import { groupThread } from "./lib/threadGroups.js";
import { ToolGroup } from "./components/ToolGroup.js";
```

在 `App()` 里、`turnPhase` 计算附近加：

```tsx
  // 分组是纯投影,事件不变就不重算——每次渲染重算会让整段时间线重挂
  const items = useMemo(() => groupThread(events), [events]);
```

把消息区里这一段：

```tsx
            {events.map((e) => (
              <EventRow key={e.seq} event={e} all={events} />
            ))}
```

换成：

```tsx
            {items.map((item) =>
              item.kind === "event" ? (
                <EventRow key={item.key} event={item.event} />
              ) : item.calls.length === 1 ? (
                // 单个调用不加壳:一个调用套一层折叠框是纯粹的视觉噪音
                <ToolRow key={item.key} call={item.calls[0]!} all={events} />
              ) : (
                <ToolGroup key={item.key} calls={item.calls} all={events} />
              )
            )}
```

`ToolRow` 需要从 `Timeline.js` 一并 import（`import { EventRow, ToolRow } from "./components/Timeline.js";`）。

- [ ] **Step 8: 跑起来验收**

Run: `npm run dev`
Expected:
- 让 agent 连读 3 个以上文件 → 执行中折叠组自动展开、逐行出结果 → 全部完成后自动收起成一行 `读取 ×3 · 2.4s`
- 点开再点合，之后新调用完成时**不再**自动收起（用户意图优先）
- 制造一个失败（读不存在的文件）→ 组不自动收，头部出现红色 `1 个失败`
- 单个调用照旧是一行 `ToolRow`，没有多余外壳
- 模型说了话再调工具 → 正文和工具组各自成段，不混在一起

- [ ] **Step 9: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/components/ToolGroup.tsx src/renderer/src/lib/toolSummary.ts tests/renderer/toolSummary.test.ts src/renderer/src/components/Timeline.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): 连续工具调用折成一组

一个 turn 读十几个文件就是十几行,把模型回复顶出屏外。相邻调用合成一组:
跑的时候自动展开看得见进度,跑完自动收成一行。

有失败就不自动收,失败数染红——错误绝不能因为折叠被藏掉。
用户手动点过之后停止自动驱动:自动行为不该抢用户已经表达过的意图。

折叠头摘要按动作归并(读取 ×5 · 写入 ×2),比'7 个工具调用'有信息量。"
```

---

### Task 6: 粘性滚动 + 回到最新

`App.tsx:2196` 现在是无条件 `bottomRef.scrollIntoView()`：模型流式输出时用户往上翻历史会被一下下拽回底部，根本读不成。

**Files:**
- Create: `src/renderer/src/lib/stickToBottom.ts`
- Create: `tests/renderer/stickToBottom.test.ts`
- Create: `src/renderer/src/components/ThreadViewport.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Produces:
  - `STICK_THRESHOLD_PX: number`、`isAtBottom(m: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold?: number): boolean`
  - `ThreadViewport({ deps, children }: { deps: unknown[]; children: ReactNode })`

- [ ] **Step 1: 写失败的测试**

Create `tests/renderer/stickToBottom.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAtBottom, STICK_THRESHOLD_PX } from "../../src/renderer/src/lib/stickToBottom.js";

/** 造一份滚动量:内容 1000,视口 400 → 最大 scrollTop 是 600 */
const m = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });

describe("isAtBottom", () => {
  it("默认阈值是 48px——一行多一点,够容下渲染抖动又不至于把半屏当'在底部'", () => {
    expect(STICK_THRESHOLD_PX).toBe(48);
  });

  it("贴死底部算在底", () => {
    expect(isAtBottom(m(600))).toBe(true);
  });

  it("差 47px 仍算在底", () => {
    expect(isAtBottom(m(553))).toBe(true);
  });

  it("正好差一个阈值算在底(边界含等号)", () => {
    expect(isAtBottom(m(552))).toBe(true);
  });

  it("差 49px 就不算了", () => {
    expect(isAtBottom(m(551))).toBe(false);
  });

  it("翻到顶部当然不在底", () => {
    expect(isAtBottom(m(0))).toBe(false);
  });

  it("内容不满一屏时永远在底——没得滚就没有'离开底部'这回事", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it("橡皮筋回弹的负 scrollTop 不该判成离底", () => {
    expect(isAtBottom({ scrollTop: 620, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("阈值可覆盖", () => {
    expect(isAtBottom(m(500), 200)).toBe(true);
    expect(isAtBottom(m(500), 50)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/stickToBottom.test.ts`
Expected: FAIL —— 解析不到 `stickToBottom.js`

- [ ] **Step 3: 写纯逻辑**

Create `src/renderer/src/lib/stickToBottom.ts`:

```ts
// 滚动粘性的判定 —— 唯一需要单测的那一点逻辑单独拿出来。
// (hook 本体要 DOM,而本仓库的 vitest 跑在 node 环境,没有 jsdom)

/** 距底多少像素之内算"还在底部"。一行多一点:
    够容下流式渲染时的高度抖动,又不至于把半屏内容当成"在底部" */
export const STICK_THRESHOLD_PX = 48;

export function isAtBottom(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = STICK_THRESHOLD_PX
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/stickToBottom.test.ts`
Expected: PASS，9 个用例全绿

- [ ] **Step 5: 写 ThreadViewport**

Create `src/renderer/src/components/ThreadViewport.tsx`:

```tsx
// 消息区的滚动容器 —— assistant-ui 的 Viewport + ScrollToBottom 同款行为。
//
// 之前是无条件 scrollIntoView:模型流式输出时,用户往上翻历史会被一下下拽回底部,
// 根本读不成。改成粘性——只在"已经在底部"时跟随,离底就停住,
// 离底期间来了新东西就在浮钮上点一颗圆点告诉你下面有没看过的内容。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { isAtBottom } from "../lib/stickToBottom.js";

export function ThreadViewport({ deps, children }: { deps: unknown[]; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(true);
  // 离底期间有没有来过新东西。回到底部即清
  const [missed, setMissed] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    setStuck(bottom);
    if (bottom) setMissed(false);
  }, []);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // 高频动作:瞬时滚动,不加动画
    setStuck(true);
    setMissed(false);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stuck) {
      el.scrollTop = el.scrollHeight;
      setMissed(false);
    } else {
      setMissed(true); // 你没在看,但下面确实多了东西
    }
    // stuck 刻意不进依赖:它一变就滚会把"用户刚滚上去"这个动作又拽回来。
    // 这个 effect 只对"内容变了"负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* pb 要盖过 footer 那道 40px 渐隐:不留这段余量,滚到底时最后一条消息
          正好压在渐变里,读起来像被蒙了一层 */}
      <section
        ref={ref}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-stable px-5 pt-4 pb-12 flex flex-col gap-2"
      >
        {children}
      </section>
      {!stuck && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={jump}
          aria-label={missed ? "回到最新（有新内容）" : "回到最新"}
          // 不写 transition-*:buttonVariants 基类那条已经含 opacity/transform,
          // 在这再写一个会被 tailwind-merge 判为同组、把基类整条替换掉,
          // 按压 scale(0.97) 和 hover 变色因此失去过渡
          className="absolute bottom-3 right-5 h-auto gap-1.5 rounded-full bg-card/90 backdrop-blur-sm px-3 py-1 text-xs shadow-md starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0"
        >
          <ArrowDown className="size-3.5" />
          回到最新
          {/* 圆点纯装饰:裸 span 映射到 generic 角色,可访问名不被可靠朗读,
              状态挂在按钮自己的 aria-label 上(见上) */}
          {missed && <span aria-hidden className="size-1.5 rounded-full bg-brand" />}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 换掉 App.tsx 的消息区**

In `src/renderer/src/App.tsx`：

1. 删掉 `const bottomRef = useRef<HTMLDivElement>(null);`
2. 删掉这个 effect（约 2195-2197 行）：

```tsx
  useEffect(() => {
    bottomRef.current?.scrollIntoView(); // 高频动作：瞬时滚动，不加动画
  }, [events.length, status, approval, streamingText.length, streamingThinking.length]);
```

3. 把消息区的 `<section className="flex-1 overflow-y-auto ...">…</section>` 整段的开闭标签换成：

```tsx
          <ThreadViewport
            // key 按会话:换会话就是换一条时间线,滚动状态该跟着会话走而不是继承。
            // 不能只靠 deps——那五项在两个空会话之间可能全等(status/approval 都是
            // 默认值、两个 streaming 长度都是 0、events.length 也可能一样),
            // effect 会被整帧跳过,滚动位置和「有新内容」圆点就串台了
            key={sessionId}
            deps={[events.length, status, approval, streamingText.length, streamingThinking.length]}
          >
            {/* …原来 section 里的全部内容原样保留… */}
          </ThreadViewport>
```

4. 删掉 section 结尾处的 `<div ref={bottomRef} />`
5. import 加 `import { ThreadViewport } from "./components/ThreadViewport.js";`

- [ ] **Step 7: 跑起来验收**

Run: `npm run dev`
Expected:
- 发一条会长输出的消息 → 内容跟着滚
- 输出中往上翻 → **不再被拽回底部**，右下角浮出「回到最新」，且带一颗小圆点
- 点浮钮 → 滚到底、浮钮消失、恢复跟随
- 手动滚回底部 → 浮钮自己消失，恢复跟随
- 内容不满一屏时浮钮不出现

- [ ] **Step 8: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/lib/stickToBottom.ts tests/renderer/stickToBottom.test.ts src/renderer/src/components/ThreadViewport.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): 消息区改成粘性滚动 + 回到最新浮钮

之前无条件 scrollIntoView:模型流式输出时往上翻历史会被一下下拽回底部,
根本读不成。改成只在已经贴底时跟随,离底就停住。

离底期间来了新内容就在浮钮上点一颗圆点——不打断阅读,但也不让你错过。
阈值 48px:够容下流式渲染的高度抖动,又不至于把半屏当成'在底部'。"
```

---

### Task 7: 消息动作条（复制 / 重试）+ 错误行重试

**Files:**
- Create: `src/renderer/src/lib/lastUserMessage.ts`
- Create: `tests/renderer/lastUserMessage.test.ts`
- Create: `src/renderer/src/components/MessageActions.tsx`
- Modify: `src/renderer/src/store.ts`
- Modify: `src/renderer/src/components/Timeline.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `CopyButton`（Task 4）
- Produces:
  - `lastUserMessage(events: SessionEvent[]): UserMessageEvent | null`
  - store: `composerInject: { text: string; append: boolean } | null`、`injectComposer(text: string, append: boolean): void`（Task 8 也用）
  - `MessageActions({ content, isLast }: { content: string; isLast: boolean })`

- [ ] **Step 1: 写 `lastUserMessage` 的失败测试**

Create `tests/renderer/lastUserMessage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lastUserMessage } from "../../src/renderer/src/lib/lastUserMessage.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1000 + seq });

const user = (content: string, withAttachment = false): SessionEvent =>
  ({
    ...env(),
    type: "user_message",
    content,
    ...(withAttachment
      ? { attachments: [{ id: "sha256:x", mediaType: "image/png", bytes: 10 }] }
      : {}),
  }) as SessionEvent;

const bot = (content: string): SessionEvent =>
  ({ ...env(), type: "assistant_message", content, model: "m" }) as SessionEvent;

describe("lastUserMessage", () => {
  it("空日志给 null", () => {
    expect(lastUserMessage([])).toBeNull();
  });

  it("没有用户消息(只有系统事件)给 null", () => {
    expect(lastUserMessage([bot("你好")])).toBeNull();
  });

  it("取最后一条,不是第一条", () => {
    const found = lastUserMessage([user("第一句"), bot("嗯"), user("第二句"), bot("好")]);
    expect(found?.content).toBe("第二句");
  });

  it("带附件的消息照样返回——是否能一键重发由调用方按 attachments 判断", () => {
    const found = lastUserMessage([user("看图", true)]);
    expect(found?.attachments).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/lastUserMessage.test.ts`
Expected: FAIL —— 解析不到 `lastUserMessage.js`

- [ ] **Step 3: 写实现**

Create `src/renderer/src/lib/lastUserMessage.ts`:

```ts
// 重试认的是"上一条用户消息"——从日志尾部倒着找第一条 user_message。
// 纯投影,单独拿出来是为了能验:重试选错了消息,用户会重发一句不相干的话

import type { SessionEvent, UserMessageEvent } from "../../../session/events.js";

export function lastUserMessage(events: SessionEvent[]): UserMessageEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "user_message") return e;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/lastUserMessage.test.ts`
Expected: PASS，4 个用例全绿

- [ ] **Step 5: store 加注入通道**

In `src/renderer/src/store.ts`：

`ChatState` 接口里（挨着 `staged` 那一组）加：

```ts
  /** 待注入输入框的文本(划词引用、重试填回都走这条)。App 收下即清。
      append=true 追加到现有草稿后面(引用),false 整体替换(重试填回)。
      为什么不把 composer 的输入状态提到 store:那是更大的重构,
      这条通道够用且不改动现有输入框的任何行为 */
  composerInject: { text: string; append: boolean } | null;
  injectComposer(text: string, append: boolean): void;
```

初始值区（挨着 `staged: [],`）加：

```ts
  composerInject: null,
```

action 区（挨着 `attachPasted` 附近）加：

```ts
  injectComposer(text, append) {
    set({ composerInject: { text, append } });
  },
```

- [ ] **Step 6: 写 MessageActions**

Create `src/renderer/src/components/MessageActions.tsx`:

```tsx
// 模型回复下方的动作条(assistant-ui 的 ActionBar 同款):hover 才现身。
//
// 复制的是 markdown 原文不是渲染结果:用户要粘进编辑器的是源码,不是排版。
//
// 重试在 append-only 日志下只有一种诚实的做法——把上一条用户消息的正文
// 原样再发一遍,追加新事件,旧日志一字不动。时间线上会出现两条一样的
// 用户消息,那就是事实:你确实又问了一遍。
// 原消息带附件时不能一键重发(附件本体在附件库,重新暂存要新增 bridge 方法),
// 按钮改成"填回输入框"让用户自己重新拖图——文案随状态变,不做静默降级。

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { CopyButton } from "./CopyButton.js";
import { lastUserMessage } from "../lib/lastUserMessage.js";
import { useChat } from "../store.js";

export function MessageActions({ content, isLast }: { content: string; isLast: boolean }) {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const prev = lastUserMessage(events);
  // 附件本体在附件库,重发要新增 bridge 方法读回来——本轮不做,降级成填回输入框
  const hasAttachments = (prev?.attachments?.length ?? 0) > 0 || (prev?.textFiles?.length ?? 0) > 0;
  const canRetry = isLast && prev !== null && status !== "running";

  const retry = (): void => {
    if (!prev) return;
    if (hasAttachments) {
      useChat.getState().injectComposer(prev.content, false);
      return;
    }
    void useChat.getState().send(prev.content);
  };

  return (
    <div className="self-stretch -mt-[2px] flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
      <CopyButton text={content} label="复制回复" />
      {canRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={hasAttachments ? "填回输入框" : "重试"}
              className="w-auto h-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]"
              onClick={retry}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {hasAttachments
              ? "把上一条消息填回输入框（附件要重新添加）"
              : "重试：把上一条消息原样再发一遍"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
```

- [ ] **Step 7: 接进 EventRow**

In `src/renderer/src/components/Timeline.tsx`：

`EventRow` 的签名加一个 `isLast`（`all` 在 Task 5 已经收窄掉了）：

```tsx
export function EventRow({ event, isLast = false }: { event: SessionEvent; isLast?: boolean }) {
```

`assistant_message` 分支里，`{event.content && (...)}` 那一块换成：

```tsx
          {event.content && (
            // group/msg:动作条只在悬停这条回复时现身
            <div className="group/msg self-stretch max-w-full flex flex-col">
              {/* 模型回复无框:正文直接躺在背景上,占满行宽(气泡只留给用户消息) */}
              <div className="md max-w-full py-[2px]">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MD_COMPONENTS}
                >
                  {event.content}
                </Markdown>
              </div>
              <MessageActions content={event.content} isLast={isLast} />
            </div>
          )}
```

import 加 `import { MessageActions } from "./MessageActions.js";`

- [ ] **Step 8: App 传 isLast，并给错误行挂重试**

In `src/renderer/src/App.tsx`：

1. 消息区的 `EventRow` 调用点加 `isLast`：

```tsx
              item.kind === "event" ? (
                <EventRow key={item.key} event={item.event} isLast={item.key === items.at(-1)?.key} />
              ) : ...
```

2. 收下注入（放在其它 effect 附近）：

```tsx
  const composerInject = useChat((s) => s.composerInject);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!composerInject) return;
    setInput((prev) =>
      composerInject.append
        ? (prev.trim() === "" ? "" : prev.replace(/\s*$/, "\n\n")) + composerInject.text
        : composerInject.text
    );
    useChat.setState({ composerInject: null });
    textareaRef.current?.focus();
  }, [composerInject]);
```

3. 给主输入框的 `<Textarea>` 加 `ref={textareaRef}`。

> 若 `Textarea` 不转发 ref（看 `src/renderer/src/components/ui/textarea.tsx`：React 19 里普通函数组件把 `ref` 当普通 prop 经 `{...props}` 透传就行），跑起来 focus 不生效时再补 `forwardRef`。

4. 错误行（约 2313 行）换成：

```tsx
            {error && (
              <div className={`${CHIP} border-err text-err flex items-center gap-2`}>
                <span>[turn 失败] {error}</span>
                <RetryButton />
              </div>
            )}
```

在 `App.tsx` 里加一个小组件（放在 `App` 上方）：

```tsx
/** 失败不该只是一行红字——恢复出口就挂在它旁边(assistant-ui 的 Error primitive 同款) */
function RetryButton() {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const prev = lastUserMessage(events);
  if (!prev || status === "running") return null;
  const hasAttachments = (prev.attachments?.length ?? 0) > 0 || (prev.textFiles?.length ?? 0) > 0;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto px-2 py-[1px] text-[12px] text-err hover:bg-err/[0.12] hover:text-err shrink-0"
      onClick={() => {
        if (hasAttachments) useChat.getState().injectComposer(prev.content, false);
        else void useChat.getState().send(prev.content);
      }}
    >
      重试
    </Button>
  );
}
```

import 加 `import { lastUserMessage } from "./lib/lastUserMessage.js";`

- [ ] **Step 9: 跑起来验收**

Run: `npm run dev`
Expected:
- 悬停一条模型回复 → 下方出现复制键；最后一条额外出现重试键
- 点复制 → 勾号 → 粘出来是 markdown 原文（带 `#`、`-`、代码围栏）
- 点重试 → 时间线追加一条一模一样的用户消息并跑起新 turn
- 上一条用户消息带图时 → 重试键 tooltip 变「填回输入框（附件要重新添加）」，点了只填输入框不发送
- turn 跑着的时候重试键不出现
- 造一次失败（比如断网发消息）→ 红色错误行右侧有「重试」

- [ ] **Step 10: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/lib/lastUserMessage.ts tests/renderer/lastUserMessage.test.ts src/renderer/src/components/MessageActions.tsx src/renderer/src/store.ts src/renderer/src/components/Timeline.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): 模型回复的复制/重试动作条 + 错误行带重试

复制的是 markdown 原文不是渲染结果:用户要粘进编辑器的是源码。

重试在 append-only 下只有一种诚实做法——把上一条用户消息原样再发一遍,
追加新事件,旧日志一字不动。时间线上会出现两条一样的用户消息,
那就是事实:你确实又问了一遍。

带附件的消息不能一键重发(附件本体在附件库,要新增 bridge 方法读回),
按钮改成填回输入框,文案随状态变——不做静默降级。"
```

---

### Task 8: 划词引用

编码 agent 里「这段函数改一下」是高频动作，现在只能手动复制再粘。

**Files:**
- Create: `src/renderer/src/lib/quote.ts`
- Create: `tests/renderer/quote.test.ts`
- Create: `src/renderer/src/components/SelectionQuote.tsx`
- Modify: `src/renderer/src/components/ThreadViewport.tsx`

**Interfaces:**
- Consumes: store 的 `injectComposer`（Task 7）
- Produces: `toBlockquote(text: string): string`、`SelectionQuote({ hostRef }: { hostRef: RefObject<HTMLElement | null> })`

- [ ] **Step 1: 写失败的测试**

Create `tests/renderer/quote.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toBlockquote } from "../../src/renderer/src/lib/quote.js";

describe("toBlockquote", () => {
  it("单行加前缀", () => {
    expect(toBlockquote("改这里")).toBe("> 改这里");
  });

  it("每一行都加前缀——只加第一行的话粘进去就不是引用块了", () => {
    expect(toBlockquote("第一行\n第二行")).toBe("> 第一行\n> 第二行");
  });

  it("空行也要有前缀,否则 markdown 会把引用块切成两段", () => {
    expect(toBlockquote("上\n\n下")).toBe("> 上\n>\n> 下");
  });

  it("首尾空白先剪掉:刷选很容易多带一个换行", () => {
    expect(toBlockquote("  改这里\n\n")).toBe("> 改这里");
  });

  it("全是空白给空串——调用方据此不弹浮钮", () => {
    expect(toBlockquote("   \n  ")).toBe("");
  });

  it("行尾空白也剪:引用里拖一串空格没意义", () => {
    expect(toBlockquote("一   \n二")).toBe("> 一\n> 二");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/quote.test.ts`
Expected: FAIL —— 解析不到 `quote.js`

- [ ] **Step 3: 写实现**

Create `src/renderer/src/lib/quote.ts`:

```ts
// 选中的文字 → markdown 引用块。
// 单独一个函数是为了能验:每行都要有前缀,空行也要——只给首行加前缀的话
// 粘进输入框、发出去之后模型看到的就不是一个引用块了

export function toBlockquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => {
      const body = line.trimEnd();
      return body === "" ? ">" : `> ${body}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/quote.test.ts`
Expected: PASS，6 个用例全绿

- [ ] **Step 5: 写 SelectionQuote**

Create `src/renderer/src/components/SelectionQuote.tsx`:

```tsx
// 划词引用(assistant-ui 的 SelectionToolbar 同款):在消息区选中一段文字,
// 选区上方浮出「引用」,点了以 markdown 引用块进输入框。
//
// 编码 agent 里"这段函数改一下"是高频动作,之前只能手动复制再粘。
//
// 坐标算的是相对宿主容器的偏移,不是视口坐标:浮钮挂在容器里,
// 容器一滚视口坐标就失效,相对偏移跟着内容走

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Quote } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toBlockquote } from "../lib/quote.js";
import { useChat } from "../store.js";

interface Anchor {
  x: number;
  y: number;
  text: string;
}

export function SelectionQuote({ hostRef }: { hostRef: RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const read = (): void => {
      const host = hostRef.current;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      const node = sel?.anchorNode ?? null;
      // 选区必须整个落在消息区里:选中输入框/侧栏的字不该弹这个钮
      if (!host || !sel || sel.isCollapsed || text.trim() === "" || !node || !host.contains(node)) {
        setAnchor(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = host.getBoundingClientRect();
      setAnchor({
        x: rect.left - box.left + rect.width / 2,
        y: rect.top - box.top,
        text,
      });
    };

    // mouseup 定位(选区此刻才定下来),selectionchange 只负责清除:
    // 拖选过程中每动一下就重定位会让浮钮跟着鼠标乱飞
    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim() === "") setAnchor(null);
    };

    document.addEventListener("mouseup", read);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [hostRef]);

  if (!anchor) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // onMouseDown 而不是 onClick:click 之前浏览器已经把选区清了
      onMouseDown={(e) => {
        e.preventDefault();
        const quoted = toBlockquote(anchor.text);
        if (quoted !== "") useChat.getState().injectComposer(quoted, true);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      style={{ left: anchor.x, top: anchor.y }}
      className="absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] h-auto gap-1.5 rounded-full bg-card px-[10px] py-1 text-xs shadow-md transition-opacity duration-150 starting:opacity-0"
    >
      <Quote className="size-3.5" />
      引用
    </Button>
  );
}
```

- [ ] **Step 6: 挂进 ThreadViewport**

In `src/renderer/src/components/ThreadViewport.tsx`：

import 加 `import { SelectionQuote } from "./SelectionQuote.js";`

在 `</section>` 之后、「回到最新」浮钮之前插一行：

```tsx
      <SelectionQuote hostRef={ref} />
```

（`ref` 就是 section 的 ref —— 浮钮定位相对它，选区归属判定也认它。）

- [ ] **Step 7: 跑起来验收**

Run: `npm run dev`
Expected:
- 在模型回复里刷选一段文字 → 选区上方浮出「引用」
- 点它 → 输入框出现 `> 选中的文字`，光标落在输入框里
- 输入框里已有草稿时 → 引用追加在草稿后面，中间空一行
- 选中多行 → 每一行都有 `> ` 前缀
- 选中输入框里的字 / 侧栏的字 → 不弹浮钮
- 点空白处取消选区 → 浮钮消失

- [ ] **Step 8: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/lib/quote.ts tests/renderer/quote.test.ts src/renderer/src/components/SelectionQuote.tsx src/renderer/src/components/ThreadViewport.tsx
git commit -m "feat(ui): 划词引用——选中消息里的文字直接引进输入框

编码 agent 里'这段函数改一下'是高频动作,之前只能手动复制再粘。

定位用 mouseup 不用 selectionchange:拖选过程中每动一下就重定位,
浮钮会跟着鼠标乱飞。点击用 onMouseDown 不用 onClick:
click 触发之前浏览器已经把选区清掉了。

每一行都加 > 前缀(空行也加):只给首行加的话,发出去模型看到的
就不是一个引用块。"
```

---

### Task 9: 思考折叠头显示字数和耗时

折起来时只写「思考过程」，不知道里面有多少东西、模型卡了多久。Task 1 已经把耗时落进日志了，这一步把它显示出来。

**Files:**
- Create: `src/renderer/src/lib/thinkingLabel.ts`
- Create: `tests/renderer/thinkingLabel.test.ts`
- Modify: `src/renderer/src/components/Timeline.tsx`

**Interfaces:**
- Consumes: `AssistantMessageEvent.reasoningMs`（Task 1）
- Produces: `thinkingLabel(reasoning: string, ms?: number): string`

- [ ] **Step 1: 写失败的测试**

Create `tests/renderer/thinkingLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { thinkingLabel } from "../../src/renderer/src/lib/thinkingLabel.js";

describe("thinkingLabel", () => {
  it("没有耗时(旧日志/非流式)就只报字数——缺席不是 0,不许编", () => {
    expect(thinkingLabel("一二三")).toBe("思考 3 字");
  });

  it("有耗时就一起报", () => {
    expect(thinkingLabel("一二三", 6200)).toBe("思考 3 字 · 6.2s");
  });

  it("不到一秒用毫秒,别显示 0.0s", () => {
    expect(thinkingLabel("一二三", 420)).toBe("思考 3 字 · 420ms");
  });

  it("正好一秒走秒", () => {
    expect(thinkingLabel("一", 1000)).toBe("思考 1 字 · 1.0s");
  });

  it("负数是坏数据,只报字数", () => {
    expect(thinkingLabel("一二", -5)).toBe("思考 2 字");
  });

  it("超过一小时是坏数据(时钟跳变/挂起),只报字数", () => {
    expect(thinkingLabel("一二", 3_600_001)).toBe("思考 2 字");
  });

  it("零毫秒是合法的(快得测不出),照报", () => {
    expect(thinkingLabel("一二", 0)).toBe("思考 2 字 · 0ms");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/thinkingLabel.test.ts`
Expected: FAIL —— 解析不到 `thinkingLabel.js`

- [ ] **Step 3: 写实现**

Create `src/renderer/src/lib/thinkingLabel.ts`:

```ts
// 思考折叠头的文案 —— 摊开之前就知道里面有多少东西、模型卡了多久
// (assistant-ui 的 "Thought for Xs" 同款)。
//
// 耗时来自日志里的 reasoningMs(ADR-0032)。字段缺席 = 这条日志没这个事实
// (旧日志 / 非流式路径),那就只报字数——UI 不许拿 ts 差值去凑一个数。

/** 明显不可能的耗时(时钟跳变、系统挂起)一律当坏数据丢掉,只报字数 */
const MAX_SANE_MS = 3_600_000;

export function thinkingLabel(reasoning: string, ms?: number): string {
  const chars = `思考 ${reasoning.length} 字`;
  if (ms === undefined || ms < 0 || ms > MAX_SANE_MS) return chars;
  // 不到一秒走毫秒:显示"0.4s"不如"420ms"精确,显示"0.0s"更是等于没说
  const t = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  return `${chars} · ${t}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/thinkingLabel.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 接进 EventRow**

In `src/renderer/src/components/Timeline.tsx`：

import 加 `import { thinkingLabel } from "../lib/thinkingLabel.js";`

`assistant_message` 分支里，把

```tsx
              <summary className={THINKING_SUMMARY}>思考过程</summary>
```

换成

```tsx
              <summary className={THINKING_SUMMARY}>
                {thinkingLabel(event.reasoning, event.reasoningMs)}
              </summary>
```

- [ ] **Step 6: 跑起来验收**

Run: `npm run dev`
Expected:
- 开着 thinking 发一条消息 → 回复上方的折叠头写「思考 N 字 · X.Xs」
- 打开一个改动前就存在的旧会话 → 折叠头写「思考 N 字」，没有时间（旧日志没这个字段），**不报错、不显示 NaN**

- [ ] **Step 7: 全量测试 + 提交**

Run: `npm test`
Expected: PASS

```bash
git add src/renderer/src/lib/thinkingLabel.ts tests/renderer/thinkingLabel.test.ts src/renderer/src/components/Timeline.tsx
git commit -m "feat(ui): 思考折叠头显示字数和耗时

折起来只写'思考过程'的时候,不知道里面有多少东西、模型卡了多久。

耗时读日志里的 reasoningMs(ADR-0032)。字段缺席 = 这条日志没这个事实
(旧日志/非流式),那就只报字数——不拿 ts 差值去凑一个像样的数。
负数、超一小时一律当坏数据丢掉。"
```

---

## 收尾（全部任务完成后）

- [ ] **跑门禁**：`npm test` 全绿
- [ ] **跑构建**：`npm run build` 无错
- [ ] **整体走一遍验收**：新建会话 → 发一条会调多个工具的消息 → 流式输出中往上翻（不被拽回）→ 点回到最新 → 展开工具组 → 复制代码块 → 划词引用 → 重试
- [ ] **开 PR**：引用对应的 Task issue，PR body 里说明 `reasoningMs` 是 schema 加字段（ADR-0032）
