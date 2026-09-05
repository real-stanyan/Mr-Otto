# 工作区多智能体整体自查 · 第三批（stop 帧 + say/approve 回执，cs 协议 5→6）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云会话的 turn 能被人停下来（A-2：`engine.abortTurn()` 在 runtime 零调用、协议没有 stop 帧、归档也不停 turn——一条跑飞的 turn 在云端谁都停不下来，烧的是 owner 的钱），归档顺带停掉正在跑的 turn（A-8：归档 2 秒后房间关了，跑完的回复发给没人）；并给 `say` / `approve` 加回执帧（#964 / #927 同族：桌面的 `ok:true` 只证明帧交给了 socket，服务端的业务拒绝走一条解耦的 `error` 帧，开局卡原文与审批按钮状态都因此撒谎）。

**Architecture:** 一次协议进位（`CS_PROTOCOL_VERSION` 5→6）把三样一起带上：上行 `stop`，下行 `say_result{ok, message?}` / `approve_result{callId, ok, message?}` / `stop_result{ok, message?}`。回执形状照 `config_result` 的先例（不复用 `error`：那条帧还承载 backlog 跳过等不相干的消息，await 它会被无关 error 提前唤醒）。runtime：`CloudSession.stop(byUid)` → 当前 job 的 engine `abortTurn()`；`archive()` 先 `stop` 再落归档事件；frameHandler 的 stop 判「发起人或 owner」（与 approve 同一判据），三种回执成功失败都发。桌面：`cloudSessionClient` 对 say/approve 各挂一个 pending（照 `pendingConfig` 的形状，15 s 超时 = 「不知道」不是「失败」），`say()`/`approve()` 等回执再 resolve；渲染层 composer 只在 `ok:true` 后清草稿、审批卡只在 `ok:true` 后保持禁用（第二批的 notice/15 s 兜底保留作旧 runtime 兼容），停止按钮出现在「正在回复」那一行。

**Tech Stack:** TypeScript strict / vitest / Node daemon / Electron 主进程 / React

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`（§2 串行队列；§12「若串行队列成为主要抱怨」）。审计 A-2 / A-8（`.superpowers/audit/A-runtime-core.md`）；issues #964、#927、#959（A-7 冻结，本批不解）。ADR：**ADR-0227**。前置：第一批（ADR-0225）、第二批（ADR-0226）已合并。

## Global Constraints

- **协议进位 5→6**：`src/shared/remote/cloudSession.ts` 的 `CS_PROTOCOL_VERSION = 6`；`CsUp` 加 `{ t: "stop" }`；`CsDown` 加 `{ t: "say_result"; ok: boolean; message?: string }`、`{ t: "approve_result"; callId: string; ok: boolean; message?: string }`、`{ t: "stop_result"; ok: boolean; message?: string }`；`encodeCs`/`decodeCsUp`/`decodeCsDown` 各补分支；`tests/shared/cloudSessionFrames.test.ts` 逐帧往返。旧 runtime × 新桌面 / 新 runtime × 旧桌面都走既有 `version_mismatch`（`frameHandler.ts:191`），文案已存在（`cloudSessionClient.ts:103`）——不做双版本兼容。
- **谁能停**：与 approve 同一判据——`session.initiatorUid()` 或 owner；没有在跑的 turn → `stop_result{ok:false, message:"此刻没有正在跑的 turn"}`；无权 → `stop_result{ok:false, message:"只有发起人或 owner 能停"}` 并 `deps.log`。
- **停的语义**：`CloudSession.stop(byUid): "ok" | "idle" | "not_allowed"`；runtime 对当前 job 的 engine 调 `abortTurn()`；engine 落 `turn_ended{outcome:"aborted", agentId}`（既有路径）；**已排队未跑的 job 照旧**（停的是「这一轮」，不是清队列——清队列另议）；停掉的 turn **不接力**（`runJob` 已有 `outcome === "completed"` 判据）。群里落一条 `chat_message{fromUid:"system", label:"系统", content:"<label> 停止了「<agent>」这一轮"}`（与归档那句同一条路），让别人知道为什么没回复。
- **归档顺带停**：`archive(byLabel)` 先 `stop`（内部，不判权限——归档权限已在 frameHandler 判过）再落 `session_archived`；daemon 的 `closeRoom` 延时从固定 2 s 改成「等 `settled()` 或封顶 10 s」——跑完的回复发给没人（A-8）就此关掉。
- **回执**：`say` → 服务端 `say()` resolve 后发 `say_result{ok:true}`；`say()` 抛错 / 限速 / 不在籍 → `say_result{ok:false, message}`（限速那条**替换**原来的 `error` 帧，文案不变）；`approve` → `approve_result{callId, ok, message}`（三态文案沿用第二批的两句）；旧的 `error` 帧只保留给 backlog 跳过与 hello 之外的杂项。
- **桌面等回执**：`cloudSessionClient.say()`/`approve()` 照 `pendingConfig` 的形状各一个 pending（`pendingSay`、`pendingApprove: Map<callId, …>`），15 s 超时回 `{ok:false, message:"没有收到回执，不确定有没有生效——看时间线"}`；断线/拒绝/关闭时统一 settle（同 `settleConfig` 的三处调用点）；**不排队**：`pendingSay` 已有时回 `{ok:false, message:"上一句还没有回执，稍等"}`。`stop()` 同款。
- **渲染层**：composer 的「草稿在发送成功之后才清」现在等的是真回执；第二批的 `cloudDraftSeed` 保留（`ok:false` 时种草稿）；审批卡 `submitting` 在 `ok:true` 后保持到卡消失、`ok:false` 当场恢复并显示 message——第二批的 notice 订阅与 15 s 定时器保留（旧 runtime 兼容 + 双保险）；停止按钮：`PendingTurnLines` 里 `running` 那一行右侧一颗「停止」（只对发起人或 owner 显示，判据与审批卡同源），点下去 `cloudStop()`，`stop_result` 回来前禁用。
- **硬规则**：渲染进程只经 `ShellBridge`（新增 `workspaceCloudStop(): Promise<FriendsResult<null>>` 一个 IPC + preload + main 接线）；事件 schema 不改（`turn_ended{aborted}` 既有）；不新增事件类型。
- 提交信息写**为什么**；每任务跑本任务测试；改类型的任务另跑两个 tsc + `npm run runtime:smoke`。提交尾部两行：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01Qrfg2wsjMwpm1TNFaRGd59`。

## PR 边界

单 PR，L2。ADR-0227。合并后 `npm run runtime:deploy`（协议进位：**runtime 先上，桌面随后发版**——中间窗口里旧桌面看到 `version_mismatch`，文案已有；安装版 v1.1.6 本来就连不上）。桌面发版 `npm run release -- minor` 在本批合并后一次发，含第一、二批。

---

## 文件结构

- Modify `src/shared/remote/cloudSession.ts`（版本、三帧、编解码）；`tests/shared/cloudSessionFrames.test.ts`
- Modify `services/runtime/src/sessionService.ts`（`stop`、`archive` 顺带停、`currentEngine`）、`frameHandler.ts`（stop 分支、say/approve 回执）、`daemon.ts`（closeRoom 等 settled）；`tests/runtime/{sessionService,frameHandler}.test.ts`
- Modify `src/main/cloudSessionClient.ts`（pendingSay/pendingApprove/pendingStop、`stop()`）、`src/main/index.ts`、`src/preload/index.ts`、`src/shared/shellBridge.ts`；`tests/main/cloudSessionClient.test.ts`
- Modify `src/renderer/src/store.ts`（`cloudStop`）、`src/renderer/src/components/CloudSessionPage.tsx`（停止按钮、审批卡 ok:false 路径）；`src/renderer/src/lib/cloudTimeline.ts`（`canStopTurn(t, selfUid, cs)` 纯判据）；`tests/renderer/cloudTimelineLabels.test.ts`
- Create `docs/adr/0227-工作区多智能体自查第三批.md`；Modify `AGENTS.md` 索引、`CONTEXT.md`

---

### Task 1: 协议——版本 6 + 三帧编解码

**Files:** `src/shared/remote/cloudSession.ts`；`tests/shared/cloudSessionFrames.test.ts`

- [ ] 测试：`stop` 上行往返；`say_result`/`approve_result`/`stop_result` 下行往返（有/无 message）；`decodeCsUp` 对形状不对的 `approve_result.callId` 回 null；`CS_PROTOCOL_VERSION === 6`。
- [ ] 红 → 实现 → 绿 + `npx tsc --noEmit`。提交 `feat(protocol): cs 协议 6——stop 帧与 say/approve/stop 回执（#957 第三批，#964）`

### Task 2: runtime——`CloudSession.stop`、归档顺带停、frameHandler 回执

**Files:** `services/runtime/src/sessionService.ts`、`frameHandler.ts`、`daemon.ts`；`tests/runtime/{sessionService,frameHandler}.test.ts`；`checks/smokeAssembly.ts`（若断言事件序列受影响）

**Produces:** `CloudSession.stop(byUid: string): "ok" | "idle" | "not_allowed"`；`CloudSession.running(): { agentId: string; initiatorUid: string } | null`。

- [ ] 测试（sessionService）：turn 跑到一半 `stop(initiator)` → `turn_ended{aborted, agentId}` + 系统 chat_message「停止了」，无 `agent_relay`，队列里下一只照跑；`stop(无关 uid)` → `"not_allowed"` 且 turn 继续；空闲 → `"idle"`；`archive()` 在 turn 跑一半 → 先 aborted 再 `session_archived`，`settled()` 立刻可返回。
- [ ] 测试（frameHandler）：`stop` 帧 → 三种 `stop_result`；`say` 帧成功 → `say_result{ok:true}`；限速 → `say_result{ok:false}` 文案同旧 `error`；`approve` → `approve_result{callId, ok:false, message}` 两句 + `deps.log`。
- [ ] 实现：engine 引用——`runJob` 里 `engineFor(spec)` 后记 `currentEngine = engine`，`finally` 清；`stop` 判 `router.canDecide(byUid)`（同一判据）→ `currentEngine.abortTurn()`；`archive` 内部先 `abortTurn`（不判权限）；daemon `closeRoom` 改 `Promise.race([session.settled(), sleep(10_000)]).then(close)`。
- [ ] 绿 + 两个 tsc + `npm run runtime:smoke`。提交 `feat(runtime): 云会话能停 turn、归档顺带停、say/approve 有回执（#957 A-2/A-8，#964）`

### Task 3: 桌面主进程——等回执 + `stop()` + IPC

**Files:** `src/main/cloudSessionClient.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/shared/shellBridge.ts`；`tests/main/cloudSessionClient.test.ts`

- [ ] 测试：`say()` 在 `say_result{ok:true}` 到达后 resolve `{ok:true}`；`ok:false` → `{ok:false,message}`；15 s 无回执（假计时器）→ `{ok:false, message 含「没有收到回执」}`；第二次 `say()` 在 pending 时被拒；断线 settle pending；`approve()` 按 callId 配对（两条并发各自 resolve）；`stop()` 同款；`version_mismatch` 文案照旧。
- [ ] 实现 + `workspaceCloudStop` 三处接线。绿 + `npx tsc --noEmit`。提交 `feat(desktop): 云会话 say/approve 等真回执再 resolve，加 stop（#957 第三批）`

### Task 4: 渲染层——停止按钮、审批卡与 composer 用真回执

**Files:** `src/renderer/src/store.ts`（`cloudStop`）、`src/renderer/src/components/CloudSessionPage.tsx`、`src/renderer/src/lib/cloudTimeline.ts`（`canStopTurn`）；`tests/renderer/cloudTimelineLabels.test.ts`

- [ ] 测试（纯逻辑）：`canStopTurn(turn, selfUid, cs)` 发起人 / owner 真，其他假；`state !== "ready"` 假。
- [ ] UI：`PendingTurnLines` running 行加「停止」（`Button variant="ghost" size="xs"`，同审批卡按钮尺寸），点击 `cloudStop()`，回执前禁用，`ok:false` 文案画在该行末尾；审批卡 `ok:false` 当场恢复并显示 message（第二批的兜底保留）；composer 逻辑不变（它已按 `ok` 清草稿）。
- [ ] 提交 `feat(desktop): 云会话「停止」按钮；审批卡与 composer 吃真回执（#957 第三批）`

### Task 5: ADR-0227 + 索引

- [ ] `docs/adr/0227-工作区多智能体自查第三批.md`（决策：一次进位带三样；停只停这一轮不清队列；归档顺带停；回执不复用 error；桌面 15 s 超时 = 不知道；否决：双版本兼容 / 清队列 / 让 archive 等 turn 跑完；已知代价：旧桌面在发版前看到 version_mismatch、`pendingSay` 不排队、A-7 冻结仍在（#959）、清队列没做）；AGENTS.md `services/runtime/` 与 `cloudSession.ts` 两条索引各补一句；CONTEXT.md「回执帧」一条；`npx vitest run tests/docs/`；提交。

## 自查记录

覆盖 A-2 / A-8 / #964 / #927 根因。类型：`stop_result`/`say_result`/`approve_result` 在 T1/T2/T3 同名；`CloudSession.stop` 返回值三态在 T2 内一致；`canStopTurn` 在 T4 内一致。顺序 1→2→3→4→5（3 依赖 1；4 依赖 3）。
