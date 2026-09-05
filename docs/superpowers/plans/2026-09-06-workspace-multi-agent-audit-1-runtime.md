# 工作区多智能体整体自查 · 第一批（runtime / 服务端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把五路审计（#957）在 runtime / 引擎 / 共用纯逻辑层抓到的 Critical 与 Important 一次修完：云会话接上自动压缩、`agent_briefed` 最新胜出且压缩幸存、接力棒数上限不再被队列去重削掉、护栏注话不串台、agent @ 未知名要出声、审批拒绝可诊断、重启补跑有上限、接力棒上的连接器调用要点火的人批准、被踢的人的 turn 不再跑、型号白名单在托管路真生效、云端换轨落 `route_changed`、共享记忆写入不再盲覆盖。

**Architecture:** 全部改动都在既有形状里：`CloudSessionOpts` 新增三个**必需**注入口（`contextWindowOf` / `isMember` / `onRouteChanged` 不在这里——前两个必需，第三个走 adapter deps），忘接线编译不过；引擎只加**可选**项（`loopGuardMaxNudges`、`snapshot()` 的点名延后判据），本机会话字节不变；纯判据（接力 depth 日志可推导、护栏周期、mention 原始 token）落 `src/shared/`；`approve` 的返回值从布尔变三态；补跑上限用既有的 `turn_ended{outcome:"interrupted"}` 当**不收口的记号**（`turnLedger` 对它天然中性），不新增事件类型。migration `0025` 只进仓、**不跑生产**（维护者点头后跑）。

**Tech Stack:** TypeScript strict / vitest / Node daemon（`services/runtime/`）/ Supabase PostgREST（service key）

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`（§2 串行队列、§4 事件、§5 上下文隔离、§6 记忆、§8 接力护栏、§9 权限）。审计报告：`.superpowers/audit/{A-runtime-core,B-security,D-billing,E-adversarial}.md`（worktree 内，gitignored——每个任务的 brief 里引用到的 finding 编号以那几份为准；实现者读 brief 就够，不必读报告）。Issue：#957（本批）、#933 / #934 / #927 / #930（本批关掉或部分关掉）。ADR：本批一份 **ADR-0225**。

## Global Constraints

- 硬规则（AGENTS.md）：append-only 日志是唯一事实；模型可见即已落盘；**投影必须可从日志推导**——本计划里每一条「判据」都要能从日志算出来（接力 depth、补跑次数、在籍与否的收口）；工具只依赖注入接口；事件 schema 只增不改（新字段全可选；`route_changed.reason` 的 union **加值不删值**）；**不新增事件类型**（十一处清单的代价）。
- 本机会话（桌面）行为**字节不变**：引擎新增项全部可选、缺席 = 现状；`agentView` 的 `user_message` 裁决只影响**带 `agentId`** 的那些（人说的话与接力开场白都没有 `agentId`，走早退路径原样放行）。
- `CloudSessionOpts` 新增字段一律**必需**（同 `memory` / `agentWriter` 的纪律）：`contextWindowOf(model: string): number | undefined`、`isMember(uid: string): Promise<boolean>`。**所有** `createCloudSession({...})` 调用点（`daemon.ts`、`checks/smokeAssembly.ts`、`tests/runtime/sessionService.test.ts` 全部用例）都要补。
- 接力 depth 的判据（A-4）：起 turn 时 `openingDepth = max(relay.depth ?? 0)` over「日志里 `mentions` 含本 agent、且**还没被本 agent 的 `turn_ended.readUpToSeq` 收口**的全部 `user_message`」——与 `openTurns` 同一收口口径（`src/shared/turnLedger.ts`），纯函数放 `src/shared/agentRelay.ts`。**否决**内存 `pendingDepth`（重启即丢）。
- 合成收口（F1）：`runJob` 两处合成的 `turn_ended{error}` 的 `readUpToSeq` = **落盘那一刻的日志尾 seq**（`lastSeqSeen`），不是 `job.opening.seq`。
- 补跑上限（A-9 / #933）：补跑前先落 `turn_ended{outcome:"interrupted", agentId, readUpToSeq: opening.seq - 1, error:"重启补跑第 N 次"}`；计数 = 该 opening 之后、该 agentId 的 `interrupted` 条数；`>= 3` 时不再排，改落 `turn_ended{outcome:"error", agentId, readUpToSeq: <日志尾>, error:"重跑 3 次仍未收口，停止补跑"}`。`MAX_CATCHUP_ATTEMPTS = 3` 导出常量。daemon 启动时按会话递增延时（`i * 1500ms`）起补跑。
- 护栏硬停（E-F5）：`LoopEngineOptions.loopGuardMaxNudges?: number`，缺席 = 现状（永不停）；命中次数达到时 `throw new Error("退化循环：护栏连续提醒 N 次仍在原地打转，本轮停止")` → 走既有 `turn_ended{error}` 路径；云会话 `engineFor` 设 **5**。
- `RELAY_GUARD.maxPeriod` 改 **8**（F2）；`decideRelay` 内 `maxDepth` 过 `normalizeRelayMaxDepth`（F4）。
- 接力棒上的连接器（B-C3 裁决）：`job.opening.relay` 存在时，`buildPxTools(..., { requiresApproval: true })`——审批人仍是点火的人（`router.setInitiator(job.fromUid)` 不变）。人自己 @ 起的 turn 照旧 `false`。
- 在籍复查（B-I1）：`runJob` 起跑前 `await opts.isMember(job.fromUid)`，false → 落 `turn_ended{error:"发起人已不在这个工作区，这条 turn 不跑"}`（`readUpToSeq` = 日志尾）并 return；重启补跑那段对每条 `t.fromUid` 同样过一遍（不在籍的直接落同一条错误收口，不入队）。
- 名单回落（B-I7）：`AgentSpec.degraded?: true`；`daemon.ts` 的 `DEFAULT_WORKSPACE_AGENT` 带 `degraded: true`；`runJob` 见 `spec.degraded` 就**不挂任何 px 刀**（`cachedPxTools = []`）并 `console.warn`。
- 型号路由（D1/D2 裁决）：`HostedRuntimeAdapterDeps.preferredModel?: () => string | undefined`（agent 白名单第一个，现读）；`decideRuntimeRoute` 的 `requestedModel` 只用于 **hosted** 分支；**workspace（自带 key）分支一律用 `ws.modelId`**，不看 agent 白名单。`daemon.ts` 的 `cfg` 回到纯 `workspaceConfigStore.load(workspaceId)?.model ?? null`。
- 换轨落账（D3）：`HostedRuntimeAdapterDeps.onRouteChanged?: (from: "hosted"|"workspace", to: "hosted"|"workspace", reason: "probe_failed"|"no_subscription"|"quota_exhausted"|"subscription_active") => void`；`decide()` 记上一次 `route.kind`，变了就回调；`route_changed` 事件的 `from/to` union 加 `"workspace"`，`reason` union 加三个值（**只加**）。daemon 的回调 `store.append({type:"route_changed", ignorable:true, from, to, reason})`。`createHostedProbe.me()` 返回 `BillingMe | null | "unreachable"`——探不到与没订阅分开（`decideRuntimeRoute` 把 `"unreachable"` 当 null 用，只有 reason 不同）。
- 额度耗尽改道（D4）：hosted 路的 `resolveEndpoint` 不再回常量：第二次（reroute）调用时带 `exhausted: true` 重新 `decide()`——有自带 key 就回 workspace 端点，没有就抛原错。`decideRuntimeRoute` 加可选入参 `exhausted?: boolean`，为 true 时跳过 hosted 分支。
- `model_usage` 带 `agentId`（D7）：`CloudSession` 加 `currentAgentId(): string | null`，daemon 的 `recordUsage` 展开 `...(agentId ? { agentId } : {})`（`ModelUsageEvent` 若无该字段则加可选字段）。
- 共享记忆（B-I3 / B-I4）：`WorkspaceMemoryStore.write(ws, agentId, content, expected: string | null)`——`expected` = 这次 read 到的原文（缺行 = null）；Supabase 实现：`expected === null` 走 insert（撞 23505 视为冲突），否则 `update ... .eq("content", expected)` 并 `.select("agent_id")` 校验行数，0 行 = 冲突；冲突抛 `MemoryConflictError`；`workspaceMemoryTool` 在锁内整段 read→apply→write **重试一次**，第二次仍冲突才抛「记忆刚被别人改了，重试一次仍冲突」。共享档条目写入前把 `[\r\n]+\s*` 折成单个空格（署名只盖一次，条目单行）。
- 审批拒绝可诊断（A-11 / #927）：`ApprovalRouter.resolve` 与 `CloudSession.approve` 返回 `"ok" | "no_pending" | "not_allowed"`；`frameHandler` 两种拒绝各一句文案（`no_pending`：「这条审批已经处理过或已过期」；`not_allowed`：「只有发起人或 owner 能批这条」）且**各自 `deps.log`**。
- 限速（B-I5）：`say` 帧的 `turn` 令牌按 `max(1, msg.mentions?.length ?? 1)` 扣（`rateLimit.allow(kind, uid, n)` 加可选第三参，缺省 1）。
- 迁移 `supabase/migrations/0025_workspace_hardening.sql` 只进仓不跑：#930 两条 delete 策略补 `is_ws_member`，`wss_delete_publisher` 加 `and kind <> 'cloud'`；`workspace_agents` 加 `check (agent_id = 'admin' or agent_id ~ '^a_[0-9a-f]{12}$')`、`check (name !~ '[\r\n]' and description !~ '[\r\n]')`、每工作区 agent 数上限 **32** 的 before-insert 触发器。
- 提交信息写**为什么**；每任务末尾跑本任务的测试文件；改类型的任务另跑 `npx tsc --noEmit` 与 `npx tsc --noEmit -p services/runtime`。提交尾部两行：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01Qrfg2wsjMwpm1TNFaRGd59`。

## PR 边界（控制者的事）

单 PR，L2（不动 Hard rules / Gate / Tech stack；AGENTS.md 只动索引）。ADR-0225 编号合并前 re-fetch 复核。合并后 `npm run runtime:deploy`；migration 0025 **等维护者点头**再跑；桌面侧（PR-2）另起计划。

---

## 文件结构

- Modify `src/session/deriveMessages.ts`、`src/session/modelContextScan.ts`（T1）
- Modify `src/loop/engine.ts`、`src/session/agentView.ts`（T2）
- Modify `src/shared/agentRelay.ts`、`src/shared/remote/agentMention.ts`（T3）
- Modify `services/runtime/src/sessionService.ts`、`pxTools.ts`、`daemon.ts`、`checks/smokeAssembly.ts`（T4a/T4c/T5）
- Modify `services/runtime/src/approvalRouter.ts`、`frameHandler.ts`、`rateLimit.ts`（T4b）
- Modify `services/runtime/src/hostedRoute.ts`、`src/session/events.ts`（`route_changed` / `model_usage` 可选字段）、`daemon.ts`（T6）
- Modify `services/runtime/src/workspaceMemory.ts`、`workspaceMemoryTool.ts`、`src/shared/workspaceMemory.ts`（T7）
- Create `supabase/migrations/0025_workspace_hardening.sql`、`docs/adr/0225-工作区多智能体自查第一批.md`；Modify `AGENTS.md` 索引、`CONTEXT.md`（T8）
- Tests：`tests/session/{agentBriefed,agentView,modelContextScan}.test.ts`、`tests/loop/engine*.test.ts`、`tests/shared/{agentRelay,agentMention}.test.ts`、`tests/runtime/{sessionService,approvalRouter,frameHandler,rateLimit,hostedRoute,workspaceMemory,workspaceMemoryTool}.test.ts`、`tests/docs/`

---

### Task 1: `agent_briefed` 最新一条胜出 + 压缩幸存（A-3）

**Files:**
- Modify: `src/session/deriveMessages.ts`（`case "agent_briefed"` 约 :668-681；`context_compacted` 分支约 :703-739；循环后拼 system 尾部约 :801）
- Modify: `src/session/modelContextScan.ts`（`head` 数组约 :49-58）
- Test: `tests/session/agentBriefed.test.ts`（既有三条要改期望）、`tests/session/modelContextScan.test.ts`（+1）

**Interfaces:**
- Produces: `deriveMessages` 对 `agent_briefed` 的投影从「事件位置一条 user 消息」改为「拼在 system 末尾、最新一条胜出、`context_compacted` 不清」。文案本体不变：`[你是这个工作区里的「${name}」。${others}]\n${instructions}`，只是位置变成 `systemMessage.content += "\n" + 那段`，并且**排在** `workspaceMemoryPrompt` 之前。

- [ ] **Step 1: 写失败测试**

在 `tests/session/agentBriefed.test.ts`（读现有三条，保留它们的事件夹具）改/加：
  1. 「两条 agent_briefed（instructions 变了）→ 投影里只出现**后一条**的 instructions，前一条一个字都不在」；
  2. 「brief 之后落一条 `context_compacted` → 投影的 system 消息里仍含 brief 文案，且 brief 只出现一次」；
  3. 「brief 在 system 末尾、在 workspace_memory 块之前」（用一条 `workspace_memory_loaded` 一起投影，断言 `indexOf(brief) < indexOf("SHARED")`）；
  4. 既有断言里凡是「brief 是一条 role:user 消息、位于事件位置」的期望改成「system 尾部」。
在 `tests/session/modelContextScan.test.ts` 加：「checkpoint 之前的 `agent_briefed` 出现在 `boundedContextEvents` 的结果里」。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/session/agentBriefed.test.ts tests/session/modelContextScan.test.ts`

- [ ] **Step 3: 实现**

`deriveMessages.ts`：
```ts
// 与 workspaceMemoryPrompt 同形（#949 的教训套到同族的 agent_briefed 上，审计 A-3）
let agentBrief: string | null = null;
...
case "agent_briefed": {
  const others = ...;  // 原样
  agentBrief = `\n[你是这个工作区里的「${event.name}」。${others}]\n${event.instructions}`;
  break;
}
...
// 循环结束后、workspaceMemoryPrompt 之前：
if (systemMessage && agentBrief) systemMessage.content += agentBrief;
if (systemMessage && workspaceMemoryPrompt) systemMessage.content += workspaceMemoryPrompt;
```
`context_compacted` 分支不动 `agentBrief`（它不在被清的 `messages` 里）。
`modelContextScan.ts` 的 `head` 加 `...store.ofType(sessionId, "agent_briefed", { beforeSeq: cp.seq }),`。

- [ ] **Step 4: 跑，确认绿**；另跑 `npx vitest run tests/session/` 确认没有别的投影测试被字节变化打红（被打红的：只改期望、不改语义，并在提交信息里说明）。

- [ ] **Step 5: 提交** `fix(session): agent_briefed 最新一条胜出并随 system 幸存压缩——同 workspace_memory_loaded 的教训（#957 A-3）`

---

### Task 2: 引擎——护栏注话带 agentId、护栏硬停可选项、增量圈延后点名（A-5 / E-F5 / A-10）

**Files:**
- Modify: `src/loop/engine.ts`（`appendBackgroundNow` :609-617、护栏注话 :923-935、`snapshot()` :298-311、`LoopEngineOptions`）
- Modify: `src/session/agentView.ts`（`OTHER_AGENT_VERDICTS.user_message`）
- Test: `tests/loop/engineAgentId.test.ts`（既有，+2）、`tests/session/agentView.test.ts`（+1）、新建 `tests/loop/engineLoopGuardCap.test.ts`

**Interfaces:**
- Produces: `LoopEngineOptions.loopGuardMaxNudges?: number`；`loopGuard` 与 `background` 注入的 `user_message` 在配了 `agentId` 的 engine 上带 `agentId`；`agentView` 对**带 agentId 的** `user_message` 裁决 `drop`；`snapshot()` 增量圈跳过「`mentions` 含本 agentId」的 `user_message`（首圈全量不变）。

- [ ] **Step 1: 写失败测试**
  - `engineAgentId.test.ts`：配 `agentId:"ops"` 的 engine 触发护栏（照该文件里已有的护栏夹具，或用一个每圈都要同一把工具的假 adapter）→ 注入的 `user_message{origin:"loop_guard"}` 带 `agentId:"ops"`；不配 agentId 的 engine 一个字段都不多（既有断言）。
  - `agentView.test.ts`：`user_message{agentId:"ops", origin:"loop_guard"}` 对 agent `ads` 的 view 不出现；没有 agentId 的 `user_message`（人说的、接力开场白）照旧出现。
  - `engineLoopGuardCap.test.ts`：`loopGuardMaxNudges: 2`，模型每圈调同一把工具并被拒 → 第 2 次护栏命中后 turn 以 `turn_ended{outcome:"error"}` 收口，error 含「护栏」，模型调用次数有限；不配该项时（同夹具，跑 6 圈后由测试侧让模型收口）turn 正常 completed。
  - `snapshot` 延后：engine 配 `agentId:"ops"`，模型第一圈调工具期间往 store 追加一条 `user_message{mentions:["ops"]}` 与一条 `user_message{mentions:["ads"]}` → 第二圈 `chat()` 收到的 messages 含后者不含前者（把 `tests/runtime/sessionService.test.ts` 里已有的「中途注入」用例形状搬过来）。

- [ ] **Step 2: 跑，确认红**

- [ ] **Step 3: 实现**
  - `envBase()` → `env()` 两处（:611、:925）。
  - `agentView.ts`：`user_message: "drop"` + 注释「只影响带 agentId 的：护栏/后台注给某只 agent 的私话不进别人的上下文；人说的话与接力开场白没有 agentId，走早退路径」。
  - `snapshot()` 增量段：
    ```ts
    const me = this.opts.agentId;
    const fresh = store.load(sessionId, { afterSeq: lastSeq })
      .filter((e) => !(me && e.type === "user_message" && e.mentions?.includes(me)));
    ```
    注意：过滤掉的事件不进 `turnLog`，于是 `lastSeq` 不前进到它们——下一圈会再读到再过滤，正确但要在注释里写明；`readUpToSeq` 的语义（起跑时视野）不受影响。
  - 护栏计数：`private loopNudges = 0`，`runTurn` 开头归零；命中时 `this.loopNudges++`，若 `this.opts.loopGuardMaxNudges !== undefined && this.loopNudges >= this.opts.loopGuardMaxNudges` 则在注话之后 `throw new Error(\`退化循环：护栏连续提醒 ${this.loopNudges} 次仍在原地打转，本轮停止\`)`。

- [ ] **Step 4: 跑，确认绿** + `npx vitest run tests/loop tests/session` + `npx tsc --noEmit`

- [ ] **Step 5: 提交** `fix(engine): 护栏与后台注话带 agentId 且不进别人的上下文；云会话可设护栏硬停；增量圈延后点了我的话（#957 A-5/A-10/E-F5，#934）`

---

### Task 3: 纯判据——接力 depth 日志可推导、护栏周期、maxDepth 归一、mention 原始 token（A-4 / F2 / F4 / A-6）

**Files:**
- Modify: `src/shared/agentRelay.ts`、`src/shared/remote/agentMention.ts`
- Test: `tests/shared/agentRelay.test.ts`、`tests/shared/agentMention.test.ts`

**Interfaces:**
- Produces:
  - `export function openingDepthFor(events: readonly SessionEvent[], agentId: string, opening: UserMessageEvent): number`——遍历 `events`，对每条 `mentions` 含 `agentId` 的 `user_message` U：若 U 之后没有该 agent 的 `turn_ended` 满足 `readUpToSeq === undefined || readUpToSeq >= U.seq`（与 `openTurns` 同口径），则计入；返回 `max(relayDepthOf(U))`，至少包含 `opening` 本身。
  - `RELAY_GUARD = { maxPeriod: 8, minRepeats: 2 }`。
  - `decideRelay` 内 `const max = normalizeRelayMaxDepth(args.maxDepth)`。
  - `export function mentionTokens(text: string): string[]`（`agentMention.ts`）：正文里所有 `@` 后紧跟的非空 token（到空白或行尾），**不**按名单解析；边界判据抄 `parseMentions` 的口径。

- [ ] **Step 1: 写失败测试**
  - `openingDepthFor`：日志 [U1(mentions ads, depth 0), U2(mentions ads, relay depth 2)]，无 turn_ended → 2；加一条 `turn_ended{agentId:ads, readUpToSeq: U2.seq}` → 只剩 opening 自己 → 用 opening=U1 时回 0；`readUpToSeq < U2.seq` 时 U2 仍算。
  - 三只互 @ 周期 6 的 hop 指纹（抄 `.superpowers/audit/tests/_audit_relayGuard.test.ts` 里的序列——文件在 worktree 的 gitignored 目录，读它）→ `decideRelay` 回 `loop` 非 null。
  - `decideRelay({... maxDepth: NaN})` 与 `maxDepth: 99` 都按默认 6 判 cap。
  - `mentionTokens("@运营 看下 @xx销量 邮箱 a@b.c")` → `["运营","xx销量"]`（`a@b.c` 不算，与 `parseMentions` 的边界一致）。

- [ ] **Step 2: 跑，确认红** → **Step 3: 实现** → **Step 4: 跑，确认绿** + `npx vitest run tests/shared/`

- [ ] **Step 5: 提交** `fix(shared): 接力 depth 改成日志可推导（队列去重削不掉）、护栏周期 8 覆盖三只互 @、maxDepth 归一、mention 原始 token（#957 A-4/F2/F4/A-6）`

---

### Task 4a: sessionService——合成收口、接力现取名单、未知 @ 出声、depth、去重、接力棒审批、在籍复查、降级名单（F1 / F3 / A-6 / A-4 / F7 / B-C3 / B-I1 / B-I7）

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（`AgentSpec`、`CloudSessionOpts`、`relayAfterTurn`、`runJob`、`say`、重启补跑段）
- Modify: `services/runtime/src/pxTools.ts`（`buildPxTools(deps, fromUid, granted, opts?: { requiresApproval?: boolean })`）
- Modify: `services/runtime/src/daemon.ts`（`isMember` 接线 = `membership.has(workspaceId, uid)`；`DEFAULT_WORKSPACE_AGENT.degraded = true`）、`services/runtime/checks/smokeAssembly.ts`（`isMember: async () => true`）
- Test: `tests/runtime/sessionService.test.ts`（所有 `createCloudSession({` 补 `isMember: async () => true,`；+7 用例）、`tests/runtime/pxTools.test.ts`（+1）

**Interfaces:**
- Consumes: Task 3 的 `openingDepthFor` / `mentionTokens`。
- Produces: `CloudSessionOpts.isMember: (uid: string) => Promise<boolean>`（必需）；`AgentSpec.degraded?: true`；`buildPxTools` 第四参。

- [ ] **Step 1: 写失败测试**（每条都断言事件序列，夹具照文件里 ⑦/⑧ 的写法）
  1. **F1**：agent 排队期间被删（`agents()` 第二次返回时不含它）且它的 job 已折叠进一条接力开场白 → 合成 `turn_ended{error}` 的 `readUpToSeq` = 当时日志尾 seq；`openTurns(store.load)` 为空。
  2. **F3**：admin 的 turn 里 `create_agent` 建出「广告」并在同一条回复里 `@广告` → 日志有 `agent_relay{to: 新id}` 与开场白（`agents()` 夹具 = `[admin, ...writer.specs("w1")]`）。
  3. **A-6**：agent 回复 `@不存在的名字 …` → 落一条 `chat_message{fromUid:"system"}` 含「没有这个人」与那个 token；无 `agent_relay`。
  4. **A-4**：人 `@ops @ads`；ops 回复 `@ads`（折叠命中）→ ads 起跑时 `relayAfterTurn` 用 `openingDepthFor` 算出 depth 1 → ads 再 `@ops` 落的 hop `depth === 2`（此前是 1）。
  5. **F7**：`say(..., mentions: ["ops","ops"])` → 只一条 `user_message`，`mentions` 去重为 `["ops"]`，一个 job。
  6. **B-C3**：接力开的 turn 里 px 工具 `requiresApproval === true`（用 adapter 捕获不到 requiresApproval——改为断言 `approval_request{toolName: px_…}` 出现且 `initiatorUid` = 点火者；人直接 @ 的 turn 里同一把 px 工具不弹审批）。px 夹具：`px.fetchImpl` 假的，按 `tests/runtime/pxTools.test.ts` 的 granted 形状返回一台 server。
  7. **B-I1**：`isMember: async (uid) => uid !== "kicked"`；`say("kicked", ...)` @admin → 落 `turn_ended{error}` 含「不在这个工作区」，`readUpToSeq` = 日志尾，无 `assistant_message`；重启补跑：seed 里一条 `kicked` 的未收口开场白 → 装配后直接落同样的错误收口，不排队。
  8. **B-I7**：`agents()` 回 `[{...admin, degraded: true}]` → turn 里工具表不含任何 `px_` 前缀工具（adapter 捕获 tools 名）。
  - `pxTools.test.ts`：`buildPxTools(..., { requiresApproval: true })` 出的每把刀 `requiresApproval === true`；缺省 false 不变。

- [ ] **Step 2: 跑，确认红**

- [ ] **Step 3: 实现**
  - `relayAfterTurn(job, spec, scanFrom)`：删 `roster` 参数，内部 `const roster = await opts.agents()` 现取；`mentionedAgents` 之后，若 `targets.length === 0 && mentionTokens(said).length > 0` → `logChat("system","系统", \`「${spec.name}」@ 了「${tokens.join("、")}」，名单里没有这个人（可能改过名或还没建），这一棒没人接\`, false)` 并 return；`openingDepth = openingDepthFor(store.load(sessionId), spec.agentId, job.opening)`。
  - `say`：`targets = [...new Set(resolveTargets(...))]`。
  - `runJob`：`setInitiator` 之后先 `if (!(await opts.isMember(job.fromUid))) { notify(store.append({type:"turn_ended", outcome:"error", agentId: job.agentId, error:"发起人已不在这个工作区，这条 turn 不跑", readUpToSeq: lastSeqSeen})); return; }`；两处合成收口 `readUpToSeq: lastSeqSeen`；`cachedPxTools = spec.degraded ? [] : buildPxTools(opts.px, job.fromUid, filtered, { requiresApproval: job.opening.relay !== undefined })`，degraded 时 `console.warn`。
  - 重启补跑段：对每条 `t` 先 `await opts.isMember(t.fromUid)`（段落要改成 async IIFE 或把补跑搬进一个 `void catchUp()`，装配仍同步返回 session），不在籍的落错误收口不入队。
  - `daemon.ts`：`isMember: (uid) => membership.has(workspaceId, uid)`；`DEFAULT_WORKSPACE_AGENT` 加 `degraded: true`。

- [ ] **Step 4: 跑，确认绿** + `npx vitest run tests/runtime/` + 两个 tsc

- [ ] **Step 5: 提交** `fix(runtime): 接力现取名单、未知 @ 出声、depth 日志可推导、合成收口收到日志尾、接力棒上的连接器要点火者批、被踢的人不再起 turn、名单降级不挂连接器（#957 F1/F3/A-6/A-4/F7/B-C3/B-I1/B-I7）`

---

### Task 4b: 审批三态 + 拒绝留痕 + 限速按目标数（A-11 / #927 / B-I5）

**Files:**
- Modify: `services/runtime/src/approvalRouter.ts`（`resolve` 返回 `ApproveOutcome`）、`sessionService.ts`（`approve` 透传）、`frameHandler.ts`（approve 分支、say 分支）、`rateLimit.ts`（`allow(kind, uid, n = 1)`）
- Test: `tests/runtime/{approvalRouter,frameHandler,rateLimit}.test.ts`

**Interfaces:**
- Produces: `export type ApproveOutcome = "ok" | "no_pending" | "not_allowed"`（approvalRouter.ts 导出；sessionService 的 `CloudSession.approve` 返回它）；`RateLimit.allow(kind, uid, n?: number)`。

- [ ] **Step 1: 写失败测试**
  - approvalRouter：同 callId 第二次 resolve → `"no_pending"`；无关 uid → `"not_allowed"` 且 pending 仍在，随后 owner → `"ok"`。
  - frameHandler：approve 回 `no_pending` → 客户端收到含「已经处理过或已过期」的 error 帧且 `deps.log` 被调一次（含 callId）；`not_allowed` → 含「只有发起人或 owner」+ log。
  - rateLimit：`allow("turn", uid, 3)` 一次扣 3 个令牌（突发 10 → 三次后第四次 false）。
  - frameHandler say：`mentions` 长度 3 的帧扣 3 个 turn 令牌（用假 rateLimit 记录 `n`）。

- [ ] **Step 2–4**：红 → 实现 → 绿（`npx vitest run tests/runtime/`）

- [ ] **Step 5: 提交** `fix(runtime): 审批拒绝分两句话且各自留痕、限速按点名数扣（#957 A-11/B-I5，#927）`

---

### Task 4c: 重启补跑上限 + 启动错峰（A-9 / #933）

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（补跑段）、`daemon.ts`（启动循环递增延时）
- Test: `tests/runtime/sessionService.test.ts`（+2）

**Interfaces:**
- Produces: `export const MAX_CATCHUP_ATTEMPTS = 3`（sessionService.ts）。

- [ ] **Step 1: 写失败测试**
  1. seed：一条未收口开场白 → 装配后日志里先有 `turn_ended{outcome:"interrupted", agentId, readUpToSeq: opening.seq-1}`，再有这只 agent 的真实 turn；`openTurns(seed 当时)` 的判定不受 interrupted 影响（对它中性——用 `openTurns` 直接断言）。
  2. seed 里同一 opening 之后已有 3 条 interrupted（模拟三次重启都没跑完）→ 装配后**不**起 turn，落 `turn_ended{outcome:"error"}` 含「停止补跑」，`openTurns` 为空。

- [ ] **Step 2–4**：红 → 实现（计数 = `seed.filter(e => e.type==="turn_ended" && e.agentId===t.agentId && e.outcome==="interrupted" && e.seq > t.seq).length`）→ 绿；daemon 启动循环里 `await new Promise(r => setTimeout(r, i * 1500))` 之后再 `openSessionRoom`（把注释写清：错峰是为了 N 个容器不同时起）。

- [ ] **Step 5: 提交** `fix(runtime): 重启补跑上限 3 次（interrupted 记号日志可推导）+ 启动错峰（#957 A-9，#933）`

---

### Task 5: 云会话接上自动压缩（A-1）

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（`CloudSessionOpts.contextWindowOf`、`engineFor`）、`daemon.ts`、`checks/smokeAssembly.ts`
- Test: `tests/runtime/sessionService.test.ts`（所有调用点补 `contextWindowOf: () => undefined,`；+1）

**Interfaces:**
- Consumes: Task 1（压缩后 brief 幸存）、`DEFAULT_AUTO_COMPACT`（`src/shared/autoCompact.ts`）、`findModel`（`src/shared/modelCatalog.ts`）。
- Produces: `CloudSessionOpts.contextWindowOf: (model: string) => number | undefined`（必需）。

- [ ] **Step 1: 写失败测试**：`contextWindowOf: () => 2_000`（很小），adapter 每轮回一段 1500 字的内容并连续两轮调 `read_file`（让占用越过阈值），第三轮 `chat()` 收到的 messages 里有 `[上下文已压缩` 且仍含 brief 文案（`agent_briefed` 夹具 instructions 非空）与 `SHARED` 记忆块；日志里有 `context_compacted{agentId}`；另一只 agent（`ads`）随后起 turn，它的 messages **不含**那条摘要（agentView 隔离，已有断言形状可抄）。压缩用的摘要请求也走同一个假 adapter——让假 adapter 对「含『摘要』字样的 system」回一段固定摘要。

- [ ] **Step 2–4**：红 → 实现：
  ```ts
  // engineFor 内：每台 engine 记住它此刻的 adapter，contextWindow 现读它的 model
  let current = opts.adapterFor(spec); ... hit 分支也更新 current
  autoCompact: { contextWindow: () => opts.contextWindowOf(current.model), settings: () => DEFAULT_AUTO_COMPACT },
  loopGuardMaxNudges: 5,
  ```
  `daemon.ts`：`contextWindowOf: (m) => { const c = findModel(m); return c?.contextWindowKnown ? c.contextWindow : undefined; }`；smoke：`() => undefined`。→ 绿 + tsc。

- [ ] **Step 5: 提交** `fix(runtime): 云会话接上自动压缩——窗口按 adapter 此刻的型号现读（#957 A-1）`

---

### Task 6: 型号路由与换轨落账（D1 / D2 / D3 / D4 / D7）

**Files:**
- Modify: `services/runtime/src/hostedRoute.ts`、`src/session/events.ts`（`route_changed.from/to` 加 `"workspace"`，`reason` 加 `"probe_failed" | "no_subscription" | "subscription_active"`；`ModelUsageEvent.agentId?: string` 若尚无）、`services/runtime/src/daemon.ts`（`adapterFor`、`recordUsage`、`cfg`）、`sessionService.ts`（`CloudSession.currentAgentId()`）
- Test: `tests/runtime/hostedRoute.test.ts`（+6）、`tests/runtime/sessionService.test.ts`（+1）

**Interfaces:**
- Produces: `HostedRuntimeAdapterDeps.preferredModel?: () => string | undefined`、`onRouteChanged?: (from, to, reason) => void`；`HostedProbe.me(): Promise<BillingMe | null | "unreachable">`；`decideRuntimeRoute` 入参 `me: BillingMe | null | "unreachable"`、`exhausted?: boolean`；`CloudSession.currentAgentId(): string | null`。

- [ ] **Step 1: 写失败测试**
  1. `decideRuntimeRoute({ me, requestedModel:"glm-5.3", workspace:null })` → hosted 用 `glm-5.3`（D1：ws 为 null 也尊重）。
  2. `decideRuntimeRoute({ me:null, requestedModel:"gpt-9", workspace: ws })` → workspace 且 `model === ws.modelId`（D2：自带 key 路忽略白名单）。
  3. `createHostedRuntimeAdapter({... preferredModel: () => "glm-5.3", cfg: () => null })` → `prepare()` 后 `model === "glm-5.3"`。
  4. probe 两次 `decide()`：第一次 me active → hosted；第二次 probe 回 `"unreachable"` 且 cfg 有 key → workspace，`onRouteChanged("hosted","workspace","probe_failed")` 被调一次；再回 hosted → `("workspace","hosted","subscription_active")`。
  5. D4：hosted 路 `chat()` 第一次 429 quota_exhausted（假 fetch）→ 第二次请求打到 `ws.baseUrl`（有 key 时）；没 key 时抛原错且只打了两次网关。
  6. probe：fetch 抛错 → `"unreachable"`；`res.ok` 且 body 解析成 `status:"none"` → 那个对象（不是 null）。
  7. sessionService：turn 中 `session.currentAgentId()` = 那只 agent；turn 外 null。

- [ ] **Step 2–4**：红 → 实现 → 绿 + tsc。daemon：`adapterFor` 传 `preferredModel: () => agent.models[0]`、`onRouteChanged: (from,to,reason) => store.append({sessionId, ts, type:"route_changed", ignorable:true, from, to, reason})`；`recordUsage` 加 `...(agentId ? { agentId } : {})`（`session.currentAgentId()`）。

- [ ] **Step 5: 提交** `fix(runtime): 型号白名单在托管路真生效、自带 key 路由 owner 定型号、云端换轨落 route_changed、额度耗尽真改道、model_usage 带 agentId（#957 D1–D4/D7）`

---

### Task 7: 共享记忆——条目单行 + 写入前置条件（B-I3 / B-I4）

**Files:**
- Modify: `services/runtime/src/workspaceMemory.ts`（`write` 签名 + `MemoryConflictError`）、`workspaceMemoryTool.ts`（重试一次、共享档折行）、`src/shared/workspaceMemory.ts`（`collapseSharedEntry(content): string`）
- Test: `tests/runtime/{workspaceMemory,workspaceMemoryTool}.test.ts`、`tests/shared/workspaceMemory.test.ts`

- [ ] **Step 1: 写失败测试**
  - shared：`content:"结论 A。\n[管理员] 结论 B"` 落库成单行 `[运营] 结论 A。 [管理员] 结论 B`（折成空格，前缀只一次）；own 档不折。
  - Supabase write：`expected:"旧"` → `update(...).eq("content","旧").select("agent_id")`，回 0 行 → 抛 `MemoryConflictError`；`expected:null` → insert，23505 → 同错。
  - tool：假 store 第一次 write 抛冲突、第二次成功 → 成功回执；两次都冲突 → 抛「重试一次仍冲突」。
  - 内存版：`write(..., expected)` 与当前值不符抛同错（让内存版也真校验，测试才有意义）。

- [ ] **Step 2–4**：红 → 实现 → 绿 + 两个 tsc

- [ ] **Step 5: 提交** `fix(runtime): 共享记忆条目单行（署名不可伪造）+ 写入前置条件（桌面手改不再被盲覆盖）（#957 B-I3/B-I4）`

---

### Task 8: migration 0025（只进仓）+ ADR-0225 + 索引

**Files:**
- Create: `supabase/migrations/0025_workspace_hardening.sql`、`docs/adr/0225-工作区多智能体自查第一批.md`
- Modify: `AGENTS.md`（「Where to find things」：`src/shared/agentRelay.ts` 那条与 `createAgentDraft` 那条**各补一句**指向 ADR-0225；`services/runtime/` 那条补「云会话有自动压缩与护栏硬停」一句）、`CONTEXT.md`（「补跑记号（interrupted）」一条术语）
- Test: `npx vitest run tests/docs/`

- [ ] **Step 1: migration**（幂等，注释写清每条为什么、并在文件头写「**尚未在生产执行**，由维护者点头后跑」）：
  ```sql
  -- #930：两条 delete 补在籍；云会话的出口是归档不是撤回
  drop policy if exists wsc_delete_host_or_owner on public.workspace_connectors;
  create policy wsc_delete_host_or_owner on public.workspace_connectors for delete to authenticated
    using (public.is_ws_member(workspace_id, auth.uid())
       and (host_uid = auth.uid() or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid())));
  drop policy if exists wss_delete_publisher on public.workspace_sessions;
  create policy wss_delete_publisher on public.workspace_sessions for delete to authenticated
    using (kind <> 'cloud' and publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));
  -- workspace_agents 形状约束（B-I3 / B-C1 的 DB 兜底）
  alter table public.workspace_agents drop constraint if exists workspace_agents_agent_id_shape;
  alter table public.workspace_agents add constraint workspace_agents_agent_id_shape
    check (agent_id = 'admin' or agent_id ~ '^a_[0-9a-f]{12}$');
  alter table public.workspace_agents drop constraint if exists workspace_agents_no_newline;
  alter table public.workspace_agents add constraint workspace_agents_no_newline
    check (name !~ '[\r\n]' and description !~ '[\r\n]');
  -- 每工作区最多 32 只（B-I5）
  create or replace function public.workspace_agents_cap() returns trigger language plpgsql as $$
  begin
    if (select count(*) from public.workspace_agents where workspace_id = new.workspace_id) >= 32 then
      raise exception 'workspace_agents: 一个工作区最多 32 只智能体';
    end if;
    return new;
  end $$;
  drop trigger if exists workspace_agents_cap on public.workspace_agents;
  create trigger workspace_agents_cap before insert on public.workspace_agents for each row execute function public.workspace_agents_cap();
  ```
  先核对 0015 里两条策略的原文（表名/列名/是否已有 owner 分支），照原文改写，别凭记忆。

- [ ] **Step 2: ADR-0225**（格式照 `docs/adr/0224-*.md`）：背景 = 五路审计；决策逐条对应 Global Constraints 里的裁决（压缩接线、brief 最新胜出、depth 日志可推导、护栏硬停只在云端、接力棒连接器要点火者批、在籍复查、降级名单不挂连接器、型号白名单只在托管路、换轨落账、补跑上限用 interrupted 记号、记忆写前置条件、审批三态、限速按点名数）+ 每条否决了什么 + 已知代价（A-7 审批冻结、D5 MAX_INFLIGHT、D8 自带 key 无天花板、E-F6/F8、B-M1/M2）+ 推翻前提。写清「migration 0025 尚未在生产执行」。

- [ ] **Step 3: AGENTS.md / CONTEXT.md** 按上面改；`npx vitest run tests/docs/` 绿。

- [ ] **Step 4: 提交** `docs(adr): 多智能体自查第一批的决策 + migration 0025（未跑生产）（ADR-0225，#957）`

---

## 自查记录

1. **覆盖**：A-1/3/4/5/6/9/10/11、B-C3、B-I1/I3/I4/I5/I7、B-I6(#930 迁移)、D1/D2/D3/D4/D7、E-F1/F2/F3/F4/F5/F7 都有任务；A-2/A-8（stop 帧）与 B-C1/C2/I2、C-* 在 PR-2/PR-3。
2. **类型一致**：`isMember` / `contextWindowOf` 在 4a/5/daemon/smoke/tests 同名；`openingDepthFor(events, agentId, opening)` 在 3/4a 同名；`ApproveOutcome` 在 4b 三处同名；`preferredModel`/`onRouteChanged` 在 6 内部一致。
3. **顺序**：1 → 2 → 3 → 4a → 4b → 4c → 5 → 6 → 7 → 8（5 依赖 1；4a 依赖 3）。
