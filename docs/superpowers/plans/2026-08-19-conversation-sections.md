# 会话分区总结 + 侧边跳转条 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 turn 结束后让一个便宜模型判断话题是否切换、给新分区起标题，右侧竖轨把分区排成目录，点击滚到那一段。

**Architecture:** 分类结果落成新事件 `section_classified`（模型产出、日志推不出 → 必须落盘；不喂回模型 → 投影必须丢弃）。分类员住在 `main/index.ts` 的 send handler 里、`runTurn` 之后，与 turn 前的 vision-bridge 严格对称，engine 一无所知。目录本身是纯投影 `deriveSections(events)`。

**Tech Stack:** TypeScript strict / Electron 主进程 / React + Zustand 渲染进程 / Tailwind / vitest

设计出处：`docs/superpowers/specs/2026-08-19-conversation-sections-design.md`

## Global Constraints

- 门禁：`npm test`（= `vitest run`）必须全绿。额外自查 `npx tsc --noEmit -p tsconfig.json`（当前是干净的，别把它弄脏）。
- tsconfig 开了 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`：数组下标取值类型带 `| undefined`；可选字段**不能**赋 `undefined`，一律用 `...(x ? { x } : {})` 的展开写法（`events.ts` / `engine.ts` 里到处是这个写法，照抄）。
- `verbatimModuleSyntax`：只做类型用途的导入必须写 `import type`。
- 相对导入一律带 `.js` 后缀（nodenext），即使源文件是 `.ts`。
- 测试放 `tests/`，镜像 `src/` 结构，**不与源码同目录**（AGENTS.md 硬规则）。
- 事件 schema 只加不改：新增类型 = union 加宽，旧日志必须永远可重放。
- 渲染进程禁止直接碰 Node API，只经 `ShellBridge`。本计划不新增任何 IPC 通道——分区事件走既有的事件推送。
- 注释和 commit message 用中文，与仓库现状一致。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/session/events.ts`（改） | 新增 `SectionClassifiedEvent` 接口 + 加进 `SessionEvent` union |
| `src/session/deriveMessages.ts`（改） | switch 里把新事件归进「落盘但不投影」那组 |
| `src/session/deriveSections.ts`（新） | 纯投影：事件流 → `Section[]`。无依赖，无副作用 |
| `src/main/sectionClassifier.ts`（新） | 一次模型调用 + 输入摘要 + 输出解析。不碰 store，不落盘，只回结果 |
| `src/main/index.ts`（改） | 接线：`runTurn` 之后调分类员、落盘、推送 |
| `src/renderer/src/components/SectionRail.tsx`（新） | 竖轨 UI。纯展示 + 回调，不认识事件 |
| `src/renderer/src/App.tsx`（改） | 账单统计、时间线不渲染该事件、锚点、scrollspy、挂轨 |

分层刻意保持：`deriveSections` 不知道 UI，`SectionRail` 不知道事件，`sectionClassifier` 不知道 store。三者都能单独读懂。

---

### Task 1: 事件类型（schema + 投影丢弃 + 账单）

**Files:**
- Modify: `src/session/events.ts`（末尾「额外 9」之后 + union）
- Modify: `src/session/deriveMessages.ts:282-287`
- Modify: `src/renderer/src/App.tsx:99-107`（`totalTokens`）、`src/renderer/src/App.tsx:803`（`EventRow`）
- Test: `tests/session/deriveMessages.test.ts`

**Interfaces:**
- Consumes: 无（本计划的第一块）
- Produces: `SectionClassifiedEvent { type: "section_classified"; title: string | null; model: string; usage?: TokenUsage }`，已并入 `SessionEvent` union。Task 2/3/4/5 全部依赖它。

- [ ] **Step 1: 写失败的测试**

在 `tests/session/deriveMessages.test.ts` 末尾追加：

```ts
describe("section_classified 不进模型上下文", () => {
  it("日志里插入分区事件，投影逐字节等于没有它时的投影", () => {
    const base: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "你好" },
      { seq: 2, sessionId: "s", ts: 3, type: "assistant_message", content: "在", model: "m" },
    ];
    const withSections: SessionEvent[] = [
      ...base,
      { seq: 3, sessionId: "s", ts: 4, type: "section_classified", title: "打招呼", model: "c" },
      { seq: 4, sessionId: "s", ts: 5, type: "section_classified", title: null, model: "c" },
    ];
    expect(JSON.stringify(deriveMessages(withSections))).toBe(JSON.stringify(deriveMessages(base)));
  });
});
```

（文件顶部已经 import 了 `deriveMessages` 和 `SessionEvent`，不用再加。）

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: FAIL —— TS 报 `"section_classified"` 不在 `SessionEvent` union 里。

- [ ] **Step 3: 加事件类型**

`src/session/events.ts`，在 `ImageDescribedEvent` 之后、`// ─── 联合类型` 之前插入：

```ts
/** 额外 10：分区分类（会话目录）。每个 turn 收口后跑一次便宜模型：这一段是延续
    当前分区，还是开了新分区。标题出自模型、日志里任何事件都推不出 → 必须落盘；
    但它是给人看的目录，不喂回模型 → 投影必须丢弃（同 reasoning：logged ≠ model-visible）。
    title 非空 = 从本条 seq 起进入新分区；null = 延续上一分区。
    延续那次也落一条（而不是只在开新区时落）：每次模型调用的 usage 都要有账，
    否则 token 统计从此少算一截（见 TokenUsage：消耗统计必须可从日志求和推导）。 */
export interface SectionClassifiedEvent extends SessionEventBase {
  type: "section_classified";
  /** 非空 = 新分区标题；null = 延续上一分区 */
  title: string | null;
  model: string;                 // 分类出自哪个模型（溯源）
  usage?: TokenUsage;            // 本次分类烧的 token
}
```

union 末尾加一行：

```ts
  | ImageDescribedEvent
  | SectionClassifiedEvent;
```

- [ ] **Step 4: 投影丢弃它**

`src/session/deriveMessages.ts`，在 `case "turn_ended":` 上面加一行（进同一组、共用那个 `break`）：

```ts
      case "tool_execution_started":
      case "turn_ended":
      // 分区目录是给人的导航，不是对话内容——喂回去只会污染上下文
      case "section_classified":
        break;
```

- [ ] **Step 5: 跑测试确认它通过**

Run: `npx vitest run tests/session/deriveMessages.test.ts`
Expected: PASS

- [ ] **Step 6: 账单加上它**

`src/renderer/src/App.tsx` 的 `totalTokens`（第 99 行起）改成：

```ts
/** 会话累计 token（prompt + completion）——又一个日志投影：重开 app 账不丢。
    section_classified 也算：分区分类是真花钱的模型调用，漏掉这一行统计就说谎 */
function totalTokens(events: SessionEvent[]): number {
  let sum = 0;
  for (const e of events) {
    if (
      (e.type === "assistant_message" ||
        e.type === "context_compacted" ||
        e.type === "section_classified") &&
      e.usage
    ) {
      sum += e.usage.promptTokens + e.usage.completionTokens;
    }
  }
  return sum;
}
```

- [ ] **Step 7: 时间线不渲染它**

`src/renderer/src/App.tsx` 的 `EventRow`，在 `case "tool_execution_started":` 上面插入：

```ts
    // 分区目录挂在右侧竖轨上，不进正文——每换一段话题就插一条系统行，
    // 等于把导航噪音倒进对话里
    case "section_classified":
      return null;
```

- [ ] **Step 8: 全量门禁 + 类型检查**

Run: `npm test`
Expected: PASS（全绿）

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 9: Commit**

```bash
git add src/session/events.ts src/session/deriveMessages.ts src/renderer/src/App.tsx tests/session/deriveMessages.test.ts
git commit -m "feat(events): 新增 section_classified —— 会话分区的落盘事实

标题出自模型、日志推不出 → 必须落盘；不喂回模型 → 投影丢弃
（同 reasoning：logged ≠ model-visible，测试逐字节钉住）。
延续那次也落一条：分类调用的 usage 要有账，否则 token 统计少算一截。"
```

---

### Task 2: `deriveSections` 纯投影

**Files:**
- Create: `src/session/deriveSections.ts`
- Test: `tests/session/deriveSections.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SectionClassifiedEvent`
- Produces: `interface Section { title: string; startSeq: number }` 与 `deriveSections(events: SessionEvent[]): Section[]`。Task 5 消费它。

**语义**（写代码前先记住）：每条 `section_classified` **收口**它前面那段未分类的事件（「跨度」）。跨度里第一条事件的 `seq` 就是分区起点——分类事件永远落在它所描述那段的**末尾**（时间顺序决定，改不了），所以起点在它**前面**，不是它自己。`title` 非空 = 这段跨度开一个新分区；`title === null` = 这段跨度并进上一个分区（不产生新条目）。日志尾巴上还没被分类的那段不成区——不猜标题。

- [ ] **Step 1: 写失败的测试**

Create `tests/session/deriveSections.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { deriveSections } from "../../src/session/deriveSections.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}
function user(content: string): SessionEvent {
  return { ...env(), type: "user_message", content };
}
function classify(title: string | null): SessionEvent {
  return { ...env(), type: "section_classified", title, model: "c" };
}

describe("deriveSections（分区 = 被分类事件收口的跨度）", () => {
  it("空日志 = 没有分区", () => {
    expect(deriveSections([])).toEqual([]);
  });

  it("一条分类事件 → 一个分区，起点是它前面那段的第一条事件", () => {
    seq = 0;
    const events = [user("修 bug"), user("再看看"), classify("修登录 bug")];
    expect(deriveSections(events)).toEqual([{ title: "修登录 bug", startSeq: 0 }]);
  });

  it("title 为 null 只延续，不开新分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), classify(null)];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("延续之后再开新区：新区起点是延续那条之后的第一条事件", () => {
    seq = 0;
    const events = [
      user("a"),          // 0
      classify("第一段"), // 1
      user("b"),          // 2
      classify(null),     // 3
      user("c"),          // 4
      classify("第二段"), // 5
    ];
    expect(deriveSections(events)).toEqual([
      { title: "第一段", startSeq: 0 },
      { title: "第二段", startSeq: 4 },
    ]);
  });

  it("日志尾巴上未分类的那段不成区（不猜标题）", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), user("b"), user("c")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("两条分类事件相邻（空跨度）不产生分区", () => {
    seq = 0;
    const events = [user("a"), classify("第一段"), classify("鬼分区")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 0 }]);
  });

  it("还没有任何分区时收到延续 → 那段跨度丢弃，不凭空造区", () => {
    seq = 0;
    const events = [user("a"), classify(null), user("b"), classify("第一段")];
    expect(deriveSections(events)).toEqual([{ title: "第一段", startSeq: 2 }]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/session/deriveSections.test.ts`
Expected: FAIL —— `Cannot find module '../../src/session/deriveSections.js'`

- [ ] **Step 3: 写实现**

Create `src/session/deriveSections.ts`：

```ts
// deriveSections — 从事件日志投影出会话目录（分区列表）。
//
// 纯函数：同样的 events 永远得到同样的目录。resume/replay/换机器全靠它。
//
// 语义：每条 section_classified 收口它前面那段未分类事件（「跨度」）。
// 分类事件永远落在它所描述那段的末尾（时间顺序决定），所以分区起点在它前面。
// title 非空 = 该跨度开新分区；null = 该跨度并进上一分区（不产生新条目）。

import type { SessionEvent } from "./events.js";

export interface Section {
  /** 分区标题（模型给的） */
  title: string;
  /** 本分区第一条事件的 seq——点击跳转的锚点，也是 scrollspy 的唯一依据 */
  startSeq: number;
}

/** 刻意没有 endSeq：分区的结束 = 下一分区的开始，推得出。推得出的不进接口 */
export function deriveSections(events: SessionEvent[]): Section[] {
  const sections: Section[] = [];
  // 当前未分类跨度的起点；null = 跨度是空的（还没攒到事件）
  let spanStart: number | null = null;

  for (const e of events) {
    if (e.type !== "section_classified") {
      if (spanStart === null) spanStart = e.seq;
      continue;
    }
    // 空跨度（两条分类事件相邻）：没有事件可归属，忽略
    if (spanStart === null) continue;
    // 延续但一个分区都还没有：那段无处可归，丢弃——不凭空造一个无名区
    if (e.title !== null) sections.push({ title: e.title, startSeq: spanStart });
    spanStart = null;
  }

  return sections;
}
```

- [ ] **Step 4: 跑测试确认它通过**

Run: `npx vitest run tests/session/deriveSections.test.ts`
Expected: PASS（7 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add src/session/deriveSections.ts tests/session/deriveSections.test.ts
git commit -m "feat(session): deriveSections —— 会话目录是投影，不是状态

分类事件落在它所描述那段的末尾，所以分区起点在它前面那条。
没有 endSeq：分区结束 = 下一分区开始，推得出的不进接口。"
```

---

### Task 3: 分类员（模型调用 + 输入摘要 + 输出解析）

**Files:**
- Create: `src/main/sectionClassifier.ts`
- Test: `tests/main/sectionClassifier.test.ts`
- Read for reference: `src/main/visionBridge.ts`（同构的先例）

**Interfaces:**
- Consumes: Task 1 的 `SectionClassifiedEvent`（只用它的字段形状）、`createOpenAICompatibleAdapter`（`src/model/openaiCompatible.js`）、`findModel`（`src/shared/modelCatalog.js`）
- Produces:
  - `export const SECTION_MODEL = "glm-4.5-flash"`
  - `export function currentSectionTitle(events: SessionEvent[]): string | null`
  - `export function summarizeSpan(events: SessionEvent[]): string`
  - `export function parseSectionReply(raw: string, hasSection: boolean): { title: string | null } | null`
  - `export async function classifySection(events: SessionEvent[]): Promise<{ title: string | null; model: string; usage?: TokenUsage } | null>`
  - Task 4 只调 `classifySection` 和 `SECTION_MODEL`

**关键约束**：`classifySection` **永不抛**。任何失败（无 key / HTTP 错 / JSON 烂 / 无分区时模型回延续）都返回 `null`，调用方不落事件。下一个 turn 的分类员会看到「最后一条 `section_classified` 之后的全部事件」，自动把漏掉的那段补进来——自愈，所以不做重试。

- [ ] **Step 1: 写失败的测试**

Create `tests/main/sectionClassifier.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SECTION_MODEL,
  classifySection,
  currentSectionTitle,
  parseSectionReply,
  summarizeSpan,
} from "../../src/main/sectionClassifier.js";
import type { SessionEvent } from "../../src/session/events.js";

afterEach(() => vi.unstubAllGlobals());

const log: SessionEvent[] = [
  { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/w" },
  { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "帮我修登录" },
  {
    seq: 2, sessionId: "s", ts: 3, type: "assistant_message", content: "看一下",
    model: "m", toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }],
  },
  { seq: 3, sessionId: "s", ts: 4, type: "tool_result", toolCallId: "t1", status: "ok", output: "x".repeat(9000) },
];

describe("currentSectionTitle", () => {
  it("没有分类事件 = 还没有分区", () => {
    expect(currentSectionTitle(log)).toBeNull();
  });

  it("取最后一个非空 title，延续事件不覆盖它", () => {
    const events: SessionEvent[] = [
      ...log,
      { seq: 4, sessionId: "s", ts: 5, type: "section_classified", title: "修登录", model: "c" },
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: null, model: "c" },
    ];
    expect(currentSectionTitle(events)).toBe("修登录");
  });
});

describe("summarizeSpan", () => {
  it("带上用户和助手的话、工具名；不倒 tool_result 全文", () => {
    const out = summarizeSpan(log);
    expect(out).toContain("帮我修登录");
    expect(out).toContain("read_file");
    expect(out).not.toContain("x".repeat(400));
    expect(out.length).toBeLessThan(4100);
  });
});

describe("parseSectionReply", () => {
  it("裸 JSON", () => {
    expect(parseSectionReply('{"newSection":true,"title":"修登录 bug"}', true)).toEqual({ title: "修登录 bug" });
  });

  it("带 ```json 围栏也认", () => {
    const raw = '```json\n{"newSection": false, "title": ""}\n```';
    expect(parseSectionReply(raw, true)).toEqual({ title: null });
  });

  it("烂形状 = 解析失败", () => {
    expect(parseSectionReply("我觉得应该开新章节", true)).toBeNull();
    expect(parseSectionReply('{"newSection":true,"title":""}', true)).toBeNull();
  });

  it("还没有分区时回延续 = 失败（不能一个区都开不出来）", () => {
    expect(parseSectionReply('{"newSection":false,"title":""}', false)).toBeNull();
  });
});

describe("classifySection", () => {
  it("打到 glm-4.5-flash，回标题和账单", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toContain("bigmodel.cn");
      bodies.push(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"newSection":true,"title":"修登录 bug"}' } }],
          usage: { prompt_tokens: 300, completion_tokens: 12 },
        }),
      };
    }));
    const out = await classifySection(log);
    expect(out).toEqual({
      title: "修登录 bug",
      model: SECTION_MODEL,
      usage: { promptTokens: 300, completionTokens: 12 },
    });
    expect(JSON.parse(bodies[0]!).model).toBe(SECTION_MODEL);
  });

  it("HTTP 失败 → 返回 null，绝不抛（turn 不能被目录拖垮）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "no key" })));
    await expect(classifySection(log)).resolves.toBeNull();
  });

  it("模型回垃圾 → 返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ choices: [{ message: { content: "随便说说" } }] }),
    })));
    await expect(classifySection(log)).resolves.toBeNull();
  });

  it("跨度是空的（上一条就是分类事件）→ 不调模型，直接 null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const events: SessionEvent[] = [
      ...log,
      { seq: 4, sessionId: "s", ts: 5, type: "section_classified", title: "修登录", model: "c" },
    ];
    await expect(classifySection(events)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/sectionClassifier.test.ts`
Expected: FAIL —— `Cannot find module '../../src/main/sectionClassifier.js'`

- [ ] **Step 3: 写实现**

Create `src/main/sectionClassifier.ts`：

```ts
// sectionClassifier — 会话目录的分类员。与 visionBridge 严格对称：
// 那个是 turn 前的代读员（图 → 文字），这个是 turn 后的分类员（一段对话 → 章节标题）。
// 两者都住在 engine 外面，engine 只管闭环，不认识这些外挂。
//
// 永不抛：分类失败是无害的——不落事件而已，下一个 turn 的分类员会看到
// 「最后一条 section_classified 之后的全部事件」，自动把漏掉的那段补进来。
// 自愈，所以刻意不做 429 重试（vision-bridge 必须重试是因为它失败 = turn 失败）。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { findModel } from "../shared/modelCatalog.js";
import type { SessionEvent, TokenUsage } from "../session/events.js";

/** 分类员型号：目录里的免费款。换分类员改这一行 */
export const SECTION_MODEL = "glm-4.5-flash";

/** 单条消息进摘要时的截断长度：分类只需要知道在聊什么，不需要读完 */
const PER_MESSAGE_CHARS = 300;
/** 整份摘要上限；超了保留最近的部分（近处的话题才决定当前章节） */
const SUMMARY_CHARS = 4000;

/** 当前分区标题 = 日志里最后一个非空 title。没有 = 还没有任何分区 */
export function currentSectionTitle(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "section_classified" && e.title !== null) return e.title;
  }
  return null;
}

/** 未分类跨度 = 最后一条 section_classified 之后的全部事件。
    锚点是分类事件而不是 turn 边界——分类失败时下一次自动把漏掉的那段一并吃进来 */
function unclassifiedSpan(events: SessionEvent[]): SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "section_classified") return events.slice(i + 1);
  }
  return events;
}

/** 把一段事件压成给分类员看的摘要。tool_result 全文不进——
    bash 吐的几万字对"在聊什么"毫无贡献，只会把上下文烧光 */
export function summarizeSpan(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "user_message") {
      lines.push(`用户：${e.content.slice(0, PER_MESSAGE_CHARS)}`);
    } else if (e.type === "assistant_message") {
      const text = e.content.trim();
      if (text) lines.push(`助手：${text.slice(0, PER_MESSAGE_CHARS)}`);
      const tools = (e.toolCalls ?? []).map((c) => c.name);
      if (tools.length > 0) lines.push(`助手调用工具：${tools.join("、")}`);
    } else if (e.type === "skill_invoked") {
      lines.push(`启用 skill：${e.name}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > SUMMARY_CHARS ? joined.slice(-SUMMARY_CHARS) : joined;
}

/** 解析模型回复。模型产出的 JSON 不可信——形状不对就返回 null（同 parseTodoArgs 的态度）。
    hasSection = 当前是否已有分区；没有时模型必须开一个，回延续算解析失败 */
export function parseSectionReply(raw: string, hasSection: boolean): { title: string | null } | null {
  // 便宜模型爱套 ```json 围栏，剥掉再解
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { newSection, title } = parsed as { newSection?: unknown; title?: unknown };
  if (typeof newSection !== "boolean") return null;
  if (!newSection) return hasSection ? { title: null } : null;
  if (typeof title !== "string" || title.trim() === "") return null;
  return { title: title.trim() };
}

function buildPrompt(currentTitle: string | null, span: string): string {
  return (
    "你在为一个 AI 助手会话维护「章节目录」，供用户在长对话里快速跳转。\n" +
    (currentTitle === null
      ? "当前还没有任何章节，所以这段内容必须开一个新章节。\n"
      : `当前章节标题：「${currentTitle}」\n`) +
    "以下是当前章节之后新增的对话：\n---\n" +
    span +
    "\n---\n" +
    "判断：新增内容还属于当前章节，还是话题/任务已经换了、该开新章节？\n" +
    "只回 JSON，不要解释，不要围栏：{\"newSection\": true 或 false, \"title\": \"新章节标题\"}\n" +
    "newSection 为 false 时 title 给空串。标题用名词短语，不超过 12 个字，" +
    "写具体在做什么（如「修登录超时」），别写「用户提问」这种废话。"
  );
}

/** 跑一次分类。失败一律返回 null（永不抛）——目录是锦上添花，不能拖垮 turn */
export async function classifySection(
  events: SessionEvent[]
): Promise<{ title: string | null; model: string; usage?: TokenUsage } | null> {
  const span = unclassifiedSpan(events);
  const summary = summarizeSpan(span);
  if (summary.trim() === "") return null; // 空跨度：没内容可分，别浪费一次调用

  const choice = findModel(SECTION_MODEL);
  if (!choice) return null;

  try {
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey: process.env[choice.apiKeyEnv] ?? "",
      model: choice.model,
      vision: false,
    });
    const currentTitle = currentSectionTitle(events);
    // 非流式、不带工具：分类没有直播价值，结果整段用
    const reply = await adapter.chat([
      { role: "user", content: buildPrompt(currentTitle, summary) },
    ]);
    const parsed = parseSectionReply(reply.content, currentTitle !== null);
    if (!parsed) return null;
    return {
      title: parsed.title,
      model: SECTION_MODEL,
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  } catch {
    // 无 key / 限流 / 断网 / 超时：全都无害。不落事件，下次自愈
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认它通过**

Run: `npx vitest run tests/main/sectionClassifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/sectionClassifier.ts tests/main/sectionClassifier.test.ts
git commit -m "feat(main): 分区分类员 —— turn 后判断话题是否切换

与 vision-bridge 对称：turn 前代读图，turn 后分章节，都在 engine 外。
永不抛：失败就不落事件，下个 turn 的输入锚点是最后一条 section_classified，
漏掉的那段自动被吃进来。自愈，所以不做重试。"
```

---

### Task 4: 接线进 send handler

**Files:**
- Modify: `src/main/index.ts:573`（`await agent.engine.runTurn(...)` 之后）
- Test: 无新测试（这一层是 IPC 编排，仓库现状没有 index.ts 的测试；行为已被 Task 3 的单测覆盖）

**Interfaces:**
- Consumes: Task 3 的 `classifySection`
- Produces: 运行时会往日志追加 `section_classified` 事件并推给渲染层。Task 5 消费这些事件。

- [ ] **Step 1: 接线**

`src/main/index.ts`，把第 573 行那句 `await agent.engine.runTurn(text, refs, textFiles);` 替换成：

```ts
        await agent.engine.runTurn(text, refs, textFiles);
        // 分区分类：turn 收口后跑一次便宜模型，判断话题是否换了（会话目录用）。
        // 位置与 vision-bridge 对称——那个在 turn 前，这个在 turn 后，都在 engine 外面。
        // runTurn 抛错时根本走不到这（失败的 turn 不值得分区）；aborted 会走到，
        // 半截对话也是对话，照分。
        // 失败静默：分类是锦上添花，不能反过来把成功的 turn 变成失败的（见 sectionClassifier）
        const section = await classifySection(store.load(sessionId));
        if (section) {
          const sectionEvent = store.append({
            sessionId, ts: Date.now(), type: "section_classified",
            title: section.title, model: section.model,
            ...(section.usage ? { usage: section.usage } : {}),
          });
          send(CHANNELS.event, sectionEvent);
        }
```

文件顶部导入区（`import { createVisionBridge, VISION_BRIDGE_MODEL } from "./visionBridge.js";` 那行下面）加：

```ts
import { classifySection } from "./sectionClassifier.js";
```

- [ ] **Step 2: 门禁 + 类型检查**

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 3: 手工验一次（这是本任务唯一的真验证）**

Run: `npm run dev`

做这几步：
1. 新建会话，问一个问题（例如「读一下 package.json」），等 turn 结束。
2. 换个完全不相干的话题再问一次（例如「帮我写个正则匹配邮箱」），等 turn 结束。
3. 在 app 的会话头部 → 更多 → 回放，或直接查 SQLite：
   ```bash
   sqlite3 ~/Library/Application\ Support/*/otter.db "select seq,type,payload from events where type='section_classified' order by seq"
   ```
   （数据库路径以 `src/session/store.ts` 里的实际位置为准；不确定就在 app 里回放着看。）

Expected: 两条 `section_classified`，第一条 `title` 非空，第二条因为话题换了 `title` 也非空且是两个不同标题。
若 `GLM_API_KEY` 没配：一条都不落，**但 turn 全部正常完成**——这正是「失败无害」要保住的行为。

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): turn 收口后跑分区分类并落盘

位置与 vision-bridge 对称（一个 turn 前、一个 turn 后，都在 engine 外）。
分类失败不落事件也不报错：成功的 turn 不该被目录功能拖垮。"
```

---

### Task 5: 竖轨组件 + 会话区接线

**Files:**
- Create: `src/renderer/src/components/SectionRail.tsx`
- Modify: `src/renderer/src/App.tsx`（`MAIN_COL` 那个聊天分支：`<section>` 外面包一层 flex、事件 map 里插锚点、加 scrollspy）
- Test: 无新测试（仓库现状没有渲染层组件测试，本改动不在这里开这个头）

**Interfaces:**
- Consumes: Task 2 的 `deriveSections` / `Section`
- Produces: `<SectionRail items={string[]} activeIndex={number | null} onJump={(index: number) => void} />`

**改自 react-bits `LineSidebar`（MIT）**，保留它的核心：单条 rAF 循环 + 帧率无关的指数平滑，让颜色/位移/刻度缩放同步移动，而不是一堆 CSS transition 各跑各的。三处改动：① `activeIndex` 受控（跟滚动走，不是点击驱动的内部 state）；② 收起态只亮当前分区标题，**轨宽全程不变**——hover 时整栏抖一下是这类交互最常见的翻车方式；③ 补 `prefers-reduced-motion`。

- [ ] **Step 1: 写组件**

Create `src/renderer/src/components/SectionRail.tsx`：

```tsx
// SectionRail — 会话分区目录的竖轨。
// 改自 react-bits LineSidebar（MIT）。保留：单条 rAF 循环 + 帧率无关的指数平滑，
// 颜色/位移/刻度缩放同步移动，不用一堆 CSS transition 各跑各的。
// 三处改动（设计出处 docs/superpowers/specs/2026-08-19-conversation-sections-design.md）：
// ① activeIndex 受控——亮哪条由滚动位置决定，不是点击驱动的内部 state
// ② 收起态只亮当前分区标题，其余只剩刻度线；轨宽全程不变（hover 不让消息栏重排）
// ③ prefers-reduced-motion 下关掉位移，只保留颜色

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

const PROXIMITY_RADIUS = 90;  // px：指针的影响半径
const MAX_SHIFT = 8;          // px：文字最大右移
const MARKER_LENGTH = 24;     // px：刻度线长度
const MARKER_GAP = 10;        // px：刻度线到文字的距离
const SMOOTHING_MS = 100;     // 指数平滑的时间常数
/** 标题淡入用的强 ease-out。CSS 内置那几档太软，没有"立刻响应"的手感 */
const REVEAL_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** smoothstep：比线性更像物理 */
const ease = (p: number) => p * p * (3 - 2 * p);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface SectionRailProps {
  items: string[];
  /** 当前所在分区；null = 还没滚进任何分区 */
  activeIndex: number | null;
  onJump: (index: number) => void;
}

export function SectionRail({ items, activeIndex, onJump }: SectionRailProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const targets = useRef<number[]>([]);
  const current = useRef<number[]>([]);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const activeRef = useRef<number | null>(activeIndex);
  const [hovered, setHovered] = useState(false);

  activeRef.current = activeIndex;

  // 单条 rAF：每个 item 的 --effect 朝目标做帧率无关的指数逼近。
  // 全部效果都读这一个变量 → 颜色、位移、刻度缩放永远同步，不会互相错拍
  const frame = useCallback((now: number) => {
    const dt = Math.min((now - last.current) / 1000, 0.05);
    last.current = now;
    const k = 1 - Math.exp(-dt / (SMOOTHING_MS / 1000));
    let moving = false;
    itemRefs.current.forEach((el, i) => {
      if (!el) return;
      const target = Math.max(targets.current[i] ?? 0, activeRef.current === i ? 1 : 0);
      const cur = current.current[i] ?? 0;
      const next = cur + (target - cur) * k;
      const settled = Math.abs(target - next) < 0.0015;
      const value = settled ? target : next;
      current.current[i] = value;
      el.style.setProperty("--effect", value.toFixed(4));
      if (!settled) moving = true;
    });
    raf.current = moving ? requestAnimationFrame(frame) : null;
  }, []);

  const start = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    last.current = performance.now();
    raf.current = requestAnimationFrame(frame);
  }, [frame]);

  // 触屏点一下会派发 pointerenter 并把轨永久卡在展开态（没有 leave）——
  // 临近效果本来就只对真实指针有意义，两处都只认 mouse
  const onPointerEnter = useCallback((e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") setHovered(true);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLUListElement>) => {
      if (e.pointerType !== "mouse") return;
      if (reducedMotion()) return; // 减动效：不做临近效果，颜色仍跟 active 走
      const list = listRef.current;
      if (!list) return;
      const y = e.clientY - list.getBoundingClientRect().top;
      itemRefs.current.forEach((el, i) => {
        if (!el) return;
        const center = el.offsetTop + el.offsetHeight / 2;
        targets.current[i] = ease(Math.max(0, 1 - Math.abs(y - center) / PROXIMITY_RADIUS));
      });
      start();
    },
    [start]
  );

  const onPointerLeave = useCallback(() => {
    setHovered(false);
    targets.current = targets.current.map(() => 0);
    start();
  }, [start]);

  useEffect(() => { start(); }, [activeIndex, start]);
  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  return (
    <nav
      aria-label="会话分区"
      // 宽度写死：收起/展开都是这个宽度，hover 只改文字透明度——
      // 轨一变宽消息栏就得重排，那一下抖动比目录本身还显眼
      className="hidden lg:block shrink-0 w-[184px] self-start sticky top-0 max-h-full overflow-y-auto py-4 pr-4"
      style={
        {
          "--max-shift": `${MAX_SHIFT}px`,
          paddingLeft: `${MARKER_LENGTH + MARKER_GAP}px`,
        } as CSSProperties
      }
    >
      <ul
        ref={listRef}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        className="m-0 flex list-none flex-col gap-[18px] p-0"
      >
        {items.map((label, i) => (
          <li
            key={`${label}-${i}`}
            ref={(el) => { itemRefs.current[i] = el; }}
            aria-current={activeIndex === i ? "true" : undefined}
            onClick={() => onJump(i)}
            title={label}
            // 按下时整条压暗一点：可点的东西必须对按压有反应，
            // 但这是一行文字不是按钮，用不着 scale
            className="relative cursor-pointer active:opacity-70"
          >
            <span
              aria-hidden
              className="absolute top-1/2 h-px origin-left [background-color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*100%),var(--border))] [transform:translateY(-50%)_scaleX(calc(0.7+var(--effect,0)*0.5))]"
              style={{ left: `-${MARKER_LENGTH + MARKER_GAP}px`, width: `${MARKER_LENGTH}px` }}
            />
            <span
              className="block truncate text-[11px] leading-[1.35] duration-200 [transition-property:opacity] [color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*100%),var(--muted-foreground))] [transform:translateX(calc(var(--effect,0)*var(--max-shift)))]"
              // 收起态只有当前分区的标题看得见；其余留在原位但透明——
              // 用 opacity 不用 display:none，布局才不会跟着 hover 跳
              style={{ opacity: hovered || activeIndex === i ? 1 : 0, transitionTimingFunction: REVEAL_EASE }}
            >
              {label}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 2: 类型检查（组件独立编译得过）**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 3: App 里算出分区 + 锚点**

`src/renderer/src/App.tsx`：

顶部导入区加：

```ts
import { deriveSections } from "../../session/deriveSections.js";
import { SectionRail } from "./components/SectionRail.js";
```

（`deriveTodos` 的导入就在附近，照同样的相对路径风格放。）

改 react 导入（第 4 行）——`useCallback` 和 `Fragment` 目前**没有**导入，必须加上：

```ts
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
```

在 `export function App()`（`src/renderer/src/App.tsx:2129`）里，紧跟着已有的
`const sessionTitle = ...` 那批 selector 之后加：

```ts
  // 会话目录 = 事件投影，不是 UI 状态（同 TodoPanel 的路子）
  const sections = useMemo(() => deriveSections(events), [events]);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
```

把消息滚动区 `<section className="flex-1 overflow-y-auto ...">` 加上 `ref={scrollRef}`，并把里面的 `events.map` 改成插锚点的版本：

```tsx
            {events.map((e) => {
              const sectionIndex = sections.findIndex((s) => s.startSeq === e.seq);
              return (
                <Fragment key={e.seq}>
                  {/* 分区锚点：零高度、不参与布局，只给跳转和 scrollspy 一个可测量的位置。
                      不给每条消息挂 data-seq —— EventRow 有的分支返回 Fragment，
                      外面再包一层 div 会把 self-end 之类的对齐全弄坏 */}
                  {sectionIndex !== -1 && (
                    <div data-section={sectionIndex} aria-hidden className="h-0 scroll-mt-4" />
                  )}
                  <EventRow event={e} all={events} />
                </Fragment>
              );
            })}
```

`Fragment` 从 react 导入（文件顶部 `import { ... } from "react";` 里加 `Fragment`）。

- [ ] **Step 4: scrollspy + 跳转**

在同一个组件里，`sections` 声明之后加：

```ts
  // 当前分区：IntersectionObserver 只当"位置变了"的廉价触发器，
  // 真判定靠回调里一次性读那几个锚点的 rect（锚点数就是分区数，个位数，读得起）。
  // 不挂 scroll 事件逐帧读 rect —— 那是每帧一次强制重排
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sections.length === 0) return;
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-section]"));
    if (anchors.length === 0) return;

    const recompute = () => {
      // 判定线：容器顶部往下 15% —— 用户读的是屏幕上方那段，不是正中间
      const line = root.getBoundingClientRect().top + root.clientHeight * 0.15;
      let active: number | null = null;
      for (const a of anchors) {
        if (a.getBoundingClientRect().top <= line) {
          active = Number(a.dataset["section"]);
        }
      }
      setActiveSection(active);
    };

    const io = new IntersectionObserver(recompute, { root, threshold: 0 });
    anchors.forEach((a) => io.observe(a));
    recompute();
    return () => io.disconnect();
  }, [sections]);

  const jumpToSection = useCallback((index: number) => {
    const root = scrollRef.current;
    const anchor = root?.querySelector<HTMLElement>(`[data-section="${index}"]`);
    anchor?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);
```

（`useCallback` 已在 Step 3 加进 react 导入。）

**已知交互，不在本次修**：`App` 里已有一个「每来一条事件就滚到底」的 effect
（`src/renderer/src/App.tsx:2199`）。turn 跑着的时候点分区跳转，会被下一条事件拽回底部。
turn 空闲时（用户翻历史的正常场景）不受影响，所以先不动它——要修得改自动滚动的策略
（"贴底才自动滚"），那是另一件事，别混进这个 PR。

- [ ] **Step 5: 把轨挂上去**

把消息滚动区 `<section>` 和轨包进一层横向 flex。原来是：

```tsx
          <section className="flex-1 overflow-y-auto ...">
            ...
          </section>
```

改成：

```tsx
          {/* 消息区 + 目录轨并排。min-h-0 是必须的：不给的话 flex 子项按内容撑高，
              overflow-y-auto 永远出不来滚动条 */}
          <div className="flex-1 min-h-0 flex">
            <section ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-stable px-5 pt-4 pb-12 flex flex-col gap-2">
              ...原样不动...
            </section>
            {/* 只有一个分区时目录没有意义，把宽度还给对话 */}
            {sections.length >= 2 && (
              <SectionRail
                items={sections.map((s) => s.title)}
                activeIndex={activeSection}
                onJump={jumpToSection}
              />
            )}
          </div>
```

注意：原 `<section>` 的 `flex-1` 保留并补上 `min-w-0`（否则长代码块会把它撑爆、挤掉轨）。

- [ ] **Step 6: 门禁 + 类型检查**

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 7: 手工验**

Run: `npm run dev`

1. 造一个至少两个话题的会话（接着 Task 4 那个会话继续用最省事）。
2. 右侧应出现一列刻度线，**只有当前分区的标题可见**，其余是纯刻度。
3. 鼠标移进轨区：全部标题淡入，靠近指针的那条变亮并右移一点；**消息栏不能有任何横向位移**（这是判定 ② 有没有做对的唯一标准）。
4. 点某条 → 消息区平滑滚到那一段；滚动条手动上下拖，轨上亮的那条要跟着换。
5. 窗口缩到 1024px 以下：轨消失（`lg:` 断点），消息区占满。
6. 系统设置里开「减弱动态效果」后重开 app：轨仍可用、颜色仍变，但没有位移，跳转是瞬移不是平滑滚动。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/SectionRail.tsx src/renderer/src/App.tsx
git commit -m "feat(ui): 会话分区竖轨 —— 长对话的目录与跳转

改自 react-bits LineSidebar（MIT），三处改动：activeIndex 受控跟滚动走、
收起态只亮当前分区标题且轨宽全程不变（hover 不让消息栏重排）、补 reduced-motion。
锚点只插在分区起点：EventRow 有分支返回 Fragment，逐条包 div 会毁掉对齐。"
```

---

### Task 6: ADR + issue（AGENTS.md 要求的流程动作）

**Files:**
- Create: `docs/adr/00NN-会话分区事件.md`（`NN` = 合并前实际可用的编号）

**Interfaces:**
- Consumes: 前五个任务的全部实现（ADR 记录的是它们背后的决策）
- Produces: 无代码产物

- [ ] **Step 1: 认领编号**

Run: `git fetch origin && ls docs/adr/ | tail -3`

当前最大是 `0030`，所以默认写 `0031`。但仓库里还有别的 lane 在跑（见 AGENTS.md「Parallel shifts」）——**如果 `0031` 已被占用就顺延**，这一步就是为了当场确认，不要照抄计划里的数字。

- [ ] **Step 2: 开 Task issue**

```bash
gh issue create --title "会话分区总结 + 侧边跳转条" --body "长会话缺导航：用户记得聊过什么，但只能靠滚动条找回去。

实现：每个 turn 收口后跑一次便宜模型判断话题是否切换，结果落 section_classified 事件；
右侧竖轨（改自 react-bits LineSidebar）把分区排成目录，点击跳转。

设计：docs/superpowers/specs/2026-08-19-conversation-sections-design.md
计划：docs/superpowers/plans/2026-08-19-conversation-sections.md"
```

记下返回的 issue 号，下一步和 PR 都要引用。

- [ ] **Step 3: 写 ADR**

Create `docs/adr/0034-会话分区事件.md`（编号按 Step 1 的结果；实际落到 0034——0031/0032/0033 在评审期间被别的 lane 陆续占走）：

```markdown
# ADR-0031：会话分区是事件，不是投影

## 背景

长会话里滚动条是唯一的导航手段。分界线是语义的（话题变了），不是结构的
（turn 边界到处都是，一个话题常跨好几个 turn），所以只能让模型来分。

## 决策

1. 分类结果落成新事件 `section_classified { title: string | null, model, usage? }`。
   标题出自模型、日志里任何事件都推不出 → 硬规则要求落盘。但它不喂回模型 →
   投影（deriveMessages）必须丢弃（同 reasoning：logged ≠ model-visible，有测试逐字节钉住）。
2. **每个 turn 都落一条**，包括「延续上一分区」那次（title 为 null），而不是
   只在开新分区时落一条 `section_started`。后者更省、也更符合「推得出的不落盘」，
   但延续那几次调用的 usage 会就地蒸发，token 统计从此少算一截——而
   TokenUsage 的契约是「消耗统计可从日志求和推导」。用几十字节换账单诚实。
3. 分类员住在 main/index.ts 的 send handler 里、runTurn 之后，与 turn 前的
   vision-bridge 严格对称。engine 只管闭环，不认识这些外挂。
4. 分类失败一律静默（不落事件、不抛）。输入锚点是「最后一条 section_classified
   之后的全部事件」而不是「本 turn 的事件」，所以漏掉的那段下次自动被吃进来。
   自愈 → 刻意不做重试（vision-bridge 必须重试，是因为它失败等于 turn 失败）。
5. 固定用目录里的免费款 `glm-4.5-flash`，不跟会话当前模型走：分段命名是低难度活，
   不值得在贵模型会话里每 turn 多烧一笔。型号落进事件，溯源不失真。

## 代价

- 每个 turn 多一次模型调用。选免费款 + 摘要输入（不倒 tool_result 全文）把它压到最小。
- 旧日志没有这类事件 = 没有目录。不批量回填。

## 备选与否决

- **`section_started`（只在开新区落）**：见决策 2，账单会说谎，否决。
- **纯启发式分区（turn 边界 / 时间间隔）**：不花钱，但分不出话题，标题只能是
  「第 3 轮」这种废话，等于没有目录。否决。
- **分区标题进模型上下文**：那是 /compact 的活，不是目录的活。否决。
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/
git commit -m "docs(adr): 0031 会话分区是事件，不是投影

记录三个非默认取舍：每 turn 都落盘（含延续）保住 token 账单诚实、
分类员在 engine 外与 vision-bridge 对称、失败静默靠输入锚点自愈而不重试。"
```

- [ ] **Step 5: 开 PR**

```bash
git push -u origin claude/conversation-partition-sidebar-31a5a6
gh pr create --title "会话分区总结 + 侧边跳转条" --body "Closes #<Step 2 的 issue 号>

- 新事件 section_classified：落盘但不投影（logged ≠ model-visible）
- deriveSections 纯投影 + SectionRail 竖轨（改自 react-bits LineSidebar，MIT）
- 分类员在 engine 外，与 vision-bridge 对称；失败静默自愈

设计 docs/superpowers/specs/2026-08-19-conversation-sections-design.md
ADR docs/adr/0034-会话分区事件.md"
```

CI 绿了之后自己合（AGENTS.md「PR disposition」：作者 agent 自己合，用 merge commit，不 squash）。本 PR 不碰 AGENTS.md，属于普通代码改动，不需要 L1 批准。
