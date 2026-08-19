# assistant-ui 迁移 PR1（输出侧）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Mr Otto 会话区的**输出侧**渲染迁到 assistant-ui —— 立起 `ExternalStoreRuntime` 接缝，用 `Thread` + `streamdown` + Shiki + `reasoning` 换掉 `ThreadViewport` + react-markdown + highlight.js，视觉保持不变。

**Architecture:** 事件日志仍是唯一事实来源。新增纯函数 `toThreadMessages(events, live)` 把 `SessionEvent[]` 投影成 `ThreadMessageLike[]`，交给 `useExternalStoreRuntime`。写入方向（发消息 / 中断 / 重试）全部回原有 ShellBridge 路径，不新开写路。输入侧（composer/附件/模型选择/上下文环）本 PR **不动**，留在 PR2。

**Tech Stack:** `@assistant-ui/react@^0.15.15`、`@assistant-ui/tool-fallback`（registry）、`@assistant-ui/react-streamdown` + `streamdown@^2.5.0` + `@streamdown/code@^1.1.1` + `@streamdown/cjk@^1.0.3`、`@base-ui/react`（随 registry 组件进来）、React 19、Tailwind v4、vitest。

**Spec:** `docs/superpowers/specs/2026-08-19-assistant-ui-migration-design.md`

## Global Constraints

- 门禁命令：`npm test`（即 `vitest run`）。与 `.github/workflows/ci.yml` 逐字一致，**不许改**（AGENTS.md L1）。
- 测试放 `tests/`，镜像 `src/` 结构，**不与源码同目录**（ADR-0016）。本仓测试全是纯函数测试，不渲染 React —— 本计划遵守该惯例。
- `tsconfig` 开了 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`。数组下标取值必须处理 `undefined`；可选字段**不能**显式赋 `undefined`（要么给值，要么整个键不出现）；`import type` 必须写成 type-only。
- 相对 import **必须带 `.js` 后缀**（`module: nodenext`）。
- 路径别名：`@/*` → `src/renderer/src/*`（tsconfig + electron.vite.config.ts 双处已配）。
- 事件日志硬规则：`toThreadMessages` 是**只读投影**，不得写日志、不得持有对话状态。
- `SessionEvent` schema 本 PR **不改**（新事件在 PR3）。
- 每个 task 结束前 `npm test` 必须绿（**939/939**，无跳过、无失败）。
- **装完任何 npm 包，先跑 `node scripts/fix-pty-perms.mjs` 再跑测试。** npm 解包会抹掉
  `node-pty` 里 `spawn-helper` 的执行位，`tests/world/localWorldTerminal.test.ts` 会以
  `posix_spawnp failed` 挂 3 条。这是环境问题不是代码问题（ad04699 加的 postinstall 就是干这个的），
  别去改测试、别当成「既有失败」放过去。
- commit message 用中文写「为什么」，结尾带 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

## 关键类型（照抄自 `@assistant-ui/core` 的 `.d.ts`，非推测）

```ts
type ThreadMessageLike = {
  readonly role: "assistant" | "user" | "system";
  readonly content: string | readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "reasoning"; readonly text: string }
    | { readonly type: "source"; readonly sourceType: "url"; readonly id: string;
        readonly url: string; readonly title?: string }
    | { readonly type: "file"; readonly data: string; readonly mimeType: string;
        readonly filename?: string }
    | { readonly type: "image"; readonly image: string; readonly filename?: string }
    | { readonly type: "tool-call"; readonly toolCallId?: string; readonly toolName: string;
        readonly args?: ReadonlyJSONObject; readonly argsText?: string;
        readonly result?: unknown; readonly isError?: boolean }
  )[];
  readonly id?: string;
  readonly createdAt?: Date;
  readonly status?: MessageStatus;
  readonly metadata?: { readonly custom?: Record<string, unknown> };
};

type MessageStatus =
  | { readonly type: "running" }
  | { readonly type: "requires-action"; readonly reason: "tool-calls" | "interrupt" }
  | { readonly type: "complete"; readonly reason: "stop" | "unknown" }
  | { readonly type: "incomplete";
      readonly reason: "cancelled" | "tool-calls" | "length" | "content-filter" | "other" | "error" };
```

`ExternalStoreAdapter<T>` = `ExternalStoreAdapterBase<T> & (T extends ThreadMessage ? object : { convertMessage: (m: T, idx: number) => ThreadMessageLike })`。
**`T = ThreadMessageLike` 时 `convertMessage` 必填** —— 本计划传恒等函数。

## 文件结构

| 文件 | 职责 | Task |
|---|---|---|
| `src/renderer/src/aui/toThreadMessages.ts` | 纯函数：`SessionEvent[]` + 直播缓冲 → `ThreadMessageLike[]` | 1–3 |
| `src/renderer/src/aui/ottoAdapter.ts` | 纯函数：状态 + 动作 → `ExternalStoreAdapter<ThreadMessageLike>` | 4 |
| `src/renderer/src/aui/useOttoRuntime.ts` | React hook：订阅 Zustand，调上面两个纯函数 | 4 |
| `src/renderer/src/aui/AuiProvider.tsx` | `AssistantRuntimeProvider` 壳 | 4 |
| `src/renderer/src/components/ui/*`（registry 生成） | thread / reasoning / streamdown / 依赖的 shadcn 件 | 5 |
| `src/renderer/src/aui/OttoThread.tsx` | Thread 组装 + 各 part 的 override | 6 |
| `src/renderer/src/App.tsx` | 换掉 `ThreadViewport` + `items.map` 那一段 | 7 |
| `src/renderer/src/app.css` | 删 hljs 配色段，加 streamdown 的 `@source` | 7 |
| `tests/renderer/toThreadMessages.test.ts` | 主战场 | 1–3 |
| `tests/renderer/ottoAdapter.test.ts` | adapter 字段取舍 | 4 |

---

### Task 1: 装依赖 + `toThreadMessages` 骨架（user / assistant 文本）

**Files:**
- Modify: `package.json`
- Create: `src/renderer/src/aui/toThreadMessages.ts`
- Test: `tests/renderer/toThreadMessages.test.ts`

**Interfaces:**
- Consumes: `SessionEvent` from `src/session/events.ts`（已存在，不改）
- Produces: `export function toThreadMessages(events: SessionEvent[], live?: LiveBuffer): ThreadMessageLike[]`，其中 `export interface LiveBuffer { content: string; reasoning: string }`

- [ ] **Step 1: 装 runtime 依赖**

```bash
npm install @assistant-ui/react@^0.15.15
```

- [ ] **Step 2: 补回 node-pty 执行位，确认门禁没被装崩**

Run: `node scripts/fix-pty-perms.mjs && npm test`
Expected: PASS，939/939。npm 解包抹掉了 `spawn-helper` 的执行位，不补的话
`tests/world/localWorldTerminal.test.ts` 会以 `posix_spawnp failed` 挂 3 条 ——
环境问题，不是新依赖的问题。

- [ ] **Step 3: 写失败的测试**

创建 `tests/renderer/toThreadMessages.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造事件的小工具：seq 自增，ts 固定（时间不参与本文件任何断言） */
function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("toThreadMessages — 骨架", () => {
  it("session_created 不产生消息", () => {
    const events = [ev({ type: "session_created" }, 0)];
    expect(toThreadMessages(events)).toEqual([]);
  });

  it("user_message 变成 user 角色的 text part", () => {
    const events = [
      ev({ type: "session_created" }, 0),
      ev({ type: "user_message", content: "你好" }, 1),
    ];
    expect(toThreadMessages(events)).toEqual([
      {
        role: "user",
        id: "1",
        createdAt: new Date(1001),
        content: [{ type: "text", text: "你好" }],
      },
    ]);
  });

  it("assistant_message 变成 assistant 角色，status 为 complete", () => {
    const events = [
      ev({ type: "user_message", content: "在吗" }, 0),
      ev({ type: "assistant_message", content: "在", model: "deepseek-chat" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out[1]).toEqual({
      role: "assistant",
      id: "1",
      createdAt: new Date(1001),
      status: { type: "complete", reason: "stop" },
      content: [{ type: "text", text: "在" }],
    });
  });

  it("content 是空串的 assistant_message 不产生 text part（纯工具调用的常态）", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([]);
  });

  it("直播缓冲追加成一条 running 的 assistant 消息", () => {
    const events = [ev({ type: "user_message", content: "算一下" }, 0)];
    const out = toThreadMessages(events, { content: "正在算", reasoning: "" });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      role: "assistant",
      id: "live",
      status: { type: "running" },
      content: [{ type: "text", text: "正在算" }],
    });
  });

  it("直播缓冲全空时不造空消息", () => {
    const events = [ev({ type: "user_message", content: "算一下" }, 0)];
    expect(toThreadMessages(events, { content: "", reasoning: "" })).toHaveLength(1);
  });
});
```

- [ ] **Step 4: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: FAIL —— `Failed to resolve import ".../aui/toThreadMessages.js"`

- [ ] **Step 5: 写最小实现**

创建 `src/renderer/src/aui/toThreadMessages.ts`：

```ts
// 事件日志 → assistant-ui 消息的投影。
//
// 和 src/session/deriveMessages.ts 同性质:都是从 append-only 日志推导的只读
// 投影,一个喂模型,一个喂 UI。硬规则「任何投影必须可从日志推导」在这条线上。
//
// 纯函数不碰 React:边界情况(悬空调用、被拒、compact 断层)全靠单测逼,
// 不靠肉眼在界面上找。

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "../../../session/events.js";

/** 流式直播缓冲(store.streamingBySession 的一项)。事件未落盘前的预览 */
export interface LiveBuffer {
  content: string;
  reasoning: string;
}

/** assistant-ui 的 content part 联合(只取本仓用得到的那几支) */
type Part = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

export function toThreadMessages(
  events: SessionEvent[],
  live?: LiveBuffer
): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];

  for (const e of events) {
    if (e.type === "user_message") {
      const parts: Part[] = [];
      if (e.content.trim() !== "") parts.push({ type: "text", text: e.content });
      out.push({
        role: "user",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        content: parts,
      });
      continue;
    }

    if (e.type === "assistant_message") {
      const parts: Part[] = [];
      if (e.content !== "") parts.push({ type: "text", text: e.content });
      out.push({
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: { type: "complete", reason: "stop" },
        content: parts,
      });
      continue;
    }
  }

  if (live !== undefined && (live.content !== "" || live.reasoning !== "")) {
    const parts: Part[] = [];
    if (live.content !== "") parts.push({ type: "text", text: live.content });
    out.push({
      role: "assistant",
      id: "live",
      status: { type: "running" },
      content: parts,
    });
  }

  return out;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: PASS（6 条全绿）

- [ ] **Step 7: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add package.json package-lock.json src/renderer/src/aui/toThreadMessages.ts tests/renderer/toThreadMessages.test.ts
git commit -m "$(cat <<'EOF'
feat(aui): 事件日志 → assistant-ui 消息的投影骨架

assistant-ui 的 runtime 想自己持有消息流,本仓硬规则是事件日志唯一事实来源。
接缝是 ExternalStoreRuntime —— 状态归本仓,这个纯函数只做格式翻译。
和 deriveMessages 同性质:一个喂模型,一个喂 UI,都从同一份日志推导。

先只处理文本:工具调用/思考/边界情况各自一个 commit,分开才验得动。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `toThreadMessages` 的工具调用与结果配对

**Files:**
- Modify: `src/renderer/src/aui/toThreadMessages.ts`
- Modify: `tests/renderer/toThreadMessages.test.ts`

**Interfaces:**
- Consumes: `buildToolIndex(events)` from `src/renderer/src/lib/toolIndex.ts`（已存在，签名 `(events: SessionEvent[]) => ToolIndex`，`ToolIndex = { results: ReadonlyMap<string, ToolResultEvent>; starts: ReadonlyMap<string, ToolExecutionStartedEvent> }`）
- Produces: `toThreadMessages` 输出的 assistant 消息里出现 `{ type: "tool-call" }` part

**背景（实现者必读）：** 本仓 `assistant_message.toolCalls?: ToolCallRequest[]`，`ToolCallRequest = { id: string; name: string; args: unknown }`；结果是**独立事件** `ToolResultEvent = { toolCallId: string; status: "ok" | "error" | "denied"; output: string }`，靠 `toolCallId` 配对。assistant-ui 要求两者合并进同一个 `tool-call` part。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/renderer/toThreadMessages.test.ts`：

```ts
describe("toThreadMessages — 工具调用", () => {
  it("tool_result 合并进同一条消息的 tool-call part", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "文件内容" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "read_file",
        args: { path: "/a.txt" }, result: "文件内容" },
    ]);
  });

  it("被拒的调用 isError 为 true", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: { cmd: "rm -rf /" } }] }, 0),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "不行" }, 1),
      ev({ type: "tool_result", toolCallId: "c1", status: "denied", output: "用户拒绝:不行" }, 2),
    ];
    const part = toThreadMessages(events)[0]?.content?.[0];
    expect(part).toMatchObject({ type: "tool-call", isError: true, result: "用户拒绝:不行" });
  });

  it("出错的调用 isError 为 true", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "error", output: "命令不存在" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.content?.[0]).toMatchObject({ isError: true });
  });

  it("悬空调用(有请求无结果)不带 result,消息状态是 requires-action", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 0),
    ];
    const msg = toThreadMessages(events)[0]!;
    expect(msg.status).toEqual({ type: "requires-action", reason: "tool-calls" });
    expect(msg.content?.[0]).toEqual({ type: "tool-call", toolCallId: "c1", toolName: "bash", args: {} });
  });

  it("正文和工具调用同时出现时,text part 在前", () => {
    const events = [
      ev({ type: "assistant_message", content: "我看一下", model: "m",
           toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a" } }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 1),
    ];
    const parts = toThreadMessages(events)[0]?.content;
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[1]).toMatchObject({ type: "tool-call" });
  });

  it("args 不是对象时退回 argsText,不硬塞进 args", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: "坏日志:不是对象" }] }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content?.[0]).toEqual({
      type: "tool-call", toolCallId: "c1", toolName: "bash", argsText: '"坏日志:不是对象"',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: FAIL —— 6 条新用例全红（现有实现丢掉了 `toolCalls`）

- [ ] **Step 3: 写实现**

改 `src/renderer/src/aui/toThreadMessages.ts`。文件顶部补 import：

```ts
import { buildToolIndex } from "../lib/toolIndex.js";
import type { ToolCallRequest } from "../../../session/events.js";
import type { ToolIndex } from "../lib/toolIndex.js";
```

在 `toThreadMessages` 函数体第一行建索引：

```ts
  const index = buildToolIndex(events);
```

新增一个把单次调用翻成 part 的辅助函数（放在 `toThreadMessages` 之前）：

```ts
/** 一次工具调用 + 它的结果 → 一个 tool-call part。
    结果是独立事件(靠 toolCallId 配对),assistant-ui 要求合进同一个 part。
    args 只有是对象时才进 args 字段:坏日志里它可能是任意 JSON,
    硬塞会让下游按对象展开时炸,退回 argsText 是无损的降级 */
function toToolCallPart(call: ToolCallRequest, index: ToolIndex): Part {
  const result = index.results.get(call.id);
  const isObject =
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args);

  const base = isObject
    ? { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        args: call.args as Record<string, unknown> }
    : { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        argsText: JSON.stringify(call.args) };

  // exactOptionalPropertyTypes:没有结果时这两个键必须整个不出现,不能赋 undefined
  if (result === undefined) return base;
  return { ...base, result: result.output, isError: result.status !== "ok" };
}
```

把 `assistant_message` 分支整段换成：

```ts
    if (e.type === "assistant_message") {
      const parts: Part[] = [];
      if (e.content !== "") parts.push({ type: "text", text: e.content });
      for (const call of e.toolCalls ?? []) parts.push(toToolCallPart(call, index));

      // 有调用还没拿到结果 = 这条消息还在等世界回话(悬空调用,ADR-0005)
      const pending = (e.toolCalls ?? []).some((c) => !index.results.has(c.id));
      out.push({
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: pending
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "complete", reason: "stop" },
        content: parts,
      });
      continue;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: PASS（12 条全绿）

- [ ] **Step 5: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/aui/toThreadMessages.ts tests/renderer/toThreadMessages.test.ts
git commit -m "$(cat <<'EOF'
feat(aui): 工具调用与结果在投影里合并成一个 tool-call part

本仓日志里请求和结果是两条独立事件(靠 toolCallId 配对),assistant-ui 要求
它们是同一个 part。复用既有的 buildToolIndex,不再多扫一遍事件。

args 只在是对象时才进 args 字段:坏日志里它可能是任意 JSON,硬塞会让下游
按对象展开时炸;退回 argsText 是无损降级。悬空调用(有请求无结果)让整条
消息停在 requires-action —— 那正是它的真实状态,不是"完成了但没输出"。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `toThreadMessages` 的边界 —— 思考、compact、图片解析、中断

**Files:**
- Modify: `src/renderer/src/aui/toThreadMessages.ts`
- Modify: `tests/renderer/toThreadMessages.test.ts`

**Interfaces:**
- Produces: 消息 `metadata.custom` 上出现 `{ reasoningMs?: number }`；`context_compacted` 投成一条 `role: "system"` 消息

**背景（实现者必读）：**
- `assistant_message.reasoning?: string` = 思考正文，`reasoningMs?: number` = 纯思考耗时（ADR-0032）。**思考不进模型上下文**（塞回去 API 报 400），但要给人看 —— 所以进投影、进 `reasoning` part。
- `turn_ended.outcome` 为 `"aborted"` = 用户主动停止（ADR-0006），为 `"error"` = 暴死。
- **审计行**：`src/renderer/src/components/Timeline.tsx:160-235` 的 `EventRow` 现在渲染 8 类
  非对话行 —— `session_created` / `session_archived` / `session_renamed` / `model_changed` /
  `skill_invoked`（可折叠）/ `image_described`（可折叠）/ `approval_decision(denied)` /
  `turn_ended(error|aborted)`。它们**必须活下来**（spec：保留现有视觉），做法是投成
  `role: "system"` 消息，把原始事件挂在 `metadata.custom.otto` 上，由 Task 6 的
  SystemMessage override 直接喂回 `<EventRow>` 渲染。这样视觉一模一样，且不需要第二条渲染路径。
- 因此 `context_compacted` 和 `image_described` **不做特殊处理**，走审计行这条统一的路 ——
  和 `deriveMessages`（喂模型的那份，真做摘要替换、真把图片解析注进 user 消息）刻意不同：
  喂模型的必须替换（不然上下文白压），喂人的必须留着给人翻。
- `tool_result`、`tool_execution_started`、`approval_decision(approved)` 三类**不出审计行**：
  前两者已被 tool-call part 吸收，第三类是「正常放行」不是对话事实（免审模式下一长串
  「已批准」纯属噪音）。这份名单照抄 `EventRow` 里返回 `null` 的分支，别自己发明。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/renderer/toThreadMessages.test.ts`：

```ts
describe("toThreadMessages — 边界", () => {
  it("reasoning 变成 reasoning part,排在 text 之前", () => {
    const events = [
      ev({ type: "assistant_message", content: "答案是 4", reasoning: "2+2", model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([
      { type: "reasoning", text: "2+2" },
      { type: "text", text: "答案是 4" },
    ]);
  });

  it("reasoningMs 挂到 metadata.custom,不混进 content", () => {
    const events = [
      ev({ type: "assistant_message", content: "好", reasoning: "想", reasoningMs: 1200, model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.metadata).toEqual({ custom: { reasoningMs: 1200 } });
  });

  it("没有 reasoningMs 时不造 metadata 键", () => {
    const events = [ev({ type: "assistant_message", content: "好", model: "m" }, 0)];
    expect(toThreadMessages(events)[0]?.metadata).toBeUndefined();
  });

  it("直播期的思考也出 reasoning part,状态仍是 running", () => {
    const out = toThreadMessages([], { content: "", reasoning: "让我想想" });
    expect(out[0]).toEqual({
      role: "assistant", id: "live", status: { type: "running" },
      content: [{ type: "reasoning", text: "让我想想" }],
    });
  });

  it("审计事件投成 system 消息,原始事件挂在 metadata.custom.otto 上", () => {
    const compacted = ev({ type: "context_compacted", summary: "聊过天气", model: "m" }, 1);
    const events = [
      ev({ type: "user_message", content: "第一句" }, 0),
      compacted,
      ev({ type: "user_message", content: "第二句" }, 2),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]).toEqual({
      role: "system", id: "1", createdAt: new Date(1001),
      content: [], metadata: { custom: { otto: compacted } },
    });
    expect(out[2]?.role).toBe("user");
  });

  it("八类审计事件一个不漏", () => {
    const events = [
      ev({ type: "session_created" }, 0),
      ev({ type: "session_archived" }, 1),
      ev({ type: "session_renamed", title: "新名字" }, 2),
      ev({ type: "model_changed", provider: "deepseek", model: "deepseek-chat" }, 3),
      ev({ type: "skill_invoked", name: "tdd", content: "# TDD" }, 4),
      ev({ type: "image_described", content: "图里是只水獭", model: "v" }, 5),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "不行" }, 6),
      ev({ type: "context_compacted", summary: "摘要", model: "m" }, 7),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(8);
    expect(out.every((m) => m.role === "system")).toBe(true);
    expect(out.map((m) => (m.metadata?.custom?.["otto"] as { type: string }).type)).toEqual([
      "session_created", "session_archived", "session_renamed", "model_changed",
      "skill_invoked", "image_described", "approval_decision", "context_compacted",
    ]);
  });

  it("被吸收/无声的三类不出审计行", () => {
    const events = [
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 0),
      ev({ type: "tool_execution_started", toolCallId: "c1" }, 1),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }, 2),
    ];
    expect(toThreadMessages(events)).toEqual([]);
  });

  it("turn 被中断时,最后一条 assistant 消息标 cancelled,并额外出一条审计行", () => {
    const events = [
      ev({ type: "assistant_message", content: "写到一半", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "aborted" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toEqual({ type: "incomplete", reason: "cancelled" });
    expect(out[1]?.role).toBe("system");
  });

  it("turn 出错时,最后一条 assistant 消息标 error", () => {
    const events = [
      ev({ type: "assistant_message", content: "写到一半", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "error", error: "连接断了" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.status).toEqual({ type: "incomplete", reason: "error" });
  });

  it("turn 正常收工:不改状态,也不出审计行", () => {
    const events = [
      ev({ type: "assistant_message", content: "好了", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "completed" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("turn_ended 之前没有 assistant 消息时不炸,审计行照出", () => {
    const events = [ev({ type: "turn_ended", outcome: "aborted" }, 0)];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("system");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: FAIL —— 11 条新用例大部分红（`isAuditEvent` / `toAuditMessage` 还不存在）

- [ ] **Step 3: 写实现**

改 `src/renderer/src/aui/toThreadMessages.ts`。

3a. 在文件顶部（`toThreadMessages` 之前）加审计行的判定与构造：

```ts
/** 时间线上看得见的非对话事件 → 一条 system 消息,原始事件挂 metadata。
    渲染交给既有的 EventRow(Task 6 的 SystemMessage override) —— 视觉一模一样,
    且不需要第二条渲染路径。
    这份名单照抄 Timeline.tsx 里 EventRow 不返回 null 的那些分支:
    tool_result / tool_execution_started 已被 tool-call part 吸收,
    approval_decision(approved) 是正常放行不是对话事实(免审模式下全是噪音) */
function isAuditEvent(e: SessionEvent): boolean {
  switch (e.type) {
    case "session_created":
    case "session_archived":
    case "session_renamed":
    case "model_changed":
    case "skill_invoked":
    case "image_described":
    case "context_compacted":
      return true;
    case "approval_decision":
      return e.decision === "denied";
    case "turn_ended":
      return e.outcome !== "completed";
    default:
      return false;
  }
}

function toAuditMessage(e: SessionEvent): ThreadMessageLike {
  return {
    role: "system",
    id: String(e.seq),
    createdAt: new Date(e.ts),
    content: [],
    metadata: { custom: { otto: e } },
  };
}
```

3b. `user_message` 分支**不动**（图片解析不再并进来，它走审计行）。

3c. `assistant_message` 分支里，`parts` 组装改成 reasoning 在前：

```ts
      const parts: Part[] = [];
      if ((e.reasoning ?? "") !== "") parts.push({ type: "reasoning", text: e.reasoning! });
      if (e.content !== "") parts.push({ type: "text", text: e.content });
      for (const call of e.toolCalls ?? []) parts.push(toToolCallPart(call, index));
```

3d. `assistant_message` 分支的 `out.push` 改成带条件 metadata（`exactOptionalPropertyTypes` 不许赋 `undefined`）：

```ts
      const message: ThreadMessageLike = {
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: pending
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "complete", reason: "stop" },
        content: parts,
      };
      out.push(
        e.reasoningMs === undefined
          ? message
          : { ...message, metadata: { custom: { reasoningMs: e.reasoningMs } } }
      );
      continue;
```

3e. 在循环末尾（`assistant_message` 分支之后）加两段。

先是 `turn_ended` 的状态回改 —— 它必须排在审计行**之前**，因为它要找的是
「最后一条 assistant 消息」，审计行一旦先 push 进去不影响（只跳过非 assistant），
但顺序写反了读起来会让人以为在改自己：

```ts
    if (e.type === "turn_ended" && e.outcome !== "completed") {
      // 回头改最后一条 assistant 消息的状态:turn 的死法是那条消息的属性,
      // 不是一条独立的消息。aborted 是用户按的停(ADR-0006),不是故障。
      // 注意这里不 continue —— 它还要往下走,出一条审计行(现状就有那个 chip)
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m === undefined || m.role !== "assistant") continue;
        out[i] = {
          ...m,
          status: { type: "incomplete", reason: e.outcome === "aborted" ? "cancelled" : "error" },
        };
        break;
      }
    }

    if (isAuditEvent(e)) {
      out.push(toAuditMessage(e));
      continue;
    }
```

3f. 直播缓冲那段改成 reasoning 也出 part：

```ts
  if (live !== undefined && (live.content !== "" || live.reasoning !== "")) {
    const parts: Part[] = [];
    if (live.reasoning !== "") parts.push({ type: "reasoning", text: live.reasoning });
    if (live.content !== "") parts.push({ type: "text", text: live.content });
    out.push({ role: "assistant", id: "live", status: { type: "running" }, content: parts });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: PASS（23 条全绿）

若数目对不上，以「全绿」为准，别去凑数字。

- [ ] **Step 5: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/aui/toThreadMessages.ts tests/renderer/toThreadMessages.test.ts
git commit -m "$(cat <<'EOF'
feat(aui): 投影补齐思考/compact/图片解析/中断四类边界

思考进 reasoning part:它不能塞回模型上下文(API 报 400),但要给人看——
logged ≠ model-visible,投影层是这条规矩的执行点。reasoningMs 走 metadata,
不混进 content:它是消息的属性,不是消息的内容。

八类审计行(会话创建/归档/改名、模型切换、skill 注入、图片解析、审批拒绝、
turn 暴死或中断)投成 role:"system" 消息,原始事件挂 metadata.custom.otto,
渲染交给既有的 EventRow —— 视觉一模一样,且不需要第二条渲染路径。
compact 和图片解析走同一条路,不做特殊处理:和 deriveMessages 刻意分岔,
喂模型的那份必须真替换/真注入,喂人的这份必须留着给人翻。

turn_ended 双重职责:既回头改最后一条 assistant 消息的状态(turn 的死法是那条
消息的属性),也出审计行(现状就有那个 chip)。aborted 是用户按的停,不是故障。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: adapter + runtime hook + Provider

**Files:**
- Create: `src/renderer/src/aui/ottoAdapter.ts`
- Create: `src/renderer/src/aui/useOttoRuntime.ts`
- Create: `src/renderer/src/aui/AuiProvider.tsx`
- Test: `tests/renderer/ottoAdapter.test.ts`

**Interfaces:**
- Consumes: `toThreadMessages`、`LiveBuffer`（Task 1–3）
- Produces:
  - `export interface OttoAdapterInput { events: SessionEvent[]; live: LiveBuffer | undefined; isRunning: boolean; send: (text: string) => Promise<void>; cancel: () => Promise<void>; retry: () => Promise<void> }`
  - `export function buildOttoAdapter(input: OttoAdapterInput): ExternalStoreAdapter<ThreadMessageLike>`
  - `export function useOttoRuntime(): AssistantRuntime`
  - `export function AuiProvider({ children }: { children: ReactNode }): JSX.Element`

**背景（实现者必读）：** store 里相关字段 —— `events: SessionEvent[]`、`streamingBySession: Record<string, { content: string; reasoning: string }>`、`statusBySession: Record<string, TurnStatus>`、`sessionId: string`。发消息 / 中断 / 重试的现成动作在 `src/renderer/src/store.ts` 上，实现前先 `grep -n "send\|abort\|interrupt\|retry" src/renderer/src/store.ts` 找准名字，**不要臆造**。

- [ ] **Step 1: 写失败的测试**

创建 `tests/renderer/ottoAdapter.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { buildOttoAdapter } from "../../src/renderer/src/aui/ottoAdapter.js";
import type { SessionEvent } from "../../src/session/events.js";

const events: SessionEvent[] = [
  { type: "user_message", content: "你好", sessionId: "s1", ts: 1000, seq: 0 },
];

function input(over: Partial<Parameters<typeof buildOttoAdapter>[0]> = {}) {
  return {
    events,
    live: undefined,
    isRunning: false,
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    ...over,
  };
}

describe("buildOttoAdapter", () => {
  it("messages 是投影结果,convertMessage 是恒等", () => {
    const a = buildOttoAdapter(input());
    expect(a.messages).toHaveLength(1);
    const m = a.messages![0]!;
    expect(a.convertMessage!(m, 0)).toBe(m);
  });

  it("刻意不提供 onEdit / setMessages —— 本仓没有消息编辑和对话分支", () => {
    const a = buildOttoAdapter(input());
    expect(a.onEdit).toBeUndefined();
    expect(a.setMessages).toBeUndefined();
  });

  it("isRunning 直接透传", () => {
    expect(buildOttoAdapter(input({ isRunning: true })).isRunning).toBe(true);
  });

  it("onNew 把纯文本消息交给 send", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [{ type: "text", text: "在吗" }] } as never);
    expect(send).toHaveBeenCalledWith("在吗");
  });

  it("onNew 把多个 text part 拼起来再发", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ] } as never);
    expect(send).toHaveBeenCalledWith("第一段\n第二段");
  });

  it("onNew 忽略非 text part —— 附件走 PR2 的通道,不从这里偷渡", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [
      { type: "image", image: "data:image/png;base64,xx" },
      { type: "text", text: "看图" },
    ] } as never);
    expect(send).toHaveBeenCalledWith("看图");
  });

  it("onCancel / onReload 接到对应动作", async () => {
    const cancel = vi.fn(async () => {});
    const retry = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ cancel, retry }));
    await a.onCancel!();
    await a.onReload!(null, {} as never);
    expect(cancel).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/ottoAdapter.test.ts`
Expected: FAIL —— `Failed to resolve import ".../aui/ottoAdapter.js"`

- [ ] **Step 3: 写 adapter**

创建 `src/renderer/src/aui/ottoAdapter.ts`：

```ts
// ExternalStoreAdapter 的组装 —— 纯函数,不碰 React。
//
// 为什么单独一个文件:adapter 的字段取舍是有法理的决定(见下),不是接线细节,
// 该能被单测钉住;混在 hook 里就只能靠肉眼看。

import type { ExternalStoreAdapter, ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "../../../session/events.js";
import { toThreadMessages, type LiveBuffer } from "./toThreadMessages.js";

export interface OttoAdapterInput {
  events: SessionEvent[];
  live: LiveBuffer | undefined;
  isRunning: boolean;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
}

/** AppendMessage.content 里挑出文本。附件不从这条路走 ——
    它有自己的通道(AttachmentAdapter,PR2),从这里偷渡会绕开附件库 */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}

export function buildOttoAdapter(input: OttoAdapterInput): ExternalStoreAdapter<ThreadMessageLike> {
  return {
    messages: toThreadMessages(input.events, input.live),
    // 类型上必填:ExternalStoreAdapter<T> 只在 T extends ThreadMessage 时才免掉它。
    // 上一行已经产出目标格式,所以这里是恒等
    convertMessage: (m) => m,
    isRunning: input.isRunning,
    onNew: async (message) => {
      await input.send(textOf(message.content as never));
    },
    onCancel: input.cancel,
    onReload: async () => {
      await input.retry();
    },
    // 刻意不给 onEdit / setMessages:本仓没有消息编辑,也没有对话分支。
    // 给了就等于凭空长出一条绕开事件日志的写路径 —— 硬规则不允许
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/ottoAdapter.test.ts`
Expected: PASS（7 条全绿）

- [ ] **Step 5: 查清 store 上动作的真实名字**

Run: `grep -n "sendMessage\|abort\|interrupt\|retry\|stopTurn" src/renderer/src/store.ts`
把查到的名字用在下一步，**不要用猜的**。

- [ ] **Step 6: 写 hook 和 Provider**

创建 `src/renderer/src/aui/useOttoRuntime.ts`（下面 `useChat` 的取值名按上一步查到的实际名字改）：

```ts
// 把 Zustand 里的会话状态接到 assistant-ui 的 runtime 上。
// 只做订阅和转交:所有判断都在 buildOttoAdapter / toThreadMessages 那两个纯函数里

import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useChat } from "../store.js";
import { buildOttoAdapter } from "./ottoAdapter.js";

export function useOttoRuntime() {
  const sessionId = useChat((s) => s.sessionId);
  const events = useChat((s) => s.events);
  const live = useChat((s) => s.streamingBySession[s.sessionId]);
  const status = useChat((s) => s.statusBySession[s.sessionId]);

  // 动作从 store 上直接取(它们是稳定引用,不进依赖数组)
  const send = useChat((s) => s.send);
  const cancel = useChat((s) => s.abortTurn);
  const retry = useChat((s) => s.retry);

  void sessionId; // 换会话时 events/live 自然变,这里只是让意图显式

  return useExternalStoreRuntime(
    buildOttoAdapter({ events, live, isRunning: status === "running", send, cancel, retry })
  );
}
```

创建 `src/renderer/src/aui/AuiProvider.tsx`：

```tsx
// AssistantRuntimeProvider 的壳。单独成文件是为了让 App.tsx 只 import 一个名字

import type { ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useOttoRuntime } from "./useOttoRuntime.js";

export function AuiProvider({ children }: { children: ReactNode }) {
  const runtime = useOttoRuntime();
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无 `src/renderer/src/aui/` 相关报错。若 `useChat` 上的动作名对不上，回到 Step 5 改名。

- [ ] **Step 8: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/renderer/src/aui/ottoAdapter.ts src/renderer/src/aui/useOttoRuntime.ts src/renderer/src/aui/AuiProvider.tsx tests/renderer/ottoAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(aui): ExternalStoreRuntime 接缝立起来

adapter 单独成文件而不是塞进 hook:字段取舍是有法理的决定,该能被单测钉住。
刻意不给 onEdit / setMessages —— 本仓没有消息编辑也没有对话分支,给了就等于
凭空长出一条绕开事件日志的写路径。onNew 只取 text part,附件走自己的通道
(AttachmentAdapter,PR2),从这里偷渡会绕开附件库。

本 commit 只立接缝,还没有人用它渲染;换渲染在后面的 commit。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: registry 装组件 + 主题改写

**Files:**
- Modify: `package.json`
- Create（registry 生成）: `src/renderer/src/components/ui/thread.tsx`、`reasoning.tsx`、`tool-fallback.tsx` 及其拉进来的 shadcn 依赖件
- Modify: `src/renderer/src/app.css`

**Interfaces:**
- Produces: 可从 `@/components/ui/thread.js` import 的 `Thread`；从 `@/components/ui/reasoning.js` import 的 `ReasoningRoot` / `ReasoningTrigger` / `ReasoningContent` / `ReasoningText`；从 `@/components/ui/tool-fallback.js` import 的 `ToolFallback`（复合件，另有 `.Root` / `.Trigger` / `.Content` / `.Args` / `.Result` / `.Error` / `.Approval` 子件）

**背景（实现者必读）：** registry 是 **copy-in 源码**，不是版本化依赖 —— 装完的文件归本仓所有，要进 diff 审查。它会尝试覆盖 `ui/button.tsx`、`ui/tooltip.tsx`，这两个本仓**已定制过**（`button.tsx` 的 `buttonVariants` 基类带 `transition-[...,opacity] duration-150`，被覆盖会让 `CopyButton` 的按压动效丢失）。

- [ ] **Step 1: 装 streamdown 依赖**

```bash
npm install @assistant-ui/react-streamdown streamdown @streamdown/code @streamdown/cjk
```

`@streamdown/cjk` 不是可选项：本仓界面和内容都是中文，CJK 断行插件缺了排版会散。

装完立刻跑 `node scripts/fix-pty-perms.mjs`（见 Global Constraints）。

- [ ] **Step 2: 备份会被覆盖的两个定制件**

```bash
cp src/renderer/src/components/ui/button.tsx /tmp/otto-button.bak.tsx
cp src/renderer/src/components/ui/tooltip.tsx /tmp/otto-tooltip.bak.tsx
```

- [ ] **Step 3: 装 registry 组件**

```bash
npx shadcn@latest add @assistant-ui/thread @assistant-ui/reasoning @assistant-ui/tool-fallback
```

- [ ] **Step 4: 审覆盖，逐个把定制找回来**

Run: `git status --short && git diff src/renderer/src/components/ui/button.tsx src/renderer/src/components/ui/tooltip.tsx`

对 `button.tsx` / `tooltip.tsx`：若 registry 覆盖了它们，用备份还原，只手工补进 assistant-ui 真正需要的新 variant：

```bash
cp /tmp/otto-button.bak.tsx src/renderer/src/components/ui/button.tsx
cp /tmp/otto-tooltip.bak.tsx src/renderer/src/components/ui/tooltip.tsx
```

- [ ] **Step 5: 把生成组件的配色改成本仓 token**

打开 `src/renderer/src/components/ui/thread.tsx`、`reasoning.tsx`、`tool-fallback.tsx`，把裸色值和非本仓 token 换成 `app.css` 里已有的那套：`bg-background` / `text-foreground` / `bg-card` / `text-muted-foreground` / `border-border` / `bg-primary` / `text-primary-foreground` / `bg-muted`。

用户气泡的形状要和现状一致（`src/renderer/src/components/Timeline.tsx` 的 `user_message` 分支）：

```
rounded-[12px_12px_2px_12px] px-3 py-2 bg-primary text-primary-foreground
```

- [ ] **Step 6: 引入 streamdown 的样式**

`streamdown@2.5.0` 自带一份样式表（`package.json` 的 `exports` 里有 `"./styles.css"`，
内容是 `sd-fadeIn` 等流式动画的 keyframes —— Tailwind 的 `@source` 扫不出来，必须真 import）。

在 `src/renderer/src/app.css` 的 `@import "tailwindcss";` **之后**加：

```css
@import "streamdown/styles.css";
@source "../../../node_modules/streamdown/dist";
```

`@source` 那行管的是另一件事：让 Tailwind v4 扫到 streamdown 组件里用的 utility 类名，
不然那些类不会被生成。两行都要，缺一样症状不同（缺 import = 流式动画没了，
缺 @source = 排版塌）。

- [ ] **Step 7: 构建确认没炸**

Run: `npm run build`
Expected: 三个目标（main / preload / renderer）都成功。**这一步会真的暴露 base-ui 与 react 19 的解析问题**，比 tsc 更靠谱。

- [ ] **Step 8: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): 装 assistant-ui 的 thread/reasoning/streamdown,配色改回本仓 token

registry 是 copy-in 源码不是版本化依赖:装完的文件归本仓所有,所以要进 diff
审查,升级也只能是主动动作。button/tooltip 被覆盖后已还原成定制版——
buttonVariants 基类那条 transition 丢了的话,CopyButton 的按压动效跟着没。

@streamdown/cjk 不是可选项:本仓界面和内容都是中文,缺了断行排版会散。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Thread 组装与 part override

**Files:**
- Create: `src/renderer/src/aui/OttoThread.tsx`
- Create: `src/renderer/src/components/ToolLiveTail.tsx`
- Modify: `src/renderer/src/components/Timeline.tsx`（`ToolRow` 里的直播尾巴改用抽出来的组件，观感不变）

**Interfaces:**
- Consumes: `Thread` / `Reasoning*` / `ToolFallback`（Task 5 装的）、`EventRow`（`src/renderer/src/components/Timeline.tsx`，已存在，不改）
- Produces: `export function OttoThread(): JSX.Element`、`export function ToolLiveTail(props: { toolCallId: string; done: boolean }): JSX.Element | null`

**背景（实现者必读）：** 现有工具行的视觉（折叠摘要行、执行中的直播尾巴、参数/输出详情面板）在 `src/renderer/src/components/Timeline.tsx` 的 `ToolRow`，成组折叠在 `ToolGroup.tsx`。**这两个不重写** —— 它们就是「保留 Mr Otto 现有视觉」这条决定的落点，只是改从 assistant-ui 的 `tool-call` part 拿数据。

**工具行用 assistant-ui 的 `ToolFallback`**（用户决定），不是本仓的 `ToolRow`。但 `ToolFallback` 没有「执行中的输出直播尾巴」这个概念，而本仓的 bash 工具靠它看进度 —— 这个能力**必须接回去**，否则跑长命令时界面上什么都看不到。

直播尾巴的实现现在埋在 `ToolRow` 里（`src/renderer/src/components/Timeline.tsx:29-38, 71-79`）：按 `toolCallId` 订阅 `store.toolOutputByCall`，新碎片到就滚到底，`tool_result` 落地后 store 清掉这个 key，它自然消失。本 task 把这块抽成独立组件，`ToolRow` 和新的 `ToolFallback` 组合各用各的 —— `ToolRow` 的行为一字不变（它还被 `EventRow` 间接留着）。

八类审计行同理：Task 3 已把原始事件投进 `metadata.custom.otto`，这里的 `SystemMessage` override 直接把它喂回 `EventRow`，**`EventRow` 一行不改**。

- [ ] **Step 1: 把直播尾巴抽成独立组件**

Run: `sed -n 25,90p src/renderer/src/components/Timeline.tsx`
找到 `ToolRow` 里 `const live = useChat(...)`、`liveRef`、`useEffect` 滚到底、以及 `{!result && live && (<pre ...>)}` 这几块。

创建 `src/renderer/src/components/ToolLiveTail.tsx`，把它们原样搬过来：

```tsx
// 执行中的输出直播尾巴 —— 迷你终端视角:只看最新进展。
//
// 从 ToolRow 抽出来:assistant-ui 的 ToolFallback 没有「执行中的输出」这个概念,
// 而 bash 跑长命令时这条尾巴是唯一的进度信号。抽出来两边共用,行为一字不变。
//
// tool_result 落地后 store 会清掉这个 key,组件自然消失——
// 直播只活在「事实到来前」的那个窗口里。

import { useEffect, useRef } from "react";
import { useChat } from "../store.js";

export function ToolLiveTail({ toolCallId, done }: { toolCallId: string; done: boolean }) {
  const live = useChat((s) => s.toolOutputByCall[toolCallId]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // 终端语义:始终看最新输出,新碎片到就滚到底
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [live]);

  if (done || live === undefined || live === "") return null;
  return (
    <pre
      className="mt-[2px] mb-1 px-[10px] py-2 max-h-40 overflow-y-auto bg-muted border border-border rounded-lg font-mono text-xs leading-normal text-muted-foreground whitespace-pre-wrap break-all transition-opacity duration-150 ease-strong starting:opacity-0"
      ref={ref}
    >
      {live}
    </pre>
  );
}
```

再改 `Timeline.tsx` 的 `ToolRow`：删掉 `live` / `liveRef` / 那个 `useEffect` / 那段 `<pre>`，换成 `<ToolLiveTail toolCallId={call.id} done={result !== undefined} />`。**观感必须一字不变** —— 这是纯搬家，不是重设计。

- [ ] **Step 2: 写 OttoThread**

创建 `src/renderer/src/aui/OttoThread.tsx`：

```tsx
// Thread 的组装 —— assistant-ui 出骨架,各 part 的皮全是本仓既有组件。
//
// 「保留 Mr Otto 现有视觉,只换底层」这条决定的落点就在这个文件:
// ToolRow / ToolGroup / UserAttachments 一行没重写,只是改从 part 拿数据。

import { MessagePrimitive, ThreadPrimitive, useMessage } from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
// 具名导出,不是默认导出(实测 @streamdown/code@1.1.1 / @streamdown/cjk@1.0.3 的 .d.ts)
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { EventRow } from "../components/Timeline.js";
import { ToolLiveTail } from "../components/ToolLiveTail.js";
import { ToolFallback } from "../components/ui/tool-fallback.js";
import type { SessionEvent } from "../../../session/events.js";
import {
  ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger,
} from "../components/ui/reasoning.js";

const PLUGINS = { code, cjk };

export function OttoThread() {
  return (
    <ThreadPrimitive.Root className="flex-1 min-h-0 flex flex-col">
      <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 px-5 py-4">
        <ThreadPrimitive.Messages
          components={{
            UserMessage: () => (
              <MessagePrimitive.Root className="max-w-[76%] self-end flex flex-col items-end gap-[6px]">
                <MessagePrimitive.Parts
                  components={{
                    Text: () => (
                      <div className="max-w-full whitespace-pre-wrap break-words bg-primary text-primary-foreground rounded-[12px_12px_2px_12px] px-3 py-2">
                        <MessagePrimitive.Content />
                      </div>
                    ),
                  }}
                />
              </MessagePrimitive.Root>
            ),
            // 审计行:原始事件挂在 metadata.custom.otto 上(Task 3 的投影),
            // 直接喂回既有的 EventRow —— 视觉与迁移前一模一样,零重写
            SystemMessage: () => {
              const event = useMessage((m) => m.metadata?.custom?.["otto"]) as
                | SessionEvent
                | undefined;
              if (event === undefined) return null;
              return <EventRow event={event} />;
            },
            AssistantMessage: () => (
              <MessagePrimitive.Root className="max-w-[76%] self-start">
                <MessagePrimitive.Parts
                  components={{
                    Text: () => (
                      <div className="md self-stretch max-w-full py-[2px]">
                        <StreamdownTextPrimitive plugins={PLUGINS} />
                      </div>
                    ),
                    Reasoning: ({ text, status }) => (
                      <ReasoningRoot variant="ghost" streaming={status?.type === "running"}>
                        <ReasoningTrigger active={status?.type === "running"}>思考</ReasoningTrigger>
                        <ReasoningContent>
                          <ReasoningText>{text}</ReasoningText>
                        </ReasoningContent>
                      </ReasoningRoot>
                    ),
                    // 工具行走 assistant-ui 的 ToolFallback,外挂一条直播尾巴——
                    // ToolFallback 没有「执行中的输出」这个概念,而 bash 跑长命令时
                    // 那条尾巴是唯一的进度信号
                    tools: {
                      Fallback: (part) => (
                        <>
                          <ToolFallback {...part} />
                          <ToolLiveTail
                            toolCallId={part.toolCallId ?? part.toolName}
                            done={part.result !== undefined}
                          />
                        </>
                      ),
                    },
                  }}
                />
              </MessagePrimitive.Root>
            ),
          }}
        />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
```

- [ ] **Step 3: 对着装出来的源码校正 API**

上一步用到的名字全部来自 assistant-ui 文档，而 registry 是 copy-in 源码 —— **仓里那份才是事实**。两处都要核：

Run: `grep -n "components=\|Fallback\|SystemMessage\|MessagePrimitive.Parts\|ThreadPrimitive.Messages" src/renderer/src/components/ui/thread.tsx`
核 `components` 的键名（`UserMessage` / `AssistantMessage` / `SystemMessage` / `Text` / `Reasoning` / `tools.Fallback`）。

Run: `grep -n "^export" src/renderer/src/components/ui/reasoning.tsx src/renderer/src/components/ui/tool-fallback.tsx`
核 `ReasoningRoot` / `ReasoningTrigger` / `ReasoningContent` / `ReasoningText` 四个导出名，以及 `ToolFallback` 的导出形态和它接受的 props —— 上一步是按「复合件直接吃 part」写的，若生成的源码要求手工组装 `.Root`/`.Trigger`/`.Content`/`.Args`/`.Result`/`.Error`，就照它的写法改。

按查到的实际写法改上一步的代码。名字对不上就改代码，不要改生成的文件。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无 `OttoThread.tsx` 相关报错

- [ ] **Step 5: 构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 6: 跑全量门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/aui/OttoThread.tsx
git commit -m "$(cat <<'EOF'
feat(aui): Thread 组装完成,工具行走 ToolFallback + 外挂直播尾巴

工具行按用户决定改用 assistant-ui 的 ToolFallback。但它没有「执行中的输出」
这个概念,而 bash 跑长命令时那条直播尾巴是唯一的进度信号——所以从 ToolRow
里抽成 ToolLiveTail 外挂上去,ToolRow 那边观感一字不变(纯搬家)。

八类审计行走 SystemMessage override 喂回既有的 EventRow,一行没重写。

components 键名以装出来的 thread.tsx 为准,不以文档为准:registry 是
copy-in 源码,仓里那份才是事实。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 接进 App.tsx，卸掉旧渲染栈

**Files:**
- Modify: `src/renderer/src/App.tsx:2091-2140`（`ThreadViewport` 那一整段）
- Modify: `src/renderer/src/components/Timeline.tsx`（换 Markdown 实现）
- Modify: `src/renderer/src/components/CodeBlock.tsx`（删 `MD_COMPONENTS`，保留 `CopyButton` 的用法说明）
- Modify: `src/renderer/src/app.css`（删 hljs 配色段）
- Modify: `package.json`（卸 react-markdown / remark-gfm / rehype-highlight / highlight.js）

**Interfaces:**
- Consumes: `AuiProvider`（Task 4）、`OttoThread`（Task 6）

**背景（实现者必读）：** `ThreadViewport` 现在承担贴底滚动（`src/renderer/src/lib/stickToBottom.ts`，有测试 `tests/renderer/stickToBottom.test.ts`）。assistant-ui 的 `ThreadPrimitive.Viewport` **自带** auto-scroll。`ThreadViewport` 和 `stickToBottom.ts` 在本 PR 后仍被回放视图用着 —— **先确认再删**，不确认就留着。

`items.map` 整段删掉是对的，**不留双渲染路径**：`EventRow` 的 8 类审计分支已经由 Task 3 投成 system 消息、Task 6 的 override 喂回 `EventRow` 渲染，视觉不丢。`EventRow` 里 `user_message` / `assistant_message` 两个分支从此走不到（它们归 `OttoThread`），但**不要删** —— 留着不碍事，删了要动 `EventRow` 的结构，那是 PR2 的活。

- [ ] **Step 1: 确认 ThreadViewport / stickToBottom 还有谁在用**

Run: `grep -rn "ThreadViewport\|stickToBottom" src/ tests/`
把结果记下来。只在下一步删掉确实没人用的东西。

- [ ] **Step 2: 换 App.tsx 的渲染段**

把 `src/renderer/src/App.tsx` 里 `<ThreadViewport ...>` 到 `</ThreadViewport>` 整段（约 2091–2140 行）换成：

```tsx
          <AuiProvider>
            <OttoThread />
          </AuiProvider>
```

`error` 行、`streamingThinking`、`streamingText`、`Marker` 那几块**一并删掉** —— 它们的职责已经进了投影：
- `streamingText` / `streamingThinking` → `toThreadMessages` 的 live 分支
- turn 失败 → 投影里的 `incomplete` 状态

`ApprovalCard` / `QuestionnaireCard` **保持原位不动**：它们是挂起中的活控制件，不是消息。

顶部补 import：

```ts
import { AuiProvider } from "./aui/AuiProvider.js";
import { OttoThread } from "./aui/OttoThread.js";
```

- [ ] **Step 3: 换掉 Timeline.tsx 里的 Markdown**

`src/renderer/src/components/Timeline.tsx` 里 `EventRow` 的 `assistant_message` 分支不再走消息主路径（它归 `OttoThread` 了），但**其余分支仍在用 Markdown**。把这四行 import：

```ts
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { MD_COMPONENTS } from "./CodeBlock.js";
```

换成：

```ts
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";

const MD_PLUGINS = { code, cjk };
```

并把每处 `<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS}>{x}</Markdown>` 换成 `<Streamdown plugins={MD_PLUGINS}>{x}</Streamdown>`。

Run: `grep -n "Markdown" src/renderer/src/components/Timeline.tsx src/renderer/src/App.tsx`
确认一处不剩。

- [ ] **Step 4: 删 app.css 里的 hljs 段**

Run: `grep -n "hljs" src/renderer/src/app.css`
把查到的那整段配色规则删掉（Shiki 自带主题，不吃这套 class）。`.hl`（自研高亮器，工具详情面板 `TOOL_PRE` 在用）**不要删**。

- [ ] **Step 5: 卸旧依赖**

```bash
npm uninstall react-markdown remark-gfm rehype-highlight highlight.js
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 都成功。有残留 import 会在这里炸出来。

- [ ] **Step 7: 跑全量门禁**

Run: `npm test`
Expected: PASS。`tests/renderer/stickToBottom.test.ts` 若因 Step 1 的删除而失效，**回到 Step 1** —— 那说明删多了。

- [ ] **Step 8: 真机看一眼**

```bash
npm run dev
```

肉眼确认四件事：① 历史消息渲染正常、代码块有高亮 ② 流式输出时文字连续增长、不闪 ③ 思考区能折叠、流式中是展开的 ④ 工具行的折叠/展开/直播尾巴和迁移前一致。

发现的视觉出入**记进 issue #123**（视觉验收欠账总账），不在本 PR 里追。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): 会话区输出侧切到 assistant-ui,卸掉 react-markdown/highlight.js

streamingText / streamingThinking / turn 失败行这几块从 App.tsx 消失不是
删功能:它们的职责进了 toThreadMessages —— 直播缓冲成 live 消息,turn 的死法
成消息状态。UI 不再自己拼这些,它只渲染投影。

ApprovalCard / QuestionnaireCard 留在原位:它们是挂起中的活控制件,不是消息,
藏了 agent 就卡死。

items.map 整段删掉,不留双渲染路径:八类审计行已经由投影 + SystemMessage
override 喂回同一个 EventRow 渲染,视觉不丢。EventRow 的 user/assistant 两个
分支从此走不到,但没删——删要动它的结构,那是 PR2 的活。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 补 ADR，开 PR

**Files:**
- Create: `docs/adr/00NN-assistant-ui-external-store.md`
- Create: `docs/adr/00NN-base-ui-and-radix-coexist.md`

- [ ] **Step 1: 定编号**

Run: `ls docs/adr/ | sort | tail -5`
`docs/adr/` 历史上有过重号（0014、0031 各两份）。取**当前最大编号 +1、+2**，别照抄 spec 里写的 0034/0035。

- [ ] **Step 2: 写第一份 ADR**

创建 `docs/adr/00NN-assistant-ui-external-store.md`（`00NN` 换成 Step 1 定的号）：

```markdown
# assistant-ui 走 ExternalStoreRuntime —— 投影，不是第二个事实来源

## 背景

会话区要接 assistant-ui 的 12 项组件。但 assistant-ui 是完整框架：`Thread`
必须包在 `AssistantRuntimeProvider` 里，它的 runtime 想自己持有消息流。
本仓硬规则是「append-only 事件日志是唯一事实来源」。两者直接对撞。

## 决定

用 `useExternalStoreRuntime`：状态归本仓所有，adapter 只做格式翻译。

- `messages` = 纯函数 `toThreadMessages(events, live)` 的结果，事件日志的只读投影
- 写入方向（`onNew` / `onCancel` / `onReload`）全部回原有 ShellBridge 路径
- **刻意不提供 `onEdit` / `setMessages`**

## 理由

`toThreadMessages` 与 `src/session/deriveMessages.ts` 同性质：都是从同一份日志
推导的只读投影，一个喂模型、一个喂 UI。硬规则「任何投影必须可从日志推导」
在这条线上成立。

不给 `onEdit` / `setMessages`，是因为本仓没有消息编辑、也没有对话分支。
给了就等于凭空长出一条绕开事件日志的写路径 —— 那才是真正违反硬规则的地方，
而不是「引入了一个第三方 runtime」本身。

## 代价

`ExternalStoreAdapter<T>` 在 `T = ThreadMessageLike` 时强制要求 `convertMessage`
（类型定义：`T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>`），
本仓传恒等函数。这是纯粹的类型仪式，无运行时成本。

投影不做 compact 的历史替换（`deriveMessages` 做）：喂模型的那份必须真替换，
喂人的这份必须留着给人翻。两份投影**刻意不同**，改其中一份时别顺手对齐另一份。

## 什么前提倒了会推翻它

本仓开始支持消息编辑或对话分支。那时 `setMessages` 就不再是「绕开日志的
写路径」，而是需要一套分支事件来支撑 —— 届时重开这个决定。
```

- [ ] **Step 3: 写第二份 ADR**

创建 `docs/adr/00NN-base-ui-and-radix-coexist.md`：

```markdown
# base-ui 与 radix 并存是刻意的

## 背景

assistant-ui 的组件依赖 `@base-ui/react`；本仓存量的 sidebar / dialog / select /
dropdown-menu 建在 `radix-ui` 上。迁移后两套 headless 库在同一个 bundle 里。

## 决定

并存。不在 assistant-ui 迁移里顺手把 radix 换掉。

## 理由

统一 headless 库是一次独立的重构：它要碰 sidebar（692 行）、questionnaire
（503 行）、dropdown-menu、select、sheet、drawer、dialog 全套，与「会话区接
assistant-ui」没有因果关系。塞进同一个 PR 会让两件事的失败混在一起，回滚时
只能整块扔。

## 代价

bundle 变大（两套 headless primitives）。Electron 桌面应用不走网络分发首屏，
这个代价可以接受 —— 若哪天要做 Web 版，重开这个决定。

## 什么前提倒了会推翻它

出现两套库抢同一个焦点/滚动锁的实际 bug（例如 base-ui 的 popover 和 radix 的
dialog 嵌套时焦点互踩）。那时统一就不再是洁癖，而是修 bug。
```

- [ ] **Step 4: 跑门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交并开 PR**

```bash
git add docs/adr/
git commit -m "$(cat <<'EOF'
docs(adr): 记下 assistant-ui 迁移的两个决定及其推翻条件

两份都写了「什么前提倒了会推翻它」:ADR 的价值不在记录选了什么,在记录
当初为什么排除了另一条路——后来者才知道情况变了该不该重开。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push -u origin HEAD
gh pr create --title "feat(ui): 会话区输出侧迁到 assistant-ui（PR1/3）" --body "$(cat <<'EOF'
## 做了什么

立起 `ExternalStoreRuntime` 接缝，把会话区**输出侧**渲染迁到 assistant-ui：
`Thread` + `streamdown`(Shiki) + `reasoning` 换掉 `ThreadViewport` +
react-markdown + highlight.js。视觉保持不变。

输入侧（composer / 附件 / 模型选择 / 上下文环）本 PR 不动，在 PR2。

## 为什么这样接

assistant-ui 的 runtime 想自己持有消息流，本仓硬规则是事件日志唯一事实来源。
接缝是 `useExternalStoreRuntime`：状态归本仓，adapter 只做格式翻译，
写入方向全部回原路。刻意不提供 `onEdit` / `setMessages` —— 本仓没有消息编辑
和对话分支，给了就是凭空长出一条绕开日志的写路径。

详见 ADR 与 `docs/superpowers/specs/2026-08-19-assistant-ui-migration-design.md`。

## 视觉保真

八类审计行（会话创建/归档/改名、模型切换、skill 注入、图片解析、审批拒绝、
turn 暴死或中断）投成 `role: "system"` 消息、原始事件挂 `metadata.custom.otto`，
由 `SystemMessage` override 喂回**既有的 `EventRow`** 渲染 —— 一行没重写，
也没有第二条渲染路径。`ToolRow` 同理。

## 已知的刻意中间态

`EventRow` 的 `user_message` / `assistant_message` 两个分支从此走不到（归 `OttoThread` 了），
留着没删 —— 删要动 `EventRow` 的结构，那是 PR2 的活。

## 验证

- `npm test` 绿；`toThreadMessages` 23 条用例覆盖悬空调用、被拒工具、
  compact 断层、图片解析注入、中断/暴死、坏日志 args
- `npm run build` 三目标通过
- `npm run dev` 肉眼过了流式增长、思考折叠、工具行展开

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 自查记录

对着 spec 逐条核过，三处修正已写进本计划：

1. **`convertMessage` 必填** —— spec 原写「不提供」。实测 `@assistant-ui/core` 的类型定义是
   `T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>`，
   `ThreadMessageLike` 不满足前者。spec 已同步改成恒等函数。
2. **`ToolRow` 签名不动** —— spec 只说「现有 ToolGroup 搬进 override」，没说怎么搬。
   `ToolRow` 还被回放视图用着，改签名会牵一条无关的线，所以改成在 `OttoThread` 侧还原入参。
3. **`@streamdown/code` / `@streamdown/cjk` 是具名导出**（`import { code }`，不是默认导出），
   **`streamdown/styles.css` 必须真 import**（`@source` 扫不出 keyframes）。两条都实测自
   `streamdown@2.5.0` / `@streamdown/code@1.1.1` / `@streamdown/cjk@1.0.3` 的包内容。
4. **`@streamdown/cjk` 不是可选依赖** —— spec 的组件清单里没提。本仓界面和内容都是中文，
   缺了断行排版会散。

执行前的预检扫描又发现两处，已就地改进本计划（裁决记录在
`.superpowers/sdd/2026-08-19-assistant-ui-pr1-render-layer/progress.md`）：

4. **投影必须覆盖 8 类审计行**（R1）—— 原 Task 3 把 `model_changed` / `skill_invoked` /
   `session_renamed` 等投成「无消息」，原 Task 7 又删掉 `items.map`，两条合起来等于
   这些行从界面消失，违背 spec 的「保留现有视觉」。改法：投成 `role: "system"` +
   `metadata.custom.otto`，由 `SystemMessage` override 喂回既有 `EventRow`。
5. **`reasoning.tsx` 的导出名也要核**（R2）—— 原 Task 6 只要求核 `thread.tsx`。

spec 的 §5（sources / file / follow-up-suggestions）、§6 的 PR2/PR3 不在本计划内，各自出计划。
