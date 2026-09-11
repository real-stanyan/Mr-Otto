# 任务会话云端日志（底座 ①）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录用户的每条任务会话在 Supabase 有一份账号级副本；本机 sqlite 是它的前缀副本；「笔」租约决定同一时刻谁在跑 turn；换执行器这件事写进日志并投影成提示词；两个 `OTTO_PROFILE` 桌面实例能互相接着聊。

**Architecture:** 一张 `task_sessions`（笔 / `last_seq` / 标题投影）+ 一张 append-only `task_session_events`，写只走 `security definer` RPC（`seq` CAS + 「executor 类事件必须握笔、人话免笔」）。桌面主进程加一个复制器 `taskSessionSync`（`EventStore.onAppend` 观察者 → 按持久化游标推；realtime `task_sessions` UPDATE + 60 s sweep → 拉尾巴 muted append）；冲突按「云端赢：纯人为动作重放、含 turn 痕迹分叉」处理。新事件 `executor_changed` 投影成 system 尾块。runtime / 手机本计划一个字不碰。

**Tech Stack:** TypeScript strict、vitest（`tests/` 镜像 `src/`，`tempDir()` 帮手）、better-sqlite3 `EventStore`、Electron IPC（`CHANNELS` + preload `subscribe`）、Supabase（PostgREST RPC / Storage / Realtime `postgres_changes`）、React + Zustand。

**Spec:** `docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md`（Task issue #1223）

## Global Constraints

- 硬规则：渲染层只走 `window.otter`（ShellBridge）；`src/shared` 不 import node builtin / electron（`tests/architecture.test.ts` 钉着，手机端也跑）；工具只依赖 `ExecutionWorld`；新事件类型必须向后兼容（`ignorable: true`）。
- 新事件类型检查清单（本计划第 12 处是 `PEN_VERDICTS`）：`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、`persistencePolicy.ts`、`tests/session/persistencePolicy.test.ts` 的 `DURABLE`、`agentView.ts` `OTHER_AGENT_VERDICTS`、`sessionPackage.ts` `PRIVACY_VERDICTS`、`contextEstimate.ts` `pendingAfter`、`deriveMessages.ts`、`aui/toThreadMessages.ts` `isAuditEvent` + `components/Timeline.tsx` `EventRow`（两份名单由 `tests/renderer/timelineLists.test.ts` 对表）、`src/shared/taskSync.ts` `PEN_VERDICTS`。`deriveSections` / `deriveUsage` 无需改动（前者没有按类型的 switch，后者只认 `BILLED_EVENT_TYPES`）。
- 常量以 `src/shared/taskSync.ts` 为准：`PEN_TTL_S = 30`、`PEN_RENEW_MS = 10_000`、`PULL_PAGE = 500`、`TASK_TEXT_MAX_BYTES = 65536`、`TASK_EVENT_MAX_BYTES = 2097152`。RPC 里的数字与免笔类型清单必须与它逐字一致（有断言对表）。
- Supabase 错误码约定：`P0010` seq_conflict、`P0011` pen_required、`P0012` forbidden/形状非法、`P0013` no_session。
- RPC 权限走仓库既有习惯（`0002_token_wallets.sql:141-148`）：`security definer` + 内部实现函数对所有角色 `revoke`、`authenticated` 只拿到 uid 从 `auth.uid()` 读的包装、`service_role` 只拿到显式 `p_uid` 的 `_as` 包装。**不用 `auth.role()`**（仓库零先例）。
- 文案纪律（ADR-0248 同族）：「云端还没建表」「连不上」不许写成「你没登录」；三态分开说。
- 门禁 `npm test`（tsc + vitest）全绿才提交；测试放 `tests/` 镜像目录；`src/shared/**` 的测试放 `tests/shared/`。
- 提交信息写 **why**，末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。分支 `claude/otto-task-sync-local-cloud-d8ef1a`，PR 合并走 merge commit。

## 与 spec 的实施偏差（合并前把这几条补进 spec §3.6 / §7，Task 16）

1. **附件不做「读时回取」而是「拉到即取」**：spec §3.6 写的 `attachmentFetch` 包装要把四处同步读字节的闭包（`attachmentStore.read` 是同步的）改成异步，波及 vision-bridge / 分享 / data-URL 三条路。改成 puller 追加事件后立刻下载它引用的图片进本地 `AttachmentStore`（内容寻址 `save()`），失败进 `missingAttachments` 下次 sweep 重试。四处闭包一个字不动。
2. **睡眠打断用 `interrupted` 收口**：`engine.abortTurn(reason)` 加一个可选 `"interrupted"`，`turn_ended.outcome` 照写；`lastUnanswered` 把它算「没答」、`aborted` 算「答过」。
3. **建会话那一批（seq 0 起）由 RPC 顺手把笔发给创建者**：否则 `[session_created, memory_loaded, …]` 里第二条就要笔、而笔要行先存在——鸡生蛋。
4. **分叉出来的兄弟会话不写 `forkedFrom`**：`store.purge` 会因为「有分支引用」拒绝抹掉原 id（`store.ts:199-216`），而分叉之后紧接着就要 purge + 重拉。分叉身份靠标题后缀「（本机未同步的分支）」（一条 `session_renamed`）。
5. **多一条 push 通道 `taskSessionReplaced`**：purge + 重拉之后，渲染层若正开着那条会话必须整份重载，没有既有通道能表达「这条会话的日志被整体换掉了」。
6. **realtime 同时订 INSERT 与 UPDATE**：别的设备新建的会话是 INSERT，不订就要等 60 s sweep。

---

## File map

| 文件 | 职责 |
|---|---|
| `supabase/migrations/0036_task_sessions.sql`（新） | 两张表 + RLS + realtime publication + 三组 RPC（`_impl` / `authenticated` 包装 / `_as` 包装）+ bucket `task-attachments` 四条策略 |
| `src/shared/sessionId.ts`（新） | `newSessionId()` 从 `src/main/agent.ts` 搬来（纯，用 `globalThis.crypto`），agent.ts 改成 re-export |
| `src/shared/taskSyncState.ts`（新） | `TaskSyncState` 四态（同 `memorySyncState.ts`） |
| `src/shared/taskSync.ts`（新） | 常量、`PEN_VERDICTS`、`HUMAN_EVENT_TYPES`、`holderId` / `holderKindOf`、`currentExecutor`、`lastUnanswered`、`divergence`、`sliceBatches`、`attachmentRefsOf`、`isTaskSessionCreated`、`stableStringify` |
| `src/session/events.ts` | `ExecutorChangedEvent` + union + `KNOWN_EVENT_TYPES_MAP` |
| `src/session/persistencePolicy.ts` / `agentView.ts` / `src/shared/sessionPackage.ts` / `src/shared/contextEstimate.ts` | 新类型表态 |
| `src/session/deriveMessages.ts` | `renderExecutorPrompt` + `executor_changed` case + system 尾块 |
| `src/session/store.ts` | `EventStoreOptions.onAppend` 观察者、`lastSeq(sessionId)` |
| `src/loop/engine.ts` | `abortTurn(reason?)`、`logUserMessage(...)`（`runTurn` = 它 + `runFrom`） |
| `src/main/taskSessionsApi.ts`（新） | `TaskSessionsApi` 接口、`TaskSessionRow`、`TaskSyncError` |
| `src/main/supabaseTaskSessionsApi.ts`（新） | 真 supabase 实现：RPC / select / storage / realtime；错误码映射 |
| `src/main/taskSyncStore.ts`（新） | `task-sync.json` 的 load / save / normalise |
| `src/main/taskSessionSync.ts`（新） | 复制器：推（含笔）、拉（muted）、sweep、realtime、冲突、附件、状态 |
| `src/main/taskWorkspace.ts` | `resolveResumeWorkspace`（default 种缺 `workspace` 时派生） |
| `src/main/index.ts` | 装配、观察者接线、`handleSendMessage` 拆成 `driveTurn`、笔准入、`answerLogged`、`ensureResumed`、powerMonitor、删除同步、IPC |
| `src/shared/shellBridge.ts` / `src/preload/index.ts` | `taskSyncStatus` invoke、`taskSyncState` / `taskWaiting` / `taskSessionReplaced` push、`SessionRuntime.waitingFor` |
| `src/renderer/src/store.ts` / `lib/agentPhase.ts` / `lib/runtimeHydration.ts` / `aui/OttoThread.tsx` / `App.tsx` / `components/TaskSyncStatusLine.tsx`（新）/ `lib/executorMarker.ts`（新）/ `components/Timeline.tsx` / `aui/toThreadMessages.ts` | 状态、第七档相位、指示条闸门、账号页那一行、时间线分隔行 |
| `CONTEXT.md` / `docs/adr/0284-*.md` / `AGENTS.md`（索引一行）/ spec 偏差段 | 术语、决策、索引 |
| `tests/shared/sessionId.test.ts`、`tests/shared/taskSync.test.ts`、`tests/session/deriveMessages.executor.test.ts`、`tests/session/store.onAppend.test.ts`、`tests/loop/engineInterrupt.test.ts`、`tests/docs/taskSessionsMigration.test.ts`、`tests/main/supabaseTaskSessionsApi.test.ts`、`tests/main/taskSyncStore.test.ts`、`tests/main/taskSessionSync.test.ts`、`tests/main/taskSessionSync.conflict.test.ts`、`tests/main/taskWorkspace.resume.test.ts`、`tests/renderer/lib/agentPhase.test.ts`（补）、`tests/renderer/lib/runtimeHydration.waiting.test.ts`、`tests/renderer/lib/executorMarker.test.ts` | 见各 Task |

---

### Task 1: `newSessionId` 搬进 `src/shared/`

**Files:**
- Create: `src/shared/sessionId.ts`
- Modify: `src/main/agent.ts:151-160`
- Test: `tests/shared/sessionId.test.ts`

**Interfaces:**
- Produces: `newSessionId(): string`（形状 `s-<14 位数字>-<8 位小写 hex>`，与 `SESSION_FOLDER_RE` 一致）。`src/main/agent.ts` 继续 `export { newSessionId }`，`index.ts:26` 的 import 不用改。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/sessionId.test.ts
import { describe, expect, it } from "vitest";
import { newSessionId } from "../../src/shared/sessionId.js";
import { SESSION_FOLDER_RE } from "../../src/shared/defaultWorkspace.js";

describe("newSessionId（搬进 shared，#1223）", () => {
  it("形状与 Default 子目录名的正则一致：s-<14 位>-<8 hex>", () => {
    const id = newSessionId();
    expect(id).toMatch(SESSION_FOLDER_RE);
  });
  it("随机段承重：连铸 200 个不重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/shared/sessionId.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/sessionId.js'`

- [ ] **Step 3: 写实现**

```ts
// src/shared/sessionId.ts
// 会话 id：秒级时间戳 + 随机段。原来住在 src/main/agent.ts（随机段用 node 的 randomBytes）。
// 搬进 shared 是因为手机端（③）也要铸同一形状：Default 子目录名就是它（ADR-0206），
// 另一台电脑靠它算路径。随机段是承重的那一半——id 是 append-only 日志的分区键，
// 撞一次就是两个会话的事件写进同一条日志，事后拆不开（#111）。
// 不 import node:crypto：src/shared 三端共用（tests/architecture.test.ts 钉着），
// Node 20+ / Electron / RN（polyfill 后）都有 globalThis.crypto.getRandomValues。
export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `s-${stamp}-${hex}`;
}
```

把 `src/main/agent.ts:151-160` 那个函数（含它上面那段注释）整体删掉，换成：

```ts
// 会话 id 的铸法搬进了 src/shared/sessionId.ts（#1223：手机端也要铸同一形状）。
// 这里 re-export 是为了 index.ts 与既有测试的 import 路径一个字不改
export { newSessionId } from "../shared/sessionId.js";
```

然后检查 `src/main/agent.ts` 里 `randomBytes` 是否还有别的用处（`grep -n "randomBytes" src/main/agent.ts`）：没有就从那行 `node:crypto` import 里删掉它，否则 tsc 报未使用。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/shared/sessionId.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/sessionId.ts src/main/agent.ts tests/shared/sessionId.test.ts
git commit -m "refactor(session): newSessionId 搬进 src/shared——手机端要铸同一形状（#1223）

Default 子目录名就是 sessionId（ADR-0206），云端建的会话要能在任何一台 Mac 上算出同一个
路径，手机端建会话就得用同一把铸模。shared 不能 import node:crypto，随机段改用
globalThis.crypto.getRandomValues；agent.ts 保留 re-export，调用方零改动。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 新事件类型 `executor_changed`（类型 + 各处表态 + 时间线分隔行）

**Files:**
- Modify: `src/session/events.ts`（`VoiceCallChangedEvent` 之后加接口；union `:1070` 后加成员；`KNOWN_EVENT_TYPES_MAP` `:1132` 后加键）
- Modify: `src/session/persistencePolicy.ts:75` 之后加 case
- Modify: `tests/session/persistencePolicy.test.ts` 的 `DURABLE` 数组（`:46` `"voice_call_changed",` 之后加一行）
- Modify: `src/session/agentView.ts:103` 之后加 `executor_changed: "keep",`
- Modify: `src/shared/sessionPackage.ts:143` 之后加 `executor_changed: "strip",`
- Modify: `src/shared/contextEstimate.ts:185-188` 那个 case 后面加同款 `break`
- Modify: `src/renderer/src/aui/toThreadMessages.ts:106` 之后加 case → `return true`
- Modify: `src/renderer/src/components/Timeline.tsx`（import + `EventRow` 新 case）
- Create: `src/renderer/src/lib/executorMarker.ts`
- Test: `tests/renderer/lib/executorMarker.test.ts`；既有 `tests/renderer/timelineLists.test.ts`、`tests/shared/sessionPackage.test.ts`、`tests/session/persistencePolicy.test.ts` 必须继续绿

**Interfaces:**
- Produces: `ExecutorChangedEvent { type: "executor_changed"; executor: "desktop" | "cloud"; label?: string; ignorable: true }`；`executorMarkerText(e: ExecutorChangedEvent): string`。

- [ ] **Step 1: 写失败的测试（分隔行文案）**

```ts
// tests/renderer/lib/executorMarker.test.ts
import { describe, expect, it } from "vitest";
import { executorMarkerText } from "../../../src/renderer/src/lib/executorMarker.js";
import type { ExecutorChangedEvent } from "../../../src/session/events.js";

const ev = (executor: "desktop" | "cloud", label?: string): ExecutorChangedEvent => ({
  seq: 3, sessionId: "s", ts: 0, type: "executor_changed", executor, ignorable: true,
  ...(label !== undefined ? { label } : {}),
});

describe("executorMarkerText（#1223）", () => {
  it("云端：说清是手机那头在续", () => {
    expect(executorMarkerText(ev("cloud"))).toBe("在云端继续（手机）");
  });
  it("回到电脑：带设备名；没有设备名就只说回到电脑", () => {
    expect(executorMarkerText(ev("desktop", "Stan 的 MacBook"))).toBe("回到电脑（Stan 的 MacBook）");
    expect(executorMarkerText(ev("desktop"))).toBe("回到电脑");
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/renderer/lib/executorMarker.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 事件类型 + 各处表态**

`src/session/events.ts`，紧跟 `VoiceCallChangedEvent`（`:604` 之后）加：

```ts
/** 这条任务会话此刻由谁在跑（#1223，spec §3.4）：电脑上的 Otto 还是云端 runtime。
    拿到笔的那一方在起 turn 之前落一条，且仅当与 `currentExecutor(events)` 不同时才落
    （一条都没有 = 桌面，存量日志全是桌面写的；云端建的会话因此天然在 seq 1 落 `cloud`）。
    模型可见面是 deriveMessages 投影出来的 system 尾块（云端：碰不到电脑文件；回到电脑：
    全部工具可用），事件本身 `ignorable`：旧桌面跳过它只少一行时间线，不会复活残缺会话。
    `label` 是桌面这台设备的人话名（`os.hostname()`），云端缺席；换了一台 Mac 时投影据它
    多说一句「文件不在这台机器上」 */
export interface ExecutorChangedEvent extends SessionEventBase {
  type: "executor_changed";
  executor: "desktop" | "cloud";
  label?: string;
  ignorable: true;
}
```

union（`:1070` `| VoiceCallChangedEvent` 之后）加 `| ExecutorChangedEvent`；`KNOWN_EVENT_TYPES_MAP`（`:1132` `voice_call_changed: true,` 之后）加 `executor_changed: true,`。

`src/session/persistencePolicy.ts:75` 之后：

```ts
    case "executor_changed": // 换执行器（#1223）：提示词块与时间线分隔行都从它投影，谁在跑这件事推不出来
```

`tests/session/persistencePolicy.test.ts:46` 之后加 `"executor_changed",`。

`src/session/agentView.ts:103` 之后：

```ts
  // 换执行器（#1223）：任务会话专属，团队会话里不会出现；穷举表要它表态，群事实 = keep
  executor_changed: "keep",
```

`src/shared/sessionPackage.ts:143` 之后：

```ts
  executor_changed: "strip", // 哪台设备在跑是发送方这个人的私事，不是这段对话（#1223）
```

`src/shared/contextEstimate.ts`，在 `case "voice_call_changed":` 那组（`:185-188`）之后加：

```ts
      case "executor_changed":
        // 换执行器（#1223）：投影成 system 尾块，块的大小按最新状态计——本机圆环暂不计
        // （块最长 120 字，误差远小于 tool_result 的估算噪声）；要精确就按 renderExecutorPrompt 现算
        break;
```

`src/renderer/src/aui/toThreadMessages.ts:106`（`case "route_changed":`）之后、`return true;` 之前加：

```ts
    // 换执行器（#1223）：「这段是在手机上/云端续的」是往回翻时唯一能答这个问题的一行，
    // 同 branch_checked_out——一条真的分隔线
    case "executor_changed":
```

- [ ] **Step 4: 分隔行**

```ts
// src/renderer/src/lib/executorMarker.ts
// 时间线上「换了执行器」那一行分隔线写什么（#1223）。纯函数，Timeline.tsx 与将来的手机端共用口径。
import type { ExecutorChangedEvent } from "../../../session/events.js";

export function executorMarkerText(e: ExecutorChangedEvent): string {
  if (e.executor === "cloud") return "在云端继续（手机）";
  return e.label ? `回到电脑（${e.label}）` : "回到电脑";
}
```

`src/renderer/src/components/Timeline.tsx`：
- `:7` 的 lucide import 改成 `import { Cloud, GitBranch, ImageIcon, KeyRound, Monitor, Share2 } from "lucide-react";`
- `:22` 附近加 `import { executorMarkerText } from "../lib/executorMarker.js";`
- 在 `case "branch_checked_out":` 那个分支（`:553-564`）之后加：

```tsx
    // 换执行器（#1223）：同 branch_checked_out 用 separator——线之上和线之下，跑这段话的不是同一台机器
    case "executor_changed":
      return (
        <Marker variant="separator" className="py-1" data-testid="executor-marker">
          <MarkerIcon>{event.executor === "cloud" ? <Cloud /> : <Monitor />}</MarkerIcon>
          <MarkerContent>{executorMarkerText(event)}</MarkerContent>
        </Marker>
      );
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run tests/renderer/lib/executorMarker.test.ts tests/renderer/timelineLists.test.ts tests/shared/sessionPackage.test.ts tests/session/persistencePolicy.test.ts && npx tsc --noEmit`
Expected: 全 PASS；tsc 零错误（`KNOWN_EVENT_TYPES_MAP` / `OTHER_AGENT_VERDICTS` / `PRIVACY_VERDICTS` 三张穷举表少一处 tsc 就红）

- [ ] **Step 6: Commit**

```bash
git add src/session/events.ts src/session/persistencePolicy.ts tests/session/persistencePolicy.test.ts src/session/agentView.ts src/shared/sessionPackage.ts src/shared/contextEstimate.ts src/renderer/src/aui/toThreadMessages.ts src/renderer/src/components/Timeline.tsx src/renderer/src/lib/executorMarker.ts tests/renderer/lib/executorMarker.test.ts
git commit -m "feat(session): 新事件 executor_changed——这条任务会话此刻由谁在跑（#1223）

拿到笔的那一方在起 turn 前落一条（与 currentExecutor 不同时才落）。ignorable：旧桌面跳过
只少一行时间线。这次只加类型与 11 处表态 + 时间线分隔行，模型可见面下一条提交。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `src/shared/taskSync.ts` 纯函数 + `TaskSyncState`

**Files:**
- Create: `src/shared/taskSyncState.ts`、`src/shared/taskSync.ts`
- Test: `tests/shared/taskSync.test.ts`

**Interfaces:**
- Produces（后面每个 Task 都靠这些名字）：
  - `PEN_TTL_S`、`PEN_RENEW_MS`、`PULL_PAGE`、`TASK_TEXT_MAX_BYTES`、`TASK_EVENT_MAX_BYTES`
  - `type PenVerdict = "human" | "executor"`；`PEN_VERDICTS: Record<SessionEvent["type"], PenVerdict>`；`HUMAN_EVENT_TYPES: ReadonlySet<string>`
  - `type ExecutorKind = "desktop" | "cloud"`；`type HolderKind = ExecutorKind | "phone"`；`holderId(kind, deviceId)`；`holderKindOf(holder: string | null): HolderKind | null`
  - `currentExecutor(last: ExecutorChangedEvent | null): ExecutorKind`（O(1)，主进程喂 `store.lastOfType`）；`executorOfLog(events): { kind: ExecutorKind; label: string | null }`
  - `lastUnanswered(events): UserMessageEvent | null`
  - `type Divergence = { kind: "none" } | { kind: "human_only" | "has_executor"; at: number }`；`divergence(local, cloud)`
  - `sliceBatches(events, maxBytes)`、`attachmentRefsOf(event): string[]`、`isTaskSessionCreated(first: SessionEvent | undefined): boolean`、`stableStringify(v: unknown): string`、`sameEvent(a, b): boolean`
  - `TaskSyncState`（`src/shared/taskSyncState.ts`）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/taskSync.test.ts
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type SessionEvent } from "../../src/session/events.js";
import {
  attachmentRefsOf, currentExecutor, divergence, executorOfLog, HUMAN_EVENT_TYPES, holderId, holderKindOf,
  isTaskSessionCreated, lastUnanswered, PEN_VERDICTS, sameEvent, sliceBatches, TASK_EVENT_MAX_BYTES,
} from "../../src/shared/taskSync.js";

let seq = 0;
const ev = (e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent =>
  ({ seq: seq++, sessionId: "s", ts: 1, ...e }) as unknown as SessionEvent;
const reset = () => { seq = 0; };

describe("PEN_VERDICTS（#1223）", () => {
  it("每个已知事件类型都表过态；人话那批是且只是 spec §3.8 列的那 12 种", () => {
    expect([...Object.keys(PEN_VERDICTS)].sort()).toEqual([...KNOWN_EVENT_TYPES].sort());
    expect([...HUMAN_EVENT_TYPES].sort()).toEqual([
      "branch_checked_out", "image_model_changed", "memory_user_edit", "model_changed", "session_archived",
      "session_created", "session_renamed", "session_shared", "session_topic_set", "session_unarchived",
      "share_grant_note", "user_message",
    ]);
    expect(PEN_VERDICTS.assistant_message).toBe("executor");
    expect(PEN_VERDICTS.executor_changed).toBe("executor");
  });
});

describe("holder", () => {
  it("形状与反解", () => {
    expect(holderId("desktop", "abc")).toBe("desktop:abc");
    expect(holderId("cloud", "ignored")).toBe("cloud");
    expect(holderKindOf("desktop:abc")).toBe("desktop");
    expect(holderKindOf("cloud")).toBe("cloud");
    expect(holderKindOf("phone:x")).toBe("phone");
    expect(holderKindOf(null)).toBeNull();
    expect(holderKindOf("garbage")).toBeNull();
  });
});

describe("currentExecutor / executorOfLog", () => {
  it("一条都没有 = 桌面；最后一条胜出；label 跟着最后一条桌面事件", () => {
    reset();
    expect(currentExecutor(null)).toBe("desktop");
    const a = ev({ type: "executor_changed", executor: "cloud", ignorable: true });
    const b = ev({ type: "executor_changed", executor: "desktop", label: "MacBook", ignorable: true });
    expect(currentExecutor(a as never)).toBe("cloud");
    expect(executorOfLog([a])).toEqual({ kind: "cloud", label: null });
    expect(executorOfLog([a, b])).toEqual({ kind: "desktop", label: "MacBook" });
  });
});

describe("lastUnanswered", () => {
  it("最后一条人话之后没有 turn_ended = 没答；aborted 算答过；interrupted 算没答；后台回注不算人话", () => {
    reset();
    const created = ev({ type: "session_created", workspace: "/w" });
    const u1 = ev({ type: "user_message", content: "a" });
    expect(lastUnanswered([created, u1])).toMatchObject({ seq: 1 });
    const done = ev({ type: "turn_ended", outcome: "completed" });
    expect(lastUnanswered([created, u1, done])).toBeNull();
    const u2 = ev({ type: "user_message", content: "b" });
    const aborted = ev({ type: "turn_ended", outcome: "aborted" });
    expect(lastUnanswered([created, u1, done, u2, aborted])).toBeNull();
    const u3 = ev({ type: "user_message", content: "c" });
    const interrupted = ev({ type: "turn_ended", outcome: "interrupted" });
    expect(lastUnanswered([created, u1, done, u2, aborted, u3, interrupted])).toMatchObject({ seq: u3.seq });
    const bg = ev({ type: "user_message", content: "[后台任务]", origin: "background" });
    expect(lastUnanswered([created, u1, done, bg])).toBeNull();
  });
});

describe("divergence", () => {
  it("重叠段逐条相等 = none；第一处不同的 seq + 本地那截有没有 executor 类事件", () => {
    reset();
    const a = ev({ type: "user_message", content: "x" });
    const b = ev({ type: "assistant_message", content: "y", model: "m" });
    expect(divergence([a, b], [a])).toEqual({ kind: "none" });
    expect(divergence([a], [a, b])).toEqual({ kind: "none" });
    // 同 seq 不同内容
    const b2 = { ...b, content: "z" } as SessionEvent;
    expect(divergence([a, b], [a, b2])).toEqual({ kind: "has_executor", at: 1 });
    const rename = { ...b, type: "session_renamed", title: "t" } as unknown as SessionEvent;
    expect(divergence([a, rename], [a, b2])).toEqual({ kind: "human_only", at: 1 });
  });
  it("键顺序不同的同一条事件算相等", () => {
    const x = { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "a" } as SessionEvent;
    const y = { type: "user_message", content: "a", ts: 1, sessionId: "s", seq: 0 } as SessionEvent;
    expect(sameEvent(x, y)).toBe(true);
  });
});

describe("sliceBatches / attachmentRefsOf / isTaskSessionCreated", () => {
  it("按字节切批，单条超限也自成一批而不是丢掉", () => {
    reset();
    const small = ev({ type: "user_message", content: "hi" });
    const big = ev({ type: "tool_result", toolCallId: "c", ok: true, output: "x".repeat(TASK_EVENT_MAX_BYTES) });
    const batches = sliceBatches([small, big, small], TASK_EVENT_MAX_BYTES);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(sliceBatches([small, small], TASK_EVENT_MAX_BYTES)).toHaveLength(1);
  });
  it("附件引用：user_message.attachments 与 tool_result.images 的 id", () => {
    reset();
    const ref = { id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 3 };
    expect(attachmentRefsOf(ev({ type: "user_message", content: "", attachments: [ref] }))).toEqual([ref.id]);
    expect(attachmentRefsOf(ev({ type: "tool_result", toolCallId: "c", ok: true, output: "", images: [ref] }))).toEqual([ref.id]);
    expect(attachmentRefsOf(ev({ type: "turn_ended", outcome: "completed" }))).toEqual([]);
  });
  it("任务会话 = workspaceKind default 且没有 spawnedBy", () => {
    reset();
    expect(isTaskSessionCreated(ev({ type: "session_created", workspaceKind: "default" }))).toBe(true);
    expect(isTaskSessionCreated(ev({ type: "session_created", workspaceKind: "default", spawnedBy: { sessionId: "p", toolCallId: "c", agent: "a" } }))).toBe(false);
    expect(isTaskSessionCreated(ev({ type: "session_created", workspace: "/repo" }))).toBe(false);
    expect(isTaskSessionCreated(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/shared/taskSync.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```ts
// src/shared/taskSyncState.ts
/** 任务会话云同步的状态（#1223），同 memorySyncState 的形状多一格 reason：
    off 有三种来路（未登录 / 云端还没建表 / 不是任务会话所以没开），设置页那行要分开说 */
export type TaskSyncState =
  | { kind: "off"; reason: string | null }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null };
```

```ts
// src/shared/taskSync.ts
// 任务会话云端日志（#1223，spec docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md §3.8）
// 三端共用的纯逻辑：桌面复制器、②runtime 兜底执行器、③手机客户端读同一份。同 wire.ts 的纪律：
// 这里的常量与判据改了，RPC（0036）与两端都要跟着改，tests/docs/taskSessionsMigration.test.ts 对表。
import type { ExecutorChangedEvent, SessionEvent, UserMessageEvent } from "../session/events.js";

export const PEN_TTL_S = 30;
export const PEN_RENEW_MS = 10_000;
export const PULL_PAGE = 500;
export const TASK_TEXT_MAX_BYTES = 64 * 1024;
export const TASK_EVENT_MAX_BYTES = 2 * 1024 * 1024;

/** 追加这类事件要不要握笔。`human` = 人的动作（改名 / 归档 / 换型号 / 人话…），任何设备随时可落；
    `executor` = 跑 turn 的一方留下的痕迹，必须握着笔。手机从不握笔，天然只发得出人话；
    桌面跑 turn 时握笔，什么都能落；runtime 同一条规矩。**穷举 Record**：新事件类型不表态 tsc 直接红 */
export type PenVerdict = "human" | "executor";
export const PEN_VERDICTS: Record<SessionEvent["type"], PenVerdict> = {
  // ── 人的动作 ──
  session_created: "human", // 仅 seq 0；RPC 建行时顺手把笔发给创建者
  user_message: "human",
  session_renamed: "human",
  session_archived: "human",
  session_unarchived: "human",
  session_topic_set: "human",
  model_changed: "human",
  image_model_changed: "human",
  memory_user_edit: "human",
  branch_checked_out: "human",
  session_shared: "human",
  share_grant_note: "human",
  // ── 跑 turn 的痕迹 ──
  assistant_message: "executor",
  approval_decision: "executor",
  approval_request: "executor",
  tool_result: "executor",
  tool_execution_started: "executor",
  tool_hook: "executor",
  turn_ended: "executor",
  route_changed: "executor",
  context_compacted: "executor",
  micro_compacted: "executor",
  skill_invoked: "executor",
  skill_released: "executor",
  image_described: "executor",
  section_classified: "executor",
  suggestions_generated: "executor",
  subagent_spawned: "executor",
  subagent_briefed: "executor",
  agent_briefed: "executor",
  agent_relay: "executor",
  voice_call_changed: "executor",
  memory_loaded: "executor",
  workspace_memory_loaded: "executor",
  workspace_wiki_loaded: "executor",
  memory_nudge: "executor",
  session_autotitled: "executor",
  session_topic_assigned: "executor",
  project_instructions: "executor",
  request_envelope: "executor",
  background_task_completed: "executor",
  background_task_started: "executor",
  residue_baseline: "executor",
  residue_detected: "executor",
  residue_cleaned: "executor",
  checkpoint_created: "executor",
  workspace_restored: "executor",
  chat_message: "executor",
  model_usage: "executor",
  executor_changed: "executor",
};
export const HUMAN_EVENT_TYPES: ReadonlySet<string> = new Set(
  (Object.keys(PEN_VERDICTS) as SessionEvent["type"][]).filter((t) => PEN_VERDICTS[t] === "human")
);

export type ExecutorKind = "desktop" | "cloud";
export type HolderKind = ExecutorKind | "phone";

/** 笔的持有人标识。云端没有 deviceId（只有一个 runtime），其余带设备 id */
export function holderId(kind: HolderKind, deviceId: string): string {
  return kind === "cloud" ? "cloud" : `${kind}:${deviceId}`;
}
export function holderKindOf(holder: string | null): HolderKind | null {
  if (holder === null) return null;
  if (holder === "cloud") return "cloud";
  if (holder.startsWith("desktop:")) return "desktop";
  if (holder.startsWith("phone:")) return "phone";
  return null;
}

/** 最后一条 executor_changed 说了算；一条都没有 = 桌面（存量日志全是桌面写的） */
export function currentExecutor(last: ExecutorChangedEvent | null): ExecutorKind {
  return last?.executor ?? "desktop";
}
export function executorOfLog(events: readonly SessionEvent[]): { kind: ExecutorKind; label: string | null } {
  let kind: ExecutorKind = "desktop";
  let label: string | null = null;
  for (const e of events) {
    if (e.type !== "executor_changed") continue;
    kind = e.executor;
    label = e.executor === "desktop" ? (e.label ?? null) : null;
  }
  return { kind, label };
}

/** 最后一条**人说的** user_message，其后没有 turn_ended、或有但 outcome 是 interrupted → 它就是没人答的那条。
    `aborted` 算答过（人按了停止），`interrupted` 算没答（睡眠 / 崩溃打断的，spec §3.3）。
    后台回注 / 护栏注入（origin 在场）不算人话——它们是 turn 内部的事 */
export function lastUnanswered(events: readonly SessionEvent[]): UserMessageEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "turn_ended") {
      if (e.outcome === "interrupted") continue;
      return null;
    }
    if (e.type === "user_message" && e.origin === undefined) return e;
  }
  return null;
}

/** 两份同一会话的事件按 seq 对齐比较（都从同一个 cursor 之后取）。
    none = 重叠段逐条相等（谁长谁短不算分歧，调用方按长短决定推还是拉）；
    否则给出第一处不同的 seq，以及本地从那儿起的尾巴里有没有 executor 类事件（决定重放还是分叉） */
export type Divergence = { kind: "none" } | { kind: "human_only" | "has_executor"; at: number };
export function divergence(local: readonly SessionEvent[], cloud: readonly SessionEvent[]): Divergence {
  const bySeq = new Map<number, SessionEvent>();
  for (const c of cloud) bySeq.set(c.seq, c);
  for (let i = 0; i < local.length; i++) {
    const l = local[i]!;
    const c = bySeq.get(l.seq);
    if (c === undefined) break;
    if (sameEvent(l, c)) continue;
    const tail = local.slice(i);
    const kind = tail.some((e) => PEN_VERDICTS[e.type] === "executor") ? "has_executor" : "human_only";
    return { kind, at: l.seq };
  }
  return { kind: "none" };
}

/** 键排序后的 JSON：sqlite 那份 payload 是 JSON.stringify(剩余字段) 拆列再拼回来的，
    键顺序与云端 jsonb（按键长/字典序重排）不同，逐字节比对会误报分歧 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
export function sameEvent(a: SessionEvent, b: SessionEvent): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** 按字节切批：一批不超过 maxBytes；单条就超限的自成一批（推上去让 RPC 用它自己的上限拒，
    不在这儿静默丢——丢了本地日志就不再是云端的前缀） */
export function sliceBatches(events: readonly SessionEvent[], maxBytes: number): SessionEvent[][] {
  const out: SessionEvent[][] = [];
  let cur: SessionEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const n = JSON.stringify(e).length;
    if (cur.length > 0 && bytes + n > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 这条事件引用了哪些附件（内容寻址 id）。推之前要先把字节传上去，拉下来要顺手取回 */
export function attachmentRefsOf(e: SessionEvent): string[] {
  if (e.type === "user_message") return (e.attachments ?? []).map((a) => a.id);
  if (e.type === "tool_result") return (e.images ?? []).map((a) => a.id);
  return [];
}

/** 上不上云的判据：日志第 0 条说它是内置 Default 的主会话（ADR-0206 的 workspaceKind），且不是派出去的子会话 */
export function isTaskSessionCreated(first: SessionEvent | undefined): boolean {
  return first?.type === "session_created" && first.workspaceKind === "default" && first.spawnedBy === undefined;
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/shared/taskSync.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/taskSyncState.ts src/shared/taskSync.ts tests/shared/taskSync.test.ts
git commit -m "feat(shared): taskSync 纯逻辑——PEN_VERDICTS / lastUnanswered / divergence 三端共用一份（#1223）

「谁能追加什么」由笔决定，判据是一张穷举 Record（新事件类型不表态 tsc 直接红）；
「最后一条人话答过没」把 interrupted 算没答、aborted 算答过；分歧判定按键排序后比对，
sqlite 与 jsonb 的键顺序不同，逐字节比会把同一条事件判成两条。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `deriveMessages` 的执行器尾块（模型可见面）

**Files:**
- Modify: `src/session/deriveMessages.ts`（尾块状态变量 `:517-532` 附近；`case "executor_changed"`；末尾拼接 `:973` 之后）
- Test: `tests/session/deriveMessages.executor.test.ts`

**Interfaces:**
- Produces: `renderExecutorPrompt(s: { kind: ExecutorKind; everCloud: boolean; changedMachine: boolean }): string`（导出，②runtime 与手机不用它，但测试要）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/session/deriveMessages.executor.test.ts
// 换执行器投影成 system 尾块（#1223，spec §3.5）：一条都没有 = 逐字节不变；cloud = 「碰不到电脑文件」；
// 回到电脑 = 「全部工具可用」；换了一台 Mac 多一句「文件不在这台机器上」。
import { describe, expect, it } from "vitest";
import { deriveMessages, renderExecutorPrompt } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const created: SessionEvent = { ...base(0), type: "session_created", workspace: "/Users/a/Documents/Mr Otto/Default/s-1", workspaceKind: "default" };
const user: SessionEvent = { ...base(9), type: "user_message", content: "开工" };
const ex = (seq: number, executor: "desktop" | "cloud", label?: string): SessionEvent => ({
  ...base(seq), type: "executor_changed", executor, ignorable: true, ...(label ? { label } : {}),
});
const systemOf = (events: SessionEvent[]): string => (deriveMessages(events)[0] as { content: string }).content;

describe("system 尾部的执行器块（#1223）", () => {
  it("没有 executor_changed：投影逐字节不变", () => {
    expect(systemOf([created, user])).toBe(systemOf([created, user]));
    expect(systemOf([created, user])).not.toContain("云端");
  });
  it("云端在跑：说清碰不到电脑文件、要记待办、回复像发消息", () => {
    const content = systemOf([created, ex(1, "cloud"), user]);
    expect(content).toContain("你现在在云端替用户接着这条会话");
    expect(content).toContain("todo_write");
    expect(content.endsWith("]")).toBe(true); // 追在最尾，prefix cache 只从这儿失效
  });
  it("回到电脑：全部工具可用；此前没上过云的桌面切换（同一台）一字不加", () => {
    expect(systemOf([created, ex(1, "cloud"), ex(2, "desktop", "A"), user])).toContain("你回到了电脑上，全部工具可用");
    expect(systemOf([created, ex(1, "desktop", "A"), user])).toBe(systemOf([created, user]));
  });
  it("换了一台电脑：多一句文件不在这台机器上（判据是 label 变了）", () => {
    const content = systemOf([created, ex(1, "desktop", "A"), ex(2, "cloud"), ex(3, "desktop", "B"), user]);
    expect(content).toContain("这是另一台电脑");
    const same = systemOf([created, ex(1, "desktop", "A"), ex(2, "cloud"), ex(3, "desktop", "A"), user]);
    expect(same).not.toContain("这是另一台电脑");
  });
  it("renderExecutorPrompt 单独可测", () => {
    expect(renderExecutorPrompt({ kind: "desktop", everCloud: false, changedMachine: false })).toBe("");
    expect(renderExecutorPrompt({ kind: "desktop", everCloud: false, changedMachine: true })).toContain("另一台电脑");
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/session/deriveMessages.executor.test.ts`
Expected: FAIL — `renderExecutorPrompt` 不是导出

- [ ] **Step 3: 写实现**

`src/session/deriveMessages.ts`，在 `renderVoiceCallPrompt`（`:274`）之后加：

```ts
/** 换执行器之后焊进 system 尾部的那一块（#1223，spec §3.5）。
    云端：模型对自己的处境一无所知——不说它会以为自己还在电脑上，去「读」一个碰不到的文件。
    回到电脑：云端那段记的待办现在能做了。换了一台 Mac：任务文件夹的文件不同步，得说。
    三种情形都空 = 返回空串，调用方一字不加（同一台电脑、从没上过云的日志逐字节不变） */
export function renderExecutorPrompt(s: { kind: ExecutorKind; everCloud: boolean; changedMachine: boolean }): string {
  if (s.kind === "cloud") {
    return (
      `\n[你现在在云端替用户接着这条会话（用户在手机上）。电脑不在线——你碰不到它的文件、终端和连接器，` +
      `能用的只有当前工具表里那几把。要动电脑的活，用 todo_write 记下来并明说「回到电脑再做」，不要假装做了。` +
      `回复像发消息：短、先说结论。]`
    );
  }
  const back = s.everCloud ? "你回到了电脑上，全部工具可用；云端那段记下的待办现在能做了。" : "";
  const moved = s.changedMachine ? "这是另一台电脑，任务文件夹里此前的文件不在这台机器上。" : "";
  if (back === "" && moved === "") return "";
  return `\n[${back}${moved}]`;
}
```

在文件顶部的 import 里加 `import type { ExecutorKind } from "../shared/taskSync.js";`。

状态变量：在 `let isCloud = false;`（`:528`）之后加：

```ts
  // 执行器（#1223）：最后一条 executor_changed 胜出，主循环结束后拼一次到 system 最尾。
  // everCloud / changedMachine 是折叠出来的两个事实：前者决定「回到电脑」那句要不要说，
  // 后者按桌面 label 变没变（desktop → cloud → 另一台 desktop 也算换机）
  let executor: { kind: ExecutorKind; everCloud: boolean; changedMachine: boolean; seen: boolean } =
    { kind: "desktop", everCloud: false, changedMachine: false, seen: false };
  let lastDesktopLabel: string | null = null;
```

主 switch 里、`case "voice_call_changed":` 那组（`:838-842`）之后加：

```ts
      case "executor_changed": {
        const changedMachine =
          event.executor === "desktop" &&
          event.label !== undefined &&
          lastDesktopLabel !== null &&
          event.label !== lastDesktopLabel;
        if (event.executor === "desktop" && event.label !== undefined) lastDesktopLabel = event.label;
        executor = {
          kind: event.executor,
          everCloud: executor.everCloud || event.executor === "cloud",
          changedMachine,
          seen: true,
        };
        break;
      }
```

末尾拼接：在 `:973`（通话块那一行）之后加：

```ts
  // 执行器块排在最后（#1223）：它比通话名单更少变，但换执行器那一刻整段上下文都要重读，
  // 放最尾让 prefix cache 只从这儿失效。seen 为 false（旧日志 / 一直在桌面）一字不加
  if (systemMessage && executor.seen) systemMessage.content += renderExecutorPrompt(executor);
```

- [ ] **Step 4: 跑测试 + 既有投影回归**

Run: `npx vitest run tests/session/ && npx tsc --noEmit`
Expected: 全 PASS（`deriveMessages` 既有测试里没有 `executor_changed`，逐字节不变）

- [ ] **Step 5: Commit**

```bash
git add src/session/deriveMessages.ts tests/session/deriveMessages.executor.test.ts
git commit -m "feat(session): executor_changed 投影成 system 尾块——云端碰不到电脑文件这件事必须从日志推导（#1223）

三种措辞：云端在跑 / 回到电脑 / 换了一台电脑（按桌面 label 变没变判）。一条 executor_changed
都没有的日志投影逐字节不变。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `EventStore` 的 `onAppend` 观察者 + `lastSeq`

**Files:**
- Modify: `src/session/store.ts`（构造函数 `:135`、`append()` `:164-182`、新方法）
- Test: `tests/session/store.onAppend.test.ts`

**Interfaces:**
- Produces: `new EventStore(path, { onAppend?: (e: SessionEvent) => void })`；`store.lastSeq(sessionId): number`（没有事件 = -1；fork 子会话只数自己的行——它的行从 `endSeq+1` 起，MAX 就是对的）。runtime 那条 `new EventStore(join(...))` 不传第二个参数，行为一字不变。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/session/store.onAppend.test.ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

describe("EventStore.onAppend 观察者 + lastSeq（#1223）", () => {
  it("每次 append 都在事务提交后收到完整事件（带 seq）；lastSeq 跟着走", () => {
    const seen: SessionEvent[] = [];
    const store = new EventStore(join(tempDir("mrotto-onappend-"), "s.db"), { onAppend: (e) => seen.push(e) });
    expect(store.lastSeq("s1")).toBe(-1);
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "hi" });
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    expect(seen[1]).toMatchObject({ type: "user_message", content: "hi", seq: 1 });
    expect(store.lastSeq("s1")).toBe(1);
    expect(store.lastSeq("nope")).toBe(-1);
  });
  it("观察者抛错不影响已经落盘的事件（append 照样返回、日志照样在）", () => {
    const store = new EventStore(join(tempDir("mrotto-onappend-"), "s.db"), { onAppend: () => { throw new Error("boom"); } });
    const e = store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(e.seq).toBe(0);
    expect(store.load("s1")).toHaveLength(1);
  });
  it("purge 不触发观察者；不传选项的构造照旧", () => {
    let n = 0;
    const store = new EventStore(":memory:", { onAppend: () => { n++; } });
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    store.purge("s1");
    expect(n).toBe(1);
    const plain = new EventStore(":memory:");
    plain.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(plain.lastSeq("s1")).toBe(0);
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/session/store.onAppend.test.ts`
Expected: FAIL — 构造函数不收第二个参数 / `lastSeq` 不存在

- [ ] **Step 3: 写实现**

`src/session/store.ts`：在 `export class EventStore` 之前加：

```ts
export interface EventStoreOptions {
  /** 每条事件落盘（事务提交）之后回调一次（#1223）：任务会话云同步的复制器挂在这里——
      engine 与 index.ts 直接 append 的都从 append() 一个门出，挂这一处就全覆盖。
      回调抛错只打日志不上抛：事件已经在盘上了，观察者的失败不该让写入方以为没写成 */
  onAppend?: (event: SessionEvent) => void;
}
```

构造函数改成：

```ts
  private readonly onAppend: ((event: SessionEvent) => void) | null;

  constructor(path: string, opts: EventStoreOptions = {}) {
    this.onAppend = opts.onAppend ?? null;
    this.db = new Database(path);
```

（其余构造体不动。）`append()` 末尾 `return insert(event);` 改成：

```ts
    const full = insert(event);
    if (this.onAppend) {
      try {
        this.onAppend(full);
      } catch (err) {
        console.error("EventStore.onAppend 观察者抛错（事件已落盘）", err);
      }
    }
    return full;
```

在 `lastSeqOf`（`:573`）旁边加：

```ts
  /** 这条会话本地末条 seq；没有事件 = -1。云同步用它比对云端 last_seq（#1223）。
      fork 子会话只数自己的行：它的行从 endSeq+1 起，MAX 就是正确答案 */
  lastSeq(sessionId: string): number {
    const row = this.prep("SELECT COALESCE(MAX(seq), -1) AS last FROM events WHERE session_id = ?").get(sessionId) as { last: number };
    return row.last;
  }
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/session/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/store.ts tests/session/store.onAppend.test.ts
git commit -m "feat(store): EventStore 加 onAppend 观察者与 lastSeq——云同步挂在唯一的写入口上（#1223）

engine 与 index.ts 直接 append 的都从 append() 出，挂这一处就全覆盖；观察者抛错不影响
已落盘的事件。runtime 那条构造不传选项，行为一字不变。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: engine：`abortTurn(reason)` 与 `logUserMessage`

**Files:**
- Modify: `src/loop/engine.ts`（`abortTurn` `:593`、`runTurn` `:656-676`、catch `:724-727`、finally `:737`）
- Test: `tests/loop/engineInterrupt.test.ts`

**Interfaces:**
- Produces: `engine.abortTurn(reason: "aborted" | "interrupted" = "aborted")`（`interrupted` 时 `turn_ended.outcome` 写 `interrupted`，返回值仍是 `"aborted"`）；`engine.logUserMessage(userInput, attachments?, textFiles?, background?): UserMessageEvent`（只落盘不起 turn；`runTurn` = 它 + `runFrom`，事件形状逐字节不变）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/loop/engineInterrupt.test.ts
import { describe, expect, it } from "vitest";
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
const newStore = () => new EventStore(join(tempDir("mrotto-engine-int-"), "s.db"));
const seed = (store: EventStore) => store.append({ sessionId: "s1", ts: 0, type: "session_created", workspace: "/w" });

describe("LoopEngine.abortTurn(reason) / logUserMessage（#1223）", () => {
  it("abortTurn(\"interrupted\")：turn_ended.outcome 写 interrupted，返回值仍是 aborted", async () => {
    const store = newStore();
    seed(store);
    let engine!: LoopEngine;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(_m, opts) {
        engine.abortTurn("interrupted");
        await new Promise((_r, rej) => opts?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        return { content: "" };
      },
    };
    engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const outcome = await engine.runTurn("hi");
    expect(outcome).toBe("aborted");
    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "interrupted" });
  });
  it("不带 reason 的 abortTurn 照旧写 aborted；上一 turn 的 interrupted 不会漏到下一 turn", async () => {
    const store = newStore();
    seed(store);
    let engine!: LoopEngine;
    let first = true;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(_m, opts) {
        if (first) { first = false; engine.abortTurn("interrupted"); }
        else engine.abortTurn();
        await new Promise((_r, rej) => opts?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        return { content: "" };
      },
    };
    engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("one");
    await engine.runTurn("two");
    const ends = store.load("s1").filter((e) => e.type === "turn_ended");
    expect(ends.map((e) => (e as { outcome: string }).outcome)).toEqual(["interrupted", "aborted"]);
  });
  it("logUserMessage 只落盘不起 turn，形状与 runTurn 落的那条逐字节一致", async () => {
    const store = newStore();
    seed(store);
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "ok" }; } };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const logged = engine.logUserMessage("hello");
    expect(store.load("s1").map((e) => e.type)).toEqual(["session_created", "user_message"]);
    expect(logged).toMatchObject({ type: "user_message", content: "hello", seq: 1 });
    expect("attachments" in logged).toBe(false);
    await engine.runLoggedTurn(logged);
    expect(store.load("s1").map((e) => e.type)).toEqual(["session_created", "user_message", "assistant_message", "turn_ended"]);
  });
});
```

先看一眼 `src/model/adapter.ts` 里 `ModelAdapter.chat` 的第二个参数是否叫 `opts` 且带 `signal`（`grep -n "signal" src/model/adapter.ts`）；如果 signal 不在第二个参数上，按 `tests/loop/engine.autoCompact.test.ts:130-160` 那条已有的中断用例改写 chat 的写法——那条用例就是「在 chat 里调 abortTurn 然后等 abort」的先例，照抄它的等待方式。

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/loop/engineInterrupt.test.ts`
Expected: FAIL — `abortTurn` 不收参数（tsc 层面）/ `logUserMessage` 不存在

- [ ] **Step 3: 写实现**

`src/loop/engine.ts`：字段区（`:135` `turnAbort` 旁）加：

```ts
  /** 这次中断以什么收口（#1223）：人按停止 = aborted；睡眠 / 笔丢了 = interrupted（系统打断，
      lastUnanswered 把它算「没答」，接手的一方会接着答）。每个 turn 起跑时复位 */
  private abortReason: "aborted" | "interrupted" = "aborted";
```

`abortTurn`（`:593-595`）改成：

```ts
  abortTurn(reason: "aborted" | "interrupted" = "aborted"): void {
    this.abortReason = reason;
    this.turnAbort?.abort();
  }
```

`runTurn`（`:656-676`）拆成两个方法：

```ts
  /** 只把这条人话落盘，不起 turn（#1223）：笔被别人握着时桌面照样先落人话，
      等笔空了再对它 runLoggedTurn。事件形状与 runTurn 落的那条逐字节一致 */
  logUserMessage(
    userInput: string,
    attachments?: UserAttachmentRef[],
    textFiles?: UserTextFile[],
    background?: { taskIds: string[] }
  ): UserMessageEvent {
    return this.append({
      ...this.envBase(),
      type: "user_message",
      content: userInput,
      // 空数组不落字段:无附件的事件形状与从前逐字节一致(投影回归测试的前提)
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(textFiles && textFiles.length > 0 ? { textFiles } : {}),
      ...(background ? { origin: "background" as const, backgroundTaskIds: background.taskIds } : {}),
    }) as UserMessageEvent;
  }

  async runTurn(
    userInput: string,
    attachments?: UserAttachmentRef[],
    textFiles?: UserTextFile[],
    background?: { taskIds: string[] }
  ): Promise<"completed" | "aborted"> {
    return this.runFrom(this.logUserMessage(userInput, attachments, textFiles, background));
  }
```

（把原 `runTurn` 上面那段 doc 注释留在 `runTurn` 上。）`runFrom` 里 `this.turnAbort = new AbortController();`（`:692`）之后加 `this.abortReason = "aborted";`；catch 里 `:725` 改成 `this.append({ ...endEnv(), type: "turn_ended", outcome: this.abortReason });`。

`UserMessageEvent` 若还没 import，在文件顶部 `import type { … } from "../session/events.js"` 里补上。

- [ ] **Step 4: 跑 engine 全部测试**

Run: `npx vitest run tests/loop/ && npx tsc --noEmit`
Expected: 全 PASS（既有 `engineLoggedTurn` / `engine.background` 等回归）

- [ ] **Step 5: Commit**

```bash
git add src/loop/engine.ts tests/loop/engineInterrupt.test.ts
git commit -m "feat(engine): abortTurn 可以说清是被打断的；logUserMessage 把「落人话」从「起 turn」里拆出来（#1223）

睡眠 / 笔丢了不是人按停止：outcome 写 interrupted，接手的一方按「没答」处理。笔被别人握着时
桌面只落人话不起 turn，等笔空了再 runLoggedTurn——两条路落的事件形状逐字节一致。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: migration `0036_task_sessions.sql` + 与 `PEN_VERDICTS` 对表

**Files:**
- Create: `supabase/migrations/0036_task_sessions.sql`
- Test: `tests/docs/taskSessionsMigration.test.ts`（既有 `tests/docs/migrationNumbers.test.ts` 保证不撞号；合并前 re-fetch 若 0036 被占就改号，SQL 本体不动）

**Interfaces:**
- Produces（客户端调用面，Task 8 依赖）：RPC `task_append(p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb) returns integer`、`task_pen_acquire(p_session_id text, p_holder text, p_ttl_s integer) returns table(ok boolean, holder text, until timestamptz)`、`task_pen_release(p_session_id text, p_holder text) returns boolean`；同名 `_as(p_uid uuid, …)` 只给 service_role。表 `task_sessions` / `task_session_events`（列见 spec §3.1），bucket `task-attachments`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/docs/taskSessionsMigration.test.ts
// RPC 里那份「免笔类型」白名单是从 PEN_VERDICTS 抄进 SQL 的（#1223）——两份名单对表，
// 同 tests/docs/migrationNumbers.test.ts 的路子：读文件、正则、比集合，不起 Postgres。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUMAN_EVENT_TYPES, PEN_TTL_S, TASK_EVENT_MAX_BYTES, TASK_TEXT_MAX_BYTES } from "../../src/shared/taskSync.js";

const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0036_task_sessions.sql"), "utf8");

describe("0036_task_sessions.sql 与 src/shared/taskSync.ts 对表", () => {
  it("免笔类型白名单逐字一致", () => {
    const m = /v_type not in \(([^)]*)\)/.exec(sql);
    expect(m, "SQL 里找不到 `v_type not in (...)`——白名单的写法变了，这条对表也得跟着改").not.toBeNull();
    const listed = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
    expect(listed).toEqual([...HUMAN_EVENT_TYPES].sort());
  });
  it("三个数字与常量一致：单条上限 / 人话上限 / 建行时发笔的 ttl", () => {
    expect(sql).toContain(`> ${TASK_EVENT_MAX_BYTES} then`);
    expect(sql).toContain(`> ${TASK_TEXT_MAX_BYTES} then`);
    expect(sql).toContain(`make_interval(secs => ${PEN_TTL_S})`);
  });
  it("客户端表上没有 insert/update 策略（写只走 RPC）；事件表连 delete 都没有", () => {
    expect(sql).not.toMatch(/create policy \w+ on public\.task_sessions for (insert|update)/);
    expect(sql).not.toMatch(/create policy \w+ on public\.task_session_events for (insert|update|delete)/);
  });
  it("内部实现函数对 authenticated 收回执行权，_as 只给 service_role", () => {
    expect(sql).toMatch(/revoke all on function public\._task_append\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.task_append_as\([^)]*\) to service_role/);
    expect(sql).not.toMatch(/grant execute on function public\.task_append_as\([^)]*\) to authenticated/);
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/docs/taskSessionsMigration.test.ts`
Expected: FAIL — 文件不存在

- [ ] **Step 3: 写 migration**

```sql
-- 0036_task_sessions.sql —— 任务会话的云端日志（#1223，spec docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md）。幂等，重跑不炸。
-- 与 0016 / 0021 / 0030 / 0035 同一约定：Supabase SQL editor / Management API 手动执行一次
-- （那个端点只回最后一条语句的结果，逐条发，整份贴进去看不出哪条炸了）。
--
-- 为什么是两张新表而不是复用 workspace_sessions：那张表的 workspace_id 是非空外键、RLS 按在籍判，
-- 而任务会话是**一个人**的东西，没有团队可言（spec §8）。
--
-- 写只走 RPC：客户端表上没有 insert/update 策略，事件表连 delete 都没有——append-only 在 DB 层成立
-- （同本机 sqlite 的 events_no_update/no_delete 触发器）。谁能追加什么由「笔」决定（spec §3.3）：
-- executor 类事件必须握着笔，人话免笔；手机从不握笔，天然只发得出人话；runtime 拿 service key
-- 走 _as 包装，同一条规矩不因为角色绕过（SQL 里不按角色分支放行，只按包装决定 uid 从哪来）。
--
-- 权限走仓库既有习惯（0002 的 ensure_wallet 那一族）：security definer + 内部实现函数对所有角色
-- revoke；authenticated 只拿到 uid 从 auth.uid() 读的包装；service_role 只拿到显式 p_uid 的 _as 包装。
-- 不用 auth.role()（仓库零先例）。
--
-- 错误码：P0010 seq_conflict / P0011 pen_required / P0012 forbidden 或形状非法 / P0013 no_session。
-- 客户端（src/main/supabaseTaskSessionsApi.ts）按 SQLSTATE 认，不按文案。

-- ── 表 ──────────────────────────────────────────────────────────────────────
create table if not exists public.task_sessions (
  id          text primary key,                                  -- s-<14 位>-<8 hex>，与桌面同形（src/shared/sessionId.ts）
  uid         uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  title_rank  smallint not null default 0,                       -- 3 renamed > 2 autotitled > 1 首行 > 0 无
  archived    boolean not null default false,
  last_seq    integer not null default -1,                       -- CAS 基准
  pen_holder  text,                                              -- desktop:<deviceId> / cloud / phone:<deviceId>
  pen_until   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists task_sessions_uid_updated_idx on public.task_sessions (uid, updated_at desc);

create table if not exists public.task_session_events (
  session_id  text not null references public.task_sessions(id) on delete cascade,
  seq         integer not null,
  uid         uuid not null,                                     -- 冗余一份，RLS select 不用 join
  ts          bigint not null,
  type        text not null,
  payload     jsonb not null,                                    -- 整条事件原样（含 seq/sessionId/ts/type）
  primary key (session_id, seq)
);

alter table public.task_sessions enable row level security;
alter table public.task_session_events enable row level security;

-- 只读自己的行；删自己的会话（级联抹事件）。**没有 insert/update 策略**：写只走 RPC
drop policy if exists task_sessions_select_own on public.task_sessions;
create policy task_sessions_select_own on public.task_sessions for select to authenticated using (uid = auth.uid());
drop policy if exists task_sessions_delete_own on public.task_sessions;
create policy task_sessions_delete_own on public.task_sessions for delete to authenticated using (uid = auth.uid());
drop policy if exists task_session_events_select_own on public.task_session_events;
create policy task_session_events_select_own on public.task_session_events for select to authenticated using (uid = auth.uid());

-- Realtime 只订 task_sessions 的小行（last_seq / pen 变了再去 select 尾巴，spec §3.1）。
-- UPDATE 事件带过滤要能读到整行：replica identity full
alter table public.task_sessions replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.task_sessions;
exception when duplicate_object then null;
end $$;

-- ── 追加 ────────────────────────────────────────────────────────────────────
create or replace function public._task_append(p_uid uuid, p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_row      public.task_sessions%rowtype;
  v_seq      integer;
  v_ev       jsonb;
  v_type     text;
  v_title    text;
  v_rank     smallint;
  v_archived boolean;
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  if p_holder is null or p_holder = '' then raise exception 'forbidden: holder required' using errcode = 'P0012'; end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'bad_request: p_events must be a non-empty array' using errcode = 'P0012';
  end if;

  select * into v_row from public.task_sessions where id = p_session_id for update;
  if not found then
    if p_expected_seq <> 0 then raise exception 'no_session' using errcode = 'P0013'; end if;
    if (p_events->0->>'type') is distinct from 'session_created' then
      raise exception 'bad_request: first event must be session_created' using errcode = 'P0012';
    end if;
    -- 建行时顺手把笔发给创建者：这一批里第二条起就是 executor 类（memory_loaded…），
    -- 没有这一手就是「要笔得先有行、有行得先追加」的死结
    insert into public.task_sessions (id, uid, pen_holder, pen_until)
      values (p_session_id, p_uid, p_holder, now() + make_interval(secs => 30))
      returning * into v_row;
  elsif v_row.uid <> p_uid then
    raise exception 'forbidden' using errcode = 'P0012';
  end if;

  if v_row.last_seq + 1 <> p_expected_seq then
    raise exception 'seq_conflict' using errcode = 'P0010';
  end if;

  v_seq := p_expected_seq;
  v_title := v_row.title;
  v_rank := v_row.title_rank;
  v_archived := v_row.archived;

  for v_ev in select value from jsonb_array_elements(p_events) loop
    v_type := v_ev->>'type';
    if v_type is null then raise exception 'bad_request: event without type' using errcode = 'P0012'; end if;
    if (v_ev->>'seq')::integer is distinct from v_seq then raise exception 'seq_conflict' using errcode = 'P0010'; end if;
    if v_type = 'session_created' and v_seq <> 0 then
      raise exception 'bad_request: session_created only at seq 0' using errcode = 'P0012';
    end if;
    if octet_length(v_ev::text) > 2097152 then raise exception 'bad_request: event too large' using errcode = 'P0012'; end if;
    if v_type = 'user_message' and octet_length(coalesce(v_ev->>'content', '')) > 65536 then
      raise exception 'bad_request: user_message too large' using errcode = 'P0012';
    end if;
    -- 免笔类型白名单：与 src/shared/taskSync.ts 的 PEN_VERDICTS（human）逐字一致，
    -- tests/docs/taskSessionsMigration.test.ts 对表
    if v_type not in ('session_created', 'user_message', 'session_renamed', 'session_archived', 'session_unarchived',
                      'session_topic_set', 'model_changed', 'image_model_changed', 'memory_user_edit',
                      'branch_checked_out', 'session_shared', 'share_grant_note') then
      if v_row.pen_holder is distinct from p_holder or v_row.pen_until is null or v_row.pen_until <= now() then
        raise exception 'pen_required' using errcode = 'P0011';
      end if;
    end if;

    insert into public.task_session_events (session_id, seq, uid, ts, type, payload)
      values (p_session_id, v_seq, p_uid, coalesce((v_ev->>'ts')::bigint, 0), v_type, v_ev);

    -- 标题投影：renamed(3) > autotitled(2) > 首行(1)，低档不盖高档（同桌面 store.sessions()）
    if v_type = 'session_renamed' then
      v_title := coalesce(v_ev->>'title', ''); v_rank := 3;
    elsif v_type = 'session_autotitled' and v_rank <= 2 then
      v_title := coalesce(v_ev->>'title', ''); v_rank := 2;
    elsif v_type = 'session_created' and v_rank = 0 and coalesce(v_ev->>'title', '') <> '' then
      v_title := v_ev->>'title'; v_rank := 1;
    elsif v_type = 'user_message' and v_rank = 0 and (v_ev->>'origin') is null then
      v_title := left(split_part(coalesce(v_ev->>'content', ''), E'\n', 1), 80); v_rank := 1;
    end if;
    if v_type = 'session_archived' then v_archived := true;
    elsif v_type = 'session_unarchived' then v_archived := false;
    end if;
    v_seq := v_seq + 1;
  end loop;

  update public.task_sessions
     set last_seq = v_seq - 1, title = v_title, title_rank = v_rank, archived = v_archived, updated_at = now()
   where id = p_session_id;
  return v_seq - 1;
end $$;

create or replace function public.task_append(p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language sql security definer set search_path = public as
$$ select public._task_append(auth.uid(), p_session_id, p_expected_seq, p_holder, p_events) $$;

create or replace function public.task_append_as(p_uid uuid, p_session_id text, p_expected_seq integer, p_holder text, p_events jsonb)
returns integer language sql security definer set search_path = public as
$$ select public._task_append(p_uid, p_session_id, p_expected_seq, p_holder, p_events) $$;

-- ── 笔 ──────────────────────────────────────────────────────────────────────
create or replace function public._task_pen_acquire(p_uid uuid, p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language plpgsql security definer set search_path = public as $$
declare
  v_row public.task_sessions%rowtype;
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  select * into v_row from public.task_sessions where id = p_session_id for update;
  if not found then raise exception 'no_session' using errcode = 'P0013'; end if;
  if v_row.uid <> p_uid then raise exception 'forbidden' using errcode = 'P0012'; end if;
  -- 空 / 过期 / 同 holder（= 续期）才拿到
  if v_row.pen_holder is null or v_row.pen_until is null or v_row.pen_until <= now() or v_row.pen_holder = p_holder then
    update public.task_sessions
       set pen_holder = p_holder, pen_until = now() + make_interval(secs => greatest(1, least(p_ttl_s, 300))), updated_at = now()
     where id = p_session_id
     returning pen_holder, pen_until into holder, until;
    ok := true;
    return next;
    return;
  end if;
  ok := false; holder := v_row.pen_holder; until := v_row.pen_until;
  return next;
end $$;

create or replace function public._task_pen_release(p_uid uuid, p_session_id text, p_holder text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_uid is null then raise exception 'forbidden: no uid' using errcode = 'P0012'; end if;
  update public.task_sessions
     set pen_holder = null, pen_until = null, updated_at = now()
   where id = p_session_id and uid = p_uid and pen_holder = p_holder;
  return found;
end $$;

create or replace function public.task_pen_acquire(p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language sql security definer set search_path = public as
$$ select * from public._task_pen_acquire(auth.uid(), p_session_id, p_holder, p_ttl_s) $$;
create or replace function public.task_pen_acquire_as(p_uid uuid, p_session_id text, p_holder text, p_ttl_s integer)
returns table (ok boolean, holder text, until timestamptz) language sql security definer set search_path = public as
$$ select * from public._task_pen_acquire(p_uid, p_session_id, p_holder, p_ttl_s) $$;
create or replace function public.task_pen_release(p_session_id text, p_holder text)
returns boolean language sql security definer set search_path = public as
$$ select public._task_pen_release(auth.uid(), p_session_id, p_holder) $$;
create or replace function public.task_pen_release_as(p_uid uuid, p_session_id text, p_holder text)
returns boolean language sql security definer set search_path = public as
$$ select public._task_pen_release(p_uid, p_session_id, p_holder) $$;

-- ── 权限（同 0002 的写法）────────────────────────────────────────────────
revoke all on function public._task_append(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public._task_pen_acquire(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public._task_pen_release(uuid, text, text) from public, anon, authenticated;
revoke all on function public.task_append_as(uuid, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.task_pen_acquire_as(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.task_pen_release_as(uuid, text, text) from public, anon, authenticated;
grant execute on function public.task_append_as(uuid, text, integer, text, jsonb) to service_role;
grant execute on function public.task_pen_acquire_as(uuid, text, text, integer) to service_role;
grant execute on function public.task_pen_release_as(uuid, text, text) to service_role;
revoke all on function public.task_append(text, integer, text, jsonb) from public, anon;
revoke all on function public.task_pen_acquire(text, text, integer) from public, anon;
revoke all on function public.task_pen_release(text, text) from public, anon;
grant execute on function public.task_append(text, integer, text, jsonb) to authenticated;
grant execute on function public.task_pen_acquire(text, text, integer) to authenticated;
grant execute on function public.task_pen_release(text, text) to authenticated;

-- ── 附件：Storage bucket，own-folder 四条（照抄 0014，去掉好友可读那条）──
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "task_attachments_insert_own" on storage.objects;
create policy "task_attachments_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_update_own" on storage.objects;
create policy "task_attachments_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_select_own" on storage.objects;
create policy "task_attachments_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "task_attachments_delete_own" on storage.objects;
create policy "task_attachments_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
```

- [ ] **Step 4: 跑对表测试 + 编号门禁**

Run: `npx vitest run tests/docs/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0036_task_sessions.sql tests/docs/taskSessionsMigration.test.ts
git commit -m "feat(db): 0036 任务会话云端日志——两张表 + seq CAS + 笔 + 附件桶（#1223）

写只走 security definer RPC：executor 类事件必须握笔、人话免笔，白名单从 PEN_VERDICTS 抄进
SQL 并有断言对表；建行时顺手把笔发给创建者（否则要笔得先有行、有行得先追加）。权限走
0002 那一族的 grant/revoke 习惯，不引入 auth.role()。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `TaskSessionsApi` 接口 + supabase 实现

**Files:**
- Create: `src/main/taskSessionsApi.ts`、`src/main/supabaseTaskSessionsApi.ts`
- Test: `tests/main/supabaseTaskSessionsApi.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TaskSessionRow { id: string; title: string; archived: boolean; last_seq: number; pen_holder: string | null; pen_until: string | null; updated_at: string }
export type TaskSyncErrorCode = "seq_conflict" | "pen_required" | "no_session" | "forbidden" | "missing_schema" | "network" | "other";
export class TaskSyncError extends Error { readonly code: TaskSyncErrorCode }
export interface TaskSessionsApi {
  listChanged(uid: string, sinceIso: string | null): Promise<TaskSessionRow[]>;
  getSession(uid: string, sessionId: string): Promise<TaskSessionRow | null>;
  pullEvents(uid: string, sessionId: string, afterSeq: number, limit: number): Promise<SessionEvent[]>;
  append(sessionId: string, expectedSeq: number, holder: string, events: readonly SessionEvent[]): Promise<number>;
  acquirePen(sessionId: string, holder: string, ttlS: number): Promise<{ ok: boolean; holder: string | null; until: number | null }>;
  releasePen(sessionId: string, holder: string): Promise<void>;
  deleteSession(uid: string, sessionId: string): Promise<void>;
  uploadAttachment(uid: string, hex: string, bytes: Uint8Array): Promise<void>;
  downloadAttachment(uid: string, hex: string): Promise<Uint8Array | null>;
  subscribe(uid: string, onRow: (row: TaskSessionRow) => void): () => void;
}
export function createSupabaseTaskSessionsApi(client: SupabaseClient): TaskSessionsApi
```

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/supabaseTaskSessionsApi.test.ts
// 薄层只测两件会写错的事：请求形状（rpc 参数名 / 查询链 / 对象名）与错误码映射（SQLSTATE → TaskSyncErrorCode）。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseTaskSessionsApi } from "../../src/main/supabaseTaskSessionsApi.js";
import { TaskSyncError } from "../../src/main/taskSessionsApi.js";
import type { SessionEvent } from "../../src/session/events.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(rpcCanned: Record<string, Canned>, selectCanned: Canned = { data: [] }) {
  const calls: { op: string; args: unknown }[] = [];
  const builder = (canned: Canned) => {
    const b: Record<string, unknown> = {
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
        Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
    };
    for (const m of ["eq", "gt", "order", "limit", "maybeSingle", "select", "delete"]) {
      b[m] = (...args: unknown[]) => { calls.push({ op: m, args }); return b; };
    }
    return b;
  };
  const client = {
    rpc: (fn: string, args: unknown) => { calls.push({ op: `rpc:${fn}`, args }); return Promise.resolve({ data: rpcCanned[fn]?.data ?? null, error: rpcCanned[fn]?.error ?? null }); },
    from: (table: string) => { calls.push({ op: `from:${table}`, args: [] }); return builder(selectCanned); },
    storage: { from: (bucket: string) => ({
      upload: async (path: string, body: unknown, opts: unknown) => { calls.push({ op: `upload:${bucket}`, args: [path, body, opts] }); return { data: {}, error: null }; },
      download: async (path: string) => { calls.push({ op: `download:${bucket}`, args: [path] }); return { data: new Blob([new Uint8Array([1, 2])]), error: null }; },
    }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {},
  } as unknown as SupabaseClient;
  return { client, calls };
}

const ev: SessionEvent = { seq: 3, sessionId: "s", ts: 1, type: "user_message", content: "hi" };

describe("supabaseTaskSessionsApi（#1223）", () => {
  it("append：rpc 名与参数名与 0036 一致，回 last seq", async () => {
    const { client, calls } = fakeClient({ task_append: { data: 3 } });
    const api = createSupabaseTaskSessionsApi(client);
    await expect(api.append("s", 3, "desktop:d", [ev])).resolves.toBe(3);
    expect(calls[0]).toEqual({ op: "rpc:task_append", args: { p_session_id: "s", p_expected_seq: 3, p_holder: "desktop:d", p_events: [ev] } });
  });
  it("错误码映射：P0010 seq_conflict / P0011 pen_required / P0013 no_session / P0012 与 42501 forbidden / PGRST202 与 42P01 missing_schema", async () => {
    for (const [code, expected] of [["P0010", "seq_conflict"], ["P0011", "pen_required"], ["P0013", "no_session"], ["P0012", "forbidden"], ["42501", "forbidden"], ["PGRST202", "missing_schema"], ["42P01", "missing_schema"], ["XX000", "other"]] as const) {
      const { client } = fakeClient({ task_append: { error: { message: "x", code } } });
      const api = createSupabaseTaskSessionsApi(client);
      const err = await api.append("s", 0, "h", [ev]).catch((e) => e);
      expect(err).toBeInstanceOf(TaskSyncError);
      expect((err as TaskSyncError).code, code).toBe(expected);
    }
  });
  it("fetch 挂了 = network", async () => {
    const client = { rpc: () => Promise.reject(new TypeError("fetch failed")) } as unknown as SupabaseClient;
    const err = await createSupabaseTaskSessionsApi(client).append("s", 0, "h", [ev]).catch((e) => e);
    expect((err as TaskSyncError).code).toBe("network");
  });
  it("pullEvents：查事件表、按 seq 升序、回 payload；acquirePen 解 table 返回的那一行", async () => {
    const { client, calls } = fakeClient({ task_pen_acquire: { data: [{ ok: false, holder: "cloud", until: "2026-09-10T00:00:00Z" }] } }, { data: [{ payload: ev }] });
    const api = createSupabaseTaskSessionsApi(client);
    await expect(api.pullEvents("u", "s", 2, 500)).resolves.toEqual([ev]);
    expect(calls.map((c) => c.op)).toEqual(expect.arrayContaining(["from:task_session_events", "select", "eq", "gt", "order", "limit"]));
    await expect(api.acquirePen("s", "desktop:d", 30)).resolves.toEqual({ ok: false, holder: "cloud", until: Date.parse("2026-09-10T00:00:00Z") });
  });
  it("附件：对象名 <uid>/<hex>，upsert；下载回字节", async () => {
    const { client, calls } = fakeClient({});
    const api = createSupabaseTaskSessionsApi(client);
    await api.uploadAttachment("u1", "ab".repeat(32), new Uint8Array([9]));
    expect(calls.at(-1)).toMatchObject({ op: "upload:task-attachments", args: [`u1/${"ab".repeat(32)}`, expect.anything(), { upsert: true, contentType: "application/octet-stream" }] });
    await expect(api.downloadAttachment("u1", "ab".repeat(32))).resolves.toEqual(new Uint8Array([1, 2]));
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/main/supabaseTaskSessionsApi.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```ts
// src/main/taskSessionsApi.ts
/** 任务会话云端日志的 API 口（#1223）。taskSessionSync 与测试通过它调 Supabase；真实现在
    supabaseTaskSessionsApi.ts。错误统一成 TaskSyncError：调用方按 code 分支（seq_conflict 进冲突流程、
    pen_required 重拿笔、no_session 标 detached、network/missing_schema 当离线），不按文案 */
import type { SessionEvent } from "../session/events.js";

export interface TaskSessionRow {
  id: string;
  title: string;
  archived: boolean;
  last_seq: number;
  pen_holder: string | null;
  pen_until: string | null;
  updated_at: string;
}

export type TaskSyncErrorCode =
  | "seq_conflict" // P0010：expected_seq 不等于 last_seq+1
  | "pen_required" // P0011：executor 类事件而笔不在我手上
  | "no_session" // P0013：expected_seq > 0 但行不存在（别的设备删了）
  | "forbidden" // P0012 / 42501：不是我的会话、形状非法
  | "missing_schema" // PGRST202 / 42883 / 42P01 / PGRST205：0036 还没在真库跑
  | "network" // fetch 失败
  | "other";

export class TaskSyncError extends Error {
  constructor(public readonly code: TaskSyncErrorCode, message: string) {
    super(message);
    this.name = "TaskSyncError";
  }
}

export interface TaskSessionsApi {
  listChanged(uid: string, sinceIso: string | null): Promise<TaskSessionRow[]>;
  getSession(uid: string, sessionId: string): Promise<TaskSessionRow | null>;
  pullEvents(uid: string, sessionId: string, afterSeq: number, limit: number): Promise<SessionEvent[]>;
  append(sessionId: string, expectedSeq: number, holder: string, events: readonly SessionEvent[]): Promise<number>;
  acquirePen(sessionId: string, holder: string, ttlS: number): Promise<{ ok: boolean; holder: string | null; until: number | null }>;
  releasePen(sessionId: string, holder: string): Promise<void>;
  deleteSession(uid: string, sessionId: string): Promise<void>;
  uploadAttachment(uid: string, hex: string, bytes: Uint8Array): Promise<void>;
  downloadAttachment(uid: string, hex: string): Promise<Uint8Array | null>;
  /** realtime：task_sessions 上属于我的 INSERT/UPDATE 行原样回调；返回退订函数 */
  subscribe(uid: string, onRow: (row: TaskSessionRow) => void): () => void;
}
```

```ts
// src/main/supabaseTaskSessionsApi.ts
/** TaskSessionsApi 的真 supabase 实现（#1223）。薄到只有请求形状与错误码映射；同 supabaseMemoryDocsApi 的纪律。 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionEvent } from "../session/events.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi, type TaskSyncErrorCode } from "./taskSessionsApi.js";

const BUCKET = "task-attachments";
const ROW_COLUMNS = "id,title,archived,last_seq,pen_holder,pen_until,updated_at";

function codeOf(err: { code?: string; message: string }): TaskSyncErrorCode {
  switch (err.code) {
    case "P0010": return "seq_conflict";
    case "P0011": return "pen_required";
    case "P0013": return "no_session";
    case "P0012":
    case "42501": return "forbidden";
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01": return "missing_schema";
    default:
      return /fetch failed|network|ECONN|ENOTFOUND|Failed to fetch/i.test(err.message) ? "network" : "other";
  }
}

function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new TaskSyncError(codeOf(res.error), res.error.message);
  return res.data;
}

/** supabase-js 在 fetch 层挂掉时是 reject 不是 {error}：统一包成 network */
async function guarded<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (err) {
    if (err instanceof TaskSyncError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new TaskSyncError(err instanceof TypeError || /fetch failed|network/i.test(msg) ? "network" : "other", msg);
  }
}

export function createSupabaseTaskSessionsApi(client: SupabaseClient): TaskSessionsApi {
  return {
    listChanged: (uid, sinceIso) =>
      guarded(async () => {
        let q = client.from("task_sessions").select(ROW_COLUMNS).eq("uid", uid);
        if (sinceIso !== null) q = q.gt("updated_at", sinceIso);
        return (unwrap(await q.order("updated_at", { ascending: true })) ?? []) as TaskSessionRow[];
      }),
    getSession: (uid, sessionId) =>
      guarded(async () => {
        const rows = (unwrap(await client.from("task_sessions").select(ROW_COLUMNS).eq("uid", uid).eq("id", sessionId)) ?? []) as TaskSessionRow[];
        return rows[0] ?? null;
      }),
    pullEvents: (uid, sessionId, afterSeq, limit) =>
      guarded(async () => {
        const rows = (unwrap(
          await client.from("task_session_events").select("payload").eq("uid", uid).eq("session_id", sessionId).gt("seq", afterSeq).order("seq", { ascending: true }).limit(limit)
        ) ?? []) as { payload: SessionEvent }[];
        return rows.map((r) => r.payload);
      }),
    append: (sessionId, expectedSeq, holder, events) =>
      guarded(async () =>
        unwrap(await client.rpc("task_append", { p_session_id: sessionId, p_expected_seq: expectedSeq, p_holder: holder, p_events: events })) as number
      ),
    acquirePen: (sessionId, holder, ttlS) =>
      guarded(async () => {
        const rows = unwrap(await client.rpc("task_pen_acquire", { p_session_id: sessionId, p_holder: holder, p_ttl_s: ttlS })) as { ok: boolean; holder: string | null; until: string | null }[] | null;
        const r = rows?.[0];
        if (!r) throw new TaskSyncError("other", "task_pen_acquire 没有返回行");
        return { ok: r.ok, holder: r.holder, until: r.until ? Date.parse(r.until) : null };
      }),
    releasePen: (sessionId, holder) =>
      guarded(async () => {
        unwrap(await client.rpc("task_pen_release", { p_session_id: sessionId, p_holder: holder }));
      }),
    deleteSession: (uid, sessionId) =>
      guarded(async () => {
        unwrap(await client.from("task_sessions").delete().eq("uid", uid).eq("id", sessionId));
      }),
    uploadAttachment: (uid, hex, bytes) =>
      guarded(async () => {
        unwrap(await client.storage.from(BUCKET).upload(`${uid}/${hex}`, bytes, { upsert: true, contentType: "application/octet-stream" }));
      }),
    downloadAttachment: (uid, hex) =>
      guarded(async () => {
        const res = await client.storage.from(BUCKET).download(`${uid}/${hex}`);
        if (res.error) {
          if (/not found|404/i.test(res.error.message)) return null;
          throw new TaskSyncError(codeOf(res.error), res.error.message);
        }
        return new Uint8Array(await res.data.arrayBuffer());
      }),
    subscribe(uid, onRow) {
      // 同 workspace-mentions 那条通道的纪律：状态不并进好友健康度；哑掉不无声——打一行 warn，
      // 60 s sweep 是兜底不是主路（spec §3.6）
      const channel = client
        .channel(`task-sessions-${uid}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_sessions", filter: `uid=eq.${uid}` }, (p) => onRow(p.new as TaskSessionRow))
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "task_sessions", filter: `uid=eq.${uid}` }, (p) => onRow(p.new as TaskSessionRow))
        .subscribe((st) => {
          if (st === "SUBSCRIBED" || st === "CLOSED") return;
          console.warn(`[otto] 任务会话 realtime 订阅状态：${st}（改靠 60s sweep）`);
        });
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/main/supabaseTaskSessionsApi.test.ts && npx tsc --noEmit`
Expected: PASS（supabase-js 类型对 `q = q.gt(...)` 的可赋值性若报错，把 `let q` 的写法改成两条链各自 `order` 后 unwrap 的 if/else——行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/main/taskSessionsApi.ts src/main/supabaseTaskSessionsApi.ts tests/main/supabaseTaskSessionsApi.test.ts
git commit -m "feat(main): 任务会话云端 API 薄层——请求形状 + SQLSTATE → TaskSyncError 映射（#1223）

调用方按 code 分支不按文案：seq_conflict 进冲突流程、pen_required 重拿笔、no_session 标 detached、
network / missing_schema 当离线（三态分开说，同 ADR-0248 的措辞纪律）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `task-sync.json` 游标文件

**Files:**
- Create: `src/main/taskSyncStore.ts`
- Test: `tests/main/taskSyncStore.test.ts`

**Interfaces:**
- Produces: `interface TaskSyncSessionState { pushedUpTo: number; detached?: true; offlineRun?: true }`、`interface TaskSyncFile { v: 1; sessions: Record<string, TaskSyncSessionState>; lastSweepIso: string | null }`、`normaliseTaskSyncFile(input: unknown): TaskSyncFile`、`loadTaskSyncFile(path): TaskSyncFile`、`saveTaskSyncFile(path, file): void`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/taskSyncStore.test.ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadTaskSyncFile, normaliseTaskSyncFile, saveTaskSyncFile } from "../../src/main/taskSyncStore.js";
import { tempDir } from "../helpers/tempDir.js";

describe("task-sync.json（#1223）", () => {
  it("没有文件 / 坏 JSON = 空表", () => {
    const dir = tempDir("mrotto-tasksync-");
    expect(loadTaskSyncFile(join(dir, "task-sync.json"))).toEqual({ v: 1, sessions: {}, lastSweepIso: null });
    writeFileSync(join(dir, "bad.json"), "{nope", "utf8");
    expect(loadTaskSyncFile(join(dir, "bad.json"))).toEqual({ v: 1, sessions: {}, lastSweepIso: null });
  });
  it("往返：游标 / detached / offlineRun 原样，非法条目丢掉", () => {
    const dir = tempDir("mrotto-tasksync-");
    const p = join(dir, "task-sync.json");
    saveTaskSyncFile(p, { v: 1, sessions: { a: { pushedUpTo: 4 }, b: { pushedUpTo: -1, detached: true, offlineRun: true } }, lastSweepIso: "2026-09-10T00:00:00.000Z" });
    expect(loadTaskSyncFile(p)).toEqual({ v: 1, sessions: { a: { pushedUpTo: 4 }, b: { pushedUpTo: -1, detached: true, offlineRun: true } }, lastSweepIso: "2026-09-10T00:00:00.000Z" });
    expect(normaliseTaskSyncFile({ v: 1, sessions: { a: { pushedUpTo: "x" }, c: null, d: { pushedUpTo: 2, detached: "yes" } }, lastSweepIso: 5 })).toEqual({ v: 1, sessions: { d: { pushedUpTo: 2 } }, lastSweepIso: null });
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/main/taskSyncStore.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```ts
// src/main/taskSyncStore.ts
// 任务会话云同步的持久化游标（#1223）：accountData/task-sync.json（同 island.json 的落法，按账号抽屉分）。
// 每条会话记 pushedUpTo（本地推到云端的末条 seq）；detached = 云端那行没了、停止同步但本地照读；
// offlineRun = 离线跑过 turn，回网后的冲突是预期内的（只给日志/诊断用，冲突流程不读它）。
// 现读现写：陈旧的游标只会导致一次「已经在了」的重推，CAS 会撞出来再对表——不会丢数据。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TaskSyncSessionState {
  pushedUpTo: number;
  detached?: true;
  offlineRun?: true;
}

export interface TaskSyncFile {
  v: 1;
  sessions: Record<string, TaskSyncSessionState>;
  lastSweepIso: string | null;
}

export function normaliseTaskSyncFile(input: unknown): TaskSyncFile {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sessions: Record<string, TaskSyncSessionState> = {};
  const raw = (obj["sessions"] && typeof obj["sessions"] === "object" ? obj["sessions"] : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    if (typeof s["pushedUpTo"] !== "number" || !Number.isInteger(s["pushedUpTo"])) continue;
    sessions[id] = {
      pushedUpTo: s["pushedUpTo"],
      ...(s["detached"] === true ? { detached: true as const } : {}),
      ...(s["offlineRun"] === true ? { offlineRun: true as const } : {}),
    };
  }
  return { v: 1, sessions, lastSweepIso: typeof obj["lastSweepIso"] === "string" ? obj["lastSweepIso"] : null };
}

export function loadTaskSyncFile(path: string): TaskSyncFile {
  try {
    return normaliseTaskSyncFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { v: 1, sessions: {}, lastSweepIso: null };
  }
}

export function saveTaskSyncFile(path: string, file: TaskSyncFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normaliseTaskSyncFile(file), null, 2), "utf8");
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/main/taskSyncStore.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/taskSyncStore.ts tests/main/taskSyncStore.test.ts
git commit -m "feat(main): task-sync.json——每条任务会话推到云端的游标（#1223）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 复制器 `taskSessionSync`（推 / 拉 / 笔 / sweep / 附件 / 状态）

**Files:**
- Create: `src/main/taskSessionSync.ts`
- Test: `tests/main/taskSessionSync.test.ts`（含一个「像 0036 那样行事」的内存版假 api，Task 11 复用）

**Interfaces:**
- Consumes: Task 3 的纯函数、Task 5 的 `store.lastSeq` / `onAppend`、Task 8 的 `TaskSessionsApi` / `TaskSyncError`、Task 9 的 `TaskSyncFile`。
- Produces:

```ts
export type PenOutcome =
  | { kind: "acquired" }
  | { kind: "held"; by: string; holderKind: HolderKind | null }
  | { kind: "offline" }   // 网络错 / 云端没建表：照跑，别拦人
  | { kind: "off" };      // 没登录 / 不是任务会话：与今天一字不差
export interface TaskSessionSyncDeps { … }   // 见实现
export interface TaskSessionSync {
  touched(event: SessionEvent): void;               // 挂在 EventStore.onAppend 上
  acquirePen(sessionId: string): Promise<PenOutcome>;
  releasePen(sessionId: string): Promise<void>;
  holdsPen(sessionId: string): boolean;
  pullNow(): Promise<void>;                         // sweep（登录 / 唤醒 / 聚焦 / 60 s）
  pullSession(sessionId: string, cloudLastSeq?: number): Promise<void>;
  flushNow(): Promise<void>;
  backfill(): void;                                 // 开机：把本地存量任务会话排进队
  deleted(sessionId: string): Promise<void>;        // 本地 purge 之后：删云端行、忘掉游标
  markOfflineRun(sessionId: string): void;
  state(): TaskSyncState;
  start(): void;                                    // 登录后：backfill + pullNow + realtime + sweep 定时器
  stop(): void;                                     // 登出：退订、停定时器、放掉握着的笔
  dispose(): void;
}
export function createTaskSessionSync(deps: TaskSessionSyncDeps): TaskSessionSync
```

- [ ] **Step 1: 写失败的测试（含假 api）**

```ts
// tests/main/taskSessionSync.test.ts
// 复制器的核心路径（#1223）：推、拉（muted）、笔、离线、detached、附件。假 api 在内存里照 0036 的规矩行事
// （seq CAS、executor 类事件要笔、建行发笔），所以这里测的是「复制器 + RPC 语义」合起来对不对。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import { createTaskSessionSync, type TaskSessionSync, type TaskSessionSyncDeps } from "../../src/main/taskSessionSync.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi } from "../../src/main/taskSessionsApi.js";
import type { TaskSyncFile } from "../../src/main/taskSyncStore.js";
import { HUMAN_EVENT_TYPES } from "../../src/shared/taskSync.js";
import { tempDir } from "../helpers/tempDir.js";

export interface FakeCloud {
  api: TaskSessionsApi;
  rows: Map<string, { row: TaskSessionRow; events: SessionEvent[] }>;
  calls: string[];
  blobs: Map<string, Uint8Array>;
  setOffline(v: boolean): void;
  emitRow(id: string): void; // 假装 realtime 推了这一行
  now: { t: number };
}

export function fakeCloud(uid = "u1"): FakeCloud {
  const rows = new Map<string, { row: TaskSessionRow; events: SessionEvent[] }>();
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const now = { t: 1_000_000 };
  let offline = false;
  let listener: ((row: TaskSessionRow) => void) | null = null;
  const net = () => { if (offline) throw new TaskSyncError("network", "fetch failed"); };
  const penLive = (r: TaskSessionRow, holder: string) => r.pen_holder === holder && r.pen_until !== null && Date.parse(r.pen_until) > now.t;
  const api: TaskSessionsApi = {
    async listChanged(_u, since) { net(); calls.push("list"); return [...rows.values()].map((x) => x.row).filter((r) => since === null || r.updated_at > since); },
    async getSession(_u, id) { net(); return rows.get(id)?.row ?? null; },
    async pullEvents(_u, id, after, limit) { net(); calls.push(`pull ${id} >${after}`); return (rows.get(id)?.events ?? []).filter((e) => e.seq > after).slice(0, limit); },
    async append(id, expected, holder, events) {
      net();
      calls.push(`append ${id} @${expected} x${events.length}`);
      let entry = rows.get(id);
      if (!entry) {
        if (expected !== 0) throw new TaskSyncError("no_session", "no_session");
        entry = { row: { id, title: "", archived: false, last_seq: -1, pen_holder: holder, pen_until: new Date(now.t + 30_000).toISOString(), updated_at: new Date(now.t).toISOString() }, events: [] };
        rows.set(id, entry);
      }
      if (entry.row.last_seq + 1 !== expected) throw new TaskSyncError("seq_conflict", "seq_conflict");
      let seq = expected;
      for (const e of events) {
        if (e.seq !== seq) throw new TaskSyncError("seq_conflict", "seq_conflict");
        if (!HUMAN_EVENT_TYPES.has(e.type) && !penLive(entry.row, holder)) throw new TaskSyncError("pen_required", "pen_required");
        entry.events.push(e);
        seq++;
      }
      entry.row.last_seq = seq - 1;
      entry.row.updated_at = new Date(++now.t).toISOString();
      return seq - 1;
    },
    async acquirePen(id, holder, ttl) {
      net();
      const entry = rows.get(id);
      if (!entry) throw new TaskSyncError("no_session", "no_session");
      const r = entry.row;
      if (r.pen_holder === null || r.pen_until === null || Date.parse(r.pen_until) <= now.t || r.pen_holder === holder) {
        r.pen_holder = holder; r.pen_until = new Date(now.t + ttl * 1000).toISOString(); r.updated_at = new Date(++now.t).toISOString();
        return { ok: true, holder, until: Date.parse(r.pen_until) };
      }
      return { ok: false, holder: r.pen_holder, until: Date.parse(r.pen_until) };
    },
    async releasePen(id, holder) { net(); const r = rows.get(id)?.row; if (r && r.pen_holder === holder) { r.pen_holder = null; r.pen_until = null; } },
    async deleteSession(_u, id) { net(); calls.push(`delete ${id}`); rows.delete(id); },
    async uploadAttachment(_u, hex, bytes) { net(); calls.push(`upload ${hex.slice(0, 6)}`); blobs.set(hex, bytes); },
    async downloadAttachment(_u, hex) { net(); return blobs.get(hex) ?? null; },
    subscribe(_u, onRow) { listener = onRow; return () => { listener = null; }; },
  };
  return { api, rows, calls, blobs, now, setOffline: (v) => { offline = v; }, emitRow: (id) => { const r = rows.get(id)?.row; if (r && listener) listener({ ...r }); } };
}

export function harness(opts: { cloud?: FakeCloud; holder?: string; running?: () => boolean } = {}) {
  const cloud = opts.cloud ?? fakeCloud();
  const dir = tempDir("mrotto-tasksync-");
  const pulled: { id: string; events: SessionEvent[] }[] = [];
  const replaced: string[] = [];
  const penLost: string[] = [];
  let file: TaskSyncFile = { v: 1, sessions: {}, lastSweepIso: null };
  const attachments = new Map<string, Uint8Array>();
  let sync!: TaskSessionSync;
  const store = new EventStore(join(dir, "s.db"), { onAppend: (e) => sync.touched(e) });
  const deps: TaskSessionSyncDeps = {
    store,
    api: cloud.api,
    uid: () => "u1",
    holder: opts.holder ?? "desktop:A",
    label: "A",
    file: { load: () => file, save: (f) => { file = f; } },
    attachments: {
      read: (id) => attachments.get(id) ?? null,
      save: (bytes) => { const id = `sha256:${"e".repeat(64)}`; attachments.set(id, bytes); return { id }; },
    },
    isRunning: opts.running ?? (() => false),
    onPulled: (id, events) => pulled.push({ id, events }),
    onReplaced: (id) => replaced.push(id),
    onPenLost: (id) => penLost.push(id),
    now: () => cloud.now.t,
    debounceMs: 1,
    retryMs: 1_000_000,
    sweepMs: 1_000_000,
  };
  sync = createTaskSessionSync(deps);
  return { sync, store, cloud, pulled, replaced, penLost, attachments, fileRef: () => file };
}

const created = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, ts: 1, type: "session_created", workspace: `/D/${sessionId}`, workspaceKind: "default", ...extra }) as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("taskSessionSync：推（#1223）", () => {
  it("任务会话的 append 按序推上云；建行那一批带 executor 类事件也过（RPC 发笔）；项目会话不推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "memory_loaded", memory: "m", user: "u" });
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "hi" });
    h.store.append({ sessionId: "p1", ts: 1, type: "session_created", workspace: "/repo" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.cloud.rows.has("p1")).toBe(false);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
    expect(h.sync.state().kind).toBe("idle");
  });
  it("后续 executor 类事件推之前先拿笔（建行时发的那支还在，同 holder 续期即可）", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    h.store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "a", model: "m" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
    expect(h.sync.holdsPen("s1")).toBe(true);
    await h.sync.releasePen("s1");
    expect(h.sync.holdsPen("s1")).toBe(false);
  });
  it("笔被别人握着：executor 类事件先不推、会话留在脏集合；笔空了（realtime 推行）再推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    // 另一台拿走笔
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    h.store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "a", model: "m" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
    await h.cloud.api.releasePen("s1", "cloud");
    h.cloud.emitRow("s1");
    await sleep(20);
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
  });
  it("人话免笔：别人握着笔也照推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "还在吗" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
  });
  it("离线：状态 error、脏集合留着；回网 flushNow 推出去", async () => {
    const h = harness();
    h.cloud.setOffline(true);
    h.store.append(created("s1"));
    await h.sync.flushNow();
    expect(h.sync.state().kind).toBe("error");
    expect(h.cloud.rows.has("s1")).toBe(false);
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
    expect(h.sync.state().kind).toBe("idle");
  });
  it("云端行被别的设备删了：no_session → detached、本地不动；之后本地再有事件 → 从 seq 0 整份重推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    h.cloud.rows.delete("s1");
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "x" });
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ detached: true });
    expect(h.store.load("s1")).toHaveLength(2);
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "y" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
  });
  it("附件先传后推；本机没有那份字节时引用照推", async () => {
    const h = harness();
    const id = `sha256:${"a".repeat(64)}`;
    h.attachments.set(id, new Uint8Array([1, 2, 3]));
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "看图", attachments: [{ id, mediaType: "image/png", bytes: 3 }] });
    await h.sync.flushNow();
    const up = h.cloud.calls.findIndex((c) => c.startsWith("upload"));
    const ap = h.cloud.calls.findIndex((c) => c.startsWith("append s1 @0"));
    expect(up).toBeGreaterThanOrEqual(0);
    expect(up).toBeLessThan(ap);
    expect(h.cloud.blobs.get("a".repeat(64))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("taskSessionSync：拉", () => {
  it("云端多出来的尾巴 muted append 进本地、seq 一致、onPulled 收到、不回推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    // 另一台设备写了两条（人话 + 它握笔写的回复）
    await h.cloud.api.releasePen("s1", "desktop:A");
    await h.cloud.api.append("s1", 1, "desktop:B", [{ seq: 1, sessionId: "s1", ts: 5, type: "user_message", content: "from B" }]);
    await h.cloud.api.acquirePen("s1", "desktop:B", 30);
    await h.cloud.api.append("s1", 2, "desktop:B", [{ seq: 2, sessionId: "s1", ts: 6, type: "assistant_message", content: "B 答", model: "m" }]);
    const appendsBefore = h.cloud.calls.filter((c) => c.startsWith("append")).length;
    await h.sync.pullSession("s1", 2);
    expect(h.store.load("s1").map((e) => [e.seq, e.type])).toEqual([[0, "session_created"], [1, "user_message"], [2, "assistant_message"]]);
    expect(h.pulled).toEqual([{ id: "s1", events: expect.arrayContaining([expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })]) }]);
    await h.sync.flushNow();
    expect(h.cloud.calls.filter((c) => c.startsWith("append")).length).toBe(appendsBefore);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
  });
  it("sweep 领养本地没有的会话（手机 / 另一台电脑建的），从 seq 0 整份拉", async () => {
    const h = harness();
    await h.cloud.api.append("s9", 0, "desktop:B", [{ seq: 0, ...created("s9") } as SessionEvent, { seq: 1, sessionId: "s9", ts: 2, type: "user_message", content: "新" }]);
    await h.sync.pullNow();
    expect(h.store.has("s9")).toBe(true);
    expect(h.store.load("s9")).toHaveLength(2);
    expect(h.sync.state().kind).toBe("idle");
  });
  it("拉到带附件的事件：下载进本地库；下载不到留到下一次 sweep 再试", async () => {
    const h = harness();
    const hex = "b".repeat(64);
    await h.cloud.api.append("s9", 0, "desktop:B", [{ seq: 0, ...created("s9") } as SessionEvent, { seq: 1, sessionId: "s9", ts: 2, type: "user_message", content: "图", attachments: [{ id: `sha256:${hex}`, mediaType: "image/png", bytes: 2 }] }]);
    await h.sync.pullNow();
    expect(h.attachments.size).toBe(0);
    h.cloud.blobs.set(hex, new Uint8Array([7, 7]));
    await h.sync.pullNow();
    expect([...h.attachments.values()]).toEqual([new Uint8Array([7, 7])]);
  });
});

describe("taskSessionSync：笔", () => {
  it("acquirePen：拿到 / 被占 / 离线 / 不是任务会话", async () => {
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "p1", ts: 1, type: "session_created", workspace: "/repo" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "acquired" });
    expect(h.sync.holdsPen("s1")).toBe(true);
    await h.sync.releasePen("s1");
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "held", by: "cloud", holderKind: "cloud" });
    h.cloud.setOffline(true);
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "offline" });
    h.cloud.setOffline(false);
    expect(await h.sync.acquirePen("p1")).toEqual({ kind: "off" });
  });
  it("云端还没有这条会话（刚建、还没推）：acquirePen 当拿到——建行那一批会发笔", async () => {
    const h = harness();
    h.store.append(created("s1"));
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "acquired" });
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/main/taskSessionSync.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

```ts
// src/main/taskSessionSync.ts
// 任务会话云端日志的桌面复制器（#1223，spec §3.6）。同 memorySync 的形状：本地写完 → 推；
// realtime / 登录 / 唤醒 / 聚焦 / 60 s sweep → 拉。云端那份是事实，本机 sqlite 是它的前缀副本。
//
// 三条纪律：
//  1. 拉进来的事件 muted：观察者跳过它们，游标直接推到那个 seq——否则拉下来又推回去。
//  2. 推 executor 类事件之前先拿笔（同 holder 再调 = 续期，幂等）；笔被别人握着就留在脏集合等
//     realtime 推来「笔空了」。人话免笔，照推。
//  3. 本地永远不因为云端行消失而删数据：no_session → detached、停止同步、照样可读；之后本地再有
//     事件就从 seq 0 整份重推 = 重新建行。
// 冲突（seq_conflict）在 reconcile：重叠段逐条相等只是游标陈旧；真分歧按「云端赢、纯人为动作重放、
// 含 turn 痕迹分叉」处理（spec §3.6，tests/main/taskSessionSync.conflict.test.ts）。
import type { SessionEvent } from "../session/events.js";
import type { EventStore, NewSessionEvent } from "../session/store.js";
import { newSessionId } from "../shared/sessionId.js";
import { retargetForImport } from "../shared/sessionPackage.js";
import {
  attachmentRefsOf, divergence, holderKindOf, isTaskSessionCreated, PEN_RENEW_MS, PEN_TTL_S, PEN_VERDICTS, PULL_PAGE,
  sliceBatches, TASK_EVENT_MAX_BYTES, type ExecutorKind, type HolderKind,
} from "../shared/taskSync.js";
import type { TaskSyncState } from "../shared/taskSyncState.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi } from "./taskSessionsApi.js";
import type { TaskSyncFile } from "./taskSyncStore.js";

export type { TaskSyncState } from "../shared/taskSyncState.js";

export type PenOutcome =
  | { kind: "acquired" }
  | { kind: "held"; by: string; holderKind: HolderKind | null }
  | { kind: "offline" }
  | { kind: "off" };

export interface TaskSessionSyncDeps {
  store: Pick<EventStore, "load" | "append" | "lastSeq" | "has" | "sessions" | "purge">;
  api: TaskSessionsApi;
  uid: () => string | null;
  /** 笔的持有人标识：desktop:<deviceId> */
  holder: string;
  /** 这台设备的人话名，落进 executor_changed.label */
  label: string;
  file: { load(): TaskSyncFile; save(f: TaskSyncFile): void };
  /** 附件字节：read 未命中回 null（不抛）；save 内容寻址落盘 */
  attachments: { read(id: string): Uint8Array | null; save(bytes: Uint8Array): { id: string } };
  /** turn 在跑的会话不做 purge/重拉那种动本地日志的事，留到收口后 */
  isRunning: (sessionId: string) => boolean;
  /** 拉进来的事件（已带本地 seq）：主进程推给渲染层、刷 fleet、看要不要起 turn */
  onPulled: (sessionId: string, events: SessionEvent[]) => void;
  /** 本地日志被整份换成云端那份之后（冲突处理）：渲染层要重载 */
  onReplaced: (sessionId: string) => void;
  onPenChanged?: (sessionId: string, holder: string | null) => void;
  /** 续期失败 = 笔已在别人手上：主进程该把正在跑的 turn 以 interrupted 停掉 */
  onPenLost?: (sessionId: string) => void;
  onExecutorSwitch?: (sessionId: string, to: ExecutorKind) => void;
  onState?: (s: TaskSyncState) => void;
  now?: () => number;
  debounceMs?: number;
  retryMs?: number;
  sweepMs?: number;
}

export interface TaskSessionSync {
  touched(event: SessionEvent): void;
  acquirePen(sessionId: string): Promise<PenOutcome>;
  releasePen(sessionId: string): Promise<void>;
  holdsPen(sessionId: string): boolean;
  pullNow(): Promise<void>;
  pullSession(sessionId: string, cloudLastSeq?: number): Promise<void>;
  flushNow(): Promise<void>;
  backfill(): void;
  deleted(sessionId: string): Promise<void>;
  markOfflineRun(sessionId: string): void;
  state(): TaskSyncState;
  start(): void;
  stop(): void;
  dispose(): void;
}

const HEX_OF = (ref: string): string => ref.slice("sha256:".length);
const MAX_FLUSH_ROUNDS = 3;

export function createTaskSessionSync(deps: TaskSessionSyncDeps): TaskSessionSync {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? 200;
  const retryMs = deps.retryMs ?? 30_000;
  const sweepMs = deps.sweepMs ?? 60_000;

  const file = deps.file.load();
  const save = (): void => deps.file.save(file);
  const dirty = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  const taskCache = new Map<string, boolean>();
  const pens = new Map<string, ReturnType<typeof setInterval>>();
  /** 建行那一批 RPC 顺手发给我们的笔（还没起续期定时器）：holdsPen / releasePen 都要认它 */
  const granted = new Set<string>();
  const uploaded = new Set<string>();
  const missingAttachments = new Map<string, Set<string>>();
  let muted = false;
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let flushing: Promise<void> | null = null;
  let lastSyncedAt: number | null = null;
  let current: TaskSyncState = { kind: "off", reason: null };

  const setState = (s: TaskSyncState): void => {
    current = s;
    deps.onState?.(s);
  };
  const ensure = (id: string) => (file.sessions[id] ??= { pushedUpTo: -1 });
  const isTask = (id: string): boolean => {
    const cached = taskCache.get(id);
    if (cached !== undefined) return cached;
    const first = deps.store.load(id, { untilSeq: 0 })[0];
    const v = isTaskSessionCreated(first);
    if (first !== undefined) taskCache.set(id, v);
    return v;
  };
  /** 同一条会话的推 / 拉 / 对账串行（同 frameHandler 按 cid 串行的做法）：前一件抛了也接着跑下一件 */
  const serialize = (id: string, fn: () => Promise<void>): Promise<void> => {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    });
    chains.set(id, next);
    return next;
  };
  const scheduleRetry = (): void => {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, retryMs);
  };
  const fail = (err: unknown): void => {
    if (err instanceof TaskSyncError && err.code === "missing_schema") {
      setState({ kind: "off", reason: "云端还没有任务会话表（migration 0036 未执行）" });
      return;
    }
    setState({ kind: "error", message: err instanceof Error ? err.message : String(err), lastSyncedAt });
    scheduleRetry();
  };

  // ── 笔 ──
  const holdsPen = (id: string): boolean => pens.has(id) || granted.has(id);
  const stopRenew = (id: string): void => {
    const t = pens.get(id);
    if (t !== undefined) {
      clearInterval(t);
      pens.delete(id);
    }
  };
  const renew = async (id: string): Promise<void> => {
    try {
      const r = await deps.api.acquirePen(id, deps.holder, PEN_TTL_S);
      if (!r.ok) {
        stopRenew(id);
        deps.onPenLost?.(id);
      }
    } catch (err) {
      // 断网续不上不算丢：笔到期前回网就续上了；真过期了下一次推会撞 pen_required 再重拿
      if (err instanceof TaskSyncError && (err.code === "network" || err.code === "missing_schema")) return;
      stopRenew(id);
      deps.onPenLost?.(id);
    }
  };
  const startRenew = (id: string): void => {
    if (pens.has(id)) return;
    const t = setInterval(() => void renew(id), PEN_RENEW_MS);
    t.unref?.(); // 别让一支还握着的笔拖住进程退出（before-quit 会 stop()）
    pens.set(id, t);
  };
  async function acquirePen(id: string): Promise<PenOutcome> {
    if (disposed || !deps.uid() || !isTask(id)) return { kind: "off" };
    try {
      const r = await deps.api.acquirePen(id, deps.holder, PEN_TTL_S);
      if (r.ok) {
        startRenew(id);
        return { kind: "acquired" };
      }
      return { kind: "held", by: r.holder ?? "", holderKind: holderKindOf(r.holder) };
    } catch (err) {
      if (err instanceof TaskSyncError) {
        // 云端还没这条会话（刚建 / 离线建的）：建行那一批 RPC 会把笔发给创建者
        if (err.code === "no_session") return { kind: "acquired" };
        if (err.code === "network" || err.code === "missing_schema") return { kind: "offline" };
      }
      throw err;
    }
  }
  async function releasePen(id: string): Promise<void> {
    if (!pens.has(id) && !granted.has(id)) return;
    stopRenew(id);
    granted.delete(id);
    try {
      await deps.api.releasePen(id, deps.holder);
    } catch {
      // 放不掉就让它过期（30 s）：对面最多多等半分钟，不值得为此报错
    }
  }

  // ── 推 ──
  const scheduleFlush = (): void => {
    if (flushTimer !== null || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, debounceMs);
  };
  function touched(event: SessionEvent): void {
    if (disposed || muted) return;
    const id = event.sessionId;
    if (!isTask(id)) return;
    const st = ensure(id);
    if (st.detached) {
      // 云端行没了之后本地又续聊：从 seq 0 整份重推 = 重新建行
      delete st.detached;
      st.pushedUpTo = -1;
      save();
    }
    dirty.add(id);
    scheduleFlush();
  }
  async function uploadRef(uid: string, ref: string): Promise<void> {
    const hex = HEX_OF(ref);
    if (uploaded.has(hex)) return;
    const bytes = deps.attachments.read(ref);
    if (bytes === null) return; // 本机没有这份字节（旧库 / 另一台机器建的）：引用照推，拉的那头画占位
    await deps.api.uploadAttachment(uid, hex, bytes);
    uploaded.add(hex);
  }
  async function pushSession(uid: string, id: string): Promise<void> {
    const st = ensure(id);
    if (st.detached) return;
    const tail = deps.store.load(id, { afterSeq: st.pushedUpTo });
    if (tail.length === 0) return;
    for (const e of tail) for (const ref of attachmentRefsOf(e)) await uploadRef(uid, ref);
    // 建行那一批（pushedUpTo === -1）不用先拿笔：RPC 建行时把笔发给创建者
    const needsPen = st.pushedUpTo >= 0 && tail.some((e) => PEN_VERDICTS[e.type] === "executor");
    if (needsPen && !holdsPen(id)) {
      const pen = await acquirePen(id);
      if (pen.kind !== "acquired") {
        dirty.add(id); // 笔被占 / 离线：留着，realtime 推来笔空了或回网时再推
        return;
      }
    }
    for (const batch of sliceBatches(tail, TASK_EVENT_MAX_BYTES)) {
      const expected = batch[0]!.seq;
      const done = (last: number): void => {
        st.pushedUpTo = last;
        save();
        if (expected === 0) granted.add(id); // 建行那一批：RPC 把笔发给了我们（spec 实施偏差 3）
      };
      try {
        done(await deps.api.append(id, expected, deps.holder, batch));
      } catch (err) {
        if (!(err instanceof TaskSyncError)) throw err;
        if (err.code === "seq_conflict") {
          await reconcile(uid, id);
          return;
        }
        if (err.code === "pen_required") {
          const again = await acquirePen(id);
          if (again.kind !== "acquired") {
            deps.onPenLost?.(id);
            dirty.add(id);
            return;
          }
          done(await deps.api.append(id, expected, deps.holder, batch));
          continue;
        }
        if (err.code === "no_session") {
          st.detached = true;
          save();
          return;
        }
        throw err;
      }
    }
  }
  async function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      const uid = deps.uid();
      if (!uid) {
        setState({ kind: "off", reason: "未登录" });
        return;
      }
      if (dirty.size === 0) return;
      setState({ kind: "syncing" });
      try {
        // 按轮推：一轮拿一份快照，处理中被重新标脏的（对账后还有尾巴要推）留到下一轮。
        // 封顶三轮——turn 在跑 / 笔被占那种「每次都把自己标回脏」的会话不能把这个循环变成死循环，
        // 剩下的由 scheduleRetry / realtime 再来
        for (let round = 0; round < MAX_FLUSH_ROUNDS && dirty.size > 0; round++) {
          const batch = [...dirty];
          dirty.clear();
          for (const id of batch) {
            try {
              await serialize(id, () => pushSession(uid, id));
            } catch (err) {
              dirty.add(id);
              throw err;
            }
          }
        }
        lastSyncedAt = now();
        setState({ kind: "idle", lastSyncedAt });
      } catch (err) {
        fail(err);
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  // ── 拉 ──
  async function fetchAttachments(uid: string, id: string, events: readonly SessionEvent[]): Promise<void> {
    for (const e of events) {
      for (const ref of attachmentRefsOf(e)) {
        if (deps.attachments.read(ref) !== null) continue;
        try {
          const bytes = await deps.api.downloadAttachment(uid, HEX_OF(ref));
          if (bytes !== null) {
            deps.attachments.save(bytes);
            continue;
          }
        } catch {
          // 落到下面记 missing
        }
        (missingAttachments.get(id) ?? missingAttachments.set(id, new Set()).get(id)!).add(ref);
      }
    }
  }
  async function retryMissingAttachments(uid: string): Promise<void> {
    for (const [id, refs] of missingAttachments) {
      for (const ref of [...refs]) {
        if (deps.attachments.read(ref) !== null) {
          refs.delete(ref);
          continue;
        }
        try {
          const bytes = await deps.api.downloadAttachment(uid, HEX_OF(ref));
          if (bytes !== null) {
            deps.attachments.save(bytes);
            refs.delete(ref);
          }
        } catch {
          // 下次再试
        }
      }
      if (refs.size === 0) missingAttachments.delete(id);
    }
  }
  /** 把云端事件（带云端 seq）muted 追加进本地，断言本地分到同一个 seq */
  function appendPulled(id: string, events: readonly SessionEvent[]): SessionEvent[] {
    const appended: SessionEvent[] = [];
    muted = true;
    try {
      for (const e of events) {
        const { seq: _seq, ...rest } = e;
        const got = deps.store.append(rest as NewSessionEvent);
        if (got.seq !== e.seq) throw new TaskSyncError("other", `拉取时 seq 对不上：本地 ${got.seq} 云端 ${e.seq}`);
        appended.push(got);
      }
    } finally {
      muted = false;
    }
    return appended;
  }
  async function pullInner(uid: string, id: string, cloudLast?: number): Promise<void> {
    const st = ensure(id);
    if (st.detached) return;
    let local = deps.store.has(id) ? deps.store.lastSeq(id) : -1;
    if (cloudLast !== undefined && cloudLast <= local) {
      if (cloudLast < local) {
        dirty.add(id); // 本地领先：走推的路（撞 seq_conflict 就对账）
        scheduleFlush();
      }
      return;
    }
    for (;;) {
      const page = await deps.api.pullEvents(uid, id, local, PULL_PAGE);
      const fresh: SessionEvent[] = [];
      for (const e of page) {
        if (e.seq <= local) continue;
        if (e.seq !== local + 1) break; // 有洞：等下一次
        fresh.push(e);
        local = e.seq;
      }
      if (fresh.length === 0) break;
      const appended = appendPulled(id, fresh);
      st.pushedUpTo = Math.max(st.pushedUpTo, local);
      save();
      await fetchAttachments(uid, id, appended);
      for (const e of appended) if (e.type === "executor_changed") deps.onExecutorSwitch?.(id, e.executor);
      deps.onPulled(id, appended);
      if (page.length < PULL_PAGE) break;
    }
  }
  async function pullSession(id: string, cloudLast?: number): Promise<void> {
    const uid = deps.uid();
    if (!uid || disposed) return;
    await serialize(id, () => pullInner(uid, id, cloudLast));
  }
  async function handleRow(uid: string, row: TaskSessionRow): Promise<void> {
    deps.onPenChanged?.(row.id, row.pen_holder);
    const local = deps.store.has(row.id) ? deps.store.lastSeq(row.id) : -1;
    if (row.last_seq > local) await serialize(row.id, () => pullInner(uid, row.id, row.last_seq));
    else if (row.last_seq < local) {
      dirty.add(row.id);
      scheduleFlush();
    }
  }
  async function pullNow(): Promise<void> {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) {
      setState({ kind: "off", reason: "未登录" });
      return;
    }
    setState({ kind: "syncing" });
    try {
      const rows = await deps.api.listChanged(uid, file.lastSweepIso);
      let latest = file.lastSweepIso;
      for (const row of rows) {
        await handleRow(uid, row);
        if (latest === null || row.updated_at > latest) latest = row.updated_at;
      }
      file.lastSweepIso = latest;
      save();
      await retryMissingAttachments(uid);
      lastSyncedAt = now();
      setState({ kind: "idle", lastSyncedAt });
    } catch (err) {
      fail(err);
    }
  }

  // ── 冲突：云端赢，本机不丢（spec §3.6） ──
  async function pullAll(uid: string, id: string, afterSeq: number): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let after = afterSeq;
    for (;;) {
      const page = await deps.api.pullEvents(uid, id, after, PULL_PAGE);
      out.push(...page);
      if (page.length < PULL_PAGE) return out;
      after = page.at(-1)!.seq;
    }
  }
  function replaceWithCloud(id: string, cloudFull: readonly SessionEvent[]): void {
    muted = true;
    try {
      deps.store.purge(id);
      taskCache.delete(id);
      for (const e of cloudFull) {
        const { seq: _seq, ...rest } = e;
        deps.store.append(rest as NewSessionEvent);
      }
    } finally {
      muted = false;
    }
  }
  /** 本地那截含 turn 痕迹的分歧：整份复制成一条独立会话（不是 store.fork 的引用式——引用式会让
      接下来的 purge 被拒），标题带「（本机未同步的分支）」，让它自己作为新会话上云 */
  function forkCopy(localFull: readonly SessionEvent[], title: string | null): void {
    const forkId = newSessionId();
    muted = true;
    try {
      for (const e of retargetForImport(localFull, forkId)) deps.store.append(e as NewSessionEvent);
      deps.store.append({ sessionId: forkId, ts: now(), type: "session_renamed", title: `${title ?? "会话"}（本机未同步的分支）` });
    } finally {
      muted = false;
    }
    file.sessions[forkId] = { pushedUpTo: -1 };
    dirty.add(forkId);
    save();
  }
  async function reconcile(uid: string, id: string): Promise<void> {
    const st = ensure(id);
    if (deps.isRunning(id)) {
      dirty.add(id); // turn 在跑不动本地日志，收口后再对账
      scheduleRetry();
      return;
    }
    const row = await deps.api.getSession(uid, id);
    if (row === null) {
      st.detached = true;
      save();
      return;
    }
    const cloudTail = await pullAll(uid, id, st.pushedUpTo);
    const localTail = deps.store.load(id, { afterSeq: st.pushedUpTo });
    const d = divergence(localTail, cloudTail);
    if (d.kind === "none") {
      // 游标陈旧：重叠段已经在云端了。谁长谁短决定接下来推还是拉
      const overlap = Math.min(localTail.length, cloudTail.length);
      st.pushedUpTo += overlap;
      save();
      if (cloudTail.length > overlap) {
        const appended = appendPulled(id, cloudTail.slice(overlap));
        st.pushedUpTo = appended.at(-1)?.seq ?? st.pushedUpTo;
        save();
        await fetchAttachments(uid, id, appended);
        deps.onPulled(id, appended);
      } else if (localTail.length > overlap) {
        dirty.add(id);
        scheduleFlush();
      }
      return;
    }
    const localFull = deps.store.load(id);
    const title = deps.store.sessions().find((s) => s.sessionId === id)?.title ?? null;
    const cloudFull = await pullAll(uid, id, -1);
    try {
      if (d.kind === "has_executor") forkCopy(localFull, title);
      replaceWithCloud(id, cloudFull);
    } catch (err) {
      // purge 被拒（这条会话有真正的引用式分支）：停止同步、本地照读，不硬来
      st.detached = true;
      save();
      throw err;
    }
    st.pushedUpTo = cloudFull.at(-1)?.seq ?? -1;
    save();
    deps.onReplaced(id);
    if (d.kind === "human_only") {
      // 纯人为动作重放到云端日志之后：不 muted，走观察者 → 脏 → 正常推
      for (const e of localTail.filter((x) => x.seq >= d.at)) {
        const { seq: _seq, ...rest } = e;
        deps.store.append(rest as NewSessionEvent);
      }
    }
  }

  // ── 生命周期 ──
  function backfill(): void {
    // 未归档先推、归档的排后面（Set 按插入序），一条一条来
    const rows = [...deps.store.sessions()].sort((a, b) => Number(a.archived) - Number(b.archived));
    for (const s of rows) {
      if (s.spawnedFrom !== null || !isTask(s.sessionId)) continue;
      if (file.sessions[s.sessionId] === undefined) dirty.add(s.sessionId);
    }
    if (dirty.size > 0) scheduleFlush();
  }
  function start(): void {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) return;
    stop();
    backfill();
    void pullNow();
    unsub = deps.api.subscribe(uid, (row) => {
      void handleRow(uid, row).catch((err) => fail(err));
    });
    sweepTimer = setInterval(() => void pullNow(), sweepMs);
    sweepTimer.unref?.();
  }
  function stop(): void {
    unsub?.();
    unsub = null;
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const id of new Set([...pens.keys(), ...granted])) void releasePen(id);
  }

  return {
    touched,
    acquirePen,
    releasePen,
    holdsPen,
    pullNow,
    pullSession,
    flushNow: () => flush(),
    backfill,
    async deleted(id) {
      stopRenew(id);
      granted.delete(id);
      delete file.sessions[id];
      dirty.delete(id);
      taskCache.delete(id);
      save();
      const uid = deps.uid();
      if (!uid) return;
      try {
        await deps.api.deleteSession(uid, id);
      } catch (err) {
        fail(err);
      }
    },
    markOfflineRun(id) {
      ensure(id).offlineRun = true;
      save();
    },
    state: () => current,
    start,
    stop,
    dispose() {
      disposed = true;
      stop();
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    },
  };
}
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/main/taskSessionSync.test.ts && npx tsc --noEmit`
Expected: 全 PASS。`exactOptionalPropertyTypes` 下若 `{ detached: true as const }` 之类报错，按 `taskSyncStore.ts` 里同款的条件展开写法改。

- [ ] **Step 5: Commit**

```bash
git add src/main/taskSessionSync.ts tests/main/taskSessionSync.test.ts
git commit -m "feat(main): 任务会话复制器——本机 sqlite 是云端日志的前缀副本（#1223）

推：观察者标脏、按持久化游标按序推，executor 类事件先拿笔（建行那批由 RPC 发笔）；
拉：realtime / sweep 看到 last_seq 长了就 select 尾巴 muted 追加，断言 seq 相等；
笔被占 / 离线都只是「留着待会儿再推」，本地永远不因云端行消失而删数据。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 冲突：游标陈旧 / 纯人为动作重放 / 含 turn 痕迹分叉 / turn 在跑时不动

**Files:**
- Test: `tests/main/taskSessionSync.conflict.test.ts`（复用 Task 10 的 `fakeCloud` / `harness`，从 `./taskSessionSync.test.js` import）
- Modify（仅当测试红）: `src/main/taskSessionSync.ts` 的 `reconcile`

**Interfaces:**
- Consumes: Task 10 的 `reconcile`（由 `seq_conflict` 触发）、`onReplaced`、`isRunning`。

- [ ] **Step 1: 写测试**

```ts
// tests/main/taskSessionSync.conflict.test.ts
// 冲突三态（#1223，spec §3.6）：重叠段相等 = 只是游标陈旧；本地多出的尾巴全是人为动作 = 重放；
// 含 turn 痕迹 = 分叉出兄弟会话、原 id 换成云端那份。turn 在跑时一律不动本地日志。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { fakeCloud, harness } from "./taskSessionSync.test.js";

const created = (sessionId: string) =>
  ({ sessionId, ts: 1, type: "session_created", workspace: `/D/${sessionId}`, workspaceKind: "default" }) as const;

/** A 建好会话并推上云、放笔；返回 harness */
async function seeded() {
  const h = harness();
  h.store.append(created("s1"));
  h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
  await h.sync.flushNow();
  await h.sync.releasePen("s1");
  return h;
}
/** 另一台设备 B 在云端写一条人话 + 一轮回复 */
async function bWrites(h: ReturnType<typeof harness>, fromSeq: number) {
  await h.cloud.api.append("s1", fromSeq, "desktop:B", [{ seq: fromSeq, sessionId: "s1", ts: 9, type: "user_message", content: "B 说" }]);
  await h.cloud.api.acquirePen("s1", "desktop:B", 30);
  await h.cloud.api.append("s1", fromSeq + 1, "desktop:B", [
    { seq: fromSeq + 1, sessionId: "s1", ts: 10, type: "assistant_message", content: "B 答", model: "m" },
    { seq: fromSeq + 2, sessionId: "s1", ts: 11, type: "turn_ended", outcome: "completed" },
  ]);
  await h.cloud.api.releasePen("s1", "desktop:B");
}

describe("taskSessionSync：冲突", () => {
  it("游标陈旧（推过但没记下来）：重叠段相等 → 只推游标，不分叉、不重放", async () => {
    const h = await seeded();
    // 假装游标丢了一格：把 pushedUpTo 退回 0，再 flush 会重推 seq 1 → seq_conflict → 对账
    h.fileRef().sessions["s1"]!.pushedUpTo = 0;
    h.store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "新名" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.replaced).toEqual([]);
    expect(h.store.sessions().filter((s) => s.title?.includes("分支"))).toHaveLength(0);
  });
  it("本地离线只改了名（human_only）：云端赢，改名重放到云端日志之后", async () => {
    const h = await seeded();
    await bWrites(h, 2); // 云端 seq 2..4
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "离线改名" }); // 本地 seq 2
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    const local = h.store.load("s1");
    expect(local.map((e) => [e.seq, e.type])).toEqual([
      [0, "session_created"], [1, "user_message"], [2, "user_message"], [3, "assistant_message"], [4, "turn_ended"], [5, "session_renamed"],
    ]);
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(6);
    expect(h.replaced).toEqual(["s1"]);
    expect(h.store.sessions().filter((s) => s.title?.includes("分支"))).toHaveLength(0);
  });
  it("本地离线跑了一轮（has_executor）：分叉出「（本机未同步的分支）」，原 id 换成云端那份，分叉自己上云", async () => {
    const h = await seeded();
    await bWrites(h, 2);
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "离线问" });
    h.store.append({ sessionId: "s1", ts: 4, type: "assistant_message", content: "离线答", model: "m" });
    h.store.append({ sessionId: "s1", ts: 5, type: "turn_ended", outcome: "completed" });
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    // 原 id = 云端那份
    expect(h.store.load("s1").map((e) => e.type)).toEqual(["session_created", "user_message", "user_message", "assistant_message", "turn_ended"]);
    expect(h.store.load("s1")[2]).toMatchObject({ content: "B 说" });
    // 兄弟会话保住了本地那截
    const fork = h.store.sessions().find((s) => s.title?.includes("（本机未同步的分支）"));
    expect(fork).toBeDefined();
    const forkEvents = h.store.load(fork!.sessionId);
    expect(forkEvents.map((e) => e.type)).toEqual(["session_created", "user_message", "user_message", "assistant_message", "turn_ended", "session_renamed"]);
    expect(forkEvents[2]).toMatchObject({ content: "离线问" });
    expect(forkEvents[0]).not.toHaveProperty("forkedFrom");
    // 分叉作为新会话上了云
    await h.sync.flushNow();
    expect(h.cloud.rows.has(fork!.sessionId)).toBe(true);
    expect(h.replaced).toEqual(["s1"]);
  });
  it("turn 在跑：撞上冲突先不动本地日志，留在脏集合；收口后再 flush 才对账", async () => {
    let running = true;
    const h = harness({ running: () => running });
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    await bWrites(h, 2);
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "assistant_message", content: "本地半截", model: "m" });
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.replaced).toEqual([]);
    expect(h.store.load("s1")).toHaveLength(3); // 没动
    running = false;
    await h.sync.flushNow();
    expect(h.replaced).toEqual(["s1"]);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/main/taskSessionSync.conflict.test.ts tests/main/taskSessionSync.test.ts`
Expected: 四条全 PASS。红了就修 `reconcile`（常见坑：`divergence` 的 `at` 是 seq 不是下标；`human_only` 重放要在 `replaceWithCloud` **之后**、且不 muted；`has_executor` 的 `forkCopy` 要在 purge **之前**读 `localFull`）。

- [ ] **Step 3: Commit**

```bash
git add tests/main/taskSessionSync.conflict.test.ts tests/main/taskSessionSync.test.ts src/main/taskSessionSync.ts
git commit -m "test(main): 复制器冲突三态——游标陈旧 / 人为动作重放 / turn 痕迹分叉，turn 在跑时不动本地（#1223）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Default 路径每台机器自己算（resume 放宽）+ 渲染层新会话出现就刷列表

**Files:**
- Modify: `src/main/taskWorkspace.ts`（新函数）
- Modify: `src/main/index.ts:2679-2683`（resume 的 workspace 判据）、`:2704`
- Modify: `src/renderer/src/store.ts:3224`（`onEvent` 里再加一个刷新条件）
- Test: `tests/main/taskWorkspace.resume.test.ts`

**Interfaces:**
- Produces: `resolveResumeWorkspace(first: SessionCreatedEvent, sessionId: string, deps: { builtin: string; exists: (abs: string) => boolean; mkdir: (abs: string) => void }): string | null`——`null` = 这条会话真的没法恢复（非 default 种且日志没记路径）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/taskWorkspace.resume.test.ts
import { describe, expect, it } from "vitest";
import { resolveResumeWorkspace } from "../../src/main/taskWorkspace.js";
import type { SessionCreatedEvent } from "../../src/session/events.js";

const created = (extra: Partial<SessionCreatedEvent>): SessionCreatedEvent =>
  ({ seq: 0, sessionId: "s-20260910000000-abcdef12", ts: 0, type: "session_created", ...extra }) as SessionCreatedEvent;
const builtin = "/Users/me/Documents/Mr Otto/Default";

describe("resolveResumeWorkspace（#1223，spec §3.6 Default 路径）", () => {
  it("default 种、日志里的目录本机存在：照用", () => {
    const made: string[] = [];
    const ws = resolveResumeWorkspace(created({ workspace: "/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12", workspaceKind: "default" }), "s-20260910000000-abcdef12", { builtin, exists: () => true, mkdir: (p) => made.push(p) });
    expect(ws).toBe("/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12");
    expect(made).toEqual([]);
  });
  it("default 种、目录不在（另一台 Mac 建的）或日志没记路径（云端建的）：按 sessionId 派生并 mkdir", () => {
    const made: string[] = [];
    const deps = { builtin, exists: () => false, mkdir: (p: string) => made.push(p) };
    expect(resolveResumeWorkspace(created({ workspace: "/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12", workspaceKind: "default" }), "s-20260910000000-abcdef12", deps)).toBe(`${builtin}/s-20260910000000-abcdef12`);
    expect(resolveResumeWorkspace(created({ workspaceKind: "default" }), "s-20260910000000-abcdef12", deps)).toBe(`${builtin}/s-20260910000000-abcdef12`);
    expect(made).toEqual([`${builtin}/s-20260910000000-abcdef12`, `${builtin}/s-20260910000000-abcdef12`]);
  });
  it("项目会话：一切照旧——有路径用路径，没路径 null", () => {
    const deps = { builtin, exists: () => false, mkdir: () => {} };
    expect(resolveResumeWorkspace(created({ workspace: "/repo" }), "x", deps)).toBe("/repo");
    expect(resolveResumeWorkspace(created({}), "x", deps)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/main/taskWorkspace.resume.test.ts`
Expected: FAIL — 函数不存在

- [ ] **Step 3: 写实现**

`src/main/taskWorkspace.ts` 末尾加：

```ts
/** resume 时这条会话的工作区落在哪（#1223，spec §3.6「Default 路径每台机器自己算」）。
    default 种：日志里那个目录本机存在就用它；不存在（另一台 Mac 建的）或压根没记（云端建的）
    就按 sessionId 派生 <内置 Default>/<sessionId> 并建目录——文件夹名就是 sessionId（ADR-0206），
    任何一台 Mac 都算得出同一处。项目会话一切照旧：有路径用路径，没路径 null（调用方拒绝恢复） */
export function resolveResumeWorkspace(
  first: SessionCreatedEvent,
  sessionId: string,
  deps: { builtin: string; exists: (abs: string) => boolean; mkdir: (abs: string) => void },
): string | null {
  if (first.workspaceKind !== "default") return first.workspace ?? null;
  if (first.workspace && deps.exists(first.workspace)) return first.workspace;
  const derived = sessionWorkspaceUnder(deps.builtin, sessionId);
  deps.mkdir(derived);
  return derived;
}
```

顶部加 `import type { SessionCreatedEvent } from "../session/events.js";`。

`src/main/index.ts` resume（`:2679-2707`）改成：

```ts
          const events = store.load(sessionId);
          const first = events[0];
          if (!first || first.type !== "session_created") {
            throw new Error(`会话 ${sessionId} 没有 session_created，无法恢复`);
          }
          // Default 路径每台机器自己算（#1223）：云端 / 另一台 Mac 建的任务会话日志里没有本机路径
          const loggedWorkspace = resolveResumeWorkspace(first, sessionId, {
            builtin: builtinDefaultWorkspace(app.getPath("documents")),
            exists: (abs) => existsSync(abs),
            mkdir: (abs) => mkdirSync(abs, { recursive: true }),
          });
          if (loggedWorkspace === null) {
            throw new Error(`会话 ${sessionId} 没有记录工程文件夹，无法恢复`);
          }
```

再把 `:2704-2707` 的 `let resumeWorkspace = first.workspace;` 改为 `let resumeWorkspace = loggedWorkspace;`，`sessionWorktrees.restore(first.isolated, first.workspace)` 的第二个参数改为 `loggedWorkspace`。`resolveResumeWorkspace` 加进 `taskWorkspace.js` 的 import；`existsSync` 若未 import 从 `node:fs` 补。

`src/renderer/src/store.ts:3224`（`if (e.type === "session_autotitled" || …)` 那一行）把条件加一项 `e.type === "session_created"`，并在上面那段注释末尾补一句：

```ts
      // 会话诞生也刷（#1223）：从云端拉下来的会话第一条就是它，不刷侧栏要等 sweep 之后的自动命名才出现
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `npx vitest run tests/main/taskWorkspace.resume.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/taskWorkspace.ts src/main/index.ts src/renderer/src/store.ts tests/main/taskWorkspace.resume.test.ts
git commit -m "feat(main): 任务会话的 Default 路径每台机器自己算——云端 / 另一台 Mac 建的也能在本机恢复（#1223）

文件夹名就是 sessionId（ADR-0206），日志里那份只是建会话那台 Mac 的记录。项目会话一字不变。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: 主进程装配（观察者 / 账号生命周期 / 拉下来的事件怎么进渲染层 / 删除 / 记忆回拉）

**Files:**
- Modify: `src/main/index.ts`（`:736` store 构造；`:2142-2162` memorySync 旁；`:684-690` onChange；`:3696-3732` delete；`:4512-4514` before-quit）

**Interfaces:**
- Consumes: Task 5 `EventStoreOptions`、Task 8/9/10 的三个模块、Task 3 的 `holderId` / `lastUnanswered`。
- Produces（Task 14/15 依赖）：`taskSync: TaskSessionSync` 实例；`answerLogged(sessionId)`（Task 14 定义，这里先以可变槽 `answerLoggedHook` 占位——同 `memorySyncHook` 的先例）；`taskSyncStateNow(): TaskSyncState`。

- [ ] **Step 1: store 构造挂观察者**

`src/main/index.ts:736` 改成：

```ts
    // 任务会话云同步的观察者（#1223）：复制器建得比 store 晚（要等 supabase client 与账号），
    // 先留槽后填——同 memorySyncHook 的先例
    const appendHook: { fn: ((e: SessionEvent) => void) | null } = { fn: null };
    const store = new EventStore(dbPath, { onAppend: (e) => appendHook.fn?.(e) });
```

- [ ] **Step 2: 装配复制器**

紧跟 `memoryPullNow = …`（`:2162`）之后加：

```ts
    // ── 任务会话云同步（#1223，ADR-0284）──
    // 云端那份是事实，本机 sqlite 是它的前缀副本；谁握笔谁写 turn；人话不要笔。
    const taskSyncPath = join(accountData, "task-sync.json");
    /** 等笔的会话：sessionId → 谁握着（渲染层运行指示条那一档「云端 / 另一台电脑正在回复」，Task 14 写它） */
    const waitingFor = new Map<string, "cloud" | "desktop">();
    /** 别的设备落的人话由这台电脑接着答（Task 14 的 answerLogged）——复制器建得比它早，先留槽后填 */
    const answerLoggedHook: { fn: ((sessionId: string) => void) | null } = { fn: null };
    const taskSync = createTaskSessionSync({
      store,
      api: createSupabaseTaskSessionsApi(supabase.raw),
      uid: () => friends.currentUid(),
      holder: holderId("desktop", remoteKeys?.idStore.deviceId ?? "nodevice"),
      label: hostname(),
      file: { load: () => loadTaskSyncFile(taskSyncPath), save: (f) => saveTaskSyncFile(taskSyncPath, f) },
      attachments: {
        read: (id) => {
          try {
            return attachmentStore.read(id);
          } catch {
            return null;
          }
        },
        save: (bytes) => attachmentStore.save(bytes),
      },
      isRunning: (id) => runningSessions.has(id),
      onPulled: (sessionId, events) => {
        // 拉进来的事件与 engine 落的走同一条路进渲染层与岛
        for (const e of events) {
          send(CHANNELS.event, e);
          feedIsland({ kind: "event", event: e });
        }
        fleetSessionsCache = null;
        pushFleet();
        // 别的设备发的人话且没人答：电脑醒着就由电脑跑（spec §3.6「手机的话由电脑跑」）
        const human = events.some((e) => e.type === "user_message" && e.origin === undefined);
        if (human && !runningSessions.has(sessionId)) answerLoggedHook.fn?.(sessionId);
      },
      onReplaced: (sessionId) => {
        // 本地日志被整份换成云端那份：内存里那只 agent 的快照已经不是这条日志的了
        agents.delete(sessionId);
        islandStates.delete(sessionId);
        fleetSessionsCache = null;
        pushFleet();
        send(CHANNELS.taskSessionReplaced, { sessionId });
      },
      onPenChanged: (sessionId, holder) => {
        // 笔空了、且本地有人在等：接着答（Task 14 的 answerLogged 自己会再拿一次笔）
        if (holder === null && waitingFor.has(sessionId)) answerLoggedHook.fn?.(sessionId);
      },
      onPenLost: (sessionId) => {
        // 续期失败 = 笔已在别人手上：正在跑的 turn 以 interrupted 停掉，接手的一方按「没答」接着答
        if (runningSessions.has(sessionId)) agents.get(sessionId)?.engine.abortTurn("interrupted");
      },
      onExecutorSwitch: (_sessionId, to) => {
        // 云端那段写的记忆落在 memory_docs：回到桌面时拉一次（spec §3.6「记忆」）
        if (to === "desktop") memoryPullNow?.();
      },
      onState: (s) => send(CHANNELS.taskSyncState, s),
    });
    appendHook.fn = (e) => taskSync.touched(e);
```

import 补：`createTaskSessionSync`（`./taskSessionSync.js`）、`createSupabaseTaskSessionsApi`（`./supabaseTaskSessionsApi.js`）、`loadTaskSyncFile` / `saveTaskSyncFile`（`./taskSyncStore.js`）、`holderId`（`../shared/taskSync.js`）；`hostname` 已在 `:7` 那行 import 里。`remoteKeys` 在 `:848` 声明、`:870` 赋值，装配顺序上早于这里（`:2162`），可直接读。

- [ ] **Step 3: 账号生命周期 + 退出**

`:689-690` 的 `onChange` 里两行改成：

```ts
        if (info.signedIn) { remoteRetryNow?.(); proxyResumeNow?.(); memoryPullNow?.(); hostedQuotaRefresh?.(); taskSyncStart?.(); }
        else { proxyCloseNow?.(); taskSyncStop?.(); }
```

在 `:641-642`（`memoryPullNow` 的空位）旁边加两个空位：

```ts
    /** 任务会话云同步（#1223）：登录后 start（回填 + 拉一次 + realtime + sweep），登出 stop。同上是空位 */
    let taskSyncStart: (() => void) | null = null;
    let taskSyncStop: (() => void) | null = null;
```

装配那段（Step 2）末尾填上：

```ts
    taskSyncStart = () => taskSync.start();
    taskSyncStop = () => taskSync.stop();
    // 开机时 onChange 可能已经来过了（restore 早于这段装配）：登录着就现在起
    if (friends.currentUid()) taskSync.start();
```

窗口聚焦时拉一次（同 #1064 点名收件箱的取舍）：在创建主窗口之后有 `win.on("focus", …)` 的地方（`grep -n 'win.on("focus"' src/main/index.ts`，若有就并进去；若没有，在 `createWindow` 返回 `win` 之后加）：

```ts
    win.on("focus", () => {
      void taskSync.pullNow();
      memoryPullNow?.(); // 云端那段写的记忆也在这一刻回拉（spec §3.6「记忆」：与会话拉取同一批触发点）
    });
```

`app.on("before-quit")`（`:4512-4514`）里 `void memorySync.flushNow();` 之后加：

```ts
      void taskSync.flushNow(); // 同上：把脏会话推完
      taskSync.stop(); // 放掉握着的笔——不放要等 30 s 过期，对面白等半分钟
```

- [ ] **Step 4: 删除同步**

`deleteSession` handler（`:3696-3732`）末尾 `pushFleet();` 之后加：

```ts
      // 云端那份跟着删（#1223）：级联抹事件；别的设备只会标 detached、不删本地
      void taskSync.deleted(sessionId);
```

- [ ] **Step 5: 状态查询 IPC（渲染层 Task 15 用）**

在 `ipcMain.handle(CHANNELS.memorySyncStatus, …)`（`:2868`）旁边加：

```ts
    ipcMain.handle(CHANNELS.taskSyncStatus, () => taskSync.state());
```

`CHANNELS.taskSyncStatus` / `taskSyncState` / `taskSessionReplaced` 在 Task 15 加进 `shellBridge.ts`；这一步 tsc 会红到 Task 15 合上为止——**Task 13 与 Task 15 同一个 commit 之前不要各自跑 `npm test`**，或者先做 Task 15 的 `shellBridge.ts` 那半再回来。推荐顺序：Task 15 Step 3（shellBridge + preload）→ Task 13 → Task 14 → Task 15 其余。

- [ ] **Step 6: tsc**

Run: `npx tsc --noEmit`
Expected: 零错误（`answerLoggedHook.fn` 到 Task 14 才填，现在是 null，行为 = 不自动接答）

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): 接上任务会话复制器——观察者、账号生命周期、拉下来的事件进渲染层、删除同步（#1223）

拉进来的事件与 engine 落的走同一条路（send + feedIsland + fleet）；别的设备发的人话且没人答
就交给 answerLogged（下一条提交）；本地日志被换成云端那份时把内存里那只 agent 丢掉重载。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: turn 准入接笔：`driveTurn` 拆分、等笔、`answerLogged`、`executor_changed{desktop}`、powerMonitor

**Files:**
- Modify: `src/main/index.ts`（`:4` electron import；`:2673-2722` resume；`:3879-4132` `handleSendMessage`；`:4377-4384` `sessionRuntime`；whenReady 块内加 powerMonitor）

**Interfaces:**
- Consumes: Task 6 `engine.logUserMessage` / `runLoggedTurn` / `abortTurn("interrupted")`、Task 10 `taskSync.acquirePen/holdsPen/releasePen/markOfflineRun`、Task 3 `lastUnanswered`、Task 13 的 `waitingFor` / `answerLoggedHook`。
- Produces: `driveTurn(sessionId, agent, { text, run })`、`answerLogged(sessionId)`、`resumeAgent(sessionId)`、`setWaiting(sessionId, kind | null)`（推 `CHANNELS.taskWaiting`，Task 15 加通道）。

- [ ] **Step 1: resume 的躯干抽成 `resumeAgent`**

把 `ipcMain.handle(CHANNELS.resumeSession, …)` 里 `resumeOnce(sessionId, async () => { … })` 的箭头函数体整个搬成一个具名函数（放在 `resumeOnce` 声明之后）：

```ts
    /** 从日志重建一只 agent（#1223 从 resumeSession 里拆出来）：两条入口共用——用户点开会话、
        别的设备落的人话要由这台电脑接着答（answerLogged）而会话还不在内存里 */
    async function resumeAgent(sessionId: string): Promise<void> {
      // ……（原箭头函数体逐字搬进来，一个字不改）
    }
```

handler 改成：

```ts
    ipcMain.handle(CHANNELS.resumeSession, async (_e, sessionId: string): Promise<BootInfo> => {
      if (!agents.has(sessionId)) await resumeOnce(sessionId, () => resumeAgent(sessionId));
      currentSessionId = sessionId;
      const info = bootInfo();
      if (!info) throw new Error("恢复会话失败");
      return info;
    });
```

- [ ] **Step 2: `handleSendMessage` 拆成「准入 + `driveTurn`」**

在 `handleSendMessage` 之前加两个帮手：

```ts
    /** 等笔的状态推给渲染层（运行指示条那一档「云端 / 另一台电脑正在回复」，#1223） */
    const setWaiting = (sessionId: string, kind: "cloud" | "desktop" | null): void => {
      if (kind === null) waitingFor.delete(sessionId);
      else waitingFor.set(sessionId, kind);
      send(CHANNELS.taskWaiting, { sessionId, waitingFor: kind });
    };
    /** 收口后的帮手链排空（annotate / microCompact 各自的串行队列）：放笔要等它们——它们会落 executor 类事件 */
    const afterTurnHelpers = (sessionId: string): Promise<unknown> =>
      Promise.allSettled([sectionQueues.get(sessionId) ?? Promise.resolve(), microQueues.get(sessionId) ?? Promise.resolve()]);
```

把 `handleSendMessage` 从 `:3973`（`// 跨进程那一半（issue #634）` 那段注释）起到函数末尾（`:4132` 后台回注排空的 `}` 之后）的内容搬进新函数 `driveTurn`，形状如下（注释原样保留，此处只标出**改动的**行）：

```ts
    /** turn 的躯干（#1223 从 handleSendMessage 里拆出来）：工作区锁、runningSessions、状态推送、
        收口清场、收口后的帮手、后台回注排空。两条入口共用：人在电脑上打字（run = 检查点 + 代读 +
        runTurn）、别的设备落的人话由这台电脑接着答（run = runLoggedTurn）。text 只给通知文案用 */
    async function driveTurn(
      sessionId: string,
      agent: ReturnType<typeof createAgent>,
      opts: { text: string; run: () => Promise<"completed" | "aborted"> }
    ): Promise<void> {
      const text = opts.text;
      // ……原 :3973-3984（wsLock / runningSessions.add / turnStatus running / feedIsland）逐字搬入
      // 换执行器（#1223，spec §3.4）：握着笔、且日志里最后一条 executor_changed 不是「这台桌面」才落。
      // 一条都没有 = 一直是桌面（存量日志），不落——旧日志逐字节不变
      if (taskSync.holdsPen(sessionId)) {
        const last = store.lastOfType(sessionId, "executor_changed") as ExecutorChangedEvent | null;
        if (last !== null && (last.executor !== "desktop" || last.label !== hostname())) {
          const ex = store.append({ sessionId, ts: Date.now(), type: "executor_changed", executor: "desktop", label: hostname(), ignorable: true });
          send(CHANNELS.event, ex);
        }
      }
      let outcome: "completed" | "aborted" = "aborted";
      try {
        outcome = await opts.run();                       // ← 原来 try 里从检查点到 runTurn 的那一大段，现在在 run 闭包里
      } catch (err) {
        void taskSync.releasePen(sessionId);              // ← 新增：失败的 turn 没有帮手，当场放笔
        // ……原 catch 逐字（turnFailedNotification + throw）
      } finally {
        // ……原 finally 逐字（wsLock.release / runningSessions.delete / pending 清理 / turnStatus idle / reportEscapedGroups）
      }
      // ……原 `if (outcome === "completed") { … }`（通知 / enqueueAnnotate / nudgeMemory / enqueueMicroCompact）逐字
      // 放笔排在帮手之后（#1223，spec §3.3）：帮手会落 session_autotitled / micro_compacted 这类 executor 事件，
      // 笔先放了它们就推不上去。aborted 那条没排帮手，两条队列为空，立刻放
      void afterTurnHelpers(sessionId).finally(() => {
        void taskSync.releasePen(sessionId);
      });
      // ……原后台回注排空那段逐字
    }
```

`handleSendMessage` 保留 `:3879-3972`（校验、skill、附件），然后改成：

```ts
      // 笔（#1223，spec §3.6 turn 准入）：任务会话先问云端此刻谁在跑。拿到 / 离线 / 不是任务会话都往下走；
      // 被别人握着 → 只落人话，不起本地 turn；等笔空了由 answerLogged 接着答（taskSync.onPenChanged）。
      // 网络错 ≠ 被占：桌面 app 离线必须能用（同 memorySync「off 也开会话」），照跑，回网后的冲突是预期内的
      const pen = await taskSync.acquirePen(sessionId);
      if (pen.kind === "held") {
        const opening = agent.engine.logUserMessage(text, refs, textFiles, background);
        send(CHANNELS.event, opening);
        setWaiting(sessionId, pen.holderKind === "cloud" ? "cloud" : "desktop");
        return;
      }
      if (pen.kind === "offline") taskSync.markOfflineRun(sessionId);
      setWaiting(sessionId, null);
      await driveTurn(sessionId, agent, {
        text,
        run: async () => {
          // ……原 try 里从「工作区检查点（issue #395）」那段到 image_described append 逐字搬入
          return agent.engine.runTurn(text, refs, textFiles, background);
        },
      });
    }
```

（`run` 闭包里引用的 `refs` / `textFiles` / `invoked` / `background` / `text` 都在 `handleSendMessage` 的作用域里，闭包直接捕获。）

- [ ] **Step 3: `answerLogged`**

紧跟 `driveTurn` 之后：

```ts
    /** 别的设备落的人话由这台电脑接着答（#1223，spec §3.6）：两个触发点——拉到一条没人答的人话
        （taskSync.onPulled）、等着的笔空了（taskSync.onPenChanged）。判据是日志（lastUnanswered），
        不是「我刚收到过什么」：两个触发点撞在一起也只答一次 */
    const answering = new Set<string>();
    async function answerLogged(sessionId: string): Promise<void> {
      if (runningSessions.has(sessionId) || answering.has(sessionId)) return;
      answering.add(sessionId);
      try {
        if (!agents.has(sessionId)) await resumeOnce(sessionId, () => resumeAgent(sessionId));
        const agent = agents.get(sessionId);
        if (!agent) return;
        const opening = lastUnanswered(store.load(sessionId));
        if (opening === null) {
          setWaiting(sessionId, null);
          return;
        }
        const pen = await taskSync.acquirePen(sessionId);
        if (pen.kind === "held") {
          setWaiting(sessionId, pen.holderKind === "cloud" ? "cloud" : "desktop");
          return;
        }
        if (pen.kind === "off") return;
        setWaiting(sessionId, null);
        await driveTurn(sessionId, agent, { text: opening.content, run: () => agent.engine.runLoggedTurn(opening) });
      } finally {
        answering.delete(sessionId);
      }
    }
    answerLoggedHook.fn = (id) => void answerLogged(id).catch((err) => console.error("接着答失败", err));
```

import 补：`lastUnanswered`（`../shared/taskSync.js`）、`ExecutorChangedEvent` 类型（`../session/events.js`）。

- [ ] **Step 4: `sessionRuntime` 带 `waitingFor`；powerMonitor**

`:4377-4384` 的返回对象加一格：`waitingFor: waitingFor.get(sessionId) ?? null,`。

`:4` 的 electron import 加 `powerMonitor`。在 Step 3 之后（仍在 whenReady 块内）加：

```ts
    // 睡眠 / 唤醒（#1223，spec §3.6）：合盖时正在跑的、握着笔的 turn 以 interrupted 收口（不是 aborted——
    // 人没按停止），尽力推出去、放笔，手机接手时看到的是干净的尾巴且那条人话按「没答」处理；
    // 醒来先 sweep 再做任何事
    powerMonitor.on("suspend", () => {
      for (const id of runningSessions) {
        if (taskSync.holdsPen(id)) agents.get(id)?.engine.abortTurn("interrupted");
      }
    });
    powerMonitor.on("resume", () => {
      void taskSync.pullNow();
      memoryPullNow?.();
    });
```

- [ ] **Step 5: tsc + 全量测试**

Run: `npm test`
Expected: 全绿（`handleSendMessage` 没有单测，靠 tsc + 既有 e2e 冒烟；行为对不对由 Task 17 的手验清单第 2、5 条盖）

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): turn 准入接笔——被别人握着只落人话、笔空了接着答、睡眠以 interrupted 收口（#1223）

handleSendMessage 拆成准入 + driveTurn，两条入口（本机打字 / 接着答别的设备落的人话）共用一副
躯干；executor_changed{desktop} 在握笔起跑前落；放笔排在收口帮手之后（它们会落 executor 类事件）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: IPC 通道 + 渲染层（状态行、等笔那一档、时间线已在 Task 2）

**Files:**
- Modify: `src/shared/shellBridge.ts`（类型导出 `:57-65` 附近；`SessionRuntime` `:199-209`；接口 `:686` 与 `:1002` 旁；`CHANNELS` `:1518` 与 `:1722` 旁）
- Modify: `src/preload/index.ts:52`、`:178` 旁
- Modify: `src/renderer/src/store.ts`（字段 `:295-315`；初值 `:1411-1416`；订阅 `:3318` 旁；`onTurnStatus` 的 idle 清理）
- Modify: `src/renderer/src/lib/runtimeHydration.ts`、`src/renderer/src/lib/agentPhase.ts`、`src/renderer/src/aui/OttoThread.tsx:823-847`、`src/renderer/src/App.tsx:1247-1290`（`AccountPage`）
- Create: `src/renderer/src/lib/taskSyncText.ts`、`src/renderer/src/components/TaskSyncStatusLine.tsx`
- Test: `tests/renderer/lib/agentPhase.test.ts`（补一条）、`tests/renderer/lib/runtimeHydration.waiting.test.ts`、`tests/renderer/lib/taskSyncText.test.ts`

**Interfaces:**
- Produces: `CHANNELS.taskSyncStatus / taskSyncState / taskWaiting / taskSessionReplaced`；`ShellBridge.taskSyncStatus()`、`onTaskSyncState`、`onTaskWaiting`、`onTaskSessionReplaced`；`TaskWaitingUpdate`；`SessionRuntime.waitingFor?`；store `taskSync`、`waitingBySession`；`agentPhase` 的 `waitingFor` 输入；`taskSyncStatusText(s: TaskSyncState): string`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/renderer/lib/taskSyncText.test.ts
import { describe, expect, it } from "vitest";
import { taskSyncStatusText } from "../../../src/renderer/src/lib/taskSyncText.js";

describe("taskSyncStatusText（#1223）", () => {
  it("四态各一句；off 带原因时说原因，不把「没建表」说成「没登录」", () => {
    expect(taskSyncStatusText({ kind: "off", reason: null })).toBe("任务会话只在这台电脑上（登录后会跟账号同步）");
    expect(taskSyncStatusText({ kind: "off", reason: "云端还没有任务会话表（migration 0036 未执行）" })).toBe("任务会话云同步关着：云端还没有任务会话表（migration 0036 未执行）");
    expect(taskSyncStatusText({ kind: "idle", lastSyncedAt: 1 })).toBe("任务会话已与账号同步");
    expect(taskSyncStatusText({ kind: "syncing" })).toBe("任务会话同步中…");
    expect(taskSyncStatusText({ kind: "error", message: "x", lastSyncedAt: null })).toBe("任务会话同步失败，会自动重试");
  });
});
```

```ts
// tests/renderer/lib/runtimeHydration.waiting.test.ts
import { describe, expect, it } from "vitest";
import { runtimePatch } from "../../../src/renderer/src/lib/runtimeHydration.js";

const empty = { statusBySession: {}, compactingBySession: {}, approvals: {}, asks: {}, waitingBySession: {} };

describe("runtimePatch 的 waitingFor（#1223）", () => {
  it("快照带 waitingFor 且 store 没记录 → 补；已有记录不覆盖；null / 缺席不补", () => {
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: "cloud" })).toMatchObject({ waitingBySession: { s: "cloud" } });
    expect(runtimePatch({ ...empty, waitingBySession: { s: "desktop" } }, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: "cloud" }).waitingBySession).toBeUndefined();
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: null }).waitingBySession).toBeUndefined();
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null }).waitingBySession).toBeUndefined();
  });
});
```

`tests/renderer/lib/agentPhase.test.ts` 的 `describe` 里加一条：

```ts
  it("等别的执行器（#1223）：排在审批之后、其余之前", () => {
    expect(agentPhase({ ...base, waitingFor: "cloud" })).toEqual({ orb: "listening", label: "云端正在回复…" });
    expect(agentPhase({ ...base, waitingFor: "desktop", tool: call("bash") })).toEqual({ orb: "listening", label: "另一台电脑正在回复…" });
    expect(agentPhase({ ...base, hasApproval: true, waitingFor: "cloud" })).toEqual({ orb: "listening", label: "等待审批…" });
  });
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `npx vitest run tests/renderer/lib/`
Expected: 三处 FAIL（模块不存在 / 字段不存在 / 文案不对）

- [ ] **Step 3: shellBridge + preload**

`src/shared/shellBridge.ts`：
- `:57` 旁加 `import type { TaskSyncState } from "./taskSyncState.js";`，`:65` 旁加 `export type { TaskSyncState };`
- `SessionRuntime`（`:199-209`）加：

```ts
  /** 在等别的执行器（#1223）：笔被云端 / 另一台电脑握着，这条会话的人话已落、turn 没起。
      可选 = 旧快照形状不变；null = 没在等 */
  waitingFor?: "cloud" | "desktop" | null;
```

- `:189` 旁加：

```ts
export interface TaskWaitingUpdate {
  sessionId: string;
  waitingFor: "cloud" | "desktop" | null;
}
```

- 接口：`:686` 旁加 `taskSyncStatus(): Promise<TaskSyncState>;`；`:1002` 旁加：

```ts
  /** 任务会话云同步状态（#1223）：主进程状态一变就推；设置页那行读它 */
  onTaskSyncState(cb: (s: TaskSyncState) => void): Unsubscribe;
  /** 等别的执行器（#1223）：运行指示条那一档 */
  onTaskWaiting(cb: (u: TaskWaitingUpdate) => void): Unsubscribe;
  /** 本地日志被整份换成云端那份（冲突处理）：正开着它就重载，侧栏刷列表 */
  onTaskSessionReplaced(cb: (u: { sessionId: string }) => void): Unsubscribe;
```

- `CHANNELS`：`:1518` 旁加 `taskSyncStatus: "otter:taskSyncStatus",`；`:1722` 旁加 `taskSyncState: "otter:taskSyncState",`、`taskWaiting: "otter:taskWaiting",`、`taskSessionReplaced: "otter:taskSessionReplaced",`。

`src/preload/index.ts`：`:52` 旁加 `taskSyncStatus: () => ipcRenderer.invoke(CHANNELS.taskSyncStatus),`；`:178` 旁加 `onTaskSyncState: subscribe(CHANNELS.taskSyncState),`、`onTaskWaiting: subscribe(CHANNELS.taskWaiting),`、`onTaskSessionReplaced: subscribe(CHANNELS.taskSessionReplaced),`。

- [ ] **Step 4: 渲染层纯逻辑**

```ts
// src/renderer/src/lib/taskSyncText.ts
import type { TaskSyncState } from "../../../shared/taskSyncState.js";

/** 账号页那一行写什么（#1223）。off 分两种：没登录 vs 云端还没建表——后者不许说成前者（ADR-0248 的措辞纪律） */
export function taskSyncStatusText(s: TaskSyncState): string {
  switch (s.kind) {
    case "off":
      return s.reason === null ? "任务会话只在这台电脑上（登录后会跟账号同步）" : `任务会话云同步关着：${s.reason}`;
    case "idle":
      return "任务会话已与账号同步";
    case "syncing":
      return "任务会话同步中…";
    case "error":
      return "任务会话同步失败，会自动重试";
  }
}
```

`src/renderer/src/lib/agentPhase.ts`：`AgentPhaseInput` 加 `waitingFor?: "cloud" | "desktop" | null;`（注释：「在等别的执行器（#1223）。审批之后、其余之前：人话已落、turn 没起，别的档都不成立」）；`agentPhase` 在 `hasApproval` 那行之后加：

```ts
  if (input.waitingFor) return { orb: "listening", label: input.waitingFor === "cloud" ? "云端正在回复…" : "另一台电脑正在回复…" };
```

`src/renderer/src/lib/runtimeHydration.ts`：`RuntimeSlice` 加 `waitingBySession: Record<string, "cloud" | "desktop">;`；`runtimePatch` 末尾 `return patch;` 之前加：

```ts
  // 等笔那一档（#1223）：同审批——有自己的推送通道，只填空不覆盖
  if (rt.waitingFor && prev.waitingBySession[sessionId] === undefined) {
    patch.waitingBySession = { ...prev.waitingBySession, [sessionId]: rt.waitingFor };
  }
```

- [ ] **Step 5: store**

`src/renderer/src/store.ts`：
- 字段（`:315` `asks` 之后）：

```ts
  /** 任务会话云同步状态（#1223）：主进程推，账号页那行读 */
  taskSync: TaskSyncState;
  /** 在等别的执行器的会话（#1223）：sessionId → 谁握着笔。运行指示条第七档 */
  waitingBySession: Record<string, "cloud" | "desktop">;
```

- 初值（`:1416` 之后）：`taskSync: { kind: "off", reason: null },`、`waitingBySession: {},`
- 订阅（`:3318` 之前）：

```ts
    window.otter.onTaskSyncState((s) => set({ taskSync: s }));
    void window.otter.taskSyncStatus().then((s) => set({ taskSync: s })).catch(() => {});
    window.otter.onTaskWaiting(({ sessionId, waitingFor }) =>
      set((s) => ({
        waitingBySession: waitingFor === null ? without(s.waitingBySession, sessionId) : { ...s.waitingBySession, [sessionId]: waitingFor },
      }))
    );
    window.otter.onTaskSessionReplaced(({ sessionId }) => {
      // 日志被整份换掉：正开着它就重载（resume 会重新拉 events），侧栏刷列表
      if (get().sessionId === sessionId) void get().resume(sessionId);
      void window.otter.listSessions().then((sessions) => set({ sessions }));
    });
```

- `onTurnStatus` 那段 `status === "idle"` 的清理对象里加 `waitingBySession: without(s.waitingBySession, sessionId),`（turn 起来过 = 不再等）。
- import 补 `TaskSyncState` 类型（从 `../../../shared/shellBridge.js`）。`get().resume` 是「打开一条既有会话」的既有 action 名——若不叫 `resume`，用 `grep -n "resumeSession(" src/renderer/src/store.ts` 找到调用 `window.otter.resumeSession` 的那个 action 名替换。

- [ ] **Step 6: RunIndicator + 账号页那一行**

`src/renderer/src/aui/OttoThread.tsx:823-847`：
- 加一行订阅 `const waitingFor = useChat((s) => s.waitingBySession[s.sessionId] ?? null);`
- 闸门改成 `if (status !== "running" && approval === null && waitingFor === null) return null;`
- `agentPhase({...})` 的入参加 `waitingFor,`
- 那段闸门注释末尾补：「等别的执行器（#1223）也算：人话已落、turn 没起，指示条得告诉人「云端正在回复」，不然输入框一清什么都没发生」

```tsx
// src/renderer/src/components/TaskSyncStatusLine.tsx
// 账号页那一行（#1223，spec §3.7）：任务会话云同步此刻的状态。同 MemorySettings 头部那句 syncHint 的做法，
// 但走推送（主进程状态一变就推）而不是挂载时拉一次——拉一次的那行在设置页开着的几分钟里会一直陈旧
import { useChat } from "../store.js";
import { taskSyncStatusText } from "../lib/taskSyncText.js";

export function TaskSyncStatusLine() {
  const state = useChat((s) => s.taskSync);
  return (
    <p className="text-xs text-muted-foreground" title={state.kind === "error" ? state.message : undefined} data-testid="task-sync-status">
      {taskSyncStatusText(state)}
    </p>
  );
}
```

`src/renderer/src/App.tsx:1274`（`<BillingSettings />` 之后）加 `<TaskSyncStatusLine />`，并 import。

- [ ] **Step 7: 跑测试 + tsc**

Run: `npx vitest run tests/renderer/ && npx tsc --noEmit`
Expected: 全 PASS（`RuntimeSlice` 多了一格：`tests/renderer/lib/runtimeHydration.test.ts` 若有构造 `RuntimeSlice` 字面量的地方，补上 `waitingBySession: {}`）

- [ ] **Step 8: Commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/renderer/src/store.ts src/renderer/src/lib/runtimeHydration.ts src/renderer/src/lib/agentPhase.ts src/renderer/src/lib/taskSyncText.ts src/renderer/src/aui/OttoThread.tsx src/renderer/src/components/TaskSyncStatusLine.tsx src/renderer/src/App.tsx tests/renderer/lib/
git commit -m "feat(renderer): 任务会话云同步的三条通道——状态行、等笔那一档、日志被换掉时重载（#1223）

运行指示条多一档「云端 / 另一台电脑正在回复」（审批之后、其余之前）；账号页一行状态走推送不走
挂载时拉一次；「没建表」不许说成「没登录」。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: 文档：CONTEXT.md 术语、ADR、AGENTS.md 索引一行、spec 偏差段

**Files:**
- Modify: `CONTEXT.md`（「产品 / 技术术语」那张表）
- Create: `docs/adr/0284-任务会话云端日志为准本机是前缀副本笔租约决定谁跑.md`（编号合并前 re-fetch 再定，撞了就 `max+1` 并在文首加「原为 ADR-0284」）
- Modify: `AGENTS.md`「Where to find things」加一行
- Modify: `docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md`（§3.6 附件那句、§7 加两条、末尾加「实施偏差」段）

- [ ] **Step 1: CONTEXT.md 三行**

在「产品 / 技术术语」表里 `任务文件夹` 那行之后加：

```
| 任务会话云端日志 | 登录用户的每条任务会话在 Supabase（`task_sessions` + `task_session_events`）有一份账号级副本，**云端那份是事实，本机 sqlite 是它的前缀副本**；桌面复制器 `taskSessionSync` 推 / 拉，冲突按「云端赢、纯人为动作重放、含 turn 痕迹分叉」处理。项目会话与子智能体会话不上云 | ADR-0284，#1223 |
| 笔（pen） | 任务会话同一时刻谁在跑 turn 的租约：`task_sessions.pen_holder/pen_until`，30 s ttl、10 s 续、收口帮手跑完才放。executor 类事件（跑 turn 的痕迹）必须握笔才能追加，人的动作（`PEN_VERDICTS` 里的 `human`）免笔——手机从不握笔，天然只发得出人话 | ADR-0284，`src/shared/taskSync.ts` |
| 执行器（executor） | 此刻替用户跑这条任务会话的一方：`desktop`（本机全工具）或 `cloud`（VPS runtime，无沙箱，②子项目）。换执行器是日志事实 `executor_changed`，投影成 system 尾块；一条都没有 = 桌面 | ADR-0284，spec §3.4 |
```

- [ ] **Step 2: ADR**

```markdown
# ADR-0284：任务会话云端日志为准，本机是前缀副本，「笔」租约决定谁跑

- 日期：2026-09-10
- 状态：已接受
- Task issue：#1223；spec：`docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md`

## 背景

维护者要的两个场景：电脑睡了手机接着聊、手机开的会话回家电脑接着聊。今天手机只是电脑的加密投影
（中继一帧不存，ADR-0094/0095），云会话从帧到容器全按 workspaceId 键（ADR-0199），没有任何
「个人会话」的云端表；本机日志的 `seq` 是 `MAX+1` 本地分配、事件不带来源——两台设备同时写必撞。

## 决定

1. **云端日志为准、本机 sqlite 是前缀副本。** 两张表（`task_sessions` / `task_session_events`）、
   own-row RLS、写只走 `security definer` RPC 的 `seq` CAS。桌面加复制器 `taskSessionSync`
   （`EventStore.onAppend` 观察者按持久化游标推；realtime `task_sessions` UPDATE + 60 s sweep 拉尾巴
   muted append，断言本地分到同一个 seq）。否决了 B「runtime 为准、桌面变显示器」（桌面离线就没有
   任务会话；本机工具调用绕 VPS + 256 KiB 帧上限）与 C「手机自己跑 LoopEngine」（iOS 后台 30 秒杀 JS）。
2. **「笔」租约决定同一时刻谁写 turn。** 只在跑 turn 时握（拿 → 10 s 续 → 收口帮手跑完才放，ttl 30 s）；
   executor 类事件必须握笔才能追加，人的动作免笔（`PEN_VERDICTS` 穷举 Record）。手机从不握笔，天然只
   发得出人话；runtime 同一条规矩不因 service key 绕过。建行那一批由 RPC 顺手把笔发给创建者。
   否决了「电脑常握笔」：手机永远要等到过期才轮到云端，且醒着没在跑也不该独占。
3. **换执行器是日志事实。** 新事件 `executor_changed`（ignorable），拿到笔的一方在起 turn 前落，
   投影成 system 尾块（云端：碰不到电脑文件；回到电脑：全部工具可用；换了一台 Mac：文件不在这台）。
4. **冲突：云端赢，本机不丢。** 重叠段逐条相等只是游标陈旧；本地多出的尾巴全是人为动作 → 重放到
   云端日志之后；含 turn 痕迹 → 整份复制成兄弟会话「（本机未同步的分支）」再把原 id 换成云端那份。
   不做三路合并。本地永远不因云端行消失而删数据（`detached`）。
5. **Default 路径每台机器自己算。** default 种的会话 resume 时日志那个目录不在就按 sessionId 派生
   `<内置 Default>/<sessionId>`（文件夹名就是 sessionId，ADR-0206）；云端建的会话日志里没有路径。
6. **睡眠打断用 `interrupted` 收口。** `engine.abortTurn("interrupted")`；`lastUnanswered` 把它算
   「没答」、`aborted`（人按停止）算「答过」，接手的一方据此接着答。

## 后果 / 已知代价

日志两份、Supabase 存储随工具输出长、开机回填一次性上传存量、对面没有 token 流式、离线分歧分叉
永不合并、`memory_loaded` 仍是起点快照、机器专属事件（检查点 / 残留）复制到对它们没意义的机器、
任务文件夹的**文件**不同步、一台删除其他设备留 detached 副本、桌面在线判据借好友 30 s 心跳、
子智能体会话不上云且**冲突分叉时随父会话一起 purge**、附件是「拉到即取」而非读时回取。
完整清单见 spec §7 与「实施偏差」。

## 推翻条件

多 runtime 水平扩展、或 Supabase 单表写入成为瓶颈时，「云端那份是事实」要换载体；手机端能常驻后台
执行时，C 路线值得重估。
```

- [ ] **Step 3: AGENTS.md 索引一行**

在「Where to find things」最后加：

```
- `src/main/taskSessionSync.ts` / `src/shared/taskSync.ts` / `supabase/migrations/0036_task_sessions.sql` — **任务会话云端日志**（ADR-0284，#1223）：云端那份是事实、本机 sqlite 是前缀副本、「笔」租约决定谁写 turn（executor 类事件必须握笔、人话免笔，判据是 `PEN_VERDICTS` 穷举 Record，SQL 白名单有断言对表）。冲突「云端赢、纯人为动作重放、含 turn 痕迹分叉」；本地永不因云端行消失而删数据。新事件 `executor_changed` 投影成 system 尾块；Default 路径每台机器按 sessionId 自己算；睡眠以 `interrupted` 收口。②runtime 兜底执行器 / ③手机客户端 / ④一对一语音各自另开 spec，契约在 spec §3.9
```

- [ ] **Step 4: spec 偏差段**

在 spec 文件末尾加一节 `## 9. 实施偏差（写 plan 时定的，合并时以此为准）`，逐条抄本计划开头「与 spec 的实施偏差」六条；§7 已知代价加两条：「13. 冲突分叉时子智能体会话随父会话一起 purge（`store.purge` 级联）」「14. 附件『拉到即取』：拉到那一刻下载失败进 `missingAttachments`，下次 sweep 重试，期间那张图在本机画占位」。

- [ ] **Step 5: 门禁（ADR 编号 / 索引断言）**

Run: `npx vitest run tests/docs/`
Expected: PASS（撞号会在 `adrNumbers.test.ts` 红——合并前再 re-fetch 一次）

- [ ] **Step 6: Commit**

```bash
git add CONTEXT.md docs/adr/0284-*.md AGENTS.md docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md
git commit -m "docs: ADR-0284 任务会话云端日志 + CONTEXT 三个词 + 索引一行 + spec 实施偏差（#1223）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: 门禁、Cloud 上跑 0036、两实例手验、PR

**Files:**
- Modify: `supabase/README.md`（执行状态记录，若该文件维护着这张表）、`supabase/migrations/0036_task_sessions.sql` 文件头（执行日期与核对结果）
- 无代码

- [ ] **Step 1: 门禁**

Run: `npm test`
Expected: tsc 零错误 + vitest 全绿

- [ ] **Step 2: 合并前 re-fetch，核 ADR 号与 migration 号**

```bash
git fetch origin && git log --oneline -5 origin/main && ls docs/adr | tail -2 && ls supabase/migrations | tail -2
```

被占就改号（ADR：文首加「原为 ADR-0284」并全仓 grep 替换；migration：只改文件名与首行注释，SQL 本体不动），重跑 `npx vitest run tests/docs/`。

- [ ] **Step 3: Cloud 真库跑 0036**

按 `supabase/migrations/0030_workspace_mentions.sql:3-9` 的做法：Management API 逐条发（VPS 上不跑 migration；钥匙串取 CLI token）。跑完核四条：两张表在、RLS 开着且 `task_session_events` 没有 insert/update/delete 策略、`task_sessions` 进了 `supabase_realtime` publication、`select proname from pg_proc where proname like 'task_%'` 回 6 个包装 + 3 个 `_task_*`。把执行日期与核对结果写进 0036 文件头（同 0030 的先例）与 `supabase/README.md`。

- [ ] **Step 4: 两实例手验（spec §5 八条）**

```bash
npm run dev
```

```bash
OTTO_PROFILE=b npm run dev
```

（同一个账号两个实例；换号会重启，一个一个登。）逐条打勾并把结果写进 #1223 评论：
1. A 新建任务会话、聊两轮 → B 侧栏出现、内容一致（含 `memory_loaded` / `request_envelope`）。
2. B 打字 → B 拿笔跑；同时 A 打字 → A 指示条「另一台电脑正在回复」；B 收口后 A 那条被接着答。
3. A 关 Wi-Fi 聊一轮 → 回网：无人动过时推上；期间 B 也聊了 → A 那截分叉成「（本机未同步的分支）」。
4. A 断网只改名 / 归档 → 回网 → 重放不分叉。
5. A 合盖 5 分钟再开 → `interrupted` 收口、sweep 拉齐。
6. 带图的人话 → B 时间线能画图、B 起 turn 时模型拿得到图。
7. 回滚 0036（或临时改 RPC 名）→ 账号页那行写「云端还没有任务会话表」，会话本地照常。
8. 一台删除 → 另一台仍可读（detached），续聊后重新出现在第一台。

- [ ] **Step 5: PR**

用 `gh pr create` 开 PR，标题：

```
feat: 任务会话云端日志底座——本机 ↔ 云端前缀副本 + 笔租约 + executor_changed（#1223）
```

正文四段：做了什么（spec / ADR-0284 / 0036 / 复制器 / `executor_changed` / Default 路径 / interrupted / 准入接笔 / 渲染层）、没做（②③④各自另开 spec）、验证（`npm test` 全绿 + 两实例手验八条见 #1223 评论）、`Closes #1223`，末尾带 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

CI 绿后 merge commit 合并（不 squash），`npm run lane:prune` 收工，按 On ending a shift 开交接 issue（②的 spec 是下一班的第一件事）。
