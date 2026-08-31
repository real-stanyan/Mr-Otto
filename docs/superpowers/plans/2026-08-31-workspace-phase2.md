# 工作区二期实施计划：云 runtime + 每工作区沙箱 + 群聊会话协议

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 群聊 Agent 在 VPS 云端执行：runtime daemon 装配现有 agent 核心，工具进每工作区 Docker 沙箱，成员经 relay 群聊、@Agent 触发 turn、审批路由到发起人/owner，桌面只当显示器。

**Architecture:** 权威 event log = VPS SQLite（EventStore 原样复用），每条事件落盘后经 relay 房间直播给成员；loop 跑在宿主 daemon（模型 key 不进容器），DockerWorld 经 dockerode exec 进容器执行工具；MCP 走 edge px 平台路径（凭据仍只在 Escrow DO 解封）。

**Tech Stack:** Node 24（VPS 宿主）、dockerode、esbuild（bundle）、better-sqlite3、Cloudflare Worker（edge，已有）、Supabase（在籍/会话行/usage_ledger）、Electron 桌面（已有）。

**Spec:** `docs/superpowers/specs/2026-08-31-workspace-phase2-design.md`

## Global Constraints

- 硬规则不动摇：先落盘再喂模型（落盘与 loop 同进程）；渲染进程只经 ShellBridge；工具只依赖 ExecutionWorld；SessionEvent 变更向后兼容（**只加不改**：新事件类型、旧类型只加可选字段）。
- `CS_PROTOCOL_VERSION = 1`（整数；破坏性变更 +1）。
- relay 房间：控制房 channel = `"cs-ctl"`；会话房 channel = `` `cs-${workspaceId}-${sessionId}` ``。runtime role = `"host"`，成员 role = `"guest"`。
- **事件只定向发给已过 hello 验籍的 cid，永不做房间级广播**（房名可猜，闯入者收不到任何帧）。
- 成员身份：hello 帧带 Supabase JWT，runtime 用 `SUPABASE_JWT_SECRET` 验签；在籍查 `workspace_members`，60s 缓存 + fail-closed。
- 审批超时 10 分钟自动 deny；可批人 = turn 发起人 ∪ workspace owner。
- 沙箱：容器名/卷名 `otto-ws-<workspaceId>`，`Memory 2GiB / NanoCpus 2e9 / PidsLimit 512`，空闲 30 分钟停容器（turn 跑着不停），孤儿标记 7 天后删。
- repo URL/PAT 只落 VPS 磁盘 0600，不进 Supabase；模型 key 只在 VPS env。
- 新增纯逻辑一律进根门禁：测试放 `tests/` 下（vitest include 钉死 `tests/**`），typecheck 加 `-p services/runtime`（gate 命令行 `npm test` 不动——内部收紧是 L2）。
- 群聊上下文发言人标签格式：`[label]: text`，label 取发言时快照存进事件，不随昵称漂移。
- 提交信息写 why；合并一律 merge commit。

---

## 文件结构总览

```
src/shared/remote/cloudSession.ts        cs 帧类型 + 编解码 + 协议版本（四端共用：runtime/桌面/手机/edge 不需）
src/session/events.ts                    +chat_message +approval_request +model_usage；approval_decision +decidedBy
src/session/deriveMessages.ts            +chat_message 投影（发言人标签）
src/session/persistence.ts（或 shouldPersist 所在文件）  新类型入持久化白名单
src/world/dockerWorld.ts                 DockerWorld（注入 DockerLike，可测）
services/edge/src/edge.ts / worker.ts    runtime 服务身份（relay connect + px 平台路径）
services/runtime/src/                    daemon.ts(装配) sessionService.ts turnCoordinator.ts
                                         approvalRouter.ts membershipCache.ts sandbox.ts
                                         pxTools.ts config.ts jwt 复用 edge 的
services/runtime/tsconfig.json           进 typecheck
services/runtime/sandbox/Dockerfile      otto-sandbox 镜像
services/runtime/checks/smoke.mjs        冒烟
scripts/runtime-deploy.mjs               esbuild bundle + rsync + systemd 重启
deploy/otto-runtime.service              systemd unit
supabase/migrations/0016_cloud_sessions.sql
src/main/cloudSessionClient.ts           桌面侧云会话客户端
src/main/index.ts                        IPC 接线 + 审批走现有 fleet 卡
src/shared/shellBridge.ts / src/preload/index.ts   新方法/通道
src/renderer/src/store.ts                cloud slice
src/renderer/src/lib/workspaceView.ts    cloudSessionRows
src/renderer/src/components/CloudSessionPage.tsx   云会话视图
src/renderer/src/components/WorkspacePage.tsx      SessionsTab 加云会话区
docs/adr/0199-*.md  docs/runtime-vps.md  AGENTS.md 索引  CONTEXT.md 术语
```

依赖顺序：T1/T2/T4 无依赖 → T3（用 T1 常量）→ T5/T6（用 T1/T2 类型）→ T7/T8 → T9（用 T2/T5/T6/T7）→ T10（用 T1/T3/T8/T9）→ T11 → T12（用 T1）→ T13（用 T12）→ T14–T16。

---

### Task 1: cs 帧协议（shared 纯逻辑）

**Files:**
- Create: `src/shared/remote/cloudSession.ts`
- Test: `tests/shared/remote/cloudSession.test.ts`

**Interfaces:**
- Produces: `CS_PROTOCOL_VERSION`、`csCtlChannel()`、`csChannel(workspaceId, sessionId)`、`CsUp`/`CsDown` 联合类型、`encodeCs(msg): string`（base64url）、`decodeCsUp(b64): CsUp | null`、`decodeCsDown(b64): CsDown | null`。后续 T5/T6/T10/T12 全部消费。
- Consumes: `src/shared/remote/wire.ts` 的 `MAX_FRAME_BYTES`；base64url 编解码用 `src/main/remoteBridge.ts` 里 `b64encode`/`b64decode` 的同一来源模块（读 remoteBridge 的 import 行，从那个 shared 模块 import——若它在 `src/main` 下则把这两个纯函数上移/复制到 `src/shared/remote/`，shared 不许碰 node builtin）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/remote/cloudSession.test.ts
import { describe, it, expect } from "vitest";
import {
  CS_PROTOCOL_VERSION, csChannel, csCtlChannel,
  encodeCs, decodeCsUp, decodeCsDown,
} from "../../../src/shared/remote/cloudSession.js";

describe("cs 帧协议", () => {
  it("协议版本是整数 1", () => {
    expect(CS_PROTOCOL_VERSION).toBe(1);
  });
  it("房名生成", () => {
    expect(csCtlChannel()).toBe("cs-ctl");
    expect(csChannel("w1", "s1")).toBe("cs-w1-s1");
  });
  it("up 帧 roundtrip + 未知形状回 null", () => {
    const hello = { t: "hello" as const, v: 1, jwt: "j" };
    expect(decodeCsUp(encodeCs(hello))).toEqual(hello);
    const say = { t: "say" as const, text: "干活", mention: true };
    expect(decodeCsUp(encodeCs(say))).toEqual(say);
    expect(decodeCsUp(encodeCs({ t: "nope" } as never))).toBeNull();
    expect(decodeCsUp("!!!not-b64")).toBeNull();
  });
  it("down 帧 roundtrip", () => {
    const ev = { t: "event" as const, event: { type: "turn_ended", sessionId: "s", seq: 3, ts: 1 } };
    expect(decodeCsDown(encodeCs(ev))).toEqual(ev);
    const denied = { t: "denied" as const, code: "not_member" as const };
    expect(decodeCsDown(encodeCs(denied))).toEqual(denied);
  });
  it("say.text 上限：超 64KiB 拒编码", () => {
    expect(() => encodeCs({ t: "say", text: "x".repeat(65 * 1024), mention: false })).toThrow();
  });
  it("mention 是显式布尔，不做文本猜测", () => {
    const m = decodeCsUp(encodeCs({ t: "say", text: "@Agent 干活", mention: false }));
    expect(m && m.t === "say" && m.mention).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（`npx vitest run tests/shared/remote/cloudSession.test.ts`，期望模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/shared/remote/cloudSession.ts
// cs（cloud session）帧协议——工作区云会话的线上约定（ADR-0199）。
// 与 wire.ts 同纪律：多端共用一份，只有类型 + 纯函数。
// 帧走 relay 的 payload 通道（cid 定向），内容是 base64url(JSON)。
// 事件只发给已过 hello 验籍的 cid——房名可猜，所以不存在房间级广播。

import type { SessionEvent } from "../../session/events.js";

export const CS_PROTOCOL_VERSION = 1;
export const CS_MAX_TEXT_BYTES = 64 * 1024;

export function csCtlChannel(): string { return "cs-ctl"; }
export function csChannel(workspaceId: string, sessionId: string): string {
  return `cs-${workspaceId}-${sessionId}`;
}

export type CsDeniedCode =
  | "bad_jwt" | "not_member" | "version_mismatch" | "not_authorized" | "no_session";

/** 成员 → runtime */
export type CsUp =
  | { t: "hello"; v: number; jwt: string }
  | { t: "create"; workspaceId: string }              // 只在控制房用
  | { t: "say"; text: string; mention: boolean }
  | { t: "backlog"; afterSeq: number }
  | { t: "approve"; callId: string; decision: "approved" | "denied" }
  | { t: "config"; repoUrl: string; pat?: string }    // owner only
  | { t: "archive" };

/** runtime → 成员 */
export type CsDown =
  | { t: "welcome"; v: number; sessionId: string; lastSeq: number;
      initiatorUid: string | null; ownerUid: string }
  | { t: "created"; workspaceId: string; sessionId: string; channel: string }
  | { t: "denied"; code: CsDeniedCode }
  | { t: "event"; event: SessionEvent }
  | { t: "backlog"; events: SessionEvent[]; done: boolean }
  | { t: "error"; msg: string };
```

编解码：`encodeCs(msg: CsUp | CsDown): string` = `JSON.stringify` → UTF-8 → base64url；`say` 且 `text` 字节数超 `CS_MAX_TEXT_BYTES` 时 throw。`decodeCsUp` / `decodeCsDown`：base64url → JSON（try/catch 回 null）→ 按 `t` 字段逐变体验形（字段类型逐个查，多余键容忍、缺键/错型回 null）；`decodeCsUp` 只认 up 变体、`decodeCsDown` 只认 down 变体。base64url 助手若现有实现在 `src/main` 下，把纯函数版放进本文件（`btoa`/`Buffer` 都不许——shared 层用 `Uint8Array` + 手写 base64url 或从 `src/shared/remote/` 现有模块 import）。

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit**（`feat(cs): 云会话帧协议——四端共用的类型与编解码（ADR-0199）`）

---

### Task 2: SessionEvent 扩展 + deriveMessages 投影

**Files:**
- Modify: `src/session/events.ts`（union 尾部追加）
- Modify: `src/session/deriveMessages.ts`
- Modify: 持久化白名单（`shouldPersist` 所在文件，`src/session/store.ts:154` 的调用处可定位）
- Test: `tests/session/cloudEvents.test.ts`

**Interfaces:**
- Produces（后续 T5/T6/T9/T13 消费）：

```ts
export interface ChatMessageEvent extends SessionEventBase {
  type: "chat_message";
  fromUid: string;
  label: string;        // 发言时快照
  content: string;
  mention: boolean;
}
export interface ApprovalRequestEvent extends SessionEventBase {
  type: "approval_request";
  callId: string;
  toolName: string;
  argsSummary: string;      // 预览文本，非完整 args
  initiatorUid: string;
  expiresTs: number;
}
export interface ModelUsageEvent extends SessionEventBase {
  type: "model_usage";
  ignorable: true;
  uid: string;              // turn 发起人
  workspaceId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}
// ApprovalDecisionEvent 加可选字段：decidedBy?: { uid: string; label: string }
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/session/cloudEvents.test.ts
import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ sessionId: "s", seq, ts: seq });

describe("云会话事件投影", () => {
  it("chat_message 投成带发言人标签的 user 消息", () => {
    const log = [
      { ...base(1), type: "session_created", workspace: "/w" },
      { ...base(2), type: "user_message", content: "[stan]: 开工" },
      { ...base(3), type: "chat_message", fromUid: "u2", label: "herz", content: "注意别动 main", mention: false },
      { ...base(4), type: "assistant_message", content: "好" },
    ] as unknown as SessionEvent[];
    const msgs = deriveMessages(log);
    const texts = msgs.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "");
    expect(texts).toContain("[herz]: 注意别动 main");
  });
  it("model_usage 与 approval_request 不进模型上下文", () => {
    const log = [
      { ...base(1), type: "session_created", workspace: "/w" },
      { ...base(2), type: "user_message", content: "hi" },
      { ...base(3), type: "model_usage", ignorable: true, uid: "u", workspaceId: "w", model: "m", promptTokens: 1, completionTokens: 2 },
      { ...base(4), type: "approval_request", callId: "c1", toolName: "bash", argsSummary: "rm x", initiatorUid: "u", expiresTs: 99 },
    ] as unknown as SessionEvent[];
    const msgs = deriveMessages(log);
    expect(JSON.stringify(msgs)).not.toContain("model_usage");
    expect(JSON.stringify(msgs)).not.toContain("rm x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（tsc 或运行时先红——新类型没进 union 时 `as unknown as` 能过编译，红在投影断言）
- [ ] **Step 3: 实现**：events.ts 按上面接口块追加三个 interface 进 union 尾部（**不动既有成员**）；`ApprovalDecisionEvent` 加 `decidedBy?`；deriveMessages 在 `:427` 附近的 switch 里加 `case "chat_message"`（复用 `pendingToolIds.size > 0 ? deferredUsers : messages` 的分流，push `{ role: "user", content: \`[${event.label}]: ${event.content}\` }`）；确认 `model_usage`/`approval_request` 落到既有 default/忽略分支（没有 default 忽略就显式加空 case）。`shouldPersist` 白名单加三个新类型。
- [ ] **Step 4: 跑测试 + `npx vitest run tests/session/` 全绿**（老投影测试不许红——向后兼容的可执行体现）
- [ ] **Step 5: Commit**（`feat(session): 群聊三事件入 schema——chat_message/approval_request/model_usage（向后兼容，只加不改）`）

---

### Task 3: edge 的 runtime 服务身份

**Files:**
- Modify: `services/edge/src/edge.ts`（identify + px 路由）
- Modify: `services/edge/src/worker.ts`（Env 加 `RUNTIME_SECRET`）
- Test: `tests/edge/runtimeAuth.test.ts`
- Modify: `services/edge/checks/relay.mjs`（+2 断言）

**Interfaces:**
- Consumes: `edge.ts:73 identify()`、`:97 roomKey`、`:110 pxIdentify`、`:153 /px/v1/call`。
- Produces: relay connect 时子协议 token === `env.RUNTIME_SECRET` → `who = { userId: "svc-runtime" }`（跳过 JWT 验签、豁免 `MAX_CONNS_PER_USER` 计数）；`/px/v1/call` 与 `/px/v1/grants` 接受 header `x-runtime-secret`，命中后 `fromUid` 取自 body/query 的显式声明（缺 fromUid → 400），**三道闸照跑**（friendChecker / workspaceOk / 白名单一个不少）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/edge/runtimeAuth.test.ts —— 模式照抄 tests/edge/pxRoutes.test.ts 的假 env/假 fetch 搭法
import { describe, it, expect } from "vitest";
// 断言四件事：
// 1. connect 子协议 token = RUNTIME_SECRET → identify 通过，userId === "svc-runtime"
// 2. connect 子协议 token = 错 secret → 401（不回落 JWT 分支的错误信息，防 oracle）
// 3. POST /px/v1/call 带 x-runtime-secret + body.fromUid → 转发给 Escrow DO 的载荷里 fromUid = 声明值
// 4. POST /px/v1/call 带 x-runtime-secret 但缺 body.fromUid → 400
```

（具体测试实现：先读 `tests/edge/pxRoutes.test.ts` 与 `tests/edge/edge.test.ts` 现有的构造方式——假 `Env`、直接调用导出的路由函数或 `fetch` handler——用同一套；四条断言如上，写成四个 `it`。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：`identify()` 顶部加分支——token 与 `config.runtimeSecret` 恒时比较（长度不同直接 false；用逐字节比较函数，不用 `===` 之外还要 timing-safe 的库——Worker 里手写 XOR 累积即可）命中回 `{ userId: "svc-runtime" }`；`pxIdentify` 同理加 header 分支。`worker.ts` Env 声明 `RUNTIME_SECRET: string`，接线进 config。`MAX_CONNS_PER_USER` 计数处（找到引用点）对 `"svc-runtime"` 跳过。
- [ ] **Step 4: 跑 `npm test`（root，含 `tsc -p services/edge`）绿**
- [ ] **Step 5: checks/relay.mjs 尾部加段落 `// ---- runtime 服务身份 ----`**：`RUNTIME_SECRET` env 存在时才跑（没配就 skip 并打印提示）——① 用 secret 连 relay 成功收到 `:cid`；② 不带 secret 的普通 JWT 用户 POST /px/v1/call 伪造 `x-runtime-secret: wrong` → 401/403。
- [ ] **Step 6: Commit**（`feat(edge): runtime 服务身份——relay 直连 + px 平台路径，三道闸不减（ADR-0199）`）

---

### Task 4: migration 0016（cloud 会话行 + usage_ledger）

**Files:**
- Create: `supabase/migrations/0016_cloud_sessions.sql`
- Test: `tests/docs/` 无需；SQL 靠 review + 上库前人工过目（一期同款流程）

- [ ] **Step 1: 写 SQL**

```sql
-- 0016：云会话行 + 用量台账（ADR-0199，二期）
-- workspace_sessions 一表两用：kind='package'（一期发布包，存量默认）/ 'cloud'（云会话）。
-- 云会话没有 pkg_id，所以放开非空，用 check 钉住「package 必有 pkg_id」。

alter table public.workspace_sessions
  add column kind text not null default 'package' check (kind in ('package', 'cloud')),
  add column archived boolean not null default false;

alter table public.workspace_sessions alter column pkg_id drop not null;
alter table public.workspace_sessions
  add constraint ws_sessions_pkg_shape check (kind <> 'package' or pkg_id is not null);

-- 云会话行由 runtime 用 service key 写（绕 RLS）；成员读走既有 select 策略（在籍可见）。
-- 现有 insert/delete 策略只约束 authed 用户，service key 不受限，无需新策略。

-- 用量台账：runtime 异步镜像写（service key），本人只读自己的行。
create table public.usage_ledger (
  id bigint generated always as identity primary key,
  uid uuid not null,
  workspace_id uuid not null,
  session_id text not null,
  model text not null,
  prompt_tokens integer not null,
  completion_tokens integer not null,
  ts timestamptz not null default now()
);
create index usage_ledger_uid_ts on public.usage_ledger (uid, ts);
alter table public.usage_ledger enable row level security;
create policy usage_select_self on public.usage_ledger
  for select using (uid = auth.uid());
-- 故意不建 insert/update/delete 策略：authed 用户全拒，只有 service key 可写。
```

- [ ] **Step 2: 本地过一遍语法**（`psql` 不在门禁里；靠实现者读三遍 + task review；上生产库是合并后的部署步骤，不在本任务内）
- [ ] **Step 3: 确认一期查询不炸**：`grep -rn "workspace_sessions" src/ services/` 逐处看——`fetchWorkspace` 的 select 列了具体列还是 `*`？若按列取则不受影响；`sessionRows`（`workspaceView.ts:96`）现在只喂 package 行——**在 `fetchWorkspace` 的查询上加 `kind = 'package'` 过滤**（云会话列表走 T12 的新查询），否则云会话行会以「可导入包」的样子混进一期 UI。
- [ ] **Step 4: Commit**（`feat(db): workspace_sessions 分 kind + usage_ledger（ADR-0199；一期查询钉在 kind='package'）`）

---

### Task 5: runtime 纯逻辑——turnCoordinator

**Files:**
- Create: `services/runtime/src/turnCoordinator.ts`
- Test: `tests/runtime/turnCoordinator.test.ts`

**Interfaces:**
- Produces（T9/T10 消费）：

```ts
export type ChatDecision = "start_turn" | "logged_only";
export interface TurnCoordinator {
  /** 一条已落盘的成员发言进来，决定它是否点火。turn 跑着时永远 logged_only（注入靠投影层）。 */
  onChat(mention: boolean): ChatDecision;
  turnStarted(): void;      // daemon 真正起跑后回报
  turnEnded(): void;
  isRunning(): boolean;
}
export function createTurnCoordinator(): TurnCoordinator;
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/runtime/turnCoordinator.test.ts
import { describe, it, expect } from "vitest";
import { createTurnCoordinator } from "../../services/runtime/src/turnCoordinator.js";

describe("turn 协调器", () => {
  it("mention 且空闲 → start_turn", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
  });
  it("非 mention 永远只落日志", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(false)).toBe("logged_only");
  });
  it("turn 跑着时 mention 不排队、不点火——注入语义", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
    c.turnStarted();
    expect(c.onChat(true)).toBe("logged_only");   // 没有隐形队列
    expect(c.isRunning()).toBe(true);
    c.turnEnded();
    expect(c.onChat(true)).toBe("start_turn");    // 结束后可再点火
  });
  it("onChat 回 start_turn 后、turnStarted 前，第二条 mention 也不重复点火", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
    expect(c.onChat(true)).toBe("logged_only");   // start 已被认领，装配层保证随后 turnStarted
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**（一个状态机三态：idle / claimed / running；`onChat(true)` 在 idle 时转 claimed 并回 `start_turn`，其余一律 `logged_only`；`turnStarted` claimed→running；`turnEnded` →idle）→ **Step 4: 测试绿** → **Step 5: Commit**（`feat(runtime): turn 协调器——@触发、单 turn 互斥、无隐形队列（ADR-0199）`）

---

### Task 6: runtime 纯逻辑——approvalRouter + membershipCache

**Files:**
- Create: `services/runtime/src/approvalRouter.ts`、`services/runtime/src/membershipCache.ts`
- Test: `tests/runtime/approvalRouter.test.ts`、`tests/runtime/membershipCache.test.ts`

**Interfaces:**
- Consumes: `Approver`/`ApprovalOutcome`（`src/loop/approvalGate.ts:11,:28`）、`ToolCallRequest`、`Tool`。
- Produces（T9 消费）：

```ts
// approvalRouter.ts
export interface ApprovalRouterOpts {
  ownerUid: string;
  timeoutMs?: number;                       // 默认 600_000
  now?: () => number;
  onRequest: (req: { callId: string; toolName: string; argsSummary: string;
                     initiatorUid: string; expiresTs: number }) => void;  // daemon 拿去落盘+广播
}
export interface ApprovalRouter extends Approver {
  setInitiator(uid: string): void;          // 每条 turn 起跑前设
  /** cs approve 帧进来。回 false = 无此 pending 或无权（daemon 只回 error 帧，不落盘） */
  resolve(callId: string, byUid: string, decision: "approved" | "denied"): boolean;
  canDecide(uid: string): boolean;          // uid === initiator || uid === owner
}
export function createApprovalRouter(opts: ApprovalRouterOpts): ApprovalRouter;

// membershipCache.ts
export interface MembershipCache {
  /** fail-closed：查询抛错→false；60s 内命中缓存 */
  isMember(workspaceId: string, uid: string): Promise<boolean>;
  invalidate(workspaceId: string): void;
}
export function createMembershipCache(
  query: (workspaceId: string) => Promise<Set<string>>,   // 抛错 = 拿不到
  opts?: { ttlMs?: number; now?: () => number }
): MembershipCache;
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/runtime/approvalRouter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createApprovalRouter } from "../../services/runtime/src/approvalRouter.js";
const call = { id: "c1", name: "bash", args: { cmd: "rm -rf x" } } as never;
const tool = { def: { name: "bash", description: "", parameters: {} }, requiresApproval: true, run: async () => "" } as never;

describe("审批路由", () => {
  it("decide 挂起 → 发起人 resolve approved → outcome 回 approved 且记 decidedBy 语义由调用方落盘", async () => {
    const reqs: unknown[] = [];
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: (q) => reqs.push(q) });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(reqs).toHaveLength(1);
    expect(r.resolve("c1", "alice", "approved")).toBe(true);
    await expect(p).resolves.toMatchObject({ decision: "approved" });
  });
  it("owner 可代批；无关成员 resolve 回 false 且不消化 pending", async () => {
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(r.resolve("c1", "mallory", "approved")).toBe(false);
    expect(r.resolve("c1", "owner", "denied")).toBe(true);
    await expect(p).resolves.toMatchObject({ decision: "denied" });
  });
  it("超时自动 deny", async () => {
    vi.useFakeTimers();
    const r = createApprovalRouter({ ownerUid: "o", timeoutMs: 1000, onRequest: () => {} });
    r.setInitiator("a");
    const p = r.decide(call, tool);
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toMatchObject({ decision: "denied" });
    vi.useRealTimers();
  });
});
```

```ts
// tests/runtime/membershipCache.test.ts
import { describe, it, expect } from "vitest";
import { createMembershipCache } from "../../services/runtime/src/membershipCache.js";

describe("在籍缓存", () => {
  it("60s 内命中缓存，只打一次查询", async () => {
    let calls = 0;
    let t = 0;
    const c = createMembershipCache(async () => { calls++; return new Set(["u1"]); }, { now: () => t });
    expect(await c.isMember("w", "u1")).toBe(true);
    expect(await c.isMember("w", "u2")).toBe(false);
    expect(calls).toBe(1);
    t = 61_000;
    await c.isMember("w", "u1");
    expect(calls).toBe(2);
  });
  it("查询抛错 fail-closed 且不污染缓存", async () => {
    let fail = true;
    const c = createMembershipCache(async () => { if (fail) throw new Error("db down"); return new Set(["u1"]); });
    expect(await c.isMember("w", "u1")).toBe(false);
    fail = false;
    expect(await c.isMember("w", "u1")).toBe(true);   // 错误不占 60s 缓存位
  });
  it("invalidate 立即失效", async () => {
    let members = new Set(["u1"]);
    const c = createMembershipCache(async () => members);
    await c.isMember("w", "u1");
    members = new Set<string>();
    c.invalidate("w");
    expect(await c.isMember("w", "u1")).toBe(false);
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（approvalRouter：`pending: Map<callId, { resolve, timer, initiatorUid }>`；`decide` 建 pending + `onRequest` + 定时器 deny；`argsSummary` = `JSON.stringify(call.args).slice(0, 200)`。membershipCache：`Map<workspaceId, { at, members }>`，错误路径不写缓存）→ **Step 4: 绿** → **Step 5: Commit**（`feat(runtime): 审批路由与在籍缓存——发起人+owner、超时 deny、fail-closed（ADR-0199）`）

---

### Task 7: DockerWorld

**Files:**
- Create: `src/world/dockerWorld.ts`
- Test: `tests/world/dockerWorld.test.ts`
- Modify: `package.json`（dependencies + `dockerode`、devDependencies + `@types/dockerode`）

**Interfaces:**
- Consumes: `ExecutionWorld`/`ExecResult`/`ExecOptions`（`src/world/executionWorld.ts:280,:13,:27`）。
- Produces（T9 消费）：

```ts
/** dockerode 的最小可注入面——测试给假货，生产给 new Docker() 的容器句柄 */
export interface ContainerLike {
  exec(opts: {
    Cmd: string[]; AttachStdout: boolean; AttachStderr: boolean;
    AttachStdin?: boolean; WorkingDir?: string;
  }): Promise<{
    start(opts: { hijack?: boolean; stdin?: boolean }): Promise<NodeJS.ReadWriteStream>;
    inspect(): Promise<{ ExitCode: number | null }>;
  }>;
  modem: { demuxStream(stream: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream): void };
}
export function createDockerWorld(opts: {
  container: () => Promise<ContainerLike>;   // 惰性取——T8 的 ensureContainer 喂进来
  fetchImpl?: typeof fetch;
}): ExecutionWorld;
```

行为契约：
- `exec(cmd, opts)`：`Cmd = ["/bin/bash", "-lc", cmd]`，`WorkingDir = "/work"`；`opts.timeoutMs`（默认 30_000，与 LocalWorld 同）用 coreutils 包裹实现——`Cmd = ["/usr/bin/timeout", "-k", "5", String(Math.ceil(ms/1000)), "/bin/bash", "-lc", cmd]`（docker exec 杀不掉已启动的 exec，timeout 是容器内自杀；ceiling 写进文件头注释）。退出码 124 = 超时，`ExecResult` 里 stderr 追加一行「命令超时」。`onOutput` 接 demux 两路。
- `fs.read(path)`：`exec` 跑 `cat -- <shellQuote(path)>`，exitCode 非 0 抛 stderr；`fs.write(path, content)`：exec `AttachStdin` + `Cmd ["/bin/bash","-lc", "mkdir -p -- \"$(dirname -- " + q + ")\" && cat > " + q]`，stream 写入 content 后 end。路径一律相对 `/work` 解析，`path.posix` 归一后含 `..` 逃出 `/work` 的抛「路径越出沙箱」（容器是硬边界，这层是礼貌报错不是安全边界——注释说明）。
- `http`：宿主侧 `fetchImpl ?? fetch` 直发（与 LocalWorld 同款）。
- 不实现 `execDetached`/`openTerminal`/其余可选能力（YAGNI，bash 工具在无 `background` 参数时不需要）。
- shellQuote：单引号包裹 + `'\''` 转义，放本文件内私有函数。

- [ ] **Step 1: 写失败测试**：假 `ContainerLike` 记录 exec 调用参数、回放脚本化 stdout/stderr/exitCode。断言：① `exec("echo hi")` 的 Cmd 形状（timeout 包裹 + bash -lc）与 WorkingDir=/work；② exitCode 124 → stderr 带「命令超时」；③ `fs.write("a/b.txt", "x")` 的 Cmd 含 mkdir -p 且 stdin 收到 "x"；④ `fs.read("../etc/passwd")` 抛「路径越出沙箱」；⑤ `onOutput` 收到 demux 的分路 chunk。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 绿；另跑 `npx vitest run tests/architecture.test.ts` 绿**（world 层允许依赖 dockerode；`src/tools` 规则不受影响）→ **Step 5: Commit**（`feat(world): DockerWorld——工具进容器执行，key 留宿主（ADR-0199）`）

---

### Task 8: 沙箱编排 sandbox.ts

**Files:**
- Create: `services/runtime/src/sandbox.ts`
- Test: `tests/runtime/sandbox.test.ts`

**Interfaces:**
- Produces（T9/T10 消费）：

```ts
/** dockerode 顶层句柄的最小注入面 */
export interface DockerLike {
  listContainers(opts: { all: boolean; filters: string }): Promise<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }[]>;
  getContainer(id: string): {
    start(): Promise<void>; stop(): Promise<void>; remove(opts: { force: boolean }): Promise<void>;
    update(opts: Record<string, unknown>): Promise<void>;
  } & import("../../../src/world/dockerWorld.js").ContainerLike;
  createContainer(opts: Record<string, unknown>): Promise<{ id: string }>;
  listVolumes(opts: { filters: string }): Promise<{ Volumes: { Name: string; Labels: Record<string, string> | null }[] }>;
  getVolume(name: string): { remove(): Promise<void> };
}
export interface Sandbox {
  ensure(workspaceId: string): Promise<import("../../../src/world/dockerWorld.js").ContainerLike>;
  markActive(workspaceId: string): void;          // 每条 turn 起跑时打点
  sweepIdle(runningWorkspaces: ReadonlySet<string>): Promise<string[]>;   // 停掉的 id 列表；跑着 turn 的不停
  reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }>;
  destroy(workspaceId: string): Promise<void>;    // 容器+卷一起删（工作区删除级联）
}
export function createSandbox(docker: DockerLike, opts?: { image?: string; idleMs?: number; orphanGraceMs?: number; now?: () => number }): Sandbox;
```

行为契约：容器名/卷名 `otto-ws-<id>`；create 参数 `Image: "otto-sandbox"`, `Cmd: ["sleep", "infinity"]`, `Labels: { "mrotto.workspace": id }`, `HostConfig: { Memory: 2 * 1024 ** 3, NanoCpus: 2e9, PidsLimit: 512, Mounts: [{ Type: "volume", Source: "otto-ws-<id>", Target: "/work" }] }`；`ensure` = list by name → 没有则 create、stopped 则 start；`sweepIdle`：`now - lastActive > idleMs(默认 30min)` 且不在 `runningWorkspaces` → stop；`reconcile`：label 扫描，`mrotto.workspace` 不在 validIds → 给容器补 label 做不到（docker 不可改 label）→ 记进内存 + 落 `/var/lib/otto-runtime/orphans.json`（`{ [id]: markedTs }`），超 `orphanGraceMs`（默认 7 天）→ remove force + 卷 remove。

- [ ] **Step 1: 写失败测试**（假 DockerLike 记录调用）：① ensure 不存在 → createContainer 参数全形状断言（上面那份逐字段）+ start；② ensure 已停 → 只 start 不 create；③ sweepIdle 尊重 runningWorkspaces；④ reconcile 首见孤儿只标记不删、越过 grace 后 remove(force)+卷删；⑤ destroy 容器与卷都删。orphans.json 的读写用注入的 `{ load(): Record<string,number>; save(m): void }` 存取器（测试给内存假货，daemon 给文件版）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 绿** → **Step 5: Commit**（`feat(runtime): 沙箱编排——每工作区一容器一卷、闲停、孤儿七天回收（ADR-0199）`）

---

### Task 9: runtime 会话服务（engine 装配 + px 工具桥 + usage）

**Files:**
- Create: `services/runtime/src/sessionService.ts`、`services/runtime/src/pxTools.ts`
- Test: `tests/runtime/sessionService.test.ts`、`tests/runtime/pxTools.test.ts`

**Interfaces:**
- Consumes: `EventStore`（`src/session/store.ts:124`）、`LoopEngine`（`src/loop/engine.ts:39`，`runTurn:528`）、`createOpenAICompatibleAdapter`（`src/model/openaiCompatible.ts:259`）、`readFileTool/writeFileTool/bashTool`、T5/T6/T7 产物、T2 事件类型。
- Produces（T10 消费）：

```ts
// pxTools.ts —— 把 edge 的 grantedView 变成 Tool 列表
export interface PxCallDeps {
  edgeBase: string;                       // https://edge.mrotto.agency
  runtimeSecret: string;
  fetchImpl?: typeof fetch;
}
export async function fetchGrantedTools(deps: PxCallDeps, fromUid: string, workspaceId: string):
  Promise<{ hostUid: string; serverId: string; toolDefs: { name: string; description: string; inputSchema: unknown }[] }[]>;
export function buildPxTools(deps: PxCallDeps, fromUid: string,
  granted: Awaited<ReturnType<typeof fetchGrantedTools>>): Tool[];
// 工具名带 host 前缀（同 proxyNamespace 口径：uid 短前缀不昵称）；requiresApproval: false
// （白名单内没有逐次审批，ADR-0151 口径）；run = POST /px/v1/call
// { headers: { "x-runtime-secret": secret }, body: { fromUid, hostUid, serverId, tool, args } }，
// 结果 content 数组压成文本（text 项拼接，其余项 JSON.stringify）。

// sessionService.ts —— 一条云会话的运行时
export interface CloudSessionOpts {
  workspaceId: string; sessionId: string; ownerUid: string;
  store: EventStore;                       // daemon 按工作区开
  world: ExecutionWorld;                   // DockerWorld
  adapter: ModelAdapter;                   // daemon 用 env 造好并包 usage
  px: PxCallDeps;
  onEvent: (e: SessionEvent) => void;      // daemon 拿去定向广播
  onUsage: (u: { uid: string; model: string; promptTokens: number; completionTokens: number }) => void;
}
export interface CloudSession {
  /** 一条已验籍成员发言。落盘 + 按协调器决定是否起 turn；起了则 turn 结束后 resolve */
  say(fromUid: string, label: string, text: string, mention: boolean): Promise<void>;
  approve(callId: string, byUid: string, byLabel: string, decision: "approved" | "denied"): boolean;
  backlog(afterSeq: number): SessionEvent[];
  isRunning(): boolean;
  lastSeq(): number;
  initiatorUid(): string | null;
}
export function createCloudSession(opts: CloudSessionOpts): CloudSession;
```

装配细节（sessionService 内）：
- engine 每会话一台：`new LoopEngine({ store, adapter, world, sessionId, tools: () => [readFileTool, writeFileTool, bashTool, ...cachedPxTools], approver: router, onEvent: opts.onEvent, middlewares: [] })`。approvalGate 由 engine 内部装（同桌面路径——确认 engine 构造里 approver 进 `createApprovalGate`；若 engine 不自动装，则 `middlewares: [createApprovalGate({ approver: router, onDecision })]`，以现场代码为准，测试兜行为）。
- `say`：mention=true 且协调器回 `start_turn` → `router.setInitiator(fromUid)`；turn 起跑前 `cachedPxTools = buildPxTools(...await fetchGrantedTools(px, fromUid, workspaceId))`（**每 turn 现拉**，授权变更下一 turn 生效）；`engine.runTurn(\`[${label}]: ${text}\`)`。mention=false 或 turn 已跑 → `store.append({ type: "chat_message", ... })` + `onEvent`。
- `approve`：`router.resolve` 通过后 append `approval_decision`（带 `decidedBy: { uid, label }`）——查 approvalGate 的 `onDecision` 是否已落这型事件，避免双写：**约定 router 的 resolve 只回内存 promise，落盘统一走 approvalGate 的 onDecision 回调**，`decidedBy` 经 router 暂存喂给 onDecision。
- usage：`onUsage` 由 daemon 包 adapter 触发（T10），sessionService 不管。
- `approval_request` 落盘：router 的 `onRequest` 回调里 `store.append({ type: "approval_request", ... })` + `onEvent`。

- [ ] **Step 1: 写失败测试**（关键三条，全用内存假货）：

```ts
// tests/runtime/sessionService.test.ts —— 假 adapter 脚本化（spike 同款），EventStore 开在 os.tmpdir()
// ① 完整 turn：say(mention) → 日志顺序含 user_message(带 [label]: 前缀) → assistant_message → turn_ended，
//    onEvent 每条都到。
// ② 中途注入：脚本 adapter 两轮（第一轮回 toolCall read_file，第二轮收尾）；第一轮 chat() 被调后
//    session.say("u2","herz","补充信息", false)；断言第二轮 chat() 的 messages 里含 "[herz]: 补充信息"。
//    ——engine 若每轮重投影则天然通过；若不通过，本任务需给 engine 加「每轮从 store 重新 load+derive」
//    的最小改动（改动点在 engine.ts:636 附近取 log 的那一步），并保持桌面既有测试全绿。
// ③ 审批链：脚本 adapter 回 bash toolCall → approval_request 事件出现 → approve(callId, ownerUid, ...)
//    → 日志出现 approval_decision(decidedBy.uid=ownerUid) → 工具执行 → turn 完成。
//    world 用假 ExecutionWorld（exec 回固定输出）。
```

```ts
// tests/runtime/pxTools.test.ts —— 假 fetchImpl
// ① fetchGrantedTools 打 GET {edgeBase}/px/v1/grants?fromUid=..&workspaceId=.. 且带 x-runtime-secret 头
// ② buildPxTools 工具名 = `px_${hostUid.slice(0,8)}_${serverId}_${toolName}` 过 safe 化（[a-zA-Z0-9_-]），
//    requiresApproval === false
// ③ run() POST /px/v1/call 载荷形状 { fromUid, hostUid, serverId, tool, args }；
//    content [{type:"text",text:"a"},{type:"json",data:1}] → "a\n{\"type\":\"json\",\"data\":1}"
// ④ 调用回 4xx → run 抛错（错误进 tool_result，不吞）
```

（注：`/px/v1/grants` 现有形状按 fromUid 查整份 grantedView；平台路径带 `workspaceId` 过滤参数——T3 已开的口子若无此参数，则在 pxTools 里客户端过滤 `workspaceId` 来源的授权。以 T3 实现为准，测试跟着真形状写。）

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: `npx vitest run tests/runtime/ tests/session/ tests/loop/` 全绿**（engine 若被改，桌面测试是回归网）→ **Step 5: Commit**（`feat(runtime): 云会话服务——engine 装配、px 工具桥、注入与审批闭环（ADR-0199）`）

---

### Task 10: runtime daemon 装配 + tsconfig 入门禁

**Files:**
- Create: `services/runtime/src/daemon.ts`、`services/runtime/src/config.ts`、`services/runtime/src/frameHandler.ts`、`services/runtime/tsconfig.json`
- Modify: `package.json`（typecheck 加 `&& tsc --noEmit -p services/runtime`）
- Test: `tests/runtime/frameHandler.test.ts`

**Interfaces:**
- Consumes: T1 帧、T3 的 relay 身份、T5–T9 全部、`createWsTransport`（`src/shared/remote/wsTransport.ts:65`）、`verifyJwt`（`services/edge/src/jwt.ts`，相对路径 import——纯函数，两个 tsconfig 各编各的）、`@supabase/supabase-js`（service key client，查 `workspace_members` 与写 `workspace_sessions`/`usage_ledger`）。
- Produces: 可跑的 daemon；`frameHandler` 是纯逻辑核心（T11 冒烟直接驱动它）。

```ts
// frameHandler.ts —— cid 世界的纯协调层：不碰网络，daemon 只做「transport ↔ 它」的搬运
export interface FrameHandlerDeps {
  verifyJwt: (token: string) => { userId: string } | null;
  isMember: (workspaceId: string, uid: string) => Promise<boolean>;
  labelOf: (uid: string) => Promise<string>;                  // profiles 查询，查不到回 uid.slice(0,8)
  sessions: {
    get(workspaceId: string, sessionId: string): CloudSession | null;
    create(workspaceId: string, byUid: string): Promise<{ sessionId: string }>;
    ownerOf(workspaceId: string): Promise<string>;
  };
  saveConfig: (workspaceId: string, cfg: { repoUrl: string; pat?: string }) => Promise<void>;
  send: (cid: string, msg: CsDown) => void;
}
export interface FrameHandler {
  /** 控制房帧（create 流程） */
  onCtlFrame(cid: string, raw: string): Promise<void>;
  /** 会话房帧。房间身份 = (workspaceId, sessionId) 由 daemon 按 transport 归属传入 */
  onSessionFrame(workspaceId: string, sessionId: string, cid: string, raw: string): Promise<void>;
  onGone(cid: string): void;
}
export function createFrameHandler(deps: FrameHandlerDeps): FrameHandler;
```

行为契约（frameHandler）：
- 未过 hello 的 cid：除 `hello` 外一律回 `denied not_authorized` 并忽略。hello：decode 失败静默丢；`v !== CS_PROTOCOL_VERSION` → `denied version_mismatch`；JWT 验签失败 → `denied bad_jwt`；非在籍 → `denied not_member`；通过 → 记 `cid → { uid, label }`，回 `welcome`（lastSeq、initiatorUid、ownerUid）。
- `say`/`backlog`/`approve`/`archive` 需已 hello；`config` 额外要求 uid === owner（否则 `denied not_authorized`）。
- `approve` 经 `CloudSession.approve`，回 false 时 `error` 帧。
- 事件扇出：daemon 把 `CloudSession.onEvent` 接到「向本会话房所有已验籍 cid 逐个 `send(cid, {t:"event",...})`」。
- `onGone` 清 cid 表。

daemon.ts（装配层，不进单测、靠 T11 冒烟）：
- `config.ts` 读 env：`RUNTIME_SECRET`、`SUPABASE_JWT_SECRET`、`SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、`EDGE_BASE`、`RELAY_BASE`、`MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_ID`、`DATA_DIR`（默认 `/var/lib/otto-runtime`）。缺任何一个 → 启动即 exit(1) 并列出缺哪几个。
- adapter：`createOpenAICompatibleAdapter({ baseUrl, apiKey, model })` 外包 usage 钩子：

```ts
function withUsage(adapter: ModelAdapter, onUsage: (u: TokenUsage, model: string) => void): ModelAdapter {
  return { ...adapter, chat: async (m, t, d, s) => {
    const r = await adapter.chat(m, t, d, s);
    if (r.usage) onUsage(r.usage, adapter.model);
    return r;
  } };
}
```

  `onUsage` → `store.append({ type: "model_usage", uid: 当前 turn 发起人, ... })` + fire-and-forget insert `usage_ledger`（失败仅 console.warn——日志里有权威记录）。
- transport：控制房一条 `createWsTransport({ baseUrl: RELAY_BASE, role: "host", channel: csCtlChannel(), authToken: async () => RUNTIME_SECRET })`；每活跃会话一条同款（channel = csChannel(...)）。重连内置（wsTransport 自带）。
- 会话创建：`create` → sessionId = `crypto.randomUUID()` → 开会话房 transport → `workspace_sessions` insert（service key，`kind:'cloud'`、`publisher_uid: byUid`、`title: ''`、`pkg_id: null`）→ 回 `created`。
- 沙箱：T8 `ensure(workspaceId)` 在会话创建与每 turn 起跑时调用；`setInterval(5min)` 跑 `sweepIdle(跑着 turn 的工作区集合)`；启动时 `reconcile`。
- `tsconfig.json`：`extends` 根配置、`include: ["src/**/*", "../edge/src/jwt.ts", "../../src/loop/**/*", "../../src/session/**/*", "../../src/model/**/*", "../../src/tools/**/*", "../../src/world/**/*", "../../src/shared/**/*"]`、`compilerOptions.noEmit: true`。以 `services/edge/tsconfig.json` 为模板。

- [ ] **Step 1: 写失败测试**（frameHandler，全假 deps）：① 未 hello 先 say → `denied not_authorized`；② hello 全链路四种拒绝码各一条断言 + 成功路径 welcome 形状；③ config 非 owner 拒、owner 过且 `saveConfig` 收到 pat；④ say 落到 `sessions.get(...).say` 且带 label；⑤ onGone 后同 cid 再 say 回 not_authorized。
- [ ] **Step 2: 确认失败** → **Step 3: 实现 frameHandler + daemon + config + tsconfig，改 package.json typecheck** → **Step 4: `npm test` 全绿（root，现在含 runtime 的 tsc）** → **Step 5: Commit**（`feat(runtime): daemon 装配——帧协调、usage 记账、typecheck 纳管（ADR-0199）`）

---

### Task 11: 冒烟 check + 部署链 + 沙箱镜像

**Files:**
- Create: `services/runtime/checks/smoke.mjs`、`scripts/runtime-deploy.mjs`、`deploy/otto-runtime.service`、`services/runtime/sandbox/Dockerfile`
- Modify: `package.json`（scripts + `"runtime:deploy": "node scripts/runtime-deploy.mjs"`、devDependencies + `esbuild`）

- [ ] **Step 1: 冒烟脚本**：`node --experimental-strip-types` 或经 tsx 起一个进程内装配——不连真 relay：直接 `createFrameHandler` + 内存 `send` 收集 + 真 `EventStore`（tmpdir）+ 脚本化假 adapter + 假 ExecutionWorld。流程：hello（自签 HS256 JWT，secret 用测试常量）→ create → say(mention) → 断言收到 event 帧序列含 assistant_message 与 turn_ended、backlog(0) 返回全量。exit 0/1。跑法 `node services/runtime/checks/smoke.mjs`（内部 `spawnSync("npx", ["tsx", ...])` 驱动 TS 亦可，照 spike 的 tsx 用法）。
- [ ] **Step 2: Dockerfile**

```dockerfile
# services/runtime/sandbox/Dockerfile —— otto-sandbox：工作区沙箱统一镜像
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ripgrep jq ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 -s /bin/bash otter || true
WORKDIR /work
CMD ["sleep", "infinity"]
```

- [ ] **Step 3: 部署脚本**：esbuild API `build({ entryPoints: ["services/runtime/src/daemon.ts"], bundle: true, platform: "node", target: "node24", format: "esm", outfile: "services/runtime/dist/runtime.mjs", external: ["better-sqlite3", "dockerode"], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })`；然后 `rsync -e "ssh -p 2222"` dist + `services/runtime/deploy-package.json`（只含 better-sqlite3 + dockerode 两个 dep，脚本生成）+ Dockerfile 到 `$RUNTIME_SSH:/opt/otto-runtime/`，远端 `npm install --omit=dev && docker build -t otto-sandbox ./sandbox && sudo systemctl restart otto-runtime`。`RUNTIME_SSH` env 缺失 → 打印用法退出 2。systemd unit：

```ini
# deploy/otto-runtime.service
[Unit]
Description=Mr Otto cloud runtime
After=network-online.target docker.service
[Service]
ExecStart=/usr/bin/node /opt/otto-runtime/runtime.mjs
EnvironmentFile=/etc/otto-runtime.env
Restart=on-failure
RestartSec=5
User=otto
[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: 本地跑冒烟绿 + `npm test` 绿** → **Step 5: Commit**（`feat(runtime): 冒烟、部署链与沙箱镜像——bundle 单文件 + systemd（ADR-0199）`）

---

### Task 12: 桌面主进程云会话客户端 + IPC

**Files:**
- Create: `src/main/cloudSessionClient.ts`
- Modify: `src/shared/shellBridge.ts`（方法 + CHANNELS）、`src/preload/index.ts`、`src/main/index.ts`
- Test: `tests/main/cloudSessionClient.test.ts`

**Interfaces:**
- Consumes: T1 帧、`createWsTransport`、`accountManager.getAccessToken()`（`index.ts:829` 同款）、`pendingApprovals`/`feedIsland`/`handleDecideApproval`（`index.ts:741,:1750,:3850`）。
- Produces（T13 消费）——ShellBridge 新方法（照一期 11 连的写法，`:985` 后追加）：

```ts
workspaceCloudList(workspaceId: string): Promise<FriendsResult<{ id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number }[]>>;
workspaceCloudCreate(workspaceId: string): Promise<FriendsResult<{ sessionId: string }>>;
workspaceCloudJoin(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
workspaceCloudLeave(): Promise<FriendsResult<null>>;               // 断当前云会话连接
workspaceCloudSay(text: string, mention: boolean): Promise<FriendsResult<null>>;
workspaceCloudApprove(callId: string, decision: "approved" | "denied"): Promise<FriendsResult<null>>;
workspaceCloudArchive(): Promise<FriendsResult<null>>;
workspaceCloudConfig(workspaceId: string, repoUrl: string, pat?: string): Promise<FriendsResult<null>>;
// 推送通道：
cloudSessionEvent: "otter:cloudSessionEvent"       // payload: SessionEvent
cloudSessionStatus: "otter:cloudSessionStatus"     // payload: { workspaceId; sessionId; state: "connecting"|"ready"|"denied"|"gone"; deniedCode?: string; initiatorUid: string | null; ownerUid: string; selfUid: string }
onCloudSessionEvent(cb) / onCloudSessionStatus(cb)
```

cloudSessionClient 契约：
- 同时只保持一条云会话连接（`join` 先断旧的——桌面是显示器，多开留后续）。控制房连接按需起（create 时），拿到 `created` 即断。
- 收 `event` 帧 → 转 `send(CHANNELS.cloudSessionEvent, event)`；`welcome` 后自动 `backlog(0)` 补全量再置 `ready`（去重按 seq：backlog 与直播重叠时只发一份）。
- **审批复用现有卡**：收到 `approval_request` 事件且 `selfUid ∈ {initiatorUid, ownerUid}` → 构造 `ApprovalRequest` 形状进 `pendingApprovals`（键用云 sessionId，与本地会话 id 无碰撞——uuid）+ `send(CHANNELS.approvalRequest, ...)` + `feedIsland`，于是**手机端零改动**（fleet 下行带 pendingApproval，手机 approve 帧回来经 `handleRemoteCommand` → `handleDecideApproval`）。`handleDecideApproval` 加分流：sessionId 是云会话 → `cloudClient.approve(callId, decision)`，不碰本地 agents。收到 `approval_decision` 事件 → 清 pendingApprovals + island。局限写注释：发起人桌面不在线时手机收不到云审批卡（fleet 是桌面投影），spec 已接受。
- `workspaceCloudList`：Supabase 直查 `workspace_sessions`（anon client + RLS，`eq("kind","cloud")`），放 `supabaseWorkspacesApi.ts` 加一个 `listCloudSessions(client, workspaceId)`。
- transport 断线：wsTransport 自动重连，`:gone`（host 离场）→ status `gone`（UI 显示「runtime 离线」，不清 events）。

- [ ] **Step 1: 写失败测试**（假 transport 注入，覆盖：welcome→backlog 去重、approval_request 只在 self 可批时进 pendingApprovals 回调、denied 状态透传）
- [ ] **Step 2: 确认失败** → **Step 3: 实现 + 接线 IPC（`index.ts` 加 8 个 `ipcMain.handle` + 分流 `handleDecideApproval`）** → **Step 4: `npm test` 绿** → **Step 5: Commit**（`feat(main): 云会话客户端——relay 订阅、backlog 去重、审批走既有卡（手机零改动）（ADR-0199）`）

---

### Task 13: 渲染层——云会话 UI

**UI 纪律（emil-design-eng 已载入）**：新增交互沿用现有组件库（shadcn/Tabs/Dialog）；审批卡、消息行复用既有样式；不加装饰动画；按钮 `:active` 缩放等既有 app.css 约定不另起炉灶。

**Files:**
- Modify: `src/renderer/src/store.ts`（cloud slice）、`src/renderer/src/lib/workspaceView.ts`（`cloudSessionRows`）、`src/renderer/src/components/WorkspacePage.tsx`（SessionsTab 加云会话区）
- Create: `src/renderer/src/components/CloudSessionPage.tsx`
- Test: `tests/renderer/workspaceView.cloud.test.ts`

**Interfaces:**
- Consumes: T12 的 bridge 方法与两个订阅通道；`EventRow` + `TimelineProjectionContext`（`components/Timeline.tsx:415,:57`）；`buildToolIndex`/`groupSubagentSpawns`（OttoThread 顶部同款）。
- Produces:

```ts
// store.ts 追加（照 workspaceGroups 的样子）：
cloudSession: {
  workspaceId: string; sessionId: string;
  state: "connecting" | "ready" | "denied" | "gone";
  deniedCode?: string;
  initiatorUid: string | null; ownerUid: string; selfUid: string;
  events: SessionEvent[];
} | null;
cloudSessionList: Record<string, { id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number }[]>;  // workspaceId → rows
// actions:
refreshCloudSessions(workspaceId: string): Promise<void>;
openCloudSession(workspaceId: string, sessionId: string | null): Promise<void>;  // null = create
closeCloudSession(): void;
cloudSay(text: string, mention: boolean): Promise<void>;
cloudApprove(callId: string, ok: boolean): Promise<void>;

// workspaceView.ts 追加：
export interface CloudSessionRowView { id: string; title: string; creatorLabel: string; archived: boolean; updatedTs: number }
export function cloudSessionRows(
  rows: readonly { id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number }[],
  ws: WorkspaceSnapshot
): CloudSessionRowView[];   // labelOf 同款回退 uid.slice(0,8)；archived 沉底，updatedTs 降序
```

- `boot()` 里订阅 `onCloudSessionEvent`（append 进 `cloudSession.events`，按 seq 去重）与 `onCloudSessionStatus`。
- CloudSessionPage：状态条（connecting/gone/denied 文案——denied 按 code 给人话，口径同 T4「云端状态三态化」纪律：拿不到说未知不说不可用）+ 事件流（`<TimelineProjectionContext.Provider value={{ index: buildToolIndex(evts), groups: groupSubagentSpawns(evts), events: evts }}>` 包 `evts.map(e => <EventRow …/>)`，`chat_message` 类型加一个本组件内的简单行渲染：label + content，EventRow 不认识的类型跳过）+ 输入区（textarea + 「@Agent」toggle chip，发送调 `cloudSay(text, mentionOn)`）+ 审批卡（`approval_request` 事件且无对应 `approval_decision` 时显示；`selfUid ∈ {initiatorUid, ownerUid}` 才有按钮，否则只读「等待 X 审批」）。
- SessionsTab：顶部加「云会话」小节——`refreshCloudSessions` on mount、行点开 `openCloudSession`、「新建云会话」按钮（`openCloudSession(ws.id, null)`）；打开后 WorkspacePage 内切换渲染 CloudSessionPage（本地 state `openCloudId`，返回键回列表——照 WorkspacesPanel 开 WorkspacePage 的同款模式，不做弹窗，ADR-0185 教训）。

- [ ] **Step 1: 写失败测试**（`cloudSessionRows`：label 回退、archived 沉底、排序）
- [ ] **Step 2: 确认失败** → **Step 3: 实现纯逻辑 + store + 组件** → **Step 4: `npm test` 绿** → **Step 5: Commit**（`feat(ui): 云会话页——列表、群聊流、@Agent 输入、审批可见性（ADR-0199）`）

---

### Task 14: e2e 冒烟

**Files:**
- Create: `tests/e2e/cloudSession.e2e.ts`（照 `tests/e2e/workspace.e2e.ts` 的搭法与 harness）

- [ ] **Step 1: 写用例**：登录态（`launchOtto({ authRecord: true })`）打开工作区页 → 断言「云会话」小节渲染且「新建云会话」按钮存在 → 点击后（runtime 不在线）页面显示 connecting/错误态而**不崩**、控制台无未捕获异常。
- [ ] **Step 2: `npm run e2e` 本地跑绿**（e2e 不在 gate 里，跑不跑不是 PR 义务——但本任务的交付就是它，跑）
- [ ] **Step 3: Commit**（`test(e2e): 云会话冒烟——runtime 离线时 UI 不崩（ADR-0199）`）

---

### Task 15: ADR + 索引 + 术语

**Files:**
- Create: `docs/adr/0199-云执行面与群聊会话.md`（编号合并前按 ADR-0074 重验 max+1）
- Modify: `AGENTS.md`（Where to find things 加三行：services/runtime、dockerWorld、cloudSession 协议——L2 索引变更）、`CONTEXT.md`（产品/技术术语节加：云会话、cs 帧、控制房、otto-sandbox、发起人审批）

- [ ] **Step 1: 写 ADR**：六决策表（spec §0 那张）+ 每条的 rationale 与推翻条件（照 0197/0198 的文风）；「明确不做」抄 spec §9。
- [ ] **Step 2: AGENTS.md 三行 + CONTEXT.md 术语** → **Step 3: `npm test` 绿（含 adrNumbers 唯一性）** → **Step 4: Commit**（`docs(adr): ADR-0199 云执行面——六决策与推翻条件；索引与术语跟上`）

---

### Task 16: VPS 手验清单文档

**Files:**
- Create: `docs/runtime-vps.md`

- [ ] **Step 1: 写文档**，内容钉死为可照抄的清单：
  1. 首次部署：`/etc/otto-runtime.env` 模板（八个 env 名 + 哪里取值：RUNTIME_SECRET 与 edge `wrangler secret put RUNTIME_SECRET` 同值、SUPABASE_SERVICE_KEY 从 Supabase 后台、JWT secret 从 Management API `/postgrest`）、`sudo cp deploy/otto-runtime.service /etc/systemd/system/ && sudo systemctl enable otto-runtime`、`npm run runtime:deploy`（`RUNTIME_SSH=user@host` env）。
  2. 手验清单（DockerWorld/沙箱真机面）：① 桌面建云会话 → VPS `docker ps` 见 `otto-ws-<id>`；② @Agent 让它 `echo hi > /work/a.txt` → 审批卡出现在发起人桌面 → 批准 → 回复出现；③ 第二台账号（`docs/dev-two-accounts.md` 的 profile 法）进同一会话看到直播、发言注入；④ 踢出成员 → 60s 内其 say 收 `denied not_member`；⑤ 空闲 31 分钟 `docker ps` 容器停、再发言自动起；⑥ `usage_ledger` 里出现本回合行。
  3. 回滚：`systemctl stop otto-runtime`；数据在 `/var/lib/otto-runtime/`，删容器不删卷的命令。
- [ ] **Step 2: Commit**（`docs: VPS 部署与真机手验清单（ADR-0199）`）

---

## Self-Review 已跑

- spec 覆盖：§1 组件（T1/T3/T7/T10）、§2 生命周期与直播（T4/T9/T10/T12）、§3 turn 协议（T2/T5/T9）、§4 审批（T2/T6/T9/T12/T13）、§5 沙箱（T7/T8/T11/T16）、§6 部署与计量（T2/T4/T10/T11）、§7 错误处理（分散在 T6 fail-closed / T8 孤儿 / T10 重连 / T12 gone 态）、§8 测试（各任务 + T11/T14）。手机端（spec §4 末行）由 T12 的 fleet 复用覆盖，零 mobile 改动。
- 无占位符；类型一致性过了一遍（CloudSession/FrameHandler/CsUp-Down 三处接口在 T9/T10/T12 间对齐）。
- 已知留白（刻意）：T3 测试细节让实现者照 pxRoutes.test.ts 现有搭法；T9 的 grants 平台参数形状以 T3 实现为准——都是「以现场代码为准」而非「以后再想」。
