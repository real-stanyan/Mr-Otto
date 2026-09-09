# 云会话的名字与最近参与的人 —— 实施计划（#1213）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让团队侧栏的云会话有一个模型起的名字（话题漂了会重起），并在每行右边画出「最近有过对话的那个 5 小时窗里参与过的人类成员」。

**Architecture:** 两件事共用一个挂载点（runtime 的 `say()` / `notify()`）和一张表（`workspace_sessions`：标题用已有的 `title` 列，参与者加两列）。判据全部是**日志的纯投影**（`src/shared/sessionParticipants.ts`），runtime 把投影写进 Supabase，桌面直查那张表。**协议不进位、不新增事件类型**。

**Tech Stack:** TypeScript strict / vitest / Electron 主进程 + 渲染进程 / `services/runtime`（Node daemon on VPS）/ Supabase（PostgREST + RLS）/ edge Worker 的 `/llm/v1` 网关

**Spec:** `docs/superpowers/specs/2026-09-09-cloud-session-title-participants-design.md`

## Global Constraints

- 门禁命令逐字是 `npm test`（= `tsc --noEmit` + `vitest run`）。内循环可以用 `npx vitest run <文件>`，但**每个 Task 的最后一步提交前必须跑一次完整 `npm test`**。
- TypeScript strict + `exactOptionalPropertyTypes`：**不许把 `undefined` 显式塞进可选字段**，用 `...(x !== undefined ? { k: x } : {})` 的写法（仓库既有纪律）。
- 测试统一放 `tests/`，镜像 `src/` 与 `services/` 结构，**不与源码同目录**。
- 渲染层**禁止** import 主进程模块（`tests/architecture.test.ts` 会红）。`src/renderer/src/lib/workspaceView.ts` 的 `CloudSessionListRow` 与 `src/main/supabaseWorkspacesApi.ts` 的 `CloudSessionRow` 形状相同但**各留一份**，两处都要改。
- 工具实现只依赖 `ExecutionWorld`，**禁止直接 import `fs` / `child_process`**（本计划不碰工具层，但架构断言对整棵树生效）。
- `services/runtime/` 直接 import `src/shared/` 是既有做法（先例：`workFiles.ts` import `src/shared/files.ts`），路径用 `../../../src/shared/xxx.js`（**带 `.js` 后缀**，ESM）。
- 提交信息写**为什么**不只写做了什么；每个 Task 一个提交。
- 事件日志 append-only 且必须向后兼容：本计划**只用已有的 `session_autotitled` 事件类型**，一个新类型都不加。
- 窗口长度常量逐字是 `5 * 60 * 60 * 1000`，只在 `src/shared/sessionParticipants.ts` 定义一次。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `src/shared/sessionParticipants.ts` | 纯投影：谁算「人类发言」、5 小时窗口怎么切、最后一个有对话的窗里有谁 |
| `services/runtime/src/sessionTitler.ts` | 标题：提示词 / 解析 / 一次网关调用 / 档位判据。不碰 store，不知道 sessionService 存在（形状抄 `dispatch.ts`） |
| `services/runtime/src/cloudSessionMeta.ts` | `workspace_sessions` 那三格（title / participants / participants_window）的写入口。接口 + 内存假件 + Supabase 实现（分层抄 `mentionInbox.ts`） |
| `supabase/migrations/0034_cloud_session_participants.sql` | 加两列，幂等 |
| `tests/shared/sessionParticipants.test.ts` | |
| `tests/runtime/sessionTitler.test.ts` | |
| `tests/renderer/WorkspaceSessionRow.test.tsx` | 侧栏那一行真渲染一遍 |

**修改**

| 文件 | 改什么 |
|---|---|
| `services/runtime/src/sessionService.ts` | 装配时播种两份内存状态；`notify` 里推进参与者；`say()` 两个出口各挂一次标题维护；`CloudSessionOpts` 加 `sessionMeta`（必需）与 `retitle`（可选） |
| `services/runtime/src/daemon.ts` | 装配 `createSupabaseCloudSessionMeta` + `retitle` 的 owner 包装 |
| `src/main/supabaseWorkspacesApi.ts` | `CloudSessionRow` 加 `participantUids`，`listCloudSessions` 的 select 多两格 |
| `src/renderer/src/lib/workspaceView.ts` | `CloudSessionListRow` / `CloudSessionRowView` 各加 `participantUids`，`cloudSessionRows` 带出来 |
| `src/renderer/src/lib/cloudTimeline.ts` | `hiddenFromCloudTimeline` 加第 ⑧ 条 |
| `src/renderer/src/store.ts` | `session_autotitled` → 重拉清单；人类发言 → 本地并进那行的参与者 |
| `src/renderer/src/components/WorkspacesSidebarSection.tsx` | 会话行加头像堆；`focus` 时重拉清单 |
| `tests/runtime/sessionService.test.ts` | 已有假件补 `sessionMeta`；新增标题/参与者断言 |
| `tests/renderer/cloudTimeline.test.ts`（若不存在则并入既有同族文件） | 第 ⑧ 条 |

---

## Task 1: 纯投影 —— 谁算人类发言、窗口怎么切

**Files:**
- Create: `src/shared/sessionParticipants.ts`
- Test: `tests/shared/sessionParticipants.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`（`src/session/events.ts`）
- Produces:
  - `PARTICIPANT_WINDOW_MS: number`
  - `windowIndexOf(ts: number): number`
  - `humanSpeakerOf(e: SessionEvent): string | null`
  - `interface ParticipantWindow { window: number; uids: string[] }`
  - `lastActiveWindowParticipants(events: readonly SessionEvent[]): ParticipantWindow | null`
  - `advanceParticipants(cur: ParticipantWindow | null, e: SessionEvent): ParticipantWindow | null`
  - `countHumanMessages(events: readonly SessionEvent[]): number`

- [ ] **Step 1: 写失败的测试**

创建 `tests/shared/sessionParticipants.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  PARTICIPANT_WINDOW_MS,
  advanceParticipants,
  countHumanMessages,
  humanSpeakerOf,
  lastActiveWindowParticipants,
  windowIndexOf,
} from "../../src/shared/sessionParticipants.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造一条群里的人话（chat_message：只跟人说话、没起 turn 的那种） */
function chat(seq: number, ts: number, fromUid: string): SessionEvent {
  return { seq, sessionId: "s", ts, type: "chat_message", fromUid, label: "L", content: "hi", mention: false };
}
/** 造一条起了 turn 的人话（user_message：say() 拼过前缀的那种） */
function user(seq: number, ts: number, fromUid: string, extra: Record<string, unknown> = {}): SessionEvent {
  return { seq, sessionId: "s", ts, type: "user_message", content: "[L]: hi", fromUid, ...extra } as SessionEvent;
}

const W = PARTICIPANT_WINDOW_MS;

describe("windowIndexOf", () => {
  it("按 5 小时切成不重叠的桶，边界归后一个桶", () => {
    expect(windowIndexOf(0)).toBe(0);
    expect(windowIndexOf(W - 1)).toBe(0);
    expect(windowIndexOf(W)).toBe(1);
    expect(windowIndexOf(2 * W + 5)).toBe(2);
  });
});

describe("humanSpeakerOf", () => {
  it("chat_message 与带 fromUid 的 user_message 算人类发言", () => {
    expect(humanSpeakerOf(chat(1, 0, "u1"))).toBe("u1");
    expect(humanSpeakerOf(user(2, 0, "u2"))).toBe("u2");
  });

  it("系统旁白不算 —— fromUid 是保留名 system", () => {
    expect(humanSpeakerOf(chat(1, 0, "system"))).toBeNull();
  });

  it("接力开场白不算：它的 fromUid 是点火那个人，几小时后不该替他重新参与一次", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { relay: { fromAgentId: "a", toAgentId: "b", depth: 1 } }))).toBeNull();
  });

  it("语音通话的招呼开场白同理不算", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { greeting: true }))).toBeNull();
  });

  it("agent 的话没有 fromUid，天然不算", () => {
    const a = { seq: 1, sessionId: "s", ts: 0, type: "assistant_message", content: "x", agentId: "admin" } as SessionEvent;
    expect(humanSpeakerOf(a)).toBeNull();
  });

  it("分类器派活的那条照常算 —— 那就是人自己打出来的话", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { mentions: ["admin"], dispatch: "auto" }))).toBe("u1");
  });
});

describe("lastActiveWindowParticipants", () => {
  it("一条人类发言都没有 → null", () => {
    expect(lastActiveWindowParticipants([])).toBeNull();
    const onlySystem = [chat(1, 0, "system")];
    expect(lastActiveWindowParticipants(onlySystem)).toBeNull();
  });

  it("只算最后一个有对话的窗，更早那个窗里的人不进名单", () => {
    const events = [chat(1, 0, "u1"), chat(2, W + 10, "u2"), chat(3, W + 20, "u3")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 1, uids: ["u2", "u3"] });
  });

  it("当前时刻早已过期也照样报最后那个有对话的窗（不会变空）", () => {
    const events = [chat(1, 3 * W + 1, "u9")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 3, uids: ["u9"] });
  });

  it("去重，且按首次出现的顺序（叠罗汉画序不因为谁又说了一句而整排跳动）", () => {
    const events = [chat(1, 0, "a"), chat(2, 1, "b"), chat(3, 2, "a"), chat(4, 3, "c")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 0, uids: ["a", "b", "c"] });
  });
});

describe("advanceParticipants", () => {
  it("同一个窗里并入新的人", () => {
    const cur = { window: 0, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 10, "b"))).toEqual({ window: 0, uids: ["a", "b"] });
  });

  it("跨进新窗 = 整份换掉，不是并集", () => {
    const cur = { window: 0, uids: ["a", "b"] };
    expect(advanceParticipants(cur, chat(2, W, "c"))).toEqual({ window: 1, uids: ["c"] });
  });

  it("没变就回同一个引用（调用方据此决定要不要打网络）", () => {
    const cur = { window: 0, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 10, "a"))).toBe(cur);
    expect(advanceParticipants(cur, chat(3, 10, "system"))).toBe(cur);
  });

  it("时钟回拨不让窗口倒退", () => {
    const cur = { window: 5, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 0, "b"))).toBe(cur);
  });
});

describe("countHumanMessages", () => {
  it("只数人类发言", () => {
    const events = [chat(1, 0, "a"), chat(2, 1, "system"), user(3, 2, "b"), user(4, 3, "c", { greeting: true })];
    expect(countHumanMessages(events)).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/shared/sessionParticipants.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/sessionParticipants.js"`

- [ ] **Step 3: 写实现**

创建 `src/shared/sessionParticipants.ts`：

```ts
// sessionParticipants —— 「最近谁在这条会话里说过话」的纯投影（#1213）。
//
// 云会话侧栏那行右边要画一排头像，回答的是「最近有过对话的那个 5 小时窗里，
// 有哪些人类成员参与过」。窗口是**固定窗**（floor(ts / 5h) 切成不重叠的桶），
// 显示的永远是**最后一个有过对话的窗**——所以一旦有过对话这一格就不会再变空，
// 也不需要一个定时器让它到点过期。这条化简掉了历史维度：只有一个当前值。
//
// runtime 把这个投影写进 `workspace_sessions` 的两列，桌面直查那张表——权威日志
// 在 VPS 上，桌面够不着（要先开一条会话房才读得到 backlog），而这一格必须在一条
// 会话都没开的时候就画得出来（同 #1064 点名角标的形状）。**库是投影不是事实**。
//
// 放 shared 而不是 services/runtime：窗口长度这个数桌面写文案时要用（「最近 5 小时」），
// 同一个数在两处各写一遍必然分家。

import type { SessionEvent } from "../session/events.js";

/** 一个窗口多长。**只在这里定义一次** */
export const PARTICIPANT_WINDOW_MS = 5 * 60 * 60 * 1000;

/** 时刻 → 窗口编号。固定窗按 epoch 切，边界归后一个窗 */
export function windowIndexOf(ts: number): number {
  return Math.floor(ts / PARTICIPANT_WINDOW_MS);
}

/**
 * 这条事件是不是「有个人真的打出来的一句话」；是就回他的 uid。
 *
 * 三条：
 * - `chat_message` 且 `fromUid` 不是保留名 `system`（系统旁白不是人说的）；
 * - `user_message` 且 `fromUid` 在场、**且 `relay` / `greeting` 都缺席**；
 * - agent 的话走 `assistant_message`，压根没有 `fromUid`，天然不进。
 *
 * 排除 relay / greeting 是这条判据里唯一不显然的一处：那两种开场白的 `fromUid`
 * 是**点火的那个人**（ADR-0223 §4.2 / #1174），不排除的话一条接力链会在几小时
 * 之后、在他早就离开的窗里，替他重新「参与」一次。判据与 `hiddenFromCloudTimeline`
 * 第 ①⑦ 条逐字相同——问的是同一件事。
 *
 * `dispatch: "auto"` 的那条**照常算**：那就是人自己打出来的话，只是收件人由分类器
 * 挑的（#1153）。
 */
export function humanSpeakerOf(e: SessionEvent): string | null {
  if (e.type === "chat_message") {
    return e.fromUid !== "" && e.fromUid !== "system" ? e.fromUid : null;
  }
  if (e.type === "user_message") {
    if (e.relay !== undefined || e.greeting !== undefined) return null;
    return e.fromUid !== undefined && e.fromUid !== "" ? e.fromUid : null;
  }
  return null;
}

/** 最后一个有过人类发言的窗，以及那个窗里说过话的人（首次出现的顺序、已去重） */
export interface ParticipantWindow {
  window: number;
  uids: string[];
}

/**
 * 从日志算出当前该显示的那一份。倒着扫，找最后一条人类发言、算它的窗，继续往前
 * 收同窗的人，越过窗起点就停——**有界**（一个 5 小时窗里的消息数），不扫全量。
 *
 * 顺序是**首次出现**：先倒着收原始序列（不去重），再反过来去重。按最近说话的排前面
 * 会让那排头像因为谁又说了一句就整排跳动。
 */
export function lastActiveWindowParticipants(events: readonly SessionEvent[]): ParticipantWindow | null {
  let window: number | null = null;
  const backwards: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const uid = humanSpeakerOf(e);
    if (uid === null) continue;
    const w = windowIndexOf(e.ts);
    if (window === null) window = w;
    else if (w < window) break;
    backwards.push(uid);
  }
  if (window === null) return null;
  const uids: string[] = [];
  for (const uid of backwards.reverse()) if (!uids.includes(uid)) uids.push(uid);
  return { window, uids };
}

/**
 * 增量推进（装配时整份折叠一次、之后每条事件推一步，同 sessionService 里
 * `relayBounds` / `voiceCall` 的手法）。**没变时回同一个引用**——调用方据此决定
 * 要不要打一次网络。时钟回拨（更早的窗）一律忽略，不让窗口倒退。
 */
export function advanceParticipants(
  cur: ParticipantWindow | null,
  e: SessionEvent
): ParticipantWindow | null {
  const uid = humanSpeakerOf(e);
  if (uid === null) return cur;
  const w = windowIndexOf(e.ts);
  if (cur === null || w > cur.window) return { window: w, uids: [uid] };
  if (w < cur.window) return cur;
  return cur.uids.includes(uid) ? cur : { window: cur.window, uids: [...cur.uids, uid] };
}

/** 这条会话累计有多少条人类发言（标题的档位判据用它） */
export function countHumanMessages(events: readonly SessionEvent[]): number {
  let n = 0;
  for (const e of events) if (humanSpeakerOf(e) !== null) n++;
  return n;
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/shared/sessionParticipants.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 跑完整门禁**

Run: `npm test`
Expected: 全绿。若 `tests/architecture.testDiscovery.test.ts` 红，说明新测试文件没落进 `vitest.config.ts` 的 `include`——按它的错误信息改文件名/位置，不要改 include。

- [ ] **Step 6: 提交**

```bash
git add src/shared/sessionParticipants.ts tests/shared/sessionParticipants.test.ts
git commit -m "feat(cloud): 「最近谁说过话」的纯投影——固定 5 小时窗，取最后一个有对话的那个（#1213）

窗口是固定窗、显示的永远是最后一个有过对话的窗，所以一旦有过对话这一格
就不会再变空，也不需要定时器让它到点过期——这条化简掉了历史维度，参与者
因此是 workspace_sessions 的两列而不是一张新表。

relay/greeting 两种开场白的 fromUid 是点火那个人，不排除的话一条接力链会在
几小时后、在他早就离开的窗里替他重新「参与」一次。判据与 hiddenFromCloudTimeline
第 ①⑦ 条逐字相同——问的是同一件事。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: 标题模块 —— 提示词 / 解析 / 档位 / 一次网关调用

**Files:**
- Create: `services/runtime/src/sessionTitler.ts`
- Test: `tests/runtime/sessionTitler.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `countHumanMessages`（调用方用，不在本模块）；`dispatchContext` / `promptSafe` / `promptSafeBody`（已有）
- Produces:
  - `TITLE_MAX_CHARS = 14` / `TITLE_SEED_MAX_CHARS = 40` / `TITLE_TIMEOUT_MS = 6000` / `TITLE_EVERY = 5`
  - `titleStepFor(n: number): "seed" | "model" | "none"`
  - `seedTitleFrom(text: string): string`
  - `parseTitleReply(raw: string): string | null`
  - `titlePrompt(input: TitleInput): string`
  - `interface TitleInput { currentTitle: string; context: readonly string[] }`
  - `requestTitle(deps: TitleDeps, input: TitleInput, models: readonly string[]): Promise<string | null>`
  - `requestTitleAsOwner(deps: OwnerTitleDeps, input: TitleInput, models: readonly string[]): Promise<string | null>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/runtime/sessionTitler.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  TITLE_MAX_CHARS,
  parseTitleReply,
  requestTitle,
  seedTitleFrom,
  titlePrompt,
  titleStepFor,
} from "../../services/runtime/src/sessionTitler.js";

describe("titleStepFor", () => {
  it("第 1 条人类发言走首行兜底（不打网关）", () => {
    expect(titleStepFor(1)).toBe("seed");
  });

  it("第 2 条起第一次模型命名，之后每 5 条重判一次", () => {
    expect(titleStepFor(2)).toBe("model");
    expect(titleStepFor(7)).toBe("model");
    expect(titleStepFor(12)).toBe("model");
  });

  it("其余什么都不做", () => {
    expect(titleStepFor(0)).toBe("none");
    expect(titleStepFor(3)).toBe("none");
    expect(titleStepFor(6)).toBe("none");
  });
});

describe("seedTitleFrom", () => {
  it("取首行、去空白", () => {
    expect(seedTitleFrom("  帮我看下这个报表  \n第二行")).toBe("帮我看下这个报表");
  });

  it("超长截断加省略号", () => {
    const long = "字".repeat(60);
    const out = seedTitleFrom(long);
    expect(out.length).toBe(41);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空白正文回空串——调用方据此不写库", () => {
    expect(seedTitleFrom("   \n  ")).toBe("");
  });
});

describe("parseTitleReply", () => {
  it("KEEP 回 null（不改标题）", () => {
    expect(parseTitleReply("KEEP")).toBeNull();
    expect(parseTitleReply("  keep\n")).toBeNull();
  });

  it("正常标题取首行、剥引号、截断", () => {
    expect(parseTitleReply("「奶茶店选址」")).toBe("奶茶店选址");
    expect(parseTitleReply('"Q4 营销预算"\n（理由略）')).toBe("Q4 营销预算");
    expect(parseTitleReply("字".repeat(30))).toBe("字".repeat(TITLE_MAX_CHARS));
  });

  it("空串 / 只有标点 → null（认不出来一律回落，不是编一个）", () => {
    expect(parseTitleReply("")).toBeNull();
    expect(parseTitleReply("。。。")).toBeNull();
  });
});

describe("titlePrompt", () => {
  it("把当前标题一起给模型——这是「多数轮回 KEEP」的全部原因", () => {
    const p = titlePrompt({ currentTitle: "老名字", context: ["[张三]: 今天聊点别的"] });
    expect(p).toContain("老名字");
    expect(p).toContain("今天聊点别的");
  });

  it("还没有标题时说清楚是「还没有」，不是留一个空位", () => {
    expect(titlePrompt({ currentTitle: "", context: [] })).toContain("（还没有标题）");
  });
});

describe("requestTitle", () => {
  const input = { currentTitle: "老名字", context: ["[张三]: 换个话题"] };

  it("模型回新标题就用新标题", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "新名字" } }] }),
    });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap", "pricey"]))
      .resolves.toBe("新名字");
    // 用的是最便宜那款（me.models 是从便宜到贵有序的，ADR-0237）
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as { model: string };
    expect(body.model).toBe("cheap");
  });

  it("网关非 2xx → null，标题保持现状", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });

  it("fetch 抛错 → null，不往外抛（命名失败不该让发言失败）", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });

  it("一款型号都没有 → null，一次网络都不打", async () => {
    const fetchImpl = vi.fn();
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, []))
      .resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("模型没回正文 → null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/runtime/sessionTitler.test.ts`
Expected: FAIL — 解析不到 `services/runtime/src/sessionTitler.js`

- [ ] **Step 3: 写实现**

创建 `services/runtime/src/sessionTitler.ts`：

```ts
// sessionTitler —— 云会话的名字（#1213）。
//
// 建云会话时 `workspace_sessions.title` 写死空串，此后没有任何一处更新它——所以
// 侧栏那一列全是 `displaySessionTitle` 的兜底「新会话」（#925）。本机那条路有
// `session_autotitled`（搭便宜模型的合并调用），云端一条都没有。
//
// 这个文件只有纯逻辑加一次网关调用；**不碰 store，不知道 sessionService 存在**
// （形状逐处抄 dispatch.ts）。谁来调、调完怎么落盘都在 sessionService 那一侧。
//
// ## 三条判据
//
// ① **挂在人类发言之后，不挂在 turn 收口上**：群聊里人可以只跟人说话（解出空名单
//    时只落一条 chat_message，一个 turn 都不起），挂 turn 上那种会话永远不会被命名。
// ② **第 1 条人类发言走首行兜底，不打网关**：与本机那条标题投影同一口径（手动改名 >
//    session_autotitled > 第一条 user_message 首行）。云端 title 是 Supabase 一列、
//    没有这个投影，所以要显式写一次。它同时是模型那条路的降级出口。第一次模型命名
//    排在第 2 条：只有一句「你能听到吗」时模型也只能起个烂名字。
// ③ **重判把当前标题一起给模型**：这是「话题漂了就重命名」不至于让侧栏那行字天天
//    乱变的全部原因——多数轮回 KEEP。不给当前标题、每次重起一个名字的话，同一段
//    对话会因为措辞抖动被反复改名，而「人找不到刚才那条会话」比「名字略旧」贵得多。
//
// 任何失败一律回落「今天的行为」：不改标题（ADR-0237 那条纪律）。

import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { promptSafe, promptSafeBody } from "../../../src/shared/promptSafe.js";

/** 模型起的标题最长几个字。侧栏那一行可用宽度约 230px，还要给头像堆和角标让位 */
export const TITLE_MAX_CHARS = 14;
/** 首行兜底截多长。它是原文不是浓缩，给宽一点，由渲染层 truncate 收尾 */
export const TITLE_SEED_MAX_CHARS = 40;
/** 命名超时。它跑在 say() 回执之外（fire-and-forget），但仍要有上限——一个挂着的
    请求会一直占着 owner 的一个并发额度 */
export const TITLE_TIMEOUT_MS = 6000;
/** 隔几条人类发言重判一次 */
export const TITLE_EVERY = 5;
/** 便宜档多是推理模型，思考 token 也算在 completion 里（ADR-0237 真机上 8 个
    completion token 里 7 个是 reasoning）；这里要它回一个短标题，给宽一点 */
const TITLE_MAX_TOKENS = 64;

/** 第 n 条人类发言之后该做什么。判据见文件头 ②：n===1 兜底、n===2 起每 5 条重判 */
export function titleStepFor(n: number): "seed" | "model" | "none" {
  if (n === 1) return "seed";
  if (n >= 2 && (n - 2) % TITLE_EVERY === 0) return "model";
  return "none";
}

/** 首行兜底：取首行、去空白、超长截断。全是空白回空串——调用方据此不写库 */
export function seedTitleFrom(text: string): string {
  const first = (text.split("\n")[0] ?? "").trim();
  if (first === "") return "";
  return first.length > TITLE_SEED_MAX_CHARS ? `${first.slice(0, TITLE_SEED_MAX_CHARS)}…` : first;
}

export const TITLE_SYSTEM = [
  "你在给一个团队群聊的会话起名字。",
  "先看当前标题：如果它仍然说得清这段对话在聊什么，回一个词 KEEP。",
  "只有话题确实换了、当前标题已经对不上了，才回一个新标题。",
  `新标题要求：一行、不超过 ${TITLE_MAX_CHARS} 个字、不加引号、不加标点结尾、不要解释。`,
  "回 KEEP 或新标题，不要回别的。",
].join("\n");

export interface TitleInput {
  /** 此刻的标题；空串 = 还没有 */
  currentTitle: string;
  /** 最近几句群里说出口的话，旧在前（dispatchContext 的产物） */
  context: readonly string[];
}

/** user 那一条的正文。当前标题与对话都过 promptSafe/promptSafeBody——它们来自
    成员可写的字段，换行与 `]` 能撑破结构（同 dispatchPrompt 的纪律） */
export function titlePrompt(input: TitleInput): string {
  const cur = input.currentTitle.trim();
  return [
    `当前标题：${cur === "" ? "（还没有标题）" : promptSafe(cur)}`,
    "",
    "最近的对话：",
    input.context.length > 0 ? input.context.map((l) => promptSafeBody(l)).join("\n") : "（没有更早的对话）",
  ].join("\n");
}

/**
 * 模型的回答 → 新标题；`null` = 不改。
 *
 * **认不出来一律 null**，不是「默认保持」也不是「默认重起」——`null` 的调用方语义
 * 就是「这次没成功，什么都不做」（同 parseDifficulty / parseDispatchReply）。
 */
export function parseTitleReply(raw: string): string | null {
  const first = (raw.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (first === "") return null;
  if (/^keep\b/i.test(first)) return null;
  // 剥常见的包裹符号（模型爱加）：直角引号、书名号、成对的直/弯引号
  const stripped = first.replace(/^[「『《"'“”‘’]+/, "").replace(/[」』》"'“”‘’]+$/, "").trim();
  // 只剩标点/空白 = 没有内容。判据是「有没有字母数字或 CJK」，不是长度
  if (!/[\p{L}\p{N}]/u.test(stripped)) return null;
  return stripped.length > TITLE_MAX_CHARS ? stripped.slice(0, TITLE_MAX_CHARS) : stripped;
}

export interface TitleDeps {
  /** 网关的 `/llm/v1` 前缀（不带尾斜杠） */
  llmBase: string;
  /** 向网关证明身份的那几个头 */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 判不出来时说一声。不抛异常——命名失败不该让发言失败 */
  log?: (msg: string) => void;
}

/**
 * 拿最便宜那款读「当前标题 + 最近几句」，回新标题或 `null`（不改）。
 *
 * **走同一条网关、带同样的归因头**，所以这一次调用照样落 `usage_event`、照样扣
 * 所有者的窗口——不做暗扣（同 ADR-0237 决策 5）。`agentId` 头故意不带：这一次
 * 调用不属于任何一只 agent（`usage_event.agent_id` 空串 = 未归因，ADR-0221）。
 *
 * 任何失败都回 `null` 不抛：清单为空、网关非 2xx、超时、fetch 抛错、正文缺席。
 */
export async function requestTitle(
  deps: TitleDeps,
  input: TitleInput,
  models: readonly string[]
): Promise<string | null> {
  const fail = (reason: string): null => {
    deps.log?.(`会话命名：${reason}`);
    return null;
  };
  if (models.length === 0) return fail("网关没有可用的型号");
  const cheap = models[0]!;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TITLE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify({
        model: cheap,
        messages: [
          { role: "system", content: TITLE_SYSTEM },
          { role: "user", content: titlePrompt(input) },
        ],
        max_tokens: TITLE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fail(`网关回 ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return fail("模型没有回正文");
    return parseTitleReply(content);
  } catch (e) {
    if (controller.signal.aborted) return fail(`命名超时（${timeoutMs}ms）`);
    return fail((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** daemon 那一侧的接线：替**团队所有者**调网关（逐处同 requestDispatchAsOwner——
    runtime 唯一独有的一样就是「怎么向网关证明身份」）。归因头带 workspace/session，
    **不带 agent**：这一次调用不属于任何一只 agent */
export interface OwnerTitleDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function requestTitleAsOwner(
  deps: OwnerTitleDeps,
  input: TitleInput,
  models: readonly string[]
): Promise<string | null> {
  return requestTitle(
    {
      llmBase: `${deps.edgeBase}/llm/v1`,
      headers: {
        "x-runtime-secret": deps.runtimeSecret,
        [ON_BEHALF_HEADER]: deps.ownerUid,
        [WORKSPACE_HEADER]: deps.workspaceId,
        [SESSION_HEADER]: deps.sessionId,
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    input,
    models
  );
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/runtime/sessionTitler.test.ts`
Expected: PASS

- [ ] **Step 5: 跑完整门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/sessionTitler.ts tests/runtime/sessionTitler.test.ts
git commit -m "feat(cloud): 会话命名模块——第 1 条走首行兜底，第 2 条起每 5 条让模型重判一次（#1213）

重判把当前标题一起给模型，这是「话题漂了就重命名」不至于让侧栏那行字天天乱变
的全部原因：多数轮回 KEEP。不给当前标题、每次重起一个名字的话，同一段对话会
因为措辞抖动被反复改名，而「人找不到刚才那条会话」比「名字略旧」贵得多。

第一次模型命名排在第 2 条而不是第 1 条：只有一句「你能听到吗」时模型也只能起
个烂名字，而首行兜底不打网关、同时是模型那条路的降级出口。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: migration 0034 + 投影写入口

**Files:**
- Create: `supabase/migrations/0034_cloud_session_participants.sql`
- Create: `services/runtime/src/cloudSessionMeta.ts`
- Test: `tests/runtime/cloudSessionMeta.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ParticipantWindow`
- Produces:
  - `interface CloudSessionMeta { setTitle(title: string): Promise<void>; setParticipants(w: ParticipantWindow): Promise<void> }`
  - `createInMemoryCloudSessionMeta(): CloudSessionMeta & { title: string | null; participants: ParticipantWindow | null }`
  - `createSupabaseCloudSessionMeta(client: SupabaseClient, sessionId: string, log: (m: string) => void): CloudSessionMeta`

- [ ] **Step 1: 写 migration**

创建 `supabase/migrations/0034_cloud_session_participants.sql`：

```sql
-- 0034_cloud_session_participants.sql —— 「最近谁在这条云会话里说过话」（#1213）。幂等，重跑不炸。
-- 与 0016 / 0021 / 0026 / 0030 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发，整份贴进去看不出哪条炸了）。
--
-- 为什么是加两列而不是一张新表：这份东西**只有一个当前值**——固定窗切桶、永远显示
-- 最后一个有过对话的那个窗，所以没有历史维度可留（#1213 拍板第 3 条）。而
-- listCloudSessions 已经在查这张表，加两格 select 是零额外往返；RLS 也已经有
-- （wss_select_member，在籍即可读）。新表要另写一遍 RLS、另开一次查询，还会凭空
-- 长出一个没有消费方的历史维度。
--
-- 与 0030 的 workspace_mentions 为什么是新表不矛盾：那份是一人一行的收件箱
-- （主键 (uid, session_id, seq)、要按人查、要标已读），这份是会话的一格属性。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不新增任何 update 策略**：现有的
-- wss_update_publisher 钉在 kind='package' 上，云会话行客户端本来就改不动——
-- 给了就是让任何在籍成员伪造「某某参与过」。
--
-- participants        : uid 数组（jsonb），首次出现的顺序，已去重
-- participants_window : floor(ts / 5h) —— 那个数组属于哪个窗

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'participants'
  ) then
    alter table public.workspace_sessions
      add column participants jsonb not null default '[]'::jsonb;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'participants_window'
  ) then
    alter table public.workspace_sessions
      add column participants_window bigint not null default 0;
  end if;
end $$;
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/runtime/cloudSessionMeta.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryCloudSessionMeta,
  createSupabaseCloudSessionMeta,
} from "../../services/runtime/src/cloudSessionMeta.js";

describe("createInMemoryCloudSessionMeta", () => {
  it("记下最后一次写进去的标题与参与者，给断言读", async () => {
    const meta = createInMemoryCloudSessionMeta();
    expect(meta.title).toBeNull();
    await meta.setTitle("奶茶店选址");
    await meta.setParticipants({ window: 3, uids: ["u1", "u2"] });
    expect(meta.title).toBe("奶茶店选址");
    expect(meta.participants).toEqual({ window: 3, uids: ["u1", "u2"] });
  });
});

describe("createSupabaseCloudSessionMeta", () => {
  /** 造一个只认 from().update().eq() 的假 client */
  function fakeClient(result: { error: { message: string } | null }) {
    const eq = vi.fn().mockResolvedValue(result);
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    return { client: { from } as never, from, update, eq };
  }

  it("标题写 title 那一列，按 sessionId 定位", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}).setTitle("新名字");
    expect(f.from).toHaveBeenCalledWith("workspace_sessions");
    expect(f.update).toHaveBeenCalledWith({ title: "新名字" });
    expect(f.eq).toHaveBeenCalledWith("id", "sess-1");
  });

  it("参与者两列一起写", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}).setParticipants({ window: 7, uids: ["a"] });
    expect(f.update).toHaveBeenCalledWith({ participants: ["a"], participants_window: 7 });
  });

  it("写失败只记一行日志不抛——这是日志的投影，权威那份已经落盘了", async () => {
    const log = vi.fn();
    const f = fakeClient({ error: { message: "column does not exist" } });
    await expect(createSupabaseCloudSessionMeta(f.client, "s", log).setTitle("x")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("column does not exist");
  });
});
```

- [ ] **Step 3: 跑测试确认它红**

Run: `npx vitest run tests/runtime/cloudSessionMeta.test.ts`
Expected: FAIL — 解析不到 `services/runtime/src/cloudSessionMeta.js`

- [ ] **Step 4: 写实现**

创建 `services/runtime/src/cloudSessionMeta.ts`：

```ts
// cloudSessionMeta —— `workspace_sessions` 那三格（title / participants /
// participants_window）的写入口（#1213）。这一侧只有 IO，判据在
// `src/shared/sessionParticipants.ts` 与 `sessionTitler.ts`。
//
// 接口注入给 sessionService，Supabase 实现只在 daemon 装配；测试与冒烟用内存版
// （分层同 mentionInbox / workspaceMemory / agentWriter）。
//
// **两个方法都不抛**：写的是日志的投影，权威那份已经落盘了。失败的后果是侧栏那一
// 格陈旧（下一次发言或下一次 daemon 重启会补上），不该把一句已经发出去的话翻成失败。
//
// service key，绕过 RLS：这张表给 authenticated 的 update 策略钉在 kind='package'
// 上，云会话行客户端本来就改不动（0016 / ADR-0245 那段前提）。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParticipantWindow } from "../../../src/shared/sessionParticipants.js";

export interface CloudSessionMeta {
  /** 侧栏那一行显示的名字。空串不该走到这里（调用方自己判） */
  setTitle(title: string): Promise<void>;
  /** 最近有过对话的那个窗，以及窗里的人 */
  setParticipants(w: ParticipantWindow): Promise<void>;
}

/** 记在内存里的假件（测试 / 冒烟）。两格直接给断言读 */
export function createInMemoryCloudSessionMeta(): CloudSessionMeta & {
  title: string | null;
  participants: ParticipantWindow | null;
} {
  const state: { title: string | null; participants: ParticipantWindow | null } = {
    title: null,
    participants: null,
  };
  return {
    get title() { return state.title; },
    get participants() { return state.participants; },
    async setTitle(title) { state.title = title; },
    async setParticipants(w) { state.participants = { window: w.window, uids: [...w.uids] }; },
  };
}

/** 真库实现。0034 还没跑的库上，两个方法都会拿到 PostgREST 的 42703（列不存在）
    ——那正好是「只记一行日志不抛」要接住的形态：功能降级成改动前的样子，
    而不是每一句话都失败 */
export function createSupabaseCloudSessionMeta(
  client: SupabaseClient,
  sessionId: string,
  log: (msg: string) => void
): CloudSessionMeta {
  const write = async (patch: Record<string, unknown>, what: string): Promise<void> => {
    const { error } = await client.from("workspace_sessions").update(patch).eq("id", sessionId);
    if (error) log(`[otto-runtime] ${what}写入失败（session=${sessionId}）：${error.message}`);
  };
  return {
    async setTitle(title) { await write({ title }, "会话标题"); },
    async setParticipants(w) {
      await write({ participants: [...w.uids], participants_window: w.window }, "会话参与者");
    },
  };
}
```

- [ ] **Step 5: 跑测试确认它绿**

Run: `npx vitest run tests/runtime/cloudSessionMeta.test.ts`
Expected: PASS

- [ ] **Step 6: 跑完整门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add supabase/migrations/0034_cloud_session_participants.sql services/runtime/src/cloudSessionMeta.ts tests/runtime/cloudSessionMeta.test.ts
git commit -m "feat(cloud): workspace_sessions 加两列存参与者 + 投影写入口（#1213）

加列不是新表：这份东西只有一个当前值（固定窗、永远显示最后一个有过对话的那个），
而 listCloudSessions 已经在查这张表、RLS 也已经有。新表要另写一遍 RLS、另开一次
查询，还会凭空长出一个没有消费方的历史维度。

两个方法都不抛：写的是日志的投影，权威那份已经落盘了——失败的后果是侧栏那一格
陈旧，下一次发言会补上，不该把一句已经发出去的话翻成失败。0034 还没跑的库上拿到
的 42703 正好是这条要接住的形态。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: sessionService 接线 —— 播种、推进、两个出口挂钩

**Files:**
- Modify: `services/runtime/src/sessionService.ts`
- Modify: `tests/runtime/sessionService.test.ts`

**Interfaces:**
- Consumes: Task 1（`lastActiveWindowParticipants` / `advanceParticipants` / `countHumanMessages` / `humanSpeakerOf`）、Task 2（`titleStepFor` / `seedTitleFrom` / `TitleInput`）、Task 3（`CloudSessionMeta`）、已有的 `dispatchContext`
- Produces: `CloudSessionOpts` 新增两格
  - `sessionMeta: CloudSessionMeta`（**必需**）
  - `retitle?: (input: TitleInput) => Promise<string | null>`（**可选**，缺席 = 只有首行兜底、不打网关）

- [ ] **Step 1: 写失败的测试**

**先做一件机械活**：`tests/runtime/sessionService.test.ts` 里**没有**装配 helper，
八处各自内联 `createCloudSession({ ... })`（约在第 47 / 113 / 170 / 239 / 289 / 374 /
417 / 477 行）。`sessionMeta` 是必需字段，所以八处都要补上
`sessionMeta: createInMemoryCloudSessionMeta(),`——tsc 会逐个指出来。
同一处理也要施加给别处自造 `CloudSessionOpts` 的测试（`npm test` 的 tsc 那半会列全）。

然后在文件末尾追加下面这一组。其中 `makeSession(extra)` 是**这一组新用例自己的
小 helper**：照最近一处内联 `createCloudSession({...})` 抄一份最小 opts，
再 `...extra` 覆盖 —— 不去重构那八处，那是与本 issue 无关的改动。

```ts
describe("会话的名字与最近参与的人（#1213）", () => {
  it("第一条人类发言写首行兜底，不打网关", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const retitle = vi.fn();
    const s = makeSession({ sessionMeta: meta, retitle });
    await s.say("u1", "张三", "帮我看下这个月的报表", false, [], undefined, undefined);
    expect(meta.title).toBe("帮我看下这个月的报表");
    expect(retitle).not.toHaveBeenCalled();
  });

  it("第二条人类发言让模型判一次；回了新标题就落 session_autotitled 并写库", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const retitle = vi.fn().mockResolvedValue("月度报表");
    const s = makeSession({ sessionMeta: meta, retitle });
    await s.say("u1", "张三", "第一句", false, [], undefined, undefined);
    await s.say("u1", "张三", "第二句", false, [], undefined, undefined);
    await s.settled();
    expect(retitle).toHaveBeenCalledTimes(1);
    expect(meta.title).toBe("月度报表");
    const titled = s.backlog(-1).filter((e) => e.type === "session_autotitled");
    expect(titled).toHaveLength(1);
    expect((titled[0] as { title: string }).title).toBe("月度报表");
  });

  it("模型回 null（KEEP / 网关挂了）就什么都不做——标题保持现状", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const retitle = vi.fn().mockResolvedValue(null);
    const s = makeSession({ sessionMeta: meta, retitle });
    await s.say("u1", "张三", "第一句", false, [], undefined, undefined);
    await s.say("u1", "张三", "第二句", false, [], undefined, undefined);
    await s.settled();
    expect(meta.title).toBe("第一句");
    expect(s.backlog(-1).filter((e) => e.type === "session_autotitled")).toHaveLength(0);
  });

  it("retitle 缺席 = 只有首行兜底，一次网络都不打（旧装配行为不变）", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const s = makeSession({ sessionMeta: meta });
    await s.say("u1", "张三", "第一句", false, [], undefined, undefined);
    await s.say("u1", "张三", "第二句", false, [], undefined, undefined);
    await s.settled();
    expect(meta.title).toBe("第一句");
  });

  it("每条人类发言都推进参与者；同一个窗里是并集", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const s = makeSession({ sessionMeta: meta });
    await s.say("u1", "张三", "一", false, [], undefined, undefined);
    await s.say("u2", "李四", "二", false, [], undefined, undefined);
    expect(meta.participants?.uids).toEqual(["u1", "u2"]);
  });

  it("系统旁白不算参与", async () => {
    const meta = createInMemoryCloudSessionMeta();
    const s = makeSession({ sessionMeta: meta });
    await s.say("u1", "张三", "@不存在的人 你好", false, ["查无此人"], undefined, undefined);
    expect(meta.participants?.uids).toEqual(["u1"]);
  });
});
```

> `s.say(...)` 的参数顺序是 `fromUid, label, text, mention, mentions, budget, memberMentions`。
> 顶部补上 `import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";`
> 最后一条用例里 `mentions: ["查无此人"]` 会触发那条 `fromUid:"system"` 的系统旁白
> （「有 1 个点名在名单里找不到」）——它正是要断言不算参与的那一条。

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/runtime/sessionService.test.ts`
Expected: FAIL —— 装配缺 `sessionMeta`（tsc）/ 断言拿到 `null`

- [ ] **Step 3: 改 `CloudSessionOpts`**

在 `services/runtime/src/sessionService.ts` 的 `CloudSessionOpts` 里，紧挨 `mentionInbox` 那一格之后加：

```ts
  /** `workspace_sessions` 那三格的写入口（#1213）。**必需**（同 memory / mentionInbox
      的纪律）：忘接线该编译不过，而不是安静地跑一条「侧栏永远叫新会话、永远看不出
      谁在里面说过话」的会话——那正是这条 issue 要拆掉的东西，失败模式本来就是无声的。
      写的是日志的投影，所以它失败只记一行日志、不把一句已经发出去的话翻成失败 */
  sessionMeta: CloudSessionMeta;
  /** 会话命名（#1213）：拿最便宜那款读「当前标题 + 最近几句」，回新标题或 null（不改）。
      daemon 给——它才有 hostedProbe 与 edge 凭据（同 dispatch / pickAutoModel）。
      **可选**：缺席 = 只有第一条人类发言那次首行兜底，一次网关都不打 */
  retitle?: (input: TitleInput) => Promise<string | null>;
```

文件顶部补两条 import：

```ts
import type { CloudSessionMeta } from "./cloudSessionMeta.js";
import { seedTitleFrom, titleStepFor, type TitleInput } from "./sessionTitler.js";
import {
  advanceParticipants,
  countHumanMessages,
  humanSpeakerOf,
  lastActiveWindowParticipants,
  type ParticipantWindow,
} from "../../../src/shared/sessionParticipants.js";
```

- [ ] **Step 4: 装配时播种两份内存状态**

在 `createCloudSession` 里，紧挨 `const bounds = relayBoundsOf(seed);` 之后加：

```ts
  /** 最近有过对话的那个 5 小时窗里有谁（#1213）。装配时整份折叠一次、之后在
      `notify` 里逐条推进——与 `bounds` / `voiceCall` / `speakerLabels` **同一个形状**，
      理由也同一条：日志是这条会话唯一的事实，而每 turn 重新全量 load 的成本跟着
      日志长。`lastActiveWindowParticipants` 自己是倒扫、越过窗起点就停的，所以
      这次播种也只读了尾巴 */
  let participants: ParticipantWindow | null = lastActiveWindowParticipants(seed);
  /** 这条会话累计有多少条人类发言（标题的档位判据）。同上：播种一次、之后逐条推进 */
  let humanSaid = countHumanMessages(seed);
  /** 此刻的标题。空串 = 还没有。日志里最后一条 session_autotitled 胜出（同本机
      store.ts 的标题投影），首行兜底那次也会更新它——它是重判时递给模型的那一格 */
  let title = "";
  for (const e of seed) if (e.type === "session_autotitled") title = e.title;
```

- [ ] **Step 5: 在 `notify` 里推进参与者**

在 `notify(e)` 里，紧挨 `if (e.type === "voice_call_changed") ...` 那一行之后加：

```ts
    // 最近谁说过话（#1163 那条的邻居，#1213）：同 advanceRelayBounds 的推理——
    // daemon.ts 绕过 notify 直接 append 的那四类里有 chat_message，但那几条的
    // fromUid 是 "system"，`humanSpeakerOf` 本来就不认；漏掉一条的后果也只是
    // 侧栏那一格少一个人，下一句话就补上。**变了才写库**（advanceParticipants
    // 没变时回同一个引用）：一个人连说十句只打一次网络
    const nextParticipants = advanceParticipants(participants, e);
    if (nextParticipants !== participants) {
      participants = nextParticipants;
      void opts.sessionMeta.setParticipants(nextParticipants);
    }
    if (humanSpeakerOf(e) !== null) humanSaid += 1;
```

- [ ] **Step 6: 加标题维护函数**

在 `logChat` 定义之后加：

```ts
  /**
   * 这条会话的名字（#1213）。**在 `say()` 的两个出口各调一次**，不在 `notify` 里：
   * 首行兜底要的是**原始正文**，而 `user_message.content` 已经被 `say()` 拼上了
   * `[名字]: ` 前缀，从事件里再剥一次前缀是同一件事的第二份判据。
   *
   * 不 `await`（`say()` 的回执不等这次网关往返），但自己吞掉所有异常：命名失败
   * 不该让一句已经发出去的话变成一个未捕获的 rejection。
   */
  function maintainTitle(text: string): void {
    const step = titleStepFor(humanSaid);
    if (step === "none") return;
    if (step === "seed") {
      const seeded = seedTitleFrom(text);
      // 全是空白 → 什么都不写：一个空标题和「新会话」在界面上是同一件事，
      // 而写进去会让下一次重判以为「已经有标题了」
      if (seeded === "") return;
      title = seeded;
      void opts.sessionMeta.setTitle(seeded).catch(() => undefined);
      return;
    }
    const retitle = opts.retitle;
    if (retitle === undefined) return;
    void (async () => {
      // 上下文复用 `dispatchTail()` + `dispatchContext`（都已存在、已测、已过
      // promptSafe）：不另写一份取上下文的逻辑，那会是同一个判据的第二份实现，
      // 也不全量 load —— 那个成本是跟着日志长的。
      // `nameOf` 给 `(id) => id`：起标题只要对话的大意，而拿真名字要一次
      // `opts.agents()` 的 Supabase 往返，为一个侧栏上的名字多打一次网络不值
      const context = dispatchContext(dispatchTail(), (id) => id);
      const next = await retitle({ currentTitle: title, context });
      if (next === null || next === title) return;
      title = next;
      notify(store.append({
        sessionId,
        ts: Date.now(),
        type: "session_autotitled",
        title: next,
        model: "cloud-titler",
      }));
      await opts.sessionMeta.setTitle(next);
    })().catch((err) => {
      console.warn(`[otto-runtime] 会话命名失败（session=${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    });
  }
```

> `dispatchTail()` 与 `dispatchContext` 都已经在这个文件里（`dispatchTail` 定义在
> `dispatchVerdictFor` 之前，读的是最近 `DISPATCH_TAIL_WINDOW` 条事件）。
> `maintainTitle` 定义在 `logChat` 之后就够（函数声明会提升）。

- [ ] **Step 7: 在 `say()` 的两个出口挂钩**

出口一（`targets.length === 0` 那段），在 `await recordMemberMentions(logged.seq);` **之后**、`return;` 之前加：

```ts
        maintainTitle(text);
```

出口二（起 turn 那条路），在 `await recordMemberMentions(opening.seq);` **之后**加：

```ts
      maintainTitle(text);
```

- [ ] **Step 8: 跑测试确认它绿**

Run: `npx vitest run tests/runtime/sessionService.test.ts`
Expected: PASS

- [ ] **Step 9: 跑完整门禁**

Run: `npm test`
Expected: 全绿。`tests/runtime/frameHandler.test.ts` 等处若有自造的 `CloudSession` 假件，缺 `sessionMeta` 会 tsc 红——补 `createInMemoryCloudSessionMeta()`。

- [ ] **Step 10: 提交**

```bash
git add services/runtime/src/sessionService.ts tests/runtime/sessionService.test.ts
git commit -m "feat(cloud): 把名字与参与者接进会话——播种一次、逐条推进、say() 两个出口各挂一次（#1213）

参与者挂在 notify 上：那是所有事件的必经之路，覆盖每一条会落盘的人话。标题不挂
在那儿——首行兜底要的是原始正文，而 user_message.content 已经被 say() 拼上了
「[名字]: 」前缀，从事件里再剥一次前缀是同一件事的第二份判据。

两份状态都装配时折叠一次、之后逐条推进（同 bounds / voiceCall / speakerLabels 的
形状）：每 turn 重新全量 load 的成本是跟着日志长的。变了才写库——一个人连说十句
只打一次网络。

sessionMeta 必需、retitle 可选：忘接线前者该编译不过（失败模式本来就是无声的），
而后者缺席 = 只有首行兜底，旧装配行为一字不变。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: daemon 接线

**Files:**
- Modify: `services/runtime/src/daemon.ts`

**Interfaces:**
- Consumes: Task 2 的 `requestTitleAsOwner`、Task 3 的 `createSupabaseCloudSessionMeta`
- Produces: 无新导出

- [ ] **Step 1: 补 import**

`services/runtime/src/daemon.ts` 顶部，紧挨 `import { createSupabaseMentionInbox } from "./mentionInbox.js";` 之后：

```ts
import { createSupabaseCloudSessionMeta } from "./cloudSessionMeta.js";
import { requestTitleAsOwner } from "./sessionTitler.js";
```

- [ ] **Step 2: 装配两格**

在 `openSessionRoom` 里造 `createCloudSession(...)` 的那份 opts 中，紧挨
`mentionInbox: createSupabaseMentionInbox(supabase, (m) => console.warn(m)),` 之后加：

```ts
      sessionMeta: createSupabaseCloudSessionMeta(supabase, sessionId, (m) => console.warn(m)),
      // 会话命名（#1213）：装配在这一层的理由同 dispatch —— 凭据与订阅探针都在这里。
      // **探不到与没订阅在这里给同一个答案：不改名**。这与 dispatch 那三种分说不同，
      // 因为命名失败不产生任何对用户说的话（侧栏那一格保持现状），没有需要区分措辞
      // 的消费方；而多打一次注定 403 的网关调用只是浪费
      retitle: async (input) => {
        const me = await hostedProbe.me(ownerUid);
        if (me === "unreachable" || me === null || me.status !== "active") return null;
        return requestTitleAsOwner(
          {
            edgeBase: config.edgeBase,
            runtimeSecret: config.runtimeSecret,
            ownerUid,
            workspaceId,
            sessionId,
            log: (m) => console.warn(`[otto-runtime] ${m}（session=${sessionId}）`),
          },
          input,
          me.models
        );
      },
```

> `ownerUid` / `workspaceId` / `sessionId` / `hostedProbe` / `config` 在
> `openSessionRoom` 的作用域里都已经有（`dispatch` 那一格用的就是同一批）。
> 若变量名不同，以 `dispatch:` 那一格实际写法为准。

- [ ] **Step 3: 跑完整门禁**

Run: `npm test`
Expected: 全绿（这一步没有新断言，靠 tsc 接住漏接线）

- [ ] **Step 4: 提交**

```bash
git add services/runtime/src/daemon.ts
git commit -m "feat(cloud): daemon 接上命名与参与者投影（#1213）

探不到与没订阅在这里给同一个答案：不改名。这与 dispatch 那三种分说不同——命名
失败不产生任何对用户说的话（侧栏那一格保持现状），没有需要区分措辞的消费方，
而多打一次注定 403 的网关调用只是浪费。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: 桌面读取路径 —— 三个类型加一格

**Files:**
- Modify: `src/main/supabaseWorkspacesApi.ts`（`CloudSessionRow` + `listCloudSessions`）
- Modify: `src/renderer/src/lib/workspaceView.ts`（`CloudSessionListRow` / `CloudSessionRowView` / `cloudSessionRows`）
- Test: `tests/renderer/workspaceView.test.ts`（已存在则追加；不存在则新建）

**Interfaces:**
- Produces: 三个类型各多一格 `participantUids: string[]`；`cloudSessionRows` 原样带出

- [ ] **Step 1: 写失败的测试**

在 `tests/renderer/workspaceView.test.ts` 追加：

```ts
describe("cloudSessionRows 带出参与者（#1213）", () => {
  it("原样带出 participantUids", () => {
    const ws = makeWorkspace(); // 该文件已有的 helper
    const rows = cloudSessionRows(
      [{ id: "s1", title: "", publisherUid: "u1", archived: false, updatedTs: 1, participantUids: ["u1", "u2"] }],
      ws
    );
    expect(rows[0]!.participantUids).toEqual(["u1", "u2"]);
  });

  it("一个人都没有时是空数组，不是 undefined（渲染层不必再判）", () => {
    const ws = makeWorkspace();
    const rows = cloudSessionRows(
      [{ id: "s1", title: "", publisherUid: "u1", archived: false, updatedTs: 1, participantUids: [] }],
      ws
    );
    expect(rows[0]!.participantUids).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/renderer/workspaceView.test.ts`
Expected: FAIL —— tsc 报 `participantUids` 不在类型上

- [ ] **Step 3: 改主进程那一份**

`src/main/supabaseWorkspacesApi.ts`：

```ts
export interface CloudSessionRow {
  id: string;
  title: string;
  publisherUid: string;
  archived: boolean;
  updatedTs: number;
  /** 最近有过对话的那个 5 小时窗里说过话的人（#1213）。runtime 写的投影，
      形状不对（不是字符串数组）一律回 []——同 normalizeStringArray 的纪律 */
  participantUids: string[];
}
```

`listCloudSessions` 里：

```ts
  const res = await client
    .from("workspace_sessions")
    .select("id,publisher_uid,title,archived,updated_at,participants")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud");
  const rows = (unwrap(res) ?? []) as {
    id: string; publisher_uid: string; title: string; archived: boolean; updated_at: string;
    participants: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publisherUid: r.publisher_uid,
    archived: r.archived,
    updatedTs: toEpochMs(r.updated_at),
    // 0034 还没跑的库上这一格是 undefined —— 回 [] 让整条路退回改动前的样子
    participantUids: Array.isArray(r.participants) && r.participants.every((x) => typeof x === "string")
      ? (r.participants as string[])
      : [],
  }));
```

> **不选 `participants_window`**：桌面不判窗口边界（那是 runtime 的活），
> 多选一格只会让人以为渲染层要拿它做判断。

- [ ] **Step 4: 改渲染层那两份**

`src/renderer/src/lib/workspaceView.ts`：

```ts
export interface CloudSessionListRow {
  id: string;
  title: string;
  publisherUid: string;
  archived: boolean;
  updatedTs: number;
  /** 见 main/supabaseWorkspacesApi.ts 的同名字段（形状凑巧相同、各留一份） */
  participantUids: string[];
}

export interface CloudSessionRowView {
  id: string;
  title: string;
  creatorLabel: string;
  creatorUid: string;
  archived: boolean;
  updatedTs: number;
  /** 最近有过对话的那个 5 小时窗里说过话的人（#1213）。**带 uid 不带名字**：
      名字要现查 `labelOf`（会变），而退了群的人 uid 仍然要画得出来 */
  participantUids: string[];
}
```

`cloudSessionRows` 的 `.map` 里加一行 `participantUids: r.participantUids,`。

- [ ] **Step 5: 跑测试确认它绿**

Run: `npx vitest run tests/renderer/workspaceView.test.ts`
Expected: PASS

- [ ] **Step 6: 跑完整门禁**

Run: `npm test`
Expected: 全绿。其他构造 `CloudSessionListRow` 的测试会因为缺字段 tsc 红——各补 `participantUids: []`。

- [ ] **Step 7: 提交**

```bash
git add src/main/supabaseWorkspacesApi.ts src/renderer/src/lib/workspaceView.ts tests/renderer/workspaceView.test.ts
git commit -m "feat(cloud): 云会话清单带出参与者 uid（#1213）

一个帧都不加：这一格走 Supabase 直查，协议不进位。0034 还没跑的库上那一格是
undefined，回空数组让整条路退回改动前的样子。

不选 participants_window：桌面不判窗口边界（那是 runtime 的活），多选一格只会
让人以为渲染层要拿它做判断。带 uid 不带名字：名字现查 labelOf（会变），而退了群
的人 uid 仍然要画得出来。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: 渲染层刷新 + 时间线第 ⑧ 条

**Files:**
- Modify: `src/renderer/src/lib/cloudTimeline.ts`
- Modify: `src/renderer/src/store.ts`
- Test: `tests/renderer/cloudTimeline.test.ts`（不存在就新建）

**Interfaces:**
- Consumes: Task 1 的 `humanSpeakerOf`
- Produces: 无新导出（行为变更）

- [ ] **Step 1: 写失败的测试**

在 `tests/renderer/cloudTimeline.test.ts` 追加（文件不存在则新建，import 从
`../../src/renderer/src/lib/cloudTimeline.js`）：

```ts
describe("hiddenFromCloudTimeline 第 ⑧ 条（#1213）", () => {
  it("自动命名藏起来——「会话被起了个名字」人不能据此行动，是机器的内务", () => {
    const e = { seq: 1, sessionId: "s", ts: 0, type: "session_autotitled", title: "x", model: "m" } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(true);
  });

  it("人说的话照旧画", () => {
    const e = { seq: 2, sessionId: "s", ts: 0, type: "chat_message", fromUid: "u1", label: "L", content: "hi", mention: false } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/renderer/cloudTimeline.test.ts`
Expected: FAIL —— 第一条断言拿到 `false`

- [ ] **Step 3: 改 `hiddenFromCloudTimeline`**

在该函数的头注末尾（第 ⑦ 条之后）加一段：

```
    ⑧ `session_autotitled`（#1213）——会话被自动命名了是机器的内务：人不能据此
       行动（ADR-0260 的判据），而侧栏那一行的字已经跟着换了，画出来是同一件事
       说两遍。**藏的是投影不是事实**：落盘/重放/隐私闸一个字不动。
```

函数体最后一行改成：

```ts
  return (
    e.type === "session_created" ||
    e.type === "agent_briefed" ||
    e.type === "request_envelope" ||
    e.type === "session_autotitled"
  );
```

- [ ] **Step 4: store 里两条刷新**

`src/renderer/src/store.ts` 的 `onCloudSessionEvent` 回调里，紧挨处理
`session_archived` 那段**之后**加：

```ts
      // 会话被自动命名了（#1213）：侧栏那一行的字该换了。判据是日志里那条事件，
      // 不是「我刚做了什么」——逐字同上面 session_archived 那条。这个事件很稀疏
      // （第 2 条人类发言起每 5 条最多一次，且多数轮模型回 KEEP 根本不落），
      // 一次往返不心疼
      if (event.type === "session_autotitled" && cur && cur.sessionId === event.sessionId) {
        void get().refreshCloudSessions(cur.workspaceId);
      }
      // 有人在这条会话里说话了（#1213）：把他并进侧栏那一行的参与者。**本地 patch
      // 不打网络**，而且**只并不删**——窗口边界不在渲染层判（那是 runtime 的活），
      // 下次拉取修正。方向是安全的：最坏是多显示一个刚说过话的人，而反过来
      // （少显示一个正在说话的人）才是撒谎
      const speaker = cur && cur.sessionId === event.sessionId ? humanSpeakerOf(event) : null;
      if (speaker !== null && cur) {
        const wsId = cur.workspaceId;
        set((s) => {
          const list = s.cloudSessionList[wsId];
          if (!list) return s;
          let changed = false;
          const next = list.map((row) => {
            if (row.id !== event.sessionId || row.participantUids.includes(speaker)) return row;
            changed = true;
            return { ...row, participantUids: [...row.participantUids, speaker] };
          });
          return changed ? { cloudSessionList: { ...s.cloudSessionList, [wsId]: next } } : s;
        });
      }
```

顶部补 import：

```ts
import { humanSpeakerOf } from "../../shared/sessionParticipants.js";
```

> 路径以该文件里其它 `src/shared/*` 的 import 写法为准。

- [ ] **Step 5: 跑测试确认它绿**

Run: `npx vitest run tests/renderer/cloudTimeline.test.ts`
Expected: PASS

- [ ] **Step 6: 跑完整门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/lib/cloudTimeline.ts src/renderer/src/store.ts tests/renderer/cloudTimeline.test.ts
git commit -m "feat(cloud): 自动命名不上群聊时间线；说话的人当场并进侧栏那一行（#1213）

第 ⑧ 条：会话被自动命名了是机器的内务——人不能据此行动（ADR-0260 的判据），而
侧栏那一行的字已经跟着换了，画出来是同一件事说两遍。藏的是投影不是事实。

参与者本地 patch 不打网络，且只并不删：窗口边界不在渲染层判，下次拉取修正。方向
是安全的——最坏是多显示一个刚说过话的人，而反过来才是撒谎。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: 侧栏那一行 —— 叠罗汉头像

**Files:**
- Modify: `src/renderer/src/components/WorkspacesSidebarSection.tsx`
- Test: `tests/renderer/WorkspaceSessionRow.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 6 的 `CloudSessionRowView.participantUids`、已有的 `labelOf`、`PARTICIPANT_WINDOW_MS`
- Produces: 组件内的 `ParticipantStack`（不导出，测试通过渲染 `WorkspacesSidebarSection` 断言）

- [ ] **Step 1: 写失败的测试**

创建 `tests/renderer/WorkspaceSessionRow.test.tsx`。**渲染整节**（同 #1068 的纪律：
纯逻辑钉不到「有没有被画出来」）：

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspacesSidebarSection } from "../../src/renderer/src/components/WorkspacesSidebarSection.js";

// 该文件需要 zustand store 与 SidebarProvider——照 tests/renderer 里其它
// 组件测试（如 FriendsSection.test.tsx）的 wrapper 写法搭同一副骨架。

describe("侧栏会话行的参与者头像（#1213）", () => {
  it("三个人以内逐个画", async () => {
    renderSection({ participantUids: ["u1", "u2"] }); // helper 见文件顶部
    expect(await screen.findByTitle(/张三/)).toBeTruthy();
    expect(screen.getAllByTestId("participant-avatar")).toHaveLength(2);
  });

  it("超过三个封顶，第四格画 +N", () => {
    renderSection({ participantUids: ["u1", "u2", "u3", "u4", "u5"] });
    expect(screen.getAllByTestId("participant-avatar")).toHaveLength(3);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("一个人都没有时整个头像堆不画", () => {
    renderSection({ participantUids: [] });
    expect(screen.queryAllByTestId("participant-avatar")).toHaveLength(0);
  });

  it("退了群的人照样画——「他当时在场」是已经发生的事实", () => {
    renderSection({ participantUids: ["u-gone"] });
    // labelOf 对不在名册里的 uid 回前 8 位
    expect(screen.getByTitle(/u-gone/)).toBeTruthy();
  });
});
```

> Radix/`<img>` 在 jsdom 里判加载成功读的是 `complete` / `naturalWidth`（#1068 的教训），
> 本任务不依赖头像真加载：**没有 `avatarUrl` 就画首字母**，测试用的成员一律不给
> `avatarUrl`，断言落在 `data-testid` 与 `title` 上。

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/renderer/WorkspaceSessionRow.test.tsx`
Expected: FAIL —— 找不到 `participant-avatar`

- [ ] **Step 3: 加 `ParticipantStack` 组件**

在 `WorkspacesSidebarSection.tsx` 里，`MentionBadge` 定义之后加：

```tsx
/** 一行最多画几枚头像。侧栏 16rem、会话行可用约 230px，标题还要占大头 */
const PARTICIPANT_STACK_MAX = 3;

/** 「最近有过对话的那个 5 小时窗里说过话的人」（#1213）。
    叠罗汉：向左重叠、每枚一圈与侧栏同色的描边分层。
    **不给入场动效**：它是挂着的状态记号不是一次事件（同 ADR-0255 / #1064 那枚角标）。
    退了群的 uid 照样画——`labelOf` 会回 uid 前 8 位，而「他当时在场」是已经发生的
    事实，不因为他后来退群而没发生。 */
function ParticipantStack({ ws, uids }: { ws: WorkspaceSnapshot; uids: readonly string[] }) {
  if (uids.length === 0) return null;
  const shown = uids.slice(0, PARTICIPANT_STACK_MAX);
  const rest = uids.length - shown.length;
  const names = uids.map((uid) => labelOf(ws, uid)).join("、");
  return (
    <span className="shrink-0 flex items-center pl-1" title={`最近 5 小时说过话的：${names}`}>
      {shown.map((uid) => {
        const member = ws.members.find((m) => m.uid === uid);
        const label = labelOf(ws, uid);
        return (
          <span
            key={uid}
            data-testid="participant-avatar"
            title={label}
            className="w-4 h-4 -ml-1 first:ml-0 rounded-full ring-1 ring-sidebar overflow-hidden
                       bg-muted text-[8px] leading-4 text-center text-muted-foreground select-none"
          >
            {member && member.avatarUrl !== "" ? (
              <img src={member.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              label.slice(0, 1)
            )}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="ml-[2px] text-[10px] leading-4 text-muted-foreground tabular-nums">+{rest}</span>
      )}
    </span>
  );
}
```

顶部补 import：

```tsx
import { labelOf } from "../lib/workspaceView.js";
```

> `labelOf` 若不是从 `workspaceView.ts` 导出的，按 `cloudSessionRows` 里实际的
> import 来源写。

- [ ] **Step 4: 挂进会话行**

在 `SidebarMenuButton` 里，标题那个 `<span>` 与 `<MentionBadge>` **之间**插入：

```tsx
                    <ParticipantStack ws={ws} uids={row.participantUids} />
```

同时把那一行的 `title` 补上参与者（`SidebarMenuButton` 的 `title` 属性）：

```tsx
                    title={`${row.title} · ${row.creatorLabel}`}
```

保持原样即可 —— 头像堆自己带 `title`，两层 `title` 会互相遮，**不要**把参与者
拼进外层那一份。

- [ ] **Step 5: 加 focus 刷新**

把已有的那个拉取 effect 改成：

```tsx
  const ids = groups.filter((g) => g.loadError === undefined).map((g) => g.id).join(",");
  useEffect(() => {
    const list = ids === "" ? [] : ids.split(",");
    const pull = (): void => { for (const id of list) void refreshCloud(id); };
    pull();
    // 参与者与标题都是 runtime 写进 Supabase 的投影，没有推送通道（#1213）。
    // **不做定时轮询**：会看到这一列的那一刻必然是人回到这扇窗前，focus 就是
    // 那个信号（同 #1064 点名角标那两次拉取的取舍）。作用域天然是「这一栏挂
    // 在屏幕上」——看不见的时候本来也不需要刷新
    window.addEventListener("focus", pull);
    return () => window.removeEventListener("focus", pull);
  }, [ids, refreshCloud]);
```

- [ ] **Step 6: 跑测试确认它绿**

Run: `npx vitest run tests/renderer/WorkspaceSessionRow.test.tsx`
Expected: PASS

- [ ] **Step 7: 跑完整门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/components/WorkspacesSidebarSection.tsx tests/renderer/WorkspaceSessionRow.test.tsx
git commit -m "feat(cloud): 侧栏会话行画出最近说过话的人（#1213）

叠罗汉封顶 3 枚、第四格 +N。退了群的 uid 照样画——labelOf 回 uid 前 8 位，而
「他当时在场」是已经发生的事实，不因为他后来退群而没发生。不给入场动效：它是
挂着的状态记号不是一次事件（同 ADR-0255）。

刷新挂在 focus 上不做定时轮询：会看到这一列的那一刻必然是人回到这扇窗前（同
#1064 那两次拉取的取舍），而作用域天然是「这一栏挂在屏幕上」。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: ADR + 索引 + 收尾

**Files:**
- Create: `docs/adr/0281-云会话的名字与最近参与的人.md`（**合并前 re-fetch，撞号就改成 max+1 并加 `原为 ADR-00XX` 别名行**，项目 ADR-0074）
- Modify: `AGENTS.md`（「Where to find things」加一条）

- [ ] **Step 1: 写 ADR**

内容取 spec 的「病根 / 拍板三条 / 每个切片的判据 / 已知代价 / 明确不做」，逐条写清
**为什么这样而不是那样**。至少要覆盖这五个决定：

1. 挂在人类发言之后而不是 turn 收口上（群聊里人可以只跟人说话）；
2. 首行兜底存在的理由（与本机标题投影同口径 + 模型那条路的降级出口）；
3. 重判把当前标题一起给模型（否则同一段对话会被反复改名）；
4. 参与者加两列而不是新表（只有一个当前值 / 零额外往返 / RLS 已有）；
5. 排除 relay & greeting（它们的 fromUid 是点火的人）。

- [ ] **Step 2: 索引加一条**

在 `AGENTS.md` 的「Where to find things」列表末尾加：

```
- `src/shared/sessionParticipants.ts` / `services/runtime/src/sessionTitler.ts` / `services/runtime/src/cloudSessionMeta.ts` — 云会话的名字与最近参与的人（ADR-0281，#1213）：**两件事共用一个挂载点和一张表**。标题挂在**人类发言之后**不挂在 turn 收口上——群聊里人可以只跟人说话（解出空名单时只落一条 `chat_message`，一个 turn 都不起），挂 turn 上那种会话永远不会被命名；第 1 条走**首行兜底**（不打网关，与本机「手动改名 > `session_autotitled` > 首行」同口径，同时是模型那条路的降级出口），第 2 条起每 5 条让模型**带着当前标题**重判一次——多数轮回 `KEEP`，这是「话题漂了就重命名」不至于让侧栏那行字天天乱变的全部原因。参与者是 `workspace_sessions` 的**两列不是新表**：固定窗切桶、永远显示最后一个有过对话的那个窗，所以只有一个当前值（没有历史消费方），而 `listCloudSessions` 已经在查这张表、RLS 也已经有。判据里唯一不显然的一处是**排除 `relay` / `greeting` 开场白**——它们的 `fromUid` 是**点火的那个人**（ADR-0223 §4.2 / #1174），不排除的话一条接力链会在几小时之后、在他早就离开的窗里替他重新「参与」一次；这条与 `hiddenFromCloudTimeline` 第 ①⑦ 条逐字同一个问题。两份内存状态装配时折叠一次、之后在 `notify` 里逐条推进（同 `bounds` / `voiceCall` / `speakerLabels` 的形状），**变了才写库**。`sessionMeta` 必需、`retitle` 可选：忘接线前者该编译不过（失败模式本来就是无声的），后者缺席 = 只有首行兜底。刷新挂 `focus` 不做轮询（同 #1064 的取舍）。**要跑 migration 0034 + 重新部署 runtime 才生效**（#791）
```

- [ ] **Step 3: 跑完整门禁**

Run: `npm test`
Expected: 全绿（`tests/docs/adrNumbers.test.ts` 会挡撞号）

- [ ] **Step 4: 提交并开 PR**

```bash
git add docs/adr AGENTS.md
git commit -m "docs(adr): ADR-0281 云会话的名字与最近参与的人 + 索引（#1213）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --title "feat(team): 云会话自动命名 + 侧栏画出最近 5 小时参与的人（#1213）" --body "..."
```

PR 正文要写明**三件不做完就不生效的事**：
1. `supabase/migrations/0034_cloud_session_participants.sql` 要在生产库手动跑一次；
2. runtime 要重新部署（`services/runtime/` 改了，#791）；
3. 桌面要发版。

并注明真机验收欠账（两账号：一个人说话、另一个人看侧栏那排头像变不变）。

---

## 自查

**Spec 覆盖**：切片 1（Task 2/4/5）· 切片 2（Task 1/3/4/5）· 切片 3（Task 6/7）·
切片 4（Task 8）· 测试表六条（Task 1 前两条、Task 2 第三条、Task 4 第四条、
Task 7 第五条、Task 8 第六条）· 已知代价与明确不做（Task 9 的 ADR）。无缺口。

**类型一致性**：`ParticipantWindow` 在 Task 1 定义、Task 3/4 消费；
`CloudSessionMeta` 在 Task 3 定义、Task 4/5 消费；`TitleInput` 在 Task 2 定义、
Task 4/5 消费；`participantUids` 在 Task 6 三处同名、Task 7/8 消费。一致。

**写计划时核过的三处**（都已落成确定写法，不是占位符）：
`tests/runtime/sessionService.test.ts` **没有**装配 helper，八处内联
`createCloudSession({...})` 都要补 `sessionMeta`（Task 4 Step 1 已写明）；
上下文取自这个文件里已有的 `dispatchTail()`（`RelayBounds` 只有 `closeBound` /
`lastHumanOpening` 两格，没有可用的尾段下界）；`labelOf` 导出自
`src/renderer/src/lib/workspaceView.ts:41`。

**留给实现者的一处判断**：Task 8 的组件测试要照 `tests/renderer/` 里既有组件测试
的 wrapper 写法搭 store + `SidebarProvider` 骨架（本仓没有统一的 render helper，
各文件自己搭）。参照 `tests/renderer/FriendsSection.test.tsx`。
