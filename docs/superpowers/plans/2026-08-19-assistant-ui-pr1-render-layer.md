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
- 每个 task 结束前 `npm test` 必须绿（基线 **939/939**，只增不减，无跳过、无失败）。
- **`npm test` 不做类型检查**（vitest 走 esbuild，只剥类型不校验）。所以每个 task 提交前
  还要单独跑 `npx tsc --noEmit -p tsconfig.json`，必须零报错。门禁命令本身不改
  （改它是 L1，超出本计划范围），但类型错不许靠「测试绿了」蒙混过去。
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
| `src/renderer/src/aui/OttoRuntimeProvider.tsx` | `AssistantRuntimeProvider` 壳 | 4 |
| `src/renderer/src/components/assistant-ui/*`（registry 生成，**11 个文件**，不是 `components/ui/`） | thread / reasoning / tool-fallback / tool-group / attachment / markdown-text / image / file / follow-up-suggestions / tooltip-icon-button；另有 `components/ui/collapsible.tsx` | 5 |
| `src/renderer/src/components/assistant-ui/thread.tsx` | 摘掉输入侧 + 加 `SystemMessage` 槽 | 6 |
| `src/renderer/src/aui/OttoThread.tsx` | Thread 组装 + 三个 override | 7 |
| `src/renderer/src/components/ToolLiveTail.tsx` | 执行中的输出直播尾巴（从 `ToolRow` 抽出） | 7 |
| `src/renderer/src/aui/toThreadMessages.ts`（再改） | user 消息挂上原始事件，附件才有数据源 | 8 |
| `src/renderer/src/App.tsx` | 换掉 `ThreadViewport` + `items.map` 那一段 | 9 |
| `src/renderer/src/app.css` | 删 hljs 配色段 | 9 |
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

创建 `tests/renderer/toThreadMessages.test.ts`。

> **不要拿 `session_created` 当填充事件。** Task 3 会把它列进八类审计行（届时它**会**产生一条
> system 消息），此处若断言「它不产生消息」，Task 3 就得回头改本文件 —— 那是计划自己制造的返工。



```ts
import { describe, expect, it } from "vitest";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造事件的小工具：seq 自增，ts 固定（时间不参与本文件任何断言） */
function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("toThreadMessages — 骨架", () => {
  it("user_message 变成 user 角色的 text part", () => {
    const events = [ev({ type: "user_message", content: "你好" }, 1)];
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
Expected: PASS（5 条全绿）

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

  // args 的类型从 Part 联合里取,不要写成 Record<string, unknown>:
  // assistant-ui 那边是 ReadonlyJSONObject,和 unknown 索引签名不兼容,tsc 会红
  type ToolCallPart = Extract<Part, { type: "tool-call" }>;
  const base = isObject
    ? { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        args: call.args as NonNullable<ToolCallPart["args"]> }
    : { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        argsText: JSON.stringify(call.args) };

  // exactOptionalPropertyTypes:没有结果时这两个键必须整个不出现,不能赋 undefined。
  // isError 同理:status 是 "ok" 时整个键不出现,不写 isError: false ——
  // 本 task 第一条测试用的是 toEqual 精确比对,多一个键就红
  if (result === undefined) return base;
  if (result.status === "ok") return { ...base, result: result.output };
  return { ...base, result: result.output, isError: true };
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
- Create: `src/renderer/src/aui/OttoRuntimeProvider.tsx`
- Test: `tests/renderer/ottoAdapter.test.ts`

**Interfaces:**
- Consumes: `toThreadMessages`、`LiveBuffer`（Task 1–3）
- Produces:
  - `export interface OttoAdapterInput { events: SessionEvent[]; live: LiveBuffer | undefined; isRunning: boolean; send: (text: string) => Promise<void>; cancel: () => Promise<void> }`
  - `export function buildOttoAdapter(input: OttoAdapterInput): ExternalStoreAdapter<ThreadMessageLike>`
  - `export function useOttoRuntime(): AssistantRuntime`
  - `export function OttoRuntimeProvider({ children }: { children: ReactNode }): JSX.Element`

**背景（实现者必读）：** store 里相关字段 —— `events: SessionEvent[]`、`streamingBySession: Record<string, { content: string; reasoning: string }>`、`statusBySession: Record<string, TurnStatus>`、`sessionId: string`。

动作的**确切名字**（已核实，别改别猜）：
- 发消息：`send(text: string, skill?: string): Promise<void>`（[store.ts:281](src/renderer/src/store.ts:281)）
- 中断：`stop(): Promise<void>`（[store.ts:290](src/renderer/src/store.ts:290)）—— **不叫** `abortTurn`

**本 PR 不提供 `onReload`。** 本仓的「重试」不是 assistant-ui 意义上的 regenerate：
`retryPlan`（[retry.ts](src/renderer/src/lib/retry.ts)）有两档，原消息带附件、或输入框暂存区
非空时走 `mode: "fill"` —— 把正文**填回输入框**让用户确认，而不是重发（附件本体在附件库，
一键重发做不到）。把它接到 `onReload` 上，assistant-ui 会渲染一个「重新生成」按钮，
点下去有时什么都不生成、只往另一棵组件树里的输入框塞了段字 —— 那是骗人。
现有的 `RetryButton` 照旧从 `turn_ended(error)` 那条审计行里出来（Task 3 保住了它），
重试能力一点没少。PR2 输入框搬家时再重开这个决定。

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
    ...over,
  };
}

describe("buildOttoAdapter", () => {
  it("messages 是投影结果,convertMessage 是恒等", () => {
    const a = buildOttoAdapter(input());
    expect(a.messages).toHaveLength(1);
    const m = a.messages![0]!;
    // convertMessage 上不加 !:T = ThreadMessageLike 时它在类型上是必填的
    expect(a.convertMessage(m, 0)).toBe(m);
  });

  it("刻意不提供 onEdit / setMessages —— 本仓没有消息编辑和对话分支", () => {
    const a = buildOttoAdapter(input());
    expect(a.onEdit).toBeUndefined();
    expect(a.setMessages).toBeUndefined();
  });

  it("刻意不提供 onReload —— 本仓的重试有 fill 档,不是 regenerate", () => {
    expect(buildOttoAdapter(input()).onReload).toBeUndefined();
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

  it("onCancel 接到 stop", async () => {
    const cancel = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ cancel }));
    await a.onCancel!();
    expect(cancel).toHaveBeenCalledOnce();
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
      // 不要在这写 as never:AppendMessage.content 的每个成员要么带 text: string、
      // 要么没有 text 字段,结构上本来就满足 textOf 的入参类型。
      // as never 是最宽的逃生口(两个方向都可赋值),写在这里等于把将来真出现的
      // 类型不匹配也一并吞掉
      await input.send(textOf(message.content));
    },
    onCancel: input.cancel,
    // 刻意不给 onEdit / setMessages:本仓没有消息编辑,也没有对话分支。
    // 给了就等于凭空长出一条绕开事件日志的写路径 —— 硬规则不允许。
    // 也不给 onReload:本仓的「重试」有 fill 档(原消息带附件时只把正文填回输入框,
    // 不重发),接上去等于给用户一个有时什么都不生成的「重新生成」键 —— 那是骗人。
    // 重试照旧走 turn_ended(error) 审计行里的 RetryButton
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/ottoAdapter.test.ts`
Expected: PASS（8 条全绿）

- [ ] **Step 5: 复核 store 上动作的名字**

Run: `grep -n "send(text\|stop()" src/renderer/src/store.ts`
应看到 `send(text: string, skill?: string): Promise<void>` 和 `stop(): Promise<void>`。
对不上就以仓里的为准改下一步，别硬套。

- [ ] **Step 6: 写 hook 和 Provider**

> 组件名叫 `OttoRuntimeProvider`，**不要**叫 `AuiProvider` —— `@assistant-ui/react` 自己导出了一个同名的 `AuiProvider`，重名会让读代码的人以为在用官方那个。

创建 `src/renderer/src/aui/useOttoRuntime.ts`：

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
  const cancel = useChat((s) => s.stop);

  void sessionId; // 换会话时 events/live 自然变,这里只是让意图显式

  return useExternalStoreRuntime(
    buildOttoAdapter({ events, live, isRunning: status === "running", send, cancel })
  );
}
```

创建 `src/renderer/src/aui/OttoRuntimeProvider.tsx`：

```tsx
// AssistantRuntimeProvider 的壳。单独成文件是为了让 App.tsx 只 import 一个名字。
//
// 名字不叫 AuiProvider:assistant-ui 自己导出了一个同名组件(@assistant-ui/react
// 的 AuiProvider),重名会让人以为在用官方那个

import type { ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useOttoRuntime } from "./useOttoRuntime.js";

export function OttoRuntimeProvider({ children }: { children: ReactNode }) {
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
git add src/renderer/src/aui/ottoAdapter.ts src/renderer/src/aui/useOttoRuntime.ts src/renderer/src/aui/OttoRuntimeProvider.tsx tests/renderer/ottoAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(aui): ExternalStoreRuntime 接缝立起来

adapter 单独成文件而不是塞进 hook:字段取舍是有法理的决定,该能被单测钉住。
刻意不给 onEdit / setMessages —— 本仓没有消息编辑也没有对话分支,给了就等于
凭空长出一条绕开事件日志的写路径。也不给 onReload:本仓的重试有 fill 档
(原消息带附件时只把正文填回输入框,不重发),接上去等于给用户一个有时什么都
不生成的「重新生成」键。重试照旧走审计行里的 RetryButton,能力一点没少。

onNew 只取 text part,附件走自己的通道(AttachmentAdapter,PR2),从这里偷渡
会绕开附件库。

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

**背景（实现者必读）：** registry 是 **copy-in 源码**，不是版本化依赖 —— 装完的文件归本仓所有，要进 diff 审查。配色和动效都得并进本仓那套（Step 5 / Step 5b），不然同一屏里会有两种手感。它会尝试覆盖 `ui/button.tsx`、`ui/tooltip.tsx`，这两个本仓**已定制过**（`button.tsx` 的 `buttonVariants` 基类带 `transition-[...,opacity] duration-150`，被覆盖会让 `CopyButton` 的按压动效丢失）。

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
npx shadcn@latest add --yes @assistant-ui/thread @assistant-ui/reasoning @assistant-ui/tool-fallback
```

`--yes` 是必须的：不带它 CLI 会停在交互确认上，非交互环境里就挂住了。代价是它对
「文件已存在，要覆盖吗」也一并答应 —— 所以上一步的备份不是保险，是**前提**。

装完先看清单，再决定下一步：

Run: `git status --short`
把「新增」和「被改」两类分开记下来。被改的那些逐个过下一步。

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

- [ ] **Step 5b: 动效并入本仓的运动系统**

registry 装进来的组件自带一套动效，本仓已有自己的一套（[app.css:196](src/renderer/src/app.css:196) 起）：
`--ease-strong: cubic-bezier(0.23, 1, 0.32, 1)` 是全仓统一的强 ease-out，
且每一处过渡都配了 `prefers-reduced-motion` 兜底。两套不并，同屏里同样的动作会有两种手感。

逐个文件过一遍 `thread.tsx` / `reasoning.tsx` / `tool-fallback.tsx`，按这张表改：

| 看到 | 改成 | 为什么 |
|---|---|---|
| `transition-all` | 只列真正变的属性，如 `transition-[opacity,transform]` | `all` 会把布局属性也拖进过渡，掉帧 |
| 内建 `ease-in-out` / `ease-in` / 无缓动 | `ease-strong`（本仓 utility，映射到 `--ease-strong`） | `ease-in` 开头慢，正是用户盯得最紧的那一刻，读起来发钝 |
| `scale-0` 入场 | `scale-[0.95]` + `opacity-0` | 现实里没有东西从「无」里冒出来 |
| 时长 > 300ms 的 UI 过渡 | 150–250ms | 超过 300ms 的界面动效会被读成卡 |
| 有过渡但没有 `motion-reduce:` 兜底 | 补 `motion-reduce:transition-none`（或只留不位移的那部分） | 减弱动效 ≠ 关掉动效：保留有助理解的淡入淡出，去掉位移 |
| popover/浮层 `transform-origin: center` | base-ui 的 `origin-[var(--transform-origin)]` | 浮层该从触发点长出来，不是从屏幕中心 |

按本仓既有写法照抄即可，`Timeline.tsx` 的工具详情面板就是范本：

```
transition-[opacity,transform] duration-150 ease-strong
starting:opacity-0 starting:-translate-y-[2px] starting:scale-[0.99]
motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 motion-reduce:starting:scale-100
```

**不要改本仓既有组件的动效** —— 这一步只管把新装进来的三个文件拉齐。

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

### Task 6: `thread.tsx` 手术 —— 摘掉输入侧，补上 SystemMessage 槽

**Files:**
- Modify: `src/renderer/src/components/assistant-ui/thread.tsx`

**Interfaces:**
- Consumes: 无（本 task 只改 Task 5 装进来的那个文件）
- Produces: `ThreadComponents` 类型新增 `SystemMessage?: ComponentType | undefined` 槽；`Thread` 的 ViewportFooter 不再渲染 composer / suggestions

**背景（实现者必读）：**

`thread.tsx` 是 registry 装进来的 **copy-in 源码，归本仓所有** —— 改它是正当动作，不是「改第三方库」。但改动要克制、要留注释，因为将来从 registry 升级时这些改动要人工合。

装进来的 `Thread` 有两处和 PR1 的边界冲突：

1. **它自带输入侧。** `ThreadRoot` 的 `<ThreadPrimitive.ViewportFooter>` 里渲染了
   `<ThreadFollowupSuggestions />`、`<Composer />`、`<ThreadSuggestions />`。
   而 PR1 只迁输出侧 —— `App.tsx` 的 footer 有自己的一整套（`WorkTreePill`、`TodoPanel`、
   `ComposerBar`、slash/$ 菜单、附件暂存区），PR2 才搬。两个都渲染 = 界面上两个输入框。
2. **它没有 system 消息的位置。** `ThreadComponents` 只有 `AssistantMessage` / `Welcome` /
   `ToolFallback` / `ToolGroup` / `ReasoningGroup`；`ThreadMessage` 只分 `role === "user"` 和
   其余，**system 会掉进 assistant 分支**。而 Task 3 把八类审计行（会话创建/归档/改名、模型切换、
   skill 注入、图片解析、审批拒绝、turn 暴死或中断）投成了 `role: "system"` —— 不补这个槽，
   它们会被当成模型回复渲染。

- [ ] **Step 1: 摘掉 ViewportFooter 里的输入侧**

在 `ThreadRoot` 里，把 `<ThreadPrimitive.ViewportFooter>` 的内容改成只留滚动键：

```tsx
          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            {/* PR1 只迁输出侧:输入框仍是 App.tsx footer 里那一整套(WorkTreePill /
                TodoPanel / ComposerBar / slash 菜单 / 附件暂存区)。这里若也渲染
                <Composer />,界面上会出现两个输入框。
                <ThreadFollowupSuggestions /> 同理:它要的 suggestions 数据 PR3 才有,
                现在挂上去是个永远空着的壳。
                PR2 搬输入框、PR3 接跟进建议时,把这两行加回来。 */}
          </ThreadPrimitive.ViewportFooter>
```

删掉 `<ThreadFollowupSuggestions />`、`<Composer />`，以及那段包着 `<ThreadSuggestions />` 的 `<AuiIf>`。

- [ ] **Step 2: 清掉因此变成死代码的东西**

Run: `npx tsc --noEmit -p tsconfig.json`

`verbatimModuleSyntax` + 未使用变量不会报错，但 `npm run build` 时 esbuild 会把它们打进包。
把只被上一步删掉那几处引用的组件和 import 一并删掉（`Composer`、`ComposerAction`、
`ComposerAttachments`、`ComposerAddAttachment`、`ThreadSuggestions`、`ThreadSuggestionItem`、
`ThreadFollowupSuggestions` 及其 import，以及随之无人引用的 `SuggestionPrimitive` /
`ComposerPrimitive` import —— **但 `EditComposer` 用了 `ComposerPrimitive`，先确认再删**）。

**逐个确认无人引用再删**：`grep -n "<组件名" src/renderer/src/components/assistant-ui/thread.tsx`。
拿不准的就留着并在报告里列出来 —— 留一个死组件的代价，远小于删掉一个还在用的。

- [ ] **Step 3: 给 `ThreadComponents` 加 `SystemMessage` 槽**

```tsx
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  /** 本仓加的槽:事件日志里的审计行(会话创建/模型切换/skill 注入/turn 暴死…)
      投成 role:"system" 消息,由它渲染。上游 registry 没有这个槽 —— 升级时要人工合 */
  SystemMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};
```

- [ ] **Step 4: 让 `ThreadMessage` 认 system**

```tsx
const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    SystemMessage: SystemMessageComponent,
  } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  // 本仓加的分支:不认 system 的话,审计行会掉进 assistant 分支、被当成模型回复渲染。
  // 没给 SystemMessage 时退回 assistant —— 与上游行为一致,不静默吞掉消息
  if (role === "system" && SystemMessageComponent) return <SystemMessageComponent />;
  return <AssistantMessageComponent />;
};
```

- [ ] **Step 5: 版式对齐本仓**

`ThreadRoot` 上写死了 `--thread-max-width: 44rem` 且内容居中（`mx-auto max-w-(--thread-max-width)`）。
本仓会话区现在是撑满宽度、气泡各自 `max-w-[76%]`（见 `src/renderer/src/timelineStyles.ts` 的 `ROW`）。

先看一眼当前值：

Run: `grep -n "thread-max-width\|max-w-\[76%\]" src/renderer/src/components/assistant-ui/thread.tsx src/renderer/src/timelineStyles.ts`

把 `--thread-max-width` 改成 `100%`，让宽度由外层容器决定 —— `App.tsx` 那边本来就有自己的
padding 和宽度约束（Task 8 接线时会看到）。**不要动 `mx-auto`/`px-4`** 那些结构类，
只改这一个变量：改结构会连带影响滚动和 sticky footer 的定位。

```tsx
        ["--thread-max-width" as string]: "100%",
```

- [ ] **Step 6: 验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build && npm test`
Expected: 三条全过，`npm test` 仍是 964。

`npm run build` 是这一步真正的门 —— 删多了引用、或删漏了 import，`tsc` 有时放过，esbuild 不会。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/components/assistant-ui/thread.tsx
git commit -m "$(cat <<'EOF'
feat(ui): thread.tsx 摘掉输入侧，补上 SystemMessage 槽

registry 装进来的 Thread 自带 Composer 和 suggestions，但 PR1 只迁输出侧——
App.tsx 的 footer 有自己一整套输入框(WorkTreePill / TodoPanel / ComposerBar /
slash 菜单 / 附件暂存区)，两个都渲染就是界面上两个输入框。PR2 搬输入框、
PR3 接跟进建议时再把那两行加回来。

它也没有 system 消息的位置：ThreadMessage 只分 user 和其余，而 Task 3 把八类
审计行投成了 role:"system"——不补槽，那些行会被当成模型回复渲染。

thread.tsx 是 copy-in 源码、归本仓所有，改它是正当动作；但每处改动都留了注释，
因为将来从 registry 升级时这些要人工合。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `OttoThread` —— 组装 overrides，接回直播尾巴

**Files:**
- Create: `src/renderer/src/aui/OttoThread.tsx`
- Create: `src/renderer/src/components/ToolLiveTail.tsx`
- Modify: `src/renderer/src/components/Timeline.tsx`（`ToolRow` 里的直播尾巴改用抽出来的组件，观感不变）

**Interfaces:**
- Consumes: `Thread` / `ThreadComponents`（`@/components/assistant-ui/thread.js`，Task 6 已加 `SystemMessage` 槽）、`ToolFallback`（`@/components/assistant-ui/tool-fallback.js`）、`EventRow`（`src/renderer/src/components/Timeline.tsx`，**不改**）
- Produces:
  - `export function OttoThread(): JSX.Element`
  - `export function ToolLiveTail(props: { toolCallId: string; done: boolean }): JSX.Element | null`

**背景（实现者必读）：**

装出来的文件在 `src/renderer/src/components/assistant-ui/`，**不是** `components/ui/`。
`thread.tsx` 导出的是一个现成的 `Thread` 组件，吃 `components` 配置对象 —— 不用手搓 primitives。

三个 override 各自要解决一件事：

1. **`SystemMessage`** —— Task 3 把八类审计行投成 `role: "system"` 消息、原始事件挂在
   `metadata.custom.otto` 上。这里把它取出来喂回**既有的 `EventRow`**，`EventRow` 一行不改，
   视觉与迁移前一模一样。
   **必须传 `isLast`**：`turn_ended(error)` 那条审计行只在最后一条上挂重试键
   （重发的是「上一条用户消息」，对历史里的旧失败行没有意义），而 `EventRow` 的 `isLast` 默认 `false`。
2. **`ToolFallback`** —— 用 assistant-ui 那套（用户决定），但它没有「执行中的输出」这个概念。
   本仓 bash 跑长命令时，那条直播尾巴是界面上唯一的进度信号，所以外挂上去。
3. 不给 `AssistantMessage` / `ToolGroup` / `ReasoningGroup` override —— 装进来的默认实现
   已经在 Task 5 里换成本仓配色和动效了，再包一层只会多一处要维护的地方（YAGNI）。

直播尾巴的实现现在埋在 `ToolRow` 里（`src/renderer/src/components/Timeline.tsx` 的
`const live = useChat(...)` / `liveRef` / 滚到底的 `useEffect` / `{!result && live && (<pre ...>)}`）。
抽成独立组件，两边共用；**`ToolRow` 的观感一字不变** —— 它还被 `EventRow` 那条线间接留着。

- [ ] **Step 1: 把直播尾巴抽成独立组件**

Run: `grep -n "toolOutputByCall\|liveRef\|const live" src/renderer/src/components/Timeline.tsx`

创建 `src/renderer/src/components/ToolLiveTail.tsx`，把那几块原样搬过来：

```tsx
// 执行中的输出直播尾巴 —— 迷你终端视角:只看最新进展。
//
// 从 ToolRow 抽出来:assistant-ui 的 ToolFallback 没有「执行中的输出」这个概念,
// 而 bash 跑长命令时这条尾巴是界面上唯一的进度信号。抽出来两边共用,行为一字不变。
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

改 `Timeline.tsx` 的 `ToolRow`：删掉 `live` / `liveRef` / 那个 `useEffect` / 那段 `<pre>`，
换成 `<ToolLiveTail toolCallId={call.id} done={result !== undefined} />`。
**className 一个字符都不要改** —— 这是纯搬家，不是重设计。

- [ ] **Step 2: 核对 override 的真实类型**

Run: `grep -n "export type ThreadComponents" -A 20 src/renderer/src/components/assistant-ui/thread.tsx`
Run: `grep -n "^export" src/renderer/src/components/assistant-ui/tool-fallback.tsx`

确认 `SystemMessage` 槽在（Task 6 加的）、`ToolFallback` 的导出名和它接受的 props。
`ToolFallback` 的类型是 `ToolCallMessagePartComponent` —— 拿到的 props 就是那个 part。

- [ ] **Step 3: 写 OttoThread**

创建 `src/renderer/src/aui/OttoThread.tsx`：

```tsx
// Thread 的组装 —— assistant-ui 出骨架,本仓只补三样东西。
//
// 「保留 Mr Otto 现有视觉」这条决定的落点在 SystemMessage:八类审计行直接喂回
// 既有的 EventRow,一行没重写,也不需要第二条渲染路径。

import type { ComponentType } from "react";
import { Thread, type ThreadComponents } from "../components/assistant-ui/thread.js";
import { ToolFallback } from "../components/assistant-ui/tool-fallback.js";
import { ToolLiveTail } from "../components/ToolLiveTail.js";
import { EventRow } from "../components/Timeline.js";
import type { SessionEvent } from "../../../session/events.js";
import { useAuiState } from "@assistant-ui/react";

/** 审计行:原始事件挂在 metadata.custom.otto 上(Task 3 的投影)。
    isLast 必须传:turn_ended(error) 那条行只在最后一条上挂重试键 ——
    重发的是「上一条用户消息」,对历史里的旧失败行没有意义 */
const SystemMessage: ComponentType = () => {
  const event = useAuiState((s) => s.message.metadata?.custom?.["otto"]) as
    | SessionEvent
    | undefined;
  const isLast = useAuiState((s) => s.message.isLast);
  if (event === undefined) return null;
  return <EventRow event={event} isLast={isLast} />;
};

/** 工具行:用 assistant-ui 的 ToolFallback,外挂一条直播尾巴 ——
    它没有「执行中的输出」这个概念,而 bash 跑长命令时那条尾巴是唯一的进度信号 */
const ToolFallbackWithLiveTail: NonNullable<ThreadComponents["ToolFallback"]> = (part) => (
  <>
    <ToolFallback {...part} />
    <ToolLiveTail
      toolCallId={part.toolCallId ?? part.toolName}
      done={part.result !== undefined}
    />
  </>
);

// 模块级常量:每次渲染新建对象会让整棵子树白重挂
const COMPONENTS: ThreadComponents = {
  SystemMessage,
  ToolFallback: ToolFallbackWithLiveTail,
};

export function OttoThread() {
  return <Thread components={COMPONENTS} />;
}
```

- [ ] **Step 4: 按真实类型修正**

Run: `npx tsc --noEmit -p tsconfig.json`

上一步的 `useAuiState` 选择器写法、`ToolCallMessagePartComponent` 的 props 形状，
以真实类型为准。**报错就改上一步的代码，不要往里塞 `as never`** ——
Task 4 已经因为一个凭空加的 `as never` 返工过一轮。
若某处确实需要转型，在报告里单独列出它 silence 了什么。

- [ ] **Step 5: 验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build && npm test`
Expected: 三条全过，`npm test` 仍是 964。

`OttoThread` 此刻还没有人渲染（Task 8 才接进 `App.tsx`），所以这一步验的是「能编译、能打包」，
不是「界面对不对」。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/aui/OttoThread.tsx src/renderer/src/components/ToolLiveTail.tsx src/renderer/src/components/Timeline.tsx
git commit -m "$(cat <<'EOF'
feat(aui): Thread 组装完成，审计行喂回 EventRow，工具行外挂直播尾巴

「保留 Mr Otto 现有视觉」这条决定的落点是 SystemMessage override:八类审计行
直接喂回既有的 EventRow，一行没重写，也不需要第二条渲染路径。isLast 必须传，
否则 turn_ended(error) 那条行的重试键永远不渲染。

工具行按用户决定用 assistant-ui 的 ToolFallback。但它没有「执行中的输出」这个
概念，而 bash 跑长命令时那条直播尾巴是界面上唯一的进度信号——所以从 ToolRow 里
抽成 ToolLiveTail 外挂上去，ToolRow 那边观感一字不变(纯搬家)。

不给 AssistantMessage / ToolGroup / ReasoningGroup override:装进来的默认实现
Task 5 已经换成本仓配色和动效了，再包一层只是多一处要维护的地方。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 补回用户附件 —— 投影没投，图片会消失

**Files:**
- Modify: `src/renderer/src/aui/toThreadMessages.ts`
- Modify: `tests/renderer/toThreadMessages.test.ts`
- Modify: `src/renderer/src/components/assistant-ui/thread.tsx`
- Modify: `src/renderer/src/aui/OttoThread.tsx`

**Interfaces:**
- Consumes: `UserAttachments`（`src/renderer/src/components/UserAttachments.tsx`，**不改**）
- Produces: `ThreadComponents` 新增 `UserAttachments?: ComponentType | undefined` 槽；user 角色的投影消息带上 `metadata.custom.otto`

**背景（实现者必读）：这是一处真实回归，不是打磨**

迁移后用户消息走 assistant-ui 的 `UserMessage`，它在 `thread.tsx` 里渲染 `<UserMessageAttachments />`，
数据来自 assistant-ui 的 attachment 状态、由 `message.attachments` 喂。
而 `toThreadMessages` 从 Task 1 起就**只投 text part**，`user_message.attachments`（图片引用）和
`textFiles`（文本文件全文快照）一个都没投 —— 接线后用户发过的图片和文件会从会话区里**消失**。

为什么不直接投进 `attachments` 字段：本仓图片本体在附件库，走
`window.otter.attachmentDataUrl(id)` 异步懒取（内容寻址，同图只过一次 IPC，见 ADR-0009），
而 assistant-ui 的 `attachments` 要求 content part 里已经有可直接渲染的 data URL。
把它变成同步就得在投影里 eager fetch 全部图片 —— 投影是纯函数，不该碰 IPC。

所以走和审计行同一条路：把原始事件挂到 `metadata.custom.otto` 上，
渲染交给**既有的 `UserAttachments`**（它自己会懒取、自己有缓存、自己处理图片丢失的降级）。
`UserAttachments` 一行不改。

**只换 `<UserMessageAttachments />` 这一处**，不要整个覆盖 `UserMessage` ——
气泡样式、动作条（复制）、BranchPicker 都在它里面，整体覆盖等于把它们全部重写一遍。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/renderer/toThreadMessages.test.ts` 的「骨架」describe 块里：

```ts
  it("user_message 带上原始事件,附件才有数据源", () => {
    const e = ev({
      type: "user_message",
      content: "看这张图",
      attachments: [{ id: "sha256:abc", mediaType: "image/png", bytes: 1024, name: "a.png" }],
    }, 0);
    const out = toThreadMessages([e]);
    expect(out[0]?.metadata).toEqual({ custom: { otto: e } });
    expect(out[0]?.content).toEqual([{ type: "text", text: "看这张图" }]);
  });

  it("只带附件不带正文时,消息仍然产生(否则图片无处可挂)", () => {
    const e = ev({
      type: "user_message",
      content: "",
      attachments: [{ id: "sha256:abc", mediaType: "image/png", bytes: 1024 }],
    }, 0);
    const out = toThreadMessages([e]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([]);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: FAIL —— `metadata` 是 `undefined`（投影没挂原始事件）

- [ ] **Step 3: 投影挂上原始事件**

改 `src/renderer/src/aui/toThreadMessages.ts` 的 `user_message` 分支，`out.push` 改成：

```ts
      out.push({
        role: "user",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        content: parts,
        // 原始事件挂上来:附件(图片引用/文本文件快照)不进 content ——
        // 图片本体在附件库、走 IPC 懒取(ADR-0009),而投影是纯函数不碰 IPC。
        // 渲染交给既有的 UserAttachments(它自己懒取、自己缓存、自己降级)
        metadata: { custom: { otto: e } },
      });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/toThreadMessages.test.ts`
Expected: PASS（25 条全绿）

- [ ] **Step 5: `thread.tsx` 加 `UserAttachments` 槽**

在 `ThreadComponents` 里加（紧挨着 Task 6 加的 `SystemMessage`，两处注释风格保持一致）：

```tsx
  /** 本仓加的槽:用户消息的附件由既有的 UserAttachments 渲染 ——
      图片本体在附件库、走 IPC 懒取,投影塞不进 assistant-ui 的 attachments 字段。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  UserAttachments?: ComponentType | undefined;
```

在 `UserMessage` 里，把 `<UserMessageAttachments />` 换成走槽（缺省仍是上游那个）：

```tsx
const UserMessage: FC = () => {
  const { UserAttachments: UserAttachmentsComponent = UserMessageAttachments } =
    useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root
      ...原样不动...
    >
      <UserAttachmentsComponent />
      ...其余原样不动...
```

**只动这一处**。气泡的 className、动作条、BranchPicker 全部保持原样。

- [ ] **Step 6: `OttoThread` 加 override**

在 `src/renderer/src/aui/OttoThread.tsx` 里，照 `SystemMessage` 的写法加：

```tsx
/** 用户附件:原始事件挂在 metadata.custom.otto 上,交给既有的 UserAttachments 渲染。
    它自己走 window.otter.attachmentDataUrl 懒取图片、自己有内存缓存、
    图片丢失时自己降级成占位卡 —— 这些都不该在投影层重做一遍 */
const UserMessageAttachments: ComponentType = () => {
  const event = useAuiState((s) => s.message.metadata.custom["otto"]) as
    | SessionEvent
    | undefined;
  if (event === undefined || event.type !== "user_message") return null;
  return <UserAttachments attachments={event.attachments} textFiles={event.textFiles} />;
};
```

并把它加进 `COMPONENTS`：

```tsx
const COMPONENTS: ThreadComponents = {
  SystemMessage,
  UserAttachments: UserMessageAttachments,
  ToolFallback: ToolFallbackWithLiveTail,
};
```

顶部补 import：

```ts
import { UserAttachments } from "../components/UserAttachments.js";
```

- [ ] **Step 7: 验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build && npm test`
Expected: 三条全过，`npm test` 966（964 + 本 task 的 2 条）。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/aui/toThreadMessages.ts tests/renderer/toThreadMessages.test.ts src/renderer/src/components/assistant-ui/thread.tsx src/renderer/src/aui/OttoThread.tsx
git commit -m "$(cat <<'EOF'
fix(aui): 补回用户附件——投影没投，接线后图片会从会话区消失

toThreadMessages 从一开始就只投 text part，user_message.attachments 和
textFiles 一个都没投。而迁移后用户消息走 assistant-ui 的 UserMessage，它的附件
由 message.attachments 喂——所以接线那一刻，用户发过的图片和文件会消失。

不直接投进 attachments 字段：本仓图片本体在附件库，走 IPC 懒取(内容寻址，
同图只过一次，ADR-0009)，而那个字段要求 content part 里已经有可渲染的 data URL。
要同步就得在投影里 eager fetch 全部图片——投影是纯函数，不该碰 IPC。

所以走和审计行同一条路：原始事件挂 metadata.custom.otto，渲染交给既有的
UserAttachments。它自己懒取、自己缓存、图片丢了自己降级，这些都不该重做一遍。

只换掉 UserMessage 里 <UserMessageAttachments /> 这一处，不整体覆盖 UserMessage——
气泡样式、复制动作条、BranchPicker 都在它里面。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 模型输出真的换成 streamdown

**Files:**
- Modify: `src/renderer/src/components/assistant-ui/markdown-text.tsx`

**Interfaces:**
- Consumes: `@assistant-ui/react-streamdown` 的 `StreamdownTextPrimitive`、`@streamdown/code` 的 `code`、`@streamdown/cjk` 的 `cjk`（Task 5 已装：`streamdown@2.5.0` / `@streamdown/code@1.1.1` / `@streamdown/cjk@1.0.3` / `@assistant-ui/react-streamdown@0.3.10`）
- Produces: `markdown-text.tsx` 仍然导出同名的 `MarkdownText`，**签名不变** —— 它的两个调用点（`thread.tsx` 的 `case "text"`、`reasoning.tsx` 的 `ReasoningImpl`）一行都不用改

**背景（实现者必读）：这一项目前是没交付的**

用户要的 12 项里有两项是「模型输出用 streamdown」和「模型输出代码块用 syntax-highlighting」。
Task 5 把 `streamdown` 和插件都装了、`app.css` 的两行样式也接了，**但 registry 生成的
`markdown-text.tsx` 走的是 `@assistant-ui/react-markdown` 的 `MarkdownTextPrimitive`**，
streamdown 至今休眠。不换掉，这两项等于没做。

换的位置只有一个文件：`markdown-text.tsx` 的内部实现。它导出的 `MarkdownText` 名字和签名不动，
所以 `thread.tsx:316` 和 `reasoning.tsx:326` 两个调用点不用碰。

**`@streamdown/cjk` 不是可选的**：本仓界面和内容都是中文，缺了 CJK 断行插件排版会散。

- [ ] **Step 1: 读清两个 primitive 的真实差异**

Run: `sed -n 1,60p src/renderer/src/components/assistant-ui/markdown-text.tsx`
Run: `grep -n "StreamdownTextPrimitiveProps\|type StreamdownProps" -A 40 node_modules/@assistant-ui/react-streamdown/dist/index.d.ts | head -60`

搞清三件事，写进报告：
① `StreamdownTextPrimitive` 接哪些 prop（`plugins` / `shikiTheme` / `controls` / `mode` / `caret` …）
② 现有 `defaultComponents` 里哪些还需要（streamdown 自带代码块高亮与控件，`CodeHeader`、
   `pre`/`code` 的覆盖多半整个多余）
③ `remark-gfm` 还需不需要显式传（streamdown 默认带 GFM 就不用）

**以 `.d.ts` 为准，不要照抄文档。**

- [ ] **Step 2: 换掉实现**

把 `MarkdownText` 的实现改成 `StreamdownTextPrimitive`，插件至少给 `{ code, cjk }`：

```tsx
// 具名导出,不是默认导出(实测 @streamdown/code@1.1.1 / @streamdown/cjk@1.0.3 的 .d.ts)
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";

// 模块级常量:每次渲染新建对象会让整棵子树白重挂
const PLUGINS = { code, cjk };
```

主题跟随本仓的明暗两套（`app.css` 的 `:root` 裸变量 = light、`.dark` 覆盖）。
`shikiTheme` 若接受 `[light, dark]` 双主题，用它；只接受单个就选与本仓 `--pre-bg` 对得上的那个，
并在报告里说明选了哪个、为什么。

删掉因此变成死代码的东西（`CodeHeader`、`pre`/`code` 的 `defaultComponents` 覆盖、
只为它们服务的 import）。**逐个 grep 确认无人引用再删**；拿不准就留着并在报告里列出来。

- [ ] **Step 3: 保住 `.md` 排版作用域**

`app.css:287` 起那段排版规则是挂在 `.md` 后代选择器上的（「react-markdown 生成的 DOM 挂不上
utility，排版只能走后代选择器」）。streamdown 生成的 DOM 结构不同 —— 确认换完之后
模型回复的标题/列表/引用/表格排版没塌。

Run: `grep -n "\.md " src/renderer/src/app.css | head -20`

若 streamdown 自带排版而与 `.md` 那套打架，**不要改 `app.css`**（那段 `ProtocolView` 也在吃），
改成在 `markdown-text.tsx` 这一侧收敛，并在报告里说明。

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build && npm test`
Expected: 三条全过，`npm test` 仍是 966。

Run: `grep -rn "streamdown" src/renderer/src/components/assistant-ui/ | head`
Expected: 至少 `markdown-text.tsx` 命中 —— 这是「不再休眠」的证据。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/assistant-ui/markdown-text.tsx
git commit -m "$(cat <<'EOF'
feat(ui): 模型输出真的换成 streamdown，代码块走 Shiki

装是装了，但 registry 生成的 markdown-text 走的是 @assistant-ui/react-markdown
的 MarkdownTextPrimitive——streamdown 一直休眠，「模型输出用 streamdown」和
「代码块用 syntax-highlighting」这两项等于没做。

只换 markdown-text.tsx 的内部实现，导出的名字和签名不动，所以 thread.tsx 和
reasoning.tsx 两个调用点一行没碰。

@streamdown/cjk 不是可选的:本仓界面和内容都是中文，缺了断行排版会散。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 接进 App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`（`<ThreadViewport>` 到 `</ThreadViewport>` 整段，约 2091-2140 行）（`ThreadViewport` 那一整段）
- Modify: `src/renderer/src/components/Timeline.tsx`（只删 `user_message` / `assistant_message` 两个已到不了的分支及其独有的 import）

**Interfaces:**
- Consumes: `OttoRuntimeProvider`（Task 4）、`OttoThread`（Task 7、8）

**背景（实现者必读）：** `ThreadViewport` 现在承担贴底滚动（`src/renderer/src/lib/stickToBottom.ts`，有测试 `tests/renderer/stickToBottom.test.ts`）。assistant-ui 的 `ThreadPrimitive.Viewport` **自带** auto-scroll。`ThreadViewport` 和 `stickToBottom.ts` 在本 PR 后仍被回放视图用着 —— **先确认再删**，不确认就留着。

`items.map` 整段删掉是对的，**不留双渲染路径**：`EventRow` 的 8 类审计分支已经由 Task 3 投成 system 消息、Task 6 的 override 喂回 `EventRow` 渲染，视觉不丢。`EventRow` 里 `user_message` / `assistant_message` 两个分支从此走不到（它们归 `OttoThread`），但**不要删** —— 留着不碍事，删了要动 `EventRow` 的结构，那是 PR2 的活。

- [ ] **Step 1: 确认 ThreadViewport / stickToBottom 还有谁在用**

Run: `grep -rn "ThreadViewport\|stickToBottom" src/ tests/`
把结果记下来。只在下一步删掉确实没人用的东西。

- [ ] **Step 2: 换 App.tsx 的渲染段**

把 `src/renderer/src/App.tsx` 里 `<ThreadViewport ...>` 到 `</ThreadViewport>` 整段（约 2091–2140 行）换成：

```tsx
          <OttoRuntimeProvider>
            <OttoThread />
          </OttoRuntimeProvider>
```

`error` 行、`streamingThinking`、`streamingText`、`Marker` 那几块**一并删掉** —— 它们的职责已经进了投影：
- `streamingText` / `streamingThinking` → `toThreadMessages` 的 live 分支
- turn 失败 → 投影里的 `incomplete` 状态

`ApprovalCard` / `QuestionnaireCard` **保持原位不动**：它们是挂起中的活控制件，不是消息。

顶部补 import：

```ts
import { OttoRuntimeProvider } from "./aui/OttoRuntimeProvider.js";
import { OttoThread } from "./aui/OttoThread.js";
```

- [ ] **Step 3: 清掉 `EventRow` 里已经到不了的两个分支**

上一步之后，`EventRow` 只剩一个调用点：`OttoThread` 的 `SystemMessage` override，
而它只会拿到审计事件（`toThreadMessages` 把 `user_message` 投成 `role:"user"`、
`assistant_message` 投成 `role:"assistant"`，两者都不走 system 槽）。
所以 `EventRow` 的 `case "user_message"` 和 `case "assistant_message"` 已经到不了。

先自己验一遍这个判断：

Run: `grep -rn "EventRow" src/renderer/src/`
应当只剩 `Timeline.tsx` 的定义处和 `OttoThread.tsx` 的调用处。**若还有第三处，停下来报告** ——
说明我这个判断错了，那两个分支还活着。

判断成立就删掉这两个 `case`，以及只为它们服务的 import：
`Markdown` / `remarkGfm` / `rehypeHighlight` / `MD_COMPONENTS` / `UserAttachments` /
`MessageActions` / `thinkingLabel`。**逐个 grep 确认文件内无人引用再删**。

- [ ] **Step 4: 不要卸包，不要删 hljs 配色段**

这两件事本 PR **明确不做**，原因是查实的，不是保守：

- `src/renderer/src/components/ProtocolView.tsx:5-7` 独立地用着
  `react-markdown` / `remark-gfm` / `rehype-highlight`（协议仪表盘，和会话区无关）。卸包会把它打瞎。
- `app.css:398` 起那段 `.md .hljs-*` 配色正是 `ProtocolView` 的代码高亮在吃。删了它同样打瞎。
- 而且 `@assistant-ui/react-markdown` 自己就依赖 `react-markdown@^10.1.0`（见其 `package.json`），
  即便本仓一处不用，它也会作为传递依赖留在树里。

Run: `grep -rn "react-markdown\|rehype-highlight\|remark-gfm" src/ | grep -v "components/assistant-ui/"`
确认删完 Step 3 之后只剩 `ProtocolView.tsx` 那三行。**只剩它 = 对**，不是遗漏。

- [ ] **Step 5: 确认 `CodeBlock.tsx` 的去留**

Run: `grep -rn "MD_COMPONENTS\|CodeBlock" src/renderer/src/`

`MD_COMPONENTS` 若在 Step 3 之后无人引用，删掉那一行导出；`CodeBlock` 组件本身若也无人引用，
整个文件可以删。**但 `CopyButton` 一定还有人用，别顺手删它。** 拿不准就留着并在报告里列出来。

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
feat(ui): 会话区输出侧接进 assistant-ui

streamingText / streamingThinking / turn 失败行这几块从 App.tsx 消失不是
删功能:它们的职责进了 toThreadMessages —— 直播缓冲成 live 消息,turn 的死法
成消息状态。UI 不再自己拼这些,它只渲染投影。

ApprovalCard / QuestionnaireCard 留在原位:它们是挂起中的活控制件,不是消息,
藏了 agent 就卡死。

items.map 整段删掉,不留双渲染路径:八类审计行已经由投影 + SystemMessage
override 喂回同一个 EventRow 渲染,视觉不丢。EventRow 的 user/assistant 两个
分支从此到不了(它只剩 SystemMessage 一个调用点,而那里只会来审计事件),一并删掉。

不卸 react-markdown 那几个包、也不删 app.css 的 hljs 配色段:ProtocolView 独立
用着它们(协议仪表盘,和会话区无关),卸了删了会把它打瞎。何况
@assistant-ui/react-markdown 自己就依赖 react-markdown,它本来也留在依赖树里。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 补回接线时丢掉的三处功能

**Files:**
- Modify: `src/renderer/src/App.tsx`（取回被删的四个纯函数 + 挂 `SelectionQuote`）
- Modify: `src/renderer/src/components/assistant-ui/thread.tsx`（加 `RunIndicator` 槽）
- Modify: `src/renderer/src/aui/OttoThread.tsx`（`RunIndicator` override）
- Modify: `src/renderer/src/aui/ottoAdapter.ts`、`useOttoRuntime.ts`（接回 `onReload`）
- Modify: `tests/renderer/ottoAdapter.test.ts`

**背景（实现者必读）：这三处都是接线（`ed49cfa`）造成的真实回归，不是打磨**

Task 10 的审查逐项走查删掉的代码，发现三样东西**没了替代品**。绿色构建证明不了这个 ——
把一个组件和它唯一的调用点一起删掉，编译完美通过，功能却消失了。

#### 1. turn 运行时的相位指示器

删掉前，`App.tsx` 在 `status === "running" || approval !== null` 的整段时间里渲染一个
`Marker`：相位 orb + 中文标签（等待审批 / 检索中 / 执行中 / 思考中 / 作答中）+
实时 `mm:ss · Nk tokens`。

删掉后，**turn 开始到第一个 token 到达之间界面上什么都没有** —— 投影只在
`live.content` / `live.reasoning` 非空时才产出消息（`toThreadMessages.ts:150`），
在那之前没有任何东西可渲染。跑一条要等十几秒才出字的命令时，界面看起来像死了。

原实现在 `git show d2e3357:src/renderer/src/App.tsx` 里：`fmtTokens`(121)、`fmtElapsed`(126)、
`TurnMeta`(175)、`currentTool`(618)、`agentPhase`(633)，以及 2129 行附近那段 `<Marker>`。
**原样取回，不要重写。**

#### 2. 模型回复上的重试/重发

删掉前，每条模型回复悬停都有重试键（`MessageActions`）：原样重发上一条用户消息，
或在原消息带附件时把正文填回输入框。它**不依赖 turn 失败** —— 回复得好好的也能重来一次。

删掉后只剩 `turn_ended(error)` 那条错误行上的 `RetryButton`。而 assistant-ui 自带的
`ActionBarPrimitive.Reload`（`thread.tsx:381-385`）是**哑的**，因为
`ottoAdapter.ts` 当初刻意没接 `onReload`。

**那个决定要推翻。** 当时的理由是「`retryPlan` 有 fill 档，接上去等于给用户一个有时
什么都不生成的『重新生成』键」—— 但当时 `MessageActions` 还在，重试还有别的入口。
现在没有了，「语义不够纯」远轻于「功能没了」。fill 档也不是什么都不做：正文落进输入框，
用户确认后自己发，这正是本仓自己选的降级方式。

#### 3. 划词引用

`SelectionQuote`（在消息区选中文字 → 浮出「引用」→ 以 markdown 引用块进输入框）
原本挂在 `ThreadViewport.tsx:63`，而 `ThreadViewport` 已经没人渲染了。
它有自己的 lib（`lib/quote.ts`）和测试（`tests/renderer/quote.test.ts`），
但**没有任何挂载点**。assistant-ui 的 `SelectionToolbar` 本仓一处没用。

它的签名是 `SelectionQuote({ hostRef }: { hostRef: RefObject<HTMLElement | null> })`，
坐标算的是相对宿主容器的偏移。原结构是：`<section ref={ref}>{children}</section>` 后面
紧跟 `<SelectionQuote hostRef={ref} />`（兄弟，不是子元素）。**照抄这个结构**。

- [ ] **Step 1: 接回 `onReload`（先做这个，它最小）**

`src/renderer/src/aui/ottoAdapter.ts`：`OttoAdapterInput` 加回 `retry: () => void`，
并在返回的 adapter 上加：

```ts
    // 接回 onReload:本仓的重试有 fill 档(原消息带附件时把正文填回输入框,不重发),
    // 语义上确实不是纯粹的 regenerate。但接线后 MessageActions 那个入口没了,
    // 「语义不够纯」远轻于「功能没了」—— fill 档也不是什么都不做:
    // 正文落进输入框、用户确认后自己发,这正是本仓自己选的降级(见 lib/retry.ts)
    onReload: async () => {
      input.retry();
    },
```

`src/renderer/src/aui/useOttoRuntime.ts`：组出 `retry` 并传进去。需要
`lastUserMessage(events)`、`retryPlan(prev, staged.length)`、`retryLastUserMessage(prev, plan)`
（分别在 `lib/lastUserMessage.js` / `lib/retry.js` / `lib/retryAction.js`）。
`staged` 从 store 取。`prev` 或 `plan` 为空时 `retry` 什么都不做。

`tests/renderer/ottoAdapter.test.ts`：把「刻意不提供 onReload」那条测试**改成**断言它存在且转交
`retry`（这是产品代码变更带着它的测试一起改，不是删测试求绿）。

- [ ] **Step 2: 验证 Step 1**

Run: `npx vitest run tests/renderer/ottoAdapter.test.ts && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: 取回相位指示器的四个纯函数**

从 `git show d2e3357:src/renderer/src/App.tsx` 取回 `fmtTokens`、`fmtElapsed`、`TurnMeta`、
`currentTool`、`agentPhase`，**原样放回 `App.tsx`**（连注释一起）。它们是纯函数，不要重写。

- [ ] **Step 4: `thread.tsx` 加 `RunIndicator` 槽**

在 `ThreadComponents` 里加（紧挨 Task 6 的 `SystemMessage`、Task 8 的 `UserAttachments`，
注释风格保持一致）：

```tsx
  /** 本仓加的槽:turn 运行时的相位指示器(orb + 相位标签 + 实时耗时/token)。
      它不是消息 —— 是 turn 级的状态,所以挂在 ViewportFooter 而不是消息流里。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  RunIndicator?: ComponentType | undefined;
```

在 `ThreadRoot` 的 `<ThreadPrimitive.ViewportFooter>` 里，`<ThreadScrollToBottom />` **之前**
渲染它（缺省不渲染任何东西）：

```tsx
            {RunIndicatorComponent ? <RunIndicatorComponent /> : null}
            <ThreadScrollToBottom />
```

位置就是它原来在的地方：消息流末尾、输入框上方。

- [ ] **Step 5: `OttoThread` 加 `RunIndicator` override**

把 `App.tsx` 里原来那段 `<Marker>`（`git show d2e3357:src/renderer/src/App.tsx` 2129 行附近）
搬进 `OttoThread.tsx` 的一个组件里，数据照旧从 store 订阅（`statusBySession` / `approvals` / `events`）。
`agentPhase` 等四个函数从 `App.tsx` 导出后 import —— 或者一并搬进 `OttoThread.tsx`，
**二选一，在报告里说明选了哪个、为什么**。

`status !== "running" && approval === null` 时返回 `null`。

- [ ] **Step 6: 挂回 `SelectionQuote`**

在 `App.tsx` 里给 thread 套一层宿主容器，结构照抄 `ThreadViewport` 原来的样子
（`SelectionQuote` 是滚动容器的**兄弟**，不是子元素）：

```tsx
          <div ref={threadHostRef} className="flex-1 min-h-0 flex flex-col relative">
            <OttoRuntimeProvider>
              <OttoThread />
            </OttoRuntimeProvider>
            <SelectionQuote hostRef={threadHostRef} />
          </div>
```

`hostRef` 指向包着滚动区的那个容器。挂上之后**必须自己验证判定逻辑仍然成立**：
`SelectionQuote` 要求选区两端都落在 host 里（防止从输入框拖选进消息区被误判）。
host 换了元素，这个判定的边界也跟着变 —— 在报告里说明你怎么确认它仍然正确。

- [ ] **Step 7: 全量验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build && npm test`
Expected: 三条全过，`npm test` 966。

Run: `grep -rn "SelectionQuote\|RunIndicator\|onReload" src/renderer/src/ | grep -v "^.*://"`
三者都应各有定义处和使用处。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(ui): 补回接线时丢掉的三处功能——相位指示器、消息级重试、划词引用

Task 10 的审查逐项走查删掉的代码才发现:绿色构建证明不了功能还在。把一个组件
和它唯一的调用点一起删掉，编译完美通过，功能却消失了。三处都是这样没的:

一、turn 运行时的相位指示器(orb + 等待审批/检索中/执行中/思考中/作答中 + 实时
耗时和 token)。投影只在有 token 之后才产出消息，所以 turn 开始到第一个 token
之间界面上什么都没有——跑一条要等十几秒的命令时，看起来像死了。

二、模型回复上的重试。它不依赖 turn 失败，回复得好好的也能重来一次。删掉后
只剩错误行上那个。同时推翻 ottoAdapter 当初「不接 onReload」的决定:当时的理由是
retryPlan 有 fill 档、语义不纯，但那时重试还有 MessageActions 这个入口；现在没了，
「语义不够纯」远轻于「功能没了」。

三、划词引用。它挂在 ThreadViewport 上，而 ThreadViewport 已经没人渲染——自带
lib 和测试，却没有任何挂载点。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: 补 ADR，开 PR

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
