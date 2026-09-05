# 工作区多智能体 · 切片 1b（骨架·桌面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 1a 建好的多智能体骨架在桌面上点亮：@ chip 输入、时间线「谁说的」、工作区设置页 agent CRUD + 型号白名单；顺手修 1a 交接（#932）的四个坑。

**Architecture:** 三条线。① runtime：发言在 `say()` 那一刻就落 `user_message`（带 `fromUid` + `mentions`），turn 从日志里已落盘的那条起跑（engine 新增 `runLoggedTurn`）——「排队中 / 正在回复」于是能从日志推导（`src/shared/turnLedger.ts`），daemon 重启也按同一推导补跑；adapter 每 turn 现取；客户端给了 `mentions` 就以它为准。② 主进程/数据：`WorkspaceSnapshot` 长出 `agents`，`workspaceManager` 长出三个 CRUD，IPC 走既有 `FriendsResult` 形状。③ 渲染层：`CloudSessionPage` 的 composer 换成 @ 选人 + chip 预览，时间线按 `agentId`/`fromUid` 署名，`WorkspacePage` 加「智能体」tab。

**Tech Stack:** TypeScript strict / vitest / React + Zustand + Tailwind + shadcn（Dialog/Input/Button/Tabs 已有）/ better-sqlite3 EventStore / Supabase PostgREST（`workspace_agents` 表**已在真库**，不跑 migration）。

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`（§3 数据模型、§4.5/4.6 线协议与 @ 解析、§9 权限、§10 切片）。交接 issue **#932** 列的四个坑是本计划的硬性输入。1a 的实现计划 `docs/superpowers/plans/2026-09-04-workspace-multi-agent-1a.md`、ADR-0219。

## Global Constraints

- **append-only 事件日志是唯一事实来源；任何投影必须可从日志推导**（AGENTS.md Hard rule）。「排队中」这个状态因此必须是日志的投影，不是内存或 UI 本地态。
- **SessionEvent schema 只加宽不改窄**：`UserMessageEvent` 新增 `fromUid?` / `mentions?` 都是可选；旧日志逐字节照旧重放。`deriveMessages` 对 user_message 的投影**不变**（content 里已带 `[label]: ` 前缀）。
- **渲染进程只经 `ShellBridge`**；渲染层不 import 主进程模块（`tests/architecture.test.ts` 会红）。
- **@ 解析只有一份**：`src/shared/remote/agentMention.ts` 的 `parseMentions`。渲染层**不许**另写一条名字匹配规则；选人弹层的「输入到哪一段算 @ 查询」是另一件事（光标位置），允许有，但**发送时 `mentions` 必须来自 `parseMentions(text, roster)`**。
- **客户端给了 `mentions`（含空数组）就以它为准**（#932 坑 ④ 的裁决）：服务端不再对正文重解析、不再回落布尔。`mentions === undefined` 才走老语义（解析正文 → 布尔回落到名单第一只）。手机端/旧桌面不受影响。
- **adapter 每 turn 现取**（#932 坑 ①）：`engineFor` 命中缓存也要 `engine.setAdapter(opts.adapterFor(spec))`，不做「型号没变就跳过」的比对——ADR-0202 同款纪律。
- **没人跑的话必须留痕**（#932 坑 ③ / 1a 终审 Critical 同族）：agent 在排队期间被删，落一条 `turn_ended{outcome:"error", agentId, error}`，让「排队中」的推导收口，人也看得见。
- `workspace_agents` 表**已在真库**（0021，PR #931 合并时执行）——本计划不写 migration，不跑 DDL。
- 权限矩阵（spec §9）：建 = 任何成员；改/删 = 建的人或 owner；「管理员」（`agent_id = 'admin'`）不可删（RLS + 触发器已拦，界面不出删除钮）。
- 新事件类型检查清单（AGENTS.md「第九处」）：本计划**不新增事件类型**，只给既有 `user_message` 加可选字段——清单不用走。
- 提交信息末尾：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01Qrfg2wsjMwpm1TNFaRGd59`。
- 门禁 `npm test`（tsc + vitest）。`npm run runtime:smoke` 不在门禁里但 Task 4 之后要跑一次绿（1a 就是在这上面翻过车）。
- UI 文案中文；样式沿用 `CloudSessionPage` / `WorkspacePage` 既有 token（`text-[10.5px] text-muted-foreground`、`ROW`、`SECTION_LABEL`、`Bubble`）；不引入新依赖；动效遵守：按钮 `press-scale`、弹层用 `transform/opacity` 且 ≤200ms、`ease-out`、无 `scale(0)` 起点。

---

## 文件地图

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/session/events.ts` | `UserMessageEvent` + `fromUid?` / `mentions?` | 1 |
| `src/loop/engine.ts` | `runLoggedTurn(opening)`；`unseenUserTail` 认 mentions | 2 |
| `src/shared/turnLedger.ts`（新） | `openTurns(events)`：哪句话点了谁、谁还没收口 | 3 |
| `services/runtime/src/turnCoordinator.ts` | `TurnJob = {agentId, fromUid, opening}` | 4 |
| `services/runtime/src/sessionService.ts` | say 先落盘；runJob 从日志起跑；每 turn setAdapter；删 agent 留痕；重启补跑 | 4 |
| `services/runtime/src/frameHandler.ts` | 限速桶按 `mentions` 也算 turn | 4 |
| `src/shared/workspaces.ts` | `WorkspaceAgentRow` + `assembleSnapshot` 第 5 张表 | 5 |
| `src/shared/workspaceAgents.ts`（新） | `validateAgentName` / `parseModelList` / `AGENT_NAME_MAX` | 5 |
| `src/main/supabaseWorkspacesApi.ts` | `fetchWorkspace` 查 agents；`insertAgentRow` / `updateAgentRow` / `deleteAgentRow` | 5 |
| `src/main/workspaceManager.ts` | `createAgent` / `updateAgent` / `deleteAgent` | 6 |
| `src/shared/shellBridge.ts` / `src/preload/index.ts` / `src/main/index.ts` | 三条 agent IPC + `workspaceCloudSay` 第三参 | 6, 8 |
| `src/renderer/src/store.ts` | 三个 agent action；`cloudSay(text, mentions?)` | 6, 8 |
| `src/renderer/src/lib/workspaceView.ts` | `agentRows(ws, selfUid)` / `agentNameOf(ws, agentId)` | 7 |
| `src/renderer/src/components/WorkspaceAgentsTab.tsx`（新） | 智能体 tab + 编辑弹窗 | 7 |
| `src/renderer/src/components/WorkspacePage.tsx` | 挂第四个 tab | 7 |
| `src/main/cloudSessionClient.ts` | `say(text, mention, mentions?)` | 8 |
| `src/renderer/src/lib/agentMentionInput.ts`（新） | 光标处的 @ 查询 / 补全写回 / 候选过滤 | 8 |
| `src/renderer/src/components/CloudSessionPage.tsx` | composer 换 @ 选人 + chips；时间线署名 + 排队状态 | 9, 10 |
| `src/renderer/src/components/CloudSessionMain.tsx` | 进云会话时刷一次快照（名单可能被别人改过） | 9 |
| `docs/adr/0220-*.md` / `AGENTS.md` / `CONTEXT.md` | 决策记录 + 索引 | 11 |

---

### Task 1: `user_message` 长出 `fromUid` / `mentions`

**Files:**
- Modify: `src/session/events.ts:26-55`（`UserMessageEvent`）
- Test: `tests/session/userMessageGroupFields.test.ts`（新）

**Interfaces:**
- Produces: `UserMessageEvent.fromUid?: string`、`UserMessageEvent.mentions?: string[]`。Task 3/4/10 读它们。

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/userMessageGroupFields.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { tempDir } from "../helpers/tempDir.js";

describe("user_message 的群聊字段（#932 坑 ②）", () => {
  it("fromUid / mentions 落盘后原样读回", () => {
    const store = new EventStore(join(tempDir("mrotto-um-"), "s.db"));
    store.append({
      sessionId: "s1", ts: 1, type: "user_message",
      content: "[alice]: @运营 看下销量", fromUid: "u1", mentions: ["ops"],
    });
    const [e] = store.load("s1");
    expect(e).toMatchObject({ type: "user_message", fromUid: "u1", mentions: ["ops"] });
    store.close();
  });

  it("模型投影读都不读它们 —— 有没有这两个字段，投影逐字节相同", () => {
    const a = { sessionId: "s1", ts: 1, seq: 0, type: "user_message" as const, content: "[alice]: 在吗" };
    const b = { ...a, fromUid: "u1", mentions: ["ops"] };
    expect(deriveMessages([b])).toEqual(deriveMessages([a]));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session/userMessageGroupFields.test.ts`
Expected: FAIL —— tsc 层面是 `fromUid` 不在 `UserMessageEvent` 的形状里（vitest 用 esbuild 剥类型，第一条可能直接过；第二条也过）。**这个任务的红主要在 `npx tsc --noEmit` 上**——跑一次 tsc 看到 `Object literal may only specify known properties` 即可。

- [ ] **Step 3: 加字段**

在 `UserMessageEvent` 的 `backgroundTaskIds?` 之后追加：

```ts
  /** 云会话群聊（#928 / #932）：这句话是哪个成员说的。**只在 runtime 落的
      user_message 上出现**——本机会话没有"别人"，缺席 = 本机操作者/旧日志。
      有了它，渲染层判"这句是不是我说的"不用再拿 `[label]: ` 前缀跟自己的
      展示名比对（那是 1a 的将就：同名两个人就分不开）。模型投影不读它 */
  fromUid?: string;
  /** 云会话群聊：这句话点了哪几只 agent（agentId，已按名单过滤）。缺席 = 没点名
      /旧日志/本机会话。它是「排队中 / 正在回复」那个状态的事实来源
      （src/shared/turnLedger.ts 据此配对 turn_ended），也是 engine 判「这条
      尾上的用户消息是不是说给我的」的依据（unseenUserTail）。模型投影不读它 */
  mentions?: string[];
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/session/userMessageGroupFields.test.ts && npx tsc --noEmit`
Expected: PASS，tsc 零错。

- [ ] **Step 5: 提交**

```bash
git add src/session/events.ts tests/session/userMessageGroupFields.test.ts
git commit -m "feat(events): user_message 长出 fromUid / mentions（#932 坑 ②）

云会话群聊的发言要在 say() 那一刻就落盘（下一任务），排队中/正在回复才能从
日志推导；落盘的那条得自带「谁说的、点了谁」两个事实，不能再靠 [label]:
前缀反解。两个字段都可选：旧日志逐字节照旧，模型投影不读它们。"
```

---

### Task 2: engine 能对「已落盘的 user_message」起 turn

**Files:**
- Modify: `src/loop/engine.ts:268-273`（`unseenUserTail`）、`:613-672`（`runTurn`）
- Test: `tests/loop/engineLoggedTurn.test.ts`（新）

**Interfaces:**
- Produces: `LoopEngine.runLoggedTurn(opening: UserMessageEvent): Promise<"completed" | "aborted">` —— opening 必须是**已经在 store 里**的那条 user_message（带 seq）。`runTurn` 行为逐字节不变（它变成「先 append 再调共用的私有 `runFrom(opening)`」）。
- Consumes: Task 1 的 `mentions`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/loop/engineLoggedTurn.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { UserMessageEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function newStore() {
  return new EventStore(join(tempDir("mrotto-engine-logged-"), "s.db"));
}

describe("LoopEngine.runLoggedTurn（#932 坑 ②）", () => {
  it("不再 append user_message：开场那条已经在日志里，turn 只补 assistant_message + turn_ended", async () => {
    const store = newStore();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({
      sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"],
    }) as UserMessageEvent;

    await engine.runLoggedTurn(opening);

    const types = store.load("s1").map((e) => e.type);
    expect(types.filter((t) => t === "user_message")).toHaveLength(1);
    expect(types.at(-1)).toBe("turn_ended");
    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed", agentId: "ops" });
  });

  it("模型看到的开场白就是那条已落盘的消息", async () => {
    const store = newStore();
    let seen = "";
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(messages) { seen = JSON.stringify(messages); return { content: "好" }; },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: 看销量" }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    expect(seen).toContain("[alice]: 看销量");
  });

  it("尾上多出来一条点名别人的 user_message，不算「我没答的」——不再采样一圈", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        // 第一次采样期间，别人往日志尾巴上追加了一条给 ads 的话
        if (calls === 1) {
          store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "[bob]: @广告 看投放", fromUid: "u2", mentions: ["ads"] });
        }
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"] }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    expect(calls).toBe(1);
  });

  it("尾上多出来一条点名我的，照旧再采样一圈（issue #871 的语义不变）", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        if (calls === 1) {
          store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "[bob]: @运营 再看下退款", fromUid: "u2", mentions: ["ops"] });
        }
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"] }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    expect(calls).toBe(2);
  });

  it("没配 agentId 的 engine（本机会话）：mentions 不参与判断，尾上任何 user_message 都算没答的", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        if (calls === 1) store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "补一句", mentions: ["ads"] });
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("在吗");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/loop/engineLoggedTurn.test.ts`
Expected: FAIL —— `engine.runLoggedTurn is not a function`。

- [ ] **Step 3: 实现**

把 `runTurn` 拆成两半。`runTurn` 的开头（append opening）保留，其余整段挪进私有 `runFrom(opening)`：

```ts
  async runTurn(
    userInput: string,
    attachments?: UserAttachmentRef[],
    textFiles?: UserTextFile[],
    background?: { taskIds: string[] }
  ): Promise<"completed" | "aborted"> {
    const opening = this.append({
      ...this.envBase(),
      type: "user_message",
      content: userInput,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(textFiles && textFiles.length > 0 ? { textFiles } : {}),
      ...(background ? { origin: "background" as const, backgroundTaskIds: background.taskIds } : {}),
    });
    return this.runFrom(opening);
  }

  /** 对一条**已经在日志里**的 user_message 起 turn（#932 坑 ②）。云会话的
      发言在 say() 那一刻就落盘（带 fromUid/mentions），turn 可能排队等一会儿
      才轮到——轮到时开场白早就在日志里了，再 append 一条就是同一句话落两遍
      （模型读两遍、时间线画两遍）。runTurn 与它共用 runFrom：turn 的身份、
      收口、finally 清场一个字不差，只有"开场那条谁来落"不同。
      opening 必须带 seq（store.append 的返回值），不是 NewSessionEvent */
  async runLoggedTurn(opening: UserMessageEvent): Promise<"completed" | "aborted"> {
    return this.runFrom(opening);
  }

  private async runFrom(opening: SessionEvent): Promise<"completed" | "aborted"> {
    this.currentTurnId = opening.seq;
    this.turnAbort = new AbortController();
    this.compactFloor = null;
    try {
      // …原 runTurn 的 try/catch/finally 原封不动搬进来…
    }
  }
```

`UserMessageEvent` 从 `../session/events.js` 引入类型（文件顶部已 import `SessionEvent`，同一行加）。

`unseenUserTail`：

```ts
  private unseenUserTail(projected: SessionEvent[]): boolean {
    const lastSeq = projected.at(-1)?.seq ?? -1;
    const fresh = this.opts.store.load(this.opts.sessionId, { afterSeq: lastSeq });
    const me = this.opts.agentId;
    return fresh.some((e) => {
      if (e.type !== "user_message") return false;
      // 群聊里点了名的话只有被点的那只欠它一个回答（#932）：运营正在说话时
      // 有人 "@广告 看投放"，运营不该为此再采样一圈——那句不是说给它的。
      // 没配 agentId（本机会话）或这条没点名（群里随口一句）：照旧算没答的
      if (!me || !e.mentions || e.mentions.length === 0) return true;
      return e.mentions.includes(me);
    });
  }
```

- [ ] **Step 4: 跑测试 + 既有 engine 测试**

Run: `npx vitest run tests/loop && npx tsc --noEmit`
Expected: 全绿（`tests/loop/` 里既有的 runTurn 断言一条不改）。

- [ ] **Step 5: 提交**

```bash
git add src/loop/engine.ts tests/loop/engineLoggedTurn.test.ts
git commit -m "feat(engine): runLoggedTurn —— 对已落盘的 user_message 起 turn（#932 坑 ②）

云会话的发言要在 say() 那一刻落盘、turn 排队晚点跑；轮到时再 append 就是同一句
话两遍。runTurn 拆成 append + runFrom，行为逐字节不变。unseenUserTail 顺带认
mentions：点了别人名的尾巴不算我没答的，否则运营会替广告的问题多采样一圈。"
```

---

### Task 3: `src/shared/turnLedger.ts` —— 谁欠谁一个回答

**Files:**
- Create: `src/shared/turnLedger.ts`
- Test: `tests/shared/turnLedger.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OpenTurn { seq: number; fromUid: string | null; agentId: string; state: "queued" | "running" }
  export function openTurns(events: readonly SessionEvent[]): OpenTurn[]
  ```
  规则：每条带非空 `mentions` 的 `user_message` U，对其中每个 agentId A：若 U 之后存在 `turn_ended` 且 `agentId === A` → 收口（不出现在结果里）；否则若 U 之后存在**任何**带 `agentId === A` 的事件 → `running`；否则 `queued`。结果按 seq 升序、同 seq 按 mentions 顺序。
- Consumers：Task 4（重启补跑）、Task 10（时间线状态行）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/turnLedger.test.ts
import { describe, it, expect } from "vitest";
import { openTurns } from "../../src/shared/turnLedger.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { sessionId: "s1", ts: 0 };
let seq = 0;
const ev = <T extends Omit<SessionEvent, "seq" | "sessionId" | "ts">>(e: T) =>
  ({ ...base, seq: seq++, ...e }) as unknown as SessionEvent;

describe("openTurns（#932 坑 ②：排队中/正在回复是日志的投影）", () => {
  it("点了名、还没人动 —— queued", () => {
    seq = 0;
    const events = [ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] })];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("那只 agent 之后有动静（request_envelope/assistant_message 任一）—— running", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops", toolCalls: [{ id: "c", name: "bash", args: "{}" }] }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "running" }]);
  });

  it("turn_ended{agentId} 收口 —— 不再出现", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "好", model: "m", agentId: "ops" }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("两只：一只跑着一只排着，各算各的", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 @广告 一起", fromUid: "u1", mentions: ["ops", "ads"] }),
      ev({ type: "request_envelope", model: "m", agentId: "ops", messages: [] } as never),
    ];
    expect(openTurns(events)).toEqual([
      { seq: 0, fromUid: "u1", agentId: "ops", state: "running" },
      { seq: 0, fromUid: "u1", agentId: "ads", state: "queued" },
    ]);
  });

  it("别只的 turn_ended 不算数；旧日志（没 mentions）一条都不出", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: 在吗" }),
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ads" }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 1, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("同一只被连点两次、只跑了一轮：第一条在 turn 里被看见，第二条也随那条 turn_ended 收口", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });
});
```

`request_envelope` 那条用 `as never` 是为了不在测试里抄它十几个字段；实现只看 `type`/`agentId`/`seq`。若 `as never` 让 spread 的类型推导变成 `never` 而 tsc 报错，换成一条 `assistant_message{agentId:"ops"}`——判据是「任何带这只 agentId 的事件」，用哪种事件不重要。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/turnLedger.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```ts
// turnLedger —— 「谁欠谁一个回答」的日志投影（#932 坑 ②）。
//
// 云会话的发言在 say() 那一刻就落成 user_message（带 fromUid/mentions），turn
// 排队晚点才跑。「排队中 / 正在回复 / 答完了」因此不是内存里的队列状态，是这
// 三种事件形状的配对：点名的 user_message U → 之后那只 agent 有没有动静 →
// 有没有它的 turn_ended。两边共用一份：runtime 重启时按它补跑，渲染层按它画
// 状态行——两处各写一遍迟早分家（agentMention.ts 同款理由）。
//
// 纯函数零 IO，手机端将来也 import 这一份。

import type { SessionEvent } from "../session/events.js";

export interface OpenTurn {
  /** 开场那条 user_message 的 seq */
  seq: number;
  fromUid: string | null;
  agentId: string;
  /** queued = 那只 agent 在这条之后还没有任何动静；running = 有动静但没 turn_ended */
  state: "queued" | "running";
}

/** 按 seq 升序、同一条里按 mentions 顺序。收了口的（U 之后有该 agent 的
    turn_ended）不出现——"答完了"不需要一行来表示 */
export function openTurns(events: readonly SessionEvent[]): OpenTurn[] {
  const out: OpenTurn[] = [];
  for (let i = 0; i < events.length; i++) {
    const u = events[i]!;
    if (u.type !== "user_message" || !u.mentions || u.mentions.length === 0) continue;
    for (const agentId of u.mentions) {
      let state: OpenTurn["state"] | "done" = "queued";
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        const owner = "agentId" in e ? e.agentId : undefined;
        if (owner !== agentId) continue;
        if (e.type === "turn_ended") { state = "done"; break; }
        state = "running";
      }
      if (state !== "done") out.push({ seq: u.seq, fromUid: u.fromUid ?? null, agentId, state });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/shared/turnLedger.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/turnLedger.ts tests/shared/turnLedger.test.ts
git commit -m "feat(shared): turnLedger —— 排队中/正在回复是日志的投影（#932 坑 ②）

点名的 user_message 配对那只 agent 之后的动静与 turn_ended。runtime 重启补跑和
渲染层状态行共用这一份，不各写一遍。"
```

---

### Task 4: runtime —— 发言先落盘，turn 从日志起跑，四个坑一起修

**Files:**
- Modify: `services/runtime/src/turnCoordinator.ts`（`TurnJob` 形状）
- Modify: `services/runtime/src/sessionService.ts`（`resolveTargets` / `engineFor` / `runJob` / `say` / 重启补跑）
- Modify: `services/runtime/src/frameHandler.ts:363`（限速桶）
- Test: `tests/runtime/turnCoordinator.test.ts`（改 job 形状）、`tests/runtime/sessionService.test.ts`（改既有断言 + 新增六条）、`tests/runtime/frameHandler.test.ts`（限速一条）

**Interfaces:**
- Consumes: Task 1 字段、Task 2 `runLoggedTurn`、Task 3 `openTurns`。
- Produces: `TurnJob = { agentId: string; fromUid: string; opening: UserMessageEvent }`；`CloudSession.say` 签名不变；日志形状变化：**点了名的发言 = 一条 `user_message{fromUid, mentions}` 立刻落盘**（不再是 turn 开跑时由 engine 落）；没点名 = `chat_message`（不变）。

- [ ] **Step 1: 改 `TurnJob` 与它的测试**

`turnCoordinator.ts`：

```ts
export interface TurnJob {
  agentId: string;
  fromUid: string;
  /** 开场那条 user_message（say() 已经落盘、带 seq）。runJob 直接拿它起 turn，
      不再自己拼 `[label]: text`——那句话只存在于日志里一处 */
  opening: UserMessageEvent;
}
```

`tests/runtime/turnCoordinator.test.ts` 里所有 `{ agentId, fromUid, label, text }` 字面量改成 `{ agentId, fromUid, opening: um(n) }`（文件顶部加一个 `um = (seq: number): UserMessageEvent => ({ sessionId: "s", ts: 0, seq, type: "user_message", content: "x" })` 助手），断言语义不变。`UserMessageEvent` 类型从 `../../../src/session/events.js` 引入。跑 `npx vitest run tests/runtime/turnCoordinator.test.ts` 绿。

- [ ] **Step 2: 写失败测试（sessionService）**

追加到 `tests/runtime/sessionService.test.ts` 的 `describe("多智能体云会话（#928 切片 1a）")` 之后：

```ts
describe("多智能体云会话 · 切片 1b（#932 四个坑）", () => {
  function open(store: EventStore, opts: {
    agents: () => Promise<typeof AGENTS>;
    adapterFor: (a: (typeof AGENTS)[number]) => ModelAdapter;
    events?: SessionEvent[];
  }): CloudSession {
    return createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: opts.agents, adapterFor: opts.adapterFor,
      onEvent: (e) => opts.events?.push(e), onUsage: () => {},
    });
  }

  it("坑 ②：点了名的发言在 say() 那一刻就落 user_message（带 fromUid/mentions），turn 不再另落一条", async () => {
    const store = newStore();
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 看下销量", true, ["ops"]);
    const ums = store.load("s1").filter((e) => e.type === "user_message");
    expect(ums).toHaveLength(1);
    expect(ums[0]).toMatchObject({ content: "[alice]: @运营 看下销量", fromUid: "u1", mentions: ["ops"] });
    // 开场白 seq 在 assistant_message 之前
    const am = store.load("s1").find((e) => e.type === "assistant_message")!;
    expect(ums[0]!.seq).toBeLessThan(am.seq);
  });

  it("坑 ①：改了型号，下一 turn 立刻用新 adapter（不等 daemon 重启）", async () => {
    const store = newStore();
    let model = "m-v1";
    const used: string[] = [];
    const session = open(store, {
      agents: async () => [{ ...AGENTS[0]!, models: [model] }],
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { used.push(a.models[0]!); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 一", true, ["ops"]);
    model = "m-v2";
    await session.say("u1", "alice", "@运营 二", true, ["ops"]);
    expect(used).toEqual(["m-v1", "m-v2"]);
  });

  it("坑 ③：排队期间 agent 被删 —— 留一条 turn_ended{error, agentId}，openTurns 收口", async () => {
    const store = newStore();
    let roster = AGENTS;
    const session = open(store, {
      agents: async () => roster,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() {
          // 运营跑着的时候，广告被删了
          roster = AGENTS.filter((x) => x.agentId !== "ads");
          return { content: "答" };
        },
      }),
    });
    await session.say("u1", "alice", "@运营 @广告 一起", true, ["ops", "ads"]);
    const events = store.load("s1");
    const gone = events.find((e) => e.type === "turn_ended" && e.agentId === "ads");
    expect(gone).toMatchObject({ outcome: "error" });
    expect((gone as { error?: string }).error).toContain("ads");
    const { openTurns } = await import("../../src/shared/turnLedger.js");
    expect(openTurns(events)).toEqual([]);
  });

  it("坑 ④：客户端给了 mentions 就以它为准 —— mentions:[] + 正文含 @ 也只落 chat_message", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 这句只是复述，别跑", false, []);
    expect(seen).toEqual([]);
    expect(store.load("s1").map((e) => e.type)).toEqual(["chat_message"]);
  });

  it("坑 ④ 反面：mentions 缺席（手机端）仍走老语义 —— 正文解析、再回落名单第一只", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@广告 看投放", true);
    await session.say("u1", "alice", "在吗", true);
    expect(seen).toEqual(["ads", "ops"]);
  });

  it("重启补跑：日志里有排队中的点名发言，重新装配时自动跑完", async () => {
    const store = newStore();
    // 模拟"上一个 daemon 收下了话、还没跑就死了"：只有那条 user_message
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 看", fromUid: "u1", mentions: ["ops"] });
    const seen: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); resolveDone(); return { content: "答" }; } }),
    });
    await done;
    // 等 turn 完整收口：轮询 openTurns 直到空（最多 1s），不用固定 sleep
    const { openTurns } = await import("../../src/shared/turnLedger.js");
    for (let i = 0; i < 50 && openTurns(store.load("s1")).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["ops"]);
    expect(openTurns(store.load("s1"))).toEqual([]);
  });

  it("排空循环里一个 job 抛错，后面的 job 照跑 —— 每只各自收口，不再整队丢弃", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() { seen.push(a.agentId); if (a.agentId === "ops") throw new Error("boom"); return { content: "答" }; },
      }),
    });
    await session.say("u1", "alice", "@运营 @广告 一起", true, ["ops", "ads"]);
    expect(seen).toEqual(["ops", "ads"]);
    expect(session.isRunning()).toBe(false);
    const ends = store.load("s1").filter((e) => e.type === "turn_ended");
    expect(ends.map((e) => [e.agentId, (e as { outcome: string }).outcome])).toEqual([["ops", "error"], ["ads", "completed"]]);
  });
});
```

同时**修改既有断言**（它们钉的是 1a 的日志形状，本任务有意改掉）：
- 「排空循环中途抛错(#928 修复轮 1/5)：剩下的 job 不再尝试跑…」——语义反转：改成断言剩下的 job **照跑**（可直接删掉，由上面最后一条替代；删除理由写进 commit message：产品代码同 PR 改了行为，L2）。
- 「去重 … logged_only 补 chat_message」那条（修复轮 2/5）：去重命中时现在也是 **user_message**（say 一律先落）——断言改成 `user_message` 数 = 发言数、`assistant_message` 数 = 1。
- `frameHandler.test.ts` 若有断言 `say` 帧 → `session.say(uid,label,text,mention,mentions)` 透传的，保持；新增一条：`{t:"say", mention:false, mentions:["ops"]}` 走 **turn** 限速桶。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/runtime/sessionService.test.ts`
Expected: 新增七条至少五条 FAIL。

- [ ] **Step 4: 实现 sessionService**

`resolveTargets`（坑 ④）：

```ts
function resolveTargets(text, mention, mentions, roster): string[] {
  const known = new Set(roster.map((a) => a.agentId));
  // 客户端给了 mentions（**含空数组**）= 它已经决定了这句话点了谁：新版桌面
  // 的 chip 输入让用户看得见自己 @ 到了谁，服务端再解析一遍只会让界面说
  // 「我没 @ 任何人」而服务端认为 @ 了（#932 坑 ④）。以它为准，不回落
  if (mentions !== undefined) return mentions.filter((id) => known.has(id));
  const parsed = parseMentions(text, roster.map((a) => ({ agentId: a.agentId, name: a.name })));
  if (parsed.length) return parsed;
  return mention && roster[0] ? [roster[0].agentId] : [];
}
```

`engineFor`（坑 ①）：

```ts
  function engineFor(spec: AgentSpec): LoopEngine {
    const hit = engines.get(spec.agentId);
    if (hit) {
      // 每 turn 现取 adapter（#932 坑 ①，ADR-0202 同款）：型号来自这只 agent
      // 此刻的白名单。不比对"变没变"——比对的判据一漏就是静默用旧型号
      hit.setAdapter(opts.adapterFor(spec));
      return hit;
    }
    …原样…
  }
```

`runJob`（坑 ③ + 从日志起跑）：

```ts
  async function runJob(job: TurnJob): Promise<void> {
    router.setInitiator(job.fromUid);
    currentInitiator = job.fromUid;
    currentAgentId = job.agentId;
    try {
      const roster = await opts.agents();
      const spec = roster.find((a) => a.agentId === job.agentId);
      if (!spec) {
        // 排队期间这只 agent 被删了（#932 坑 ③）。开场白已经落盘、mentions 里
        // 有它——不留痕的话 openTurns 会把它永远算作「排队中」。落一条它的
        // turn_ended{error}：推导收口，人也看得见这一轮为什么没跑
        notify(store.append({
          sessionId, ts: Date.now(), type: "turn_ended", outcome: "error",
          // 用 agentId 不用名字：名字已经查不到了（就是因为它被删了），别为一条
        // 错误信息再去猜
        error: `智能体 ${job.agentId} 已不在这个工作区，这句话没人接`,
          agentId: job.agentId,
        }));
        return;
      }
      briefIfNeeded(spec, roster);
      const engine = engineFor(spec);
      …px 那段原样…
      await engine.runLoggedTurn(job.opening);
    } finally {
      currentInitiator = null;
      currentAgentId = null;
    }
  }
```

排空循环（抽成具名函数，`say` 与重启补跑共用）：

```ts
  /** 排空协调器直到 null。**每个 job 各自 catch**：一只抛错（模型 key 没配、
      runTurn 暴死）不该让排在它后面的那只被整队丢弃——1a 那版是"抛错就
      放弃剩下的、每个补一条 chat_message"，现在开场白早已在日志里、每只
      的收口由 turn_ended 各自负责（engine 抛之前已经落了 turn_ended{error}），
      跳过这一只接着跑下一只才是对的。runJob 自己抛的那种（开场白找不到）
      同样只影响这一只 */
  async function drain(): Promise<void> {
    let job = coordinator.nextJob();
    while (job !== null) {
      try {
        await runJob(job);
      } catch (err) {
        console.error(`[otto-runtime] turn 失败（agent=${job.agentId} opening=${job.opening.seq}）`, err);
      }
      job = coordinator.nextJob();
    }
  }
```

`say`：

```ts
    async say(fromUid, label, text, mention, mentions) {
      const roster = await opts.agents();
      const targets = resolveTargets(text, mention, mentions, roster);
      if (targets.length === 0) {
        logChat(fromUid, label, text, mention);
        return;
      }
      // 先落盘再排队（#932 坑 ②）：收下了 = 记下了。排队纯内存，daemon 重启
      // 会丢；但开场白已经在日志里，重启时 openTurns 能把它找回来补跑
      const opening = store.append({
        sessionId, ts: Date.now(), type: "user_message",
        content: `[${label}]: ${text}`, fromUid, mentions: targets,
      }) as UserMessageEvent; // append 回的是 union；这一条我们刚亲手写的就是 user_message
      notify(opening);
      const decisions = targets.map((agentId) => coordinator.enqueue({ agentId, fromUid, opening }));
      // 全是 logged_only（每只都已在队里）：这句话已经落盘，排着的那轮读日志
      // 时看得见它（engine 的 unseenUserTail 也认得它）——不用再补任何事件
      if (!decisions.includes("start_turn")) return;
      await drain();
    },
```

原来的 `finally` 补偿循环整段删掉（它补的是「丢弃的 job 说过的话」，现在话早就在日志里了）。`logChat` 只剩「没点名」一个调用方，保留。

重启补跑（`createCloudSession` 末尾、`return {...}` 之前）：

```ts
  // 重启补跑（#932 坑 ②）：上一个 daemon 收下了话（user_message 已落盘）、
  // 还没跑到就死了——按同一份推导把它们重新排上。openTurns 里 running 的
  // 也重排：它的 turn 在上一个进程里没收口，这里再跑一遍（日志会多一段
  // 尝试，但比永远「排队中」诚实）。fromUid 缺席只可能是旧日志——旧日志
  // 没有 mentions，压根进不了 openTurns
  const stale = openTurns(seed);
  if (!archived && stale.length > 0) {
    const decisions: EnqueueDecision[] = [];
    for (const t of stale) {
      const opening = seed.find((e) => e.seq === t.seq);
      if (t.fromUid === null || !opening || opening.type !== "user_message") continue;
      decisions.push(coordinator.enqueue({ agentId: t.agentId, fromUid: t.fromUid, opening }));
    }
    if (decisions.includes("start_turn")) void drain();
  }
```

`openTurns` 从 `../../../src/shared/turnLedger.js` 引入；`UserMessageEvent` 从 `../../../src/session/events.js`；`EnqueueDecision` 从 `./turnCoordinator.js` 导出（已有的类型，加进 import）。daemon 侧不用改：重启补跑的 drain 第一个 `await opts.agents()` 就让出了事件循环，daemon 里 `let session!` 那句赋值早在 `recordUsage` 第一次被调用之前完成。

`frameHandler.ts:363`：

```ts
          const kind = msg.mention || (msg.mentions?.length ?? 0) > 0 ? "turn" : "say";
```

- [ ] **Step 5: 跑测试 + 冒烟**

Run: `npx vitest run tests/runtime && npx tsc --noEmit && npm run runtime:smoke`
Expected: 全绿。冒烟脚本的「event 帧序列以 user_message 开头」断言仍成立（现在 user_message 落得更早了）。

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src tests/runtime
git commit -m "feat(runtime): 发言先落盘再排队，turn 从日志起跑；四个坑一起修（#932）

① engineFor 命中缓存也 setAdapter——改型号下一 turn 生效，不等重启（ADR-0202 同款）。
② say() 收下即落 user_message{fromUid,mentions}；排队纯内存但开场白在日志里，
   重启按 openTurns 补跑。runJob 用 runLoggedTurn，不再让 engine 重落一条。
③ 排队期间 agent 被删：落 turn_ended{error,agentId}，推导收口、人看得见。
④ 客户端给了 mentions（含 []）就以它为准，不再重解析正文。
排空循环改成每 job 各自 catch：一只抛错不丢整队（1a 那条测试语义反转，随本次
产品代码一起改，非删测试保绿）。限速桶按 mentions 也算 turn。"
```

---

### Task 5: 数据层 —— `WorkspaceSnapshot.agents` + 三条行操作 + 校验纯逻辑

**Files:**
- Modify: `src/shared/workspaces.ts`（`WorkspaceAgentRow`、`WorkspaceSnapshot.agents`、`assembleSnapshot` 第 5 个位置参数）
- Create: `src/shared/workspaceAgents.ts`
- Modify: `src/main/supabaseWorkspacesApi.ts`（`fetchWorkspace` + 三个函数）
- Test: `tests/shared/workspaces.test.ts`（三处调用改签名 + 一条新断言）、`tests/shared/workspaceAgents.test.ts`（新）

**Interfaces:**
- Produces:
  ```ts
  // src/shared/workspaces.ts
  export interface WorkspaceAgentRow {
    agentId: string; name: string; description: string; instructions: string;
    models: string[]; createdBy: string; updatedTs: number;
  }
  export interface WorkspaceSnapshot { …; agents: WorkspaceAgentRow[] }
  export function assembleSnapshot(ws, members, connectors, sessions,
    agents: readonly { agent_id: string; name: string; description: string; instructions: string; models: unknown; created_by: string; updated_at: string }[],
    labelOf): WorkspaceSnapshot
  ```
  `models` 形状不对（非数组/含非字符串）回 `[]`，与 `normalizeTools` 同一条口径（复用它）。`agents` 按 `created_at` 升序由查询保证（管理员是种下的第一行 = 名单第一只 = 服务端老语义的默认那只，**顺序必须和 daemon 的 `queryAgents` 一致**：都 `order("created_at")`）。
  ```ts
  // src/shared/workspaceAgents.ts
  export const AGENT_NAME_MAX = 32;
  /** null = 合法；否则一句给人看的理由 */
  export function validateAgentName(raw: string): string | null;
  /** "a, b，c" → ["a","b","c"]；去空、去重、保序 */
  export function parseModelList(raw: string): string[];
  ```
  规则：`trim()` 后 1–32 字符；不许含 `@`（它是寻址前缀）；不许含换行；首尾空白剔掉（DB check 是 `char_length between 1 and 32`，这里对齐）。
  ```ts
  // src/main/supabaseWorkspacesApi.ts
  export async function insertAgentRow(client, row: { workspaceId; agentId; name; description; instructions; models: string[]; createdBy }): Promise<void>
  export async function updateAgentRow(client, workspaceId, agentId, patch: { name?; description?; instructions?; models? }): Promise<void>  // .select("agent_id") 空 → throw "行不存在或无权修改"
  export async function deleteAgentRow(client, workspaceId, agentId): Promise<void>  // 同上，"行不存在或无权删除"
  ```
  `updateAgentRow` 写 `updated_at: new Date().toISOString()`（同 `upsertConnectorRow`）。

- [ ] **Step 1: 写失败测试**

`tests/shared/workspaces.test.ts`：三处 `assembleSnapshot(...)` 调用在 `labelOf` 前插入 `[]`；第一条的期望对象加 `agents: []`。新增一条：

```ts
  it("agents：models 形状不对回 []，updated_at → ms，created_by 原样", () => {
    const snapshot = assembleSnapshot(
      WS, [], [], [],
      [
        { agent_id: "admin", name: "管理员", description: "", instructions: "", models: ["deepseek-v4"], created_by: "owner-uid-12345678", updated_at: "2026-09-01T00:00:00.000Z" },
        { agent_id: "a1", name: "运营", description: "管店铺", instructions: "你管运营", models: "nope", created_by: "u2", updated_at: "bad" },
      ],
      () => null,
    );
    expect(snapshot.agents).toEqual([
      { agentId: "admin", name: "管理员", description: "", instructions: "", models: ["deepseek-v4"], createdBy: "owner-uid-12345678", updatedTs: Date.parse("2026-09-01T00:00:00.000Z") },
      { agentId: "a1", name: "运营", description: "管店铺", instructions: "你管运营", models: [], createdBy: "u2", updatedTs: 0 },
    ]);
  });
```

`tests/shared/workspaceAgents.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { AGENT_NAME_MAX, parseModelList, validateAgentName } from "../../src/shared/workspaceAgents.js";

describe("validateAgentName", () => {
  it("合法：中文 / 英文 / 带空格，1–32 字符", () => {
    expect(validateAgentName("运营")).toBeNull();
    expect(validateAgentName("Ads Analyst")).toBeNull();
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX))).toBeNull();
  });
  it("空 / 全空白 / 超长 / 含 @ / 含换行 —— 各给一句理由", () => {
    expect(validateAgentName("")).toMatch(/名字/);
    expect(validateAgentName("   ")).toMatch(/名字/);
    expect(validateAgentName("x".repeat(AGENT_NAME_MAX + 1))).toMatch(/32/);
    expect(validateAgentName("运@营")).toMatch(/@/);
    expect(validateAgentName("运\n营")).toMatch(/换行/);
  });
});

describe("parseModelList", () => {
  it("英文/中文逗号、多余空白、重复、空项", () => {
    expect(parseModelList(" deepseek-v4 ,glm-5，deepseek-v4,, ")).toEqual(["deepseek-v4", "glm-5"]);
    expect(parseModelList("")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/workspaces.test.ts tests/shared/workspaceAgents.test.ts`
Expected: FAIL（模块不存在 / `agents` 缺席）。

- [ ] **Step 3: 实现**

`src/shared/workspaces.ts`：加类型、`assembleSnapshot` 加参数（位置在 `sessions` 之后、`labelOf` 之前，**必填**——写成可选尾参的话 `fetchWorkspace` 忘接线就是静默没有 agents），映射：

```ts
    agents: agents.map((a) => ({
      agentId: a.agent_id, name: a.name, description: a.description, instructions: a.instructions,
      models: normalizeTools(a.models), // 同一条口径：形状不对宁可当空
      createdBy: a.created_by, updatedTs: toEpochMs(a.updated_at),
    })),
```

`src/shared/workspaceAgents.ts`：

```ts
// workspaceAgents —— 工作区 agent 表单的纯校验（#932 切片 1b）。
// 桌面设置页用；手机端将来做同一张表单时 import 同一份（纪律同 workspaces.ts）。
// DB 那侧的约束（0021：name 1–32 字符、一个工作区不重名）在这里对齐成能提前
// 说出口的人话；重名靠 23505 回来再翻，这里判不了。

export const AGENT_NAME_MAX = 32;

export function validateAgentName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "名字不能为空";
  if (name.length > AGENT_NAME_MAX) return `名字最多 ${AGENT_NAME_MAX} 个字符`;
  if (name.includes("@")) return "名字里不能有 @——它是点名用的前缀";
  if (/[\r\n]/.test(name)) return "名字不能换行";
  return null;
}

export function parseModelList(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,，]/)) {
    const m = piece.trim();
    if (m !== "" && !out.includes(m)) out.push(m);
  }
  return out;
}
```

`src/main/supabaseWorkspacesApi.ts`：`fetchWorkspace` 在 sessions 之后加一段：

```ts
  const agents = (unwrap(
    await client.from("workspace_agents")
      .select("agent_id,name,description,instructions,models,created_by,updated_at")
      .eq("workspace_id", id)
      .order("created_at", { ascending: true }),
  ) ?? []) as { agent_id: string; name: string; description: string; instructions: string; models: unknown; created_by: string; updated_at: string }[];
```

传给 `assembleSnapshot(ws, members, connectors, sessions, agents, …)`。三个行函数照 `deleteSessionRow` 的「`.select` 是唯一的行数证据」写法。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/shared && npx tsc --noEmit`
Expected: PASS。tsc 会把所有构造 `WorkspaceSnapshot` 字面量的测试（`tests/main/workspaceManager.test.ts`、`tests/renderer/*workspace*`）标红——**给它们都补 `agents: []`**，这一步归本任务。

- [ ] **Step 5: 提交**

```bash
git add src/shared/workspaces.ts src/shared/workspaceAgents.ts src/main/supabaseWorkspacesApi.ts tests
git commit -m "feat(workspaces): 快照长出 agents + 三条行操作 + 表单纯校验（#932）

渲染层的 @ 名单与设置页都从 WorkspaceSnapshot.agents 读，不另开一条 IPC 拉名单。
assembleSnapshot 的新参数必填：写成可选尾参的话 fetchWorkspace 忘接线就是静默
没有名单。顺序 order(created_at) 与 daemon 的 queryAgents 一致——名单第一只是
服务端老语义的默认那只，两边不一致会让「不 @ 谁接」在界面和服务端上答案不同。"
```

---

### Task 6: 主进程编排 + IPC + store action

**Files:**
- Modify: `src/main/workspaceManager.ts`（deps + 三个方法）
- Modify: `src/shared/shellBridge.ts:1035-1058` 附近（三条方法）、`src/preload/index.ts:222-236`、`src/main/index.ts:3197-3208`
- Modify: `src/renderer/src/store.ts`（三个 action，照 `contributeWorkspaceConnector` 的写法）
- Test: `tests/main/workspaceManager.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ShellBridge
  workspaceAgentCreate(id: string, draft: { name: string; description: string; instructions: string; models: string[] }): Promise<FriendsResult<{ agentId: string }>>;
  workspaceAgentUpdate(id: string, agentId: string, patch: { name?: string; description?: string; instructions?: string; models?: string[] }): Promise<FriendsResult<null>>;
  workspaceAgentDelete(id: string, agentId: string): Promise<FriendsResult<null>>;
  // store
  createWorkspaceAgent(id, draft): Promise<boolean>; updateWorkspaceAgent(id, agentId, patch): Promise<boolean>; deleteWorkspaceAgent(id, agentId): Promise<boolean>;
  ```
  `agentId` 由主进程生成：`"a_" + randomBytes(6).toString("hex")`（`node:crypto`；不是 name 的 slug——spec §3：改名不换键）。`23505` → 人话 `已有同名的智能体`（manager 层翻，同 `unwrap` 带的 `code`）。`admin` 的删除在 manager 层就拒：`return { ok:false, message:"管理员不能删除" }`——RLS 也拦，但那条回来的是一句 PostgREST 的英文。

- [ ] **Step 1: 写失败测试**

`tests/main/workspaceManager.test.ts` 的 harness deps 加三个假函数（`insertAgentRow` / `updateAgentRow` / `deleteAgentRow` 各 push 一条 calls），新增：

```ts
describe("workspace agents（#932）", () => {
  it("createAgent：生成 a_ 前缀的 agentId，透传 draft，回 agentId", async () => {
    const { manager, calls } = harness();
    const r = await manager.createAgent("ws-1", { name: "运营", description: "管店铺", instructions: "你管运营", models: ["deepseek-v4"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.agentId).toMatch(/^a_[0-9a-f]{12}$/);
    expect(calls).toContain("insertAgentRow");
  });
  it("createAgent：23505 翻成「已有同名的智能体」", async () => {
    const { manager } = harness({
      insertAgentRow: async () => { throw Object.assign(new Error("duplicate key"), { code: "23505" }); },
    });
    const r = await manager.createAgent("ws-1", { name: "运营", description: "", instructions: "", models: [] });
    expect(r).toEqual({ ok: false, message: "已有同名的智能体" });
  });
  it("deleteAgent：admin 在本层就拒，不打网络", async () => {
    const { manager, calls } = harness();
    expect(await manager.deleteAgent("ws-1", "admin")).toEqual({ ok: false, message: "管理员不能删除" });
    expect(calls).not.toContain("deleteAgentRow");
  });
  it("updateAgent：透传 patch", async () => {
    const { manager, calls } = harness();
    expect(await manager.updateAgent("ws-1", "a_1", { models: ["glm-5"] })).toEqual({ ok: true, value: null });
    expect(calls).toContain("updateAgentRow");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/workspaceManager.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现** manager 三个方法（`withSession` 包一层；`createAgent` 里 `randomBytes(6).toString("hex")`；catch 里 `if ((e as {code?:string}).code === "23505") throw new Error("已有同名的智能体")`——注意 `withSession` 的 catch 会把 message 收敛，所以在业务体里转译再抛）。ShellBridge 三条方法 + 注释；preload 三行；`main/index.ts` 三个 handle；store 三个 action（成功后 `refreshWorkspaceGroups()`，失败落 `workspaceGroupsError`，回布尔）。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/main/workspaceManager.test.ts && npx tsc --noEmit`

- [ ] **Step 5: 提交**

```bash
git add src/main/workspaceManager.ts src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/renderer/src/store.ts tests/main/workspaceManager.test.ts
git commit -m "feat(workspace): agent 增删改的编排 + IPC + store action（#932）

agentId 主进程生成（a_ + 12 hex），不是名字的 slug——改名不换键（spec §3）。
23505 在编排层翻成人话；admin 的删除在本层就拒，RLS 那条回来的是英文。"
```

---

### Task 7: 设置页「智能体」tab

**Files:**
- Modify: `src/renderer/src/lib/workspaceView.ts`（`agentRows` / `agentNameOf`）
- Create: `src/renderer/src/components/WorkspaceAgentsTab.tsx`
- Modify: `src/renderer/src/components/WorkspacePage.tsx`（第四个 `TabsTrigger`/`TabsContent`；文件头注释补一句）
- Modify: `src/renderer/src/components/WorkspacesSidebarSection.tsx:141` 附近的 ⚙ `title` 加「智能体」
- Test: `tests/renderer/workspaceView.agents.test.ts`（新）

**Interfaces:**
- Produces:
  ```ts
  export interface AgentRowView { agentId; name; description; modelsSummary: string; isAdmin: boolean; canEdit: boolean; canDelete: boolean; creatorLabel: string }
  export function agentRows(ws: WorkspaceSnapshot, selfUid: string): AgentRowView[]
  /** agentId → 名字；查不到回 agentId 本身（被删了的 agent 在旧消息上还得有个把手） */
  export function agentNameOf(ws: WorkspaceSnapshot, agentId: string): string
  ```
  `modelsSummary`：`[]` → `"用工作区默认型号"`；否则 `models.join(" · ")`。`canEdit = createdBy === selfUid || ws.ownerUid === selfUid`；`canDelete = canEdit && !isAdmin`；`isAdmin = agentId === "admin"`。
- Consumes: Task 5 快照、Task 6 action。

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/workspaceView.agents.test.ts
import { describe, it, expect } from "vitest";
import { agentNameOf, agentRows } from "../../src/renderer/src/lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [],
  members: [{ uid: "owner", role: "owner", label: "Stan" }, { uid: "m1", role: "member", label: "Mei" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], createdBy: "owner", updatedTs: 0 },
    { agentId: "a_1", name: "运营", description: "管店铺", instructions: "", models: ["deepseek-v4", "glm-5"], createdBy: "m1", updatedTs: 0 },
  ],
};

describe("agentRows（spec §9 权限矩阵）", () => {
  it("owner：都能改，管理员不能删", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => [r.agentId, r.canEdit, r.canDelete])).toEqual([["admin", true, false], ["a_1", true, true]]);
  });
  it("成员：只能改删自己建的", () => {
    const rows = agentRows(ws, "m1");
    expect(rows.map((r) => [r.agentId, r.canEdit, r.canDelete])).toEqual([["admin", false, false], ["a_1", true, true]]);
  });
  it("型号摘要：空 = 用工作区默认；否则点连", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => r.modelsSummary)).toEqual(["用工作区默认型号", "deepseek-v4 · glm-5"]);
    expect(rows[1]!.creatorLabel).toBe("Mei");
  });
});

describe("agentNameOf", () => {
  it("查得到用名字，查不到回 id", () => {
    expect(agentNameOf(ws, "a_1")).toBe("运营");
    expect(agentNameOf(ws, "a_gone")).toBe("a_gone");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**，实现 `workspaceView.ts` 两个函数，跑绿。

- [ ] **Step 3: 组件 `WorkspaceAgentsTab.tsx`**

结构（照 `ConnectorsTab` + `ContributeConnectorDialog` 的骨架）：

- 顶部右侧 `<Button size="sm">新建智能体…</Button>`。
- 列表：每行 `ROW + border`：`<b>{name}</b>`（`isAdmin` 时后跟 `<span className="text-[10.5px] text-muted-foreground">· 管理员</span>`），第二行 `text-[10.5px] text-muted-foreground`：`{description || "没有写职责"} · {modelsSummary} · {creatorLabel}`。右侧：`canEdit` → `编辑`（ghost xs），`canDelete` → `删除`（ghost xs text-err，`confirm(\`删除智能体「${name}」？它的提示词和型号配置会一起消失，正在排队的消息会被标成没人接。\`)`）。`isAdmin && canEdit` → 编辑钮旁 `title="管理员不能删除"`。
- 空态不会出现（每个工作区至少有管理员）；但 `ws.agents.length === 0`（真库还没回填/查询失败）时显示一句 `text-xs text-muted-foreground`：`还没读到这个工作区的智能体名单。`——**不是**「还没有智能体」（同 CloudStateDot 的「拿不到 ≠ 没有」纪律）。
- `AgentEditorDialog`（同文件）：`mode: "create" | "edit"`；字段：名字（`Input`，必填，`validateAgentName` 实时提示）、职责（`Input`，一句话，进别人的 briefing roster）、提示词（`textarea`，`min-h-[120px]`，同 CloudSessionPage 的 textarea 类名去掉 rounded-2xl 改 `rounded-md`）、型号（`Input`，placeholder `逗号分隔，第一个是默认；留空用工作区的型号`，`parseModelList`；下方一行 HINT：`型号 id 得是工作区所配那家提供商认得的——这里不校验`）。保存：create → `createWorkspaceAgent`；edit → `updateWorkspaceAgent`（只发变了的字段）。失败不关窗、错误取 `useChat.getState().workspaceGroupsError`（同 `CloudRepoConfigDialog` 的理由，那段注释原话照抄一句）。busy 时禁用。
- 动效：Dialog 用 shadcn 既有；按钮 `press-scale`。

`WorkspacePage.tsx`：`<TabsTrigger value="agents">智能体</TabsTrigger>` 排在「会话」之后、「连接器」之前（顺序理由写注释：智能体是用的最多的一页，连接器/成员是配一次的东西）。文件头注释末尾补一句「智能体 tab（#932 切片 1b）：@ 得着的那几只在这儿建改删」。

- [ ] **Step 4: tsc + 手工冒烟**

Run: `npx tsc --noEmit && npx vitest run tests/renderer`
手工：`npm run dev`，进任一工作区 ⚙ → 智能体 tab：建一只「运营」→ 列表出现；改型号 → 摘要变；删 → 消失；试删管理员 → 没有删除钮。（记进 report，不作为自动化断言）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/workspaceView.ts src/renderer/src/components/WorkspaceAgentsTab.tsx src/renderer/src/components/WorkspacePage.tsx src/renderer/src/components/WorkspacesSidebarSection.tsx tests/renderer/workspaceView.agents.test.ts
git commit -m "feat(ui): 工作区设置页「智能体」tab —— 建改删 + 型号白名单（#932）

权限按 spec §9：建 = 任何成员，改删 = 建的人或 owner，管理员没有删除钮。
名单读不到时说「还没读到」不说「还没有」——每个工作区至少种了管理员。"
```

---

### Task 8: `cloudSay` 带 `mentions` 走完整条 IPC + @ 输入纯逻辑

**Files:**
- Modify: `src/shared/shellBridge.ts`（`workspaceCloudSay(text, mention, mentions?)`）、`src/preload/index.ts:243`、`src/main/index.ts:3293`、`src/main/cloudSessionClient.ts:657-661`、`src/renderer/src/store.ts`（`cloudSay(text, mentions?: string[])`）
- Create: `src/renderer/src/lib/agentMentionInput.ts`
- Test: `tests/renderer/agentMentionInput.test.ts`、`tests/main/cloudSessionClient*.test.ts`（若有 say 的断言，加一条透传）

**Interfaces:**
- Produces:
  ```ts
  // store
  /** mentions 缺席 = 老语义（开局卡那句：不 @ 也由名单第一只接）；给了（含 []）= 以它为准 */
  cloudSay(text: string, mentions?: string[]): Promise<boolean>;
  // 主进程 cloudSessionClient
  say(text: string, mention: boolean, mentions?: string[]): Promise<FriendsResult<null>>;
  // src/renderer/src/lib/agentMentionInput.ts
  /** 光标前的那段是不是正在打 @：返回 @ 的下标与已打的查询串；不是回 null。
      判据与 parseMentions 的边界一致：@ 前是行首或非构词字符 */
  export function mentionQueryAt(text: string, caret: number): { at: number; query: string } | null;
  /** 把光标前那个 @query 换成 @名字 + 空格，返回新文本与新光标 */
  export function applyAgentMention(text: string, at: number, caret: number, name: string): { text: string; caret: number };
  /** 候选过滤：名字或职责包含 query（大小写不敏感）；空 query = 全部 */
  export function filterAgentCandidates<T extends { name: string; description: string }>(roster: readonly T[], query: string): T[];
  ```
  `store.cloudSay` 把 `mentions` 翻成 `mention = mentions === undefined ? true : mentions.length > 0`——**布尔与数组必须同源**：手写两份就是坑 ④ 在客户端重演。

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/agentMentionInput.test.ts
import { describe, it, expect } from "vitest";
import { applyAgentMention, filterAgentCandidates, mentionQueryAt } from "../../src/renderer/src/lib/agentMentionInput.js";

describe("mentionQueryAt", () => {
  it("刚打了 @ / 打了一半 / 中文标点后 —— 都算正在打", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ at: 0, query: "" });
    expect(mentionQueryAt("看下 @运", 4)).toEqual({ at: 3, query: "运" });
    expect(mentionQueryAt("你好，@广", 5)).toEqual({ at: 3, query: "广" });
  });
  it("邮箱 / @ 后面已经有空格 / 光标不在末尾那段 —— 不算", () => {
    expect(mentionQueryAt("rick@x", 6)).toBeNull();
    expect(mentionQueryAt("@运营 看", 5)).toBeNull();
    expect(mentionQueryAt("@运营 看", 2)).toEqual({ at: 0, query: "运" });
  });
});

describe("applyAgentMention", () => {
  it("换掉 @query，补空格，光标落在空格后", () => {
    expect(applyAgentMention("看下 @运 明天", 3, 5, "运营")).toEqual({ text: "看下 @运营  明天", caret: 7 });
  });
});

describe("filterAgentCandidates", () => {
  const roster = [{ name: "管理员", description: "" }, { name: "运营", description: "管店铺" }, { name: "Ads", description: "投放" }];
  it("空 = 全部；按名字或职责；大小写不敏感", () => {
    expect(filterAgentCandidates(roster, "")).toHaveLength(3);
    expect(filterAgentCandidates(roster, "店").map((r) => r.name)).toEqual(["运营"]);
    expect(filterAgentCandidates(roster, "ads").map((r) => r.name)).toEqual(["Ads"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**，实现：

```ts
// agentMentionInput —— composer 里「正在打 @」的光标判定与补全写回（#932 切片 1b）。
// **不是**@ 解析：发送时点了谁一律由 src/shared/remote/agentMention.ts 的
// parseMentions 决定（三端共用那一份）。这里只回答"光标此刻是不是停在一个
// 没打完的 @ 后面、打了几个字"，好决定要不要弹选人列表——那是编辑器的事，
// 与"这句话最后点了谁"是两个问题。边界判据抄 parseMentions 的口径（@ 前是
// 行首或非构词字符），不然邮箱地址会弹出选人。

const WORD = /[\p{L}\p{N}_]/u;

export function mentionQueryAt(text: string, caret: number): { at: number; query: string } | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && WORD.test(head[at - 1]!)) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null; // 已经打过空格 = 这个 @ 结束了
  return { at, query };
}

export function applyAgentMention(text: string, at: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, at) + inserted + text.slice(caret), caret: at + inserted.length };
}

export function filterAgentCandidates<T extends { name: string; description: string }>(roster: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  return roster.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
}
```

IPC 五处按签名加第三参（preload：`(text, mention, mentions) => ipcRenderer.invoke(CHANNELS.workspaceCloudSay, text, mention, mentions ?? null)`——IPC 里 `undefined` 会被序列化丢掉，用 `null` 走线，主进程 handler 再 `?? undefined` 回来，注释说明）。`store.cloudSay`：

```ts
  async cloudSay(text, mentions) {
    // 布尔与数组同源：mentions 缺席 = 老语义（开局卡那句话不 @ 也由名单第一只接）
    const mention = mentions === undefined ? true : mentions.length > 0;
    const r = await window.otter.workspaceCloudSay(text, mention, mentions);
    …其余不变…
  },
```

`CloudSessionMain.tsx` 与 `CloudSessionPage.tsx` 里既有的 `cloudSay(text, true)` 改成 `cloudSay(text)`（老语义），`cloudSay(text, mentionOn)` 暂改成 `cloudSay(text, mentionOn ? undefined : [])`——Task 9 会整个换掉，这里只求 tsc 绿。

- [ ] **Step 3: 跑测试 + tsc**

Run: `npx vitest run tests/renderer/agentMentionInput.test.ts tests/main && npx tsc --noEmit`

- [ ] **Step 4: 提交**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/main/cloudSessionClient.ts src/renderer/src/store.ts src/renderer/src/lib/agentMentionInput.ts src/renderer/src/components/CloudSessionMain.tsx src/renderer/src/components/CloudSessionPage.tsx tests/renderer/agentMentionInput.test.ts
git commit -m "feat(cloud): cloudSay 带 mentions 走通 IPC；@ 输入的光标判定纯逻辑（#932）

布尔与数组在 store 一处同源翻译，不手写两份。光标判定不是 @ 解析——发送时点了
谁仍由 parseMentions 唯一决定；这里只管要不要弹选人列表，边界口径抄它的。"
```

---

### Task 9: composer —— @ 选人 + chip 预览

**Files:**
- Modify: `src/renderer/src/components/CloudSessionPage.tsx`（footer 那段 + `submit`；`mentionOn` 删掉）
- Modify: `src/renderer/src/components/CloudSessionMain.tsx`（挂载时 `refreshWorkspaceGroups()` 一次）
- Modify: `src/renderer/src/components/CloudWelcome.tsx`（placeholder 加一句「不 @ 谁的话由管理员接」——只改文案）

**Interfaces:**
- Consumes: Task 8 的 `mentionQueryAt` / `applyAgentMention` / `filterAgentCandidates`、`store.cloudSay(text, mentions)`、`parseMentions`、`ws.agents`。

- [ ] **Step 1: 实现**

在 `CloudSessionPage` 内：

```ts
  const roster = ws.agents; // 名单第一只 = 管理员（created_at 升序）
  const candidates = useMemo(() => roster.map((a) => ({ agentId: a.agentId, name: a.name, description: a.description })), [roster]);
  const [caret, setCaret] = useState(0);
  const picking = mentionQueryAt(draft, caret);           // 正在打 @？
  const options = picking ? filterAgentCandidates(candidates, picking.query) : [];
  const [hi, setHi] = useState(0);                          // 高亮下标；options 变了归零
  const mentions = useMemo(() => parseMentions(draft, candidates), [draft, candidates]); // 发送时点了谁——唯一那份规则
```

- 选人弹层：`picking && options.length > 0` 时在 textarea **上方**画一个 `absolute bottom-full mb-1 left-0` 的小列表（`rounded-md border border-border bg-popover shadow-sm py-1 min-w-[200px] max-w-[320px]`），每行 `name` + `text-muted-foreground` 的 `description`（truncate），高亮行 `bg-foreground/[0.06]`。键盘：`ArrowUp/ArrowDown` 移动、`Enter`/`Tab` 选中（`applyAgentMention` 写回并把光标放回去：`requestAnimationFrame(() => box.setSelectionRange(caret, caret))`）、`Escape` 关（本地 `dismissedAt` 记 `picking.at`，同一个 @ 不再弹）。鼠标点行同 Enter。**Enter 在弹层开着时不发送**。进入动效：`starting:opacity-0 starting:translate-y-[2px] transition-[opacity,transform] duration-150 ease-[var(--ease-strong)]`（同 StagedChips 那条），`transform-origin: bottom left`。
- textarea `onSelect`/`onKeyUp`/`onClick` 更新 `caret = e.currentTarget.selectionStart`（`onChange` 里也更新）。
- chips 行：`mentions.length > 0` 时在 textarea 上方（弹层之下）画一行 `flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground`：前缀「发给」，每只一枚 `rounded-full border border-border px-2 py-[1px]` 的 pill 写名字。这行**只读**（去掉 chip = 从正文里删掉 @，正文才是事实）。`mentions.length === 0 && draft.trim() !== ""` 时不画这行，靠 placeholder：`输入 @ 点名智能体；不 @ 就只是群里说一句`。
- `AtSign` 那颗钮改成「插入 @」：`onClick` 在光标处插入 `@`（若前一个字符是构词字符先补空格），聚焦 textarea——弹层随之出现。`title="@ 智能体"`。`mentionOn` state 与 `variant` 切换整段删掉。
- `submit`：`const ok = await cloudSay(text, mentions);`。

`CloudSessionMain.tsx`：

```ts
  const refreshGroups = useChat((s) => s.refreshWorkspaceGroups);
  // 进云会话时刷一次快照：agent 名单是别的成员也能改的，而 workspaceGroups
  // 没有推送通道（只在本地改动后重拉）——不刷的话别人新建的那只 @ 不到
  useEffect(() => { if (cs?.sessionId) void refreshGroups(); }, [cs?.sessionId, refreshGroups]);
```

- [ ] **Step 2: tsc + 既有 renderer 测试 + 手工冒烟**

Run: `npx tsc --noEmit && npx vitest run tests/renderer`
手工：进云会话，打 `你好，@` → 弹层列出管理员/运营；↓ Enter → 正文变 `你好，@运营 `，chips 行「发给 运营」；发送 → 时间线出现这句；打 `rick@x` 不弹层；`mentions` 空时发送 → 只落 chat_message（服务端不起 turn）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/components/CloudSessionPage.tsx src/renderer/src/components/CloudSessionMain.tsx src/renderer/src/components/CloudWelcome.tsx
git commit -m "feat(ui): 云会话 composer —— @ 选人弹层 + 「发给谁」chip 预览（#932）

chip 行只读：去掉一枚 = 从正文里删 @，正文才是事实。发送带的 mentions 与 chip
同一份 parseMentions 算出——界面上写着发给谁，服务端就跑谁（坑 ④ 两端对齐）。
「@Agent」布尔开关撤掉：有了名单，'对 Agent 说' 得说清对哪只。"
```

---

### Task 10: 时间线 —— 谁说的、说给谁、谁还没回

**Files:**
- Create: `src/renderer/src/lib/cloudTimeline.ts`（`parseUserMessageLabel` 从组件里搬过来 + 下面两个纯函数）
- Modify: `src/renderer/src/components/CloudSessionPage.tsx`（`AssistantMessageRow` / `UserMessageRow` / 事件循环 / 新 `PendingTurnLines`、`AgentBriefedRow`；import lib）
- Test: `tests/renderer/cloudTimelineLabels.test.ts`（新，纯逻辑那几条）

**Interfaces:**
- Consumes: `agentNameOf(ws, agentId)`（Task 7）、`openTurns(events)`（Task 3）、`UserMessageEvent.fromUid/mentions`（Task 1）。
- Produces（`src/renderer/src/lib/cloudTimeline.ts`，纯逻辑零 React，同仓库「组件旁边放一个 lib」的惯例）：
  ```ts
  /** user_message 行的署名与归属：fromUid 在就按 uid 判「是不是我」，否则退回 1a 的前缀比对 */
  export function userRowIdentity(e: UserMessageEvent, ws: WorkspaceSnapshot, selfUid: string): { label: string | null; text: string; mine: boolean; targets: string[] }
  /** assistant_message 的署名：agentId 查名单；没 agentId（旧日志/单 agent）→ "Agent" */
  export function assistantLabel(e: AssistantMessageEvent, ws: WorkspaceSnapshot): string
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/cloudTimelineLabels.test.ts
import { describe, it, expect } from "vitest";
import { assistantLabel, userRowIdentity } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan" }, { uid: "u2", role: "member", label: "Stan" }],
  agents: [{ agentId: "a_1", name: "运营", description: "", instructions: "", models: [], createdBy: "u1", updatedTs: 0 }],
};
const base = { sessionId: "s", ts: 0, seq: 0 } as const;

describe("userRowIdentity", () => {
  it("有 fromUid：同名两个人也分得开", () => {
    const e = { ...base, type: "user_message" as const, content: "[Stan]: @运营 看", fromUid: "u2", mentions: ["a_1"] };
    expect(userRowIdentity(e, ws, "u1")).toEqual({ label: "Stan", text: "@运营 看", mine: false, targets: ["运营"] });
    expect(userRowIdentity(e, ws, "u2").mine).toBe(true);
  });
  it("旧日志没 fromUid：退回前缀比对", () => {
    const e = { ...base, type: "user_message" as const, content: "[Stan]: 在吗" };
    expect(userRowIdentity(e, ws, "u1")).toEqual({ label: "Stan", text: "在吗", mine: true, targets: [] });
  });
});

describe("assistantLabel", () => {
  it("agentId 查名单；查不到回 id；没有回 Agent", () => {
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m", agentId: "a_1" }, ws)).toBe("运营");
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m", agentId: "a_x" }, ws)).toBe("a_x");
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m" }, ws)).toBe("Agent");
  });
});
```

- [ ] **Step 2: 实现**

- `src/renderer/src/lib/cloudTimeline.ts`：`parseUserMessageLabel`（原样搬，组件里删掉）、`userRowIdentity`、`assistantLabel`。`userRowIdentity`：`parseUserMessageLabel` 做前缀剥离；`mine = e.fromUid ? e.fromUid === selfUid : parsed.label === labelOf(ws, selfUid)`；`targets = (e.mentions ?? []).map((id) => agentNameOf(ws, id))`。
- `UserMessageRow` 标签行末尾加 `targets.length > 0 ? \` · → ${targets.join("、")}\` : ""`。
- `AssistantMessageRow` 标签用 `assistantLabel(event, ws)`（组件多接一个 `ws` prop）。
- `PendingTurnLines`：`const pending = useMemo(() => openTurns(events), [events])`；在时间线**末尾**（审批卡之前）画：每条 `text-[11px] text-muted-foreground px-1`：`{agentNameOf(ws, t.agentId)} {t.state === "running" ? "正在回复…" : "排队中…"}`；running 那条前面一个 `size-[6px] rounded-full bg-brand animate-pulse` 的点，queued 用 `bg-muted-foreground/40` 不闪。多条按 seq 顺序。**画在末尾而不是贴在各自那条消息下面**：排队的东西看的是「接下来会发生什么」，那是时间线尾巴的事。
- `agent_briefed`：事件循环里加一个分支，画一行 `text-[10.5px] text-muted-foreground/70 px-1 italic`：`「{e.name}」就位{e.instructions.trim() ? "（提示词已更新）" : ""}`。它是「改了提示词真的生效了」在界面上唯一的痕迹。
- `turn_ended{error}`：已经由 `EventRow` 画 `TurnErrorState`（Timeline.tsx:641），不动；但 `EventRow` 的 `isLast` 决定「重试」钮，云会话里那颗钮点了走本地 `resendMessage`——**云会话里必须不出**：事件循环里 `turn_ended` 分支传 `isLast={false}`（一行注释：云端没有重发这条路，钮出来就是撒谎）。先 grep 确认 `EventRow` 对 `turn_ended` 的 interactive 只看 `isLast`。

- [ ] **Step 3: tsc + 测试 + 手工冒烟**

Run: `npx tsc --noEmit && npx vitest run tests/renderer/cloudTimelineLabels.test.ts`
手工：@运营 发一句 → 立刻出现「运营 排队中…」→ 变「正在回复…」→ 回复气泡署名「运营」→ 状态行消失；user 行标签「Stan · 12:00 · → 运营」。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/lib/cloudTimeline.ts src/renderer/src/components/CloudSessionPage.tsx tests/renderer/cloudTimelineLabels.test.ts
git commit -m "feat(ui): 云会话时间线 —— 谁说的、说给谁、谁还没回（#932）

assistant 按 agentId 署名；user 行按 fromUid 判归属（同名两人也分得开）、标出 → 谁；
末尾按 openTurns 画「排队中 / 正在回复」——那是日志的投影不是 UI 本地态，daemon
重启回来也还在。agent_briefed 画一行「就位」：改提示词生效了在界面上唯一的痕迹。"
```

---

### Task 11: ADR-0220 + 索引 + 交接

**Files:**
- Create: `docs/adr/0220-云会话发言先落盘再排队.md`（编号合并前 `git -c core.quotePath=false ls-tree origin/main docs/adr/` 复核，ADR-0074）
- Modify: `AGENTS.md`「Where to find things」：eventLog/agentView/sessionService 那一行末尾补 1b 的三句（发言先落盘、turnLedger、客户端 mentions 优先）；新增一行 `src/shared/turnLedger.ts` / `src/renderer/src/lib/agentMentionInput.ts` / `WorkspaceAgentsTab.tsx`
- Modify: `CONTEXT.md` 产品/技术术语：`openTurns`（排队中/正在回复的日志投影）、`工作区 agent`（若 1a 没加）
- Modify: `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md` §4.5 补一句「客户端给了 mentions（含 []）以它为准」（spec 是活文档，改动理由写在 ADR）

ADR 内容（四节）：
1. **发言先落盘再排队**：1a 的 `say()` 收下了 ≠ 记下了（队列纯内存）；改成 `user_message{fromUid, mentions}` 当场落盘，turn 用 `runLoggedTurn` 从日志起跑；「排队中」是 `openTurns` 的投影；重启补跑。否决的两条：往协议里加 `queued` 帧（内存状态的另一份拷贝，重启还是丢）、把 chat_message 当排队记录（turn 跑起来时 user_message 再落一遍 = 同一句话两遍）。代价：engine 多一个入口；`unseenUserTail` 要认 mentions。
2. **客户端 mentions 优先**：坑 ④；老客户端不受影响。推翻它的前提：手机端也做了 chip 输入之后，布尔字段可以退役。
3. **adapter 每 turn 现取**：ADR-0202 在 agent 粒度的重申。
4. **删 agent 留痕 = turn_ended{error}**：为什么不是 chat_message（推导要收口）。
末尾「推翻它的前提」一节 + 关联 #932 / ADR-0219 / ADR-0202。

- [ ] **Step 1: 写三份文档**，`npx vitest run tests/docs` 绿（编号唯一）。
- [ ] **Step 2: 提交**

```bash
git add docs/adr/0220-*.md AGENTS.md CONTEXT.md docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md
git commit -m "docs(adr): 云会话发言先落盘再排队——ADR-0220、索引、spec §4.5 补句（#932）"
```

---

## 自查（写完计划后对着 spec 与 #932 过一遍）

- spec §10 1b 三项：@ chip 输入（Task 8/9）、时间线「谁说的」（Task 10）、设置页 CRUD + 型号白名单（Task 5/6/7）——齐。
- #932 四个坑：① Task 4 `engineFor`；② Task 1/2/3/4/10 整条链；③ Task 4 `runJob`；④ Task 4 `resolveTargets` + Task 8 store 同源。
- #932「推迟的小项」不进本计划（留给收尾 issue）；「带去切片 4 的隐患」不动 `OTHER_AGENT_VERDICTS`。
- 类型一致性：`TurnJob.opening.seq`（Task 4）↔ `openTurns().seq`（Task 3）；`WorkspaceAgentRow`（Task 5）↔ `agentRows`（Task 7）↔ `candidates`（Task 9）；`cloudSay(text, mentions?)`（Task 8）↔ Task 9 调用。
- 占位符扫描：无 TBD/TODO；每个代码步骤都有代码。
