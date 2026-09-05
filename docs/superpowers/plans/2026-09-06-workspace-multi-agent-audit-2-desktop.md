# 工作区多智能体整体自查 · 第二批（桌面 + 共用校验）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把审计 B（安全）与 C（桌面）里落在桌面、主进程与三端共用校验层的 Critical/Important 修完：agent 名字与职责的服务端校验（两条写入路都过同一份）、审批卡从字符串变逐字段 DOM、审批按钮有反馈且说是哪只 agent 在要权限、连接器多步操作不吞失败、@ 输入认全角与陈旧名册、护栏注话与接力开场白在时间线上不再画成匿名人类、开局卡失败不丢草稿、历史缺口持久提示，以及一批「状态撒谎」的小修。

**Architecture:** 校验下沉到 `src/shared/`（一份 `validateAgentName` + `normalizeAgentName` + `agentNameConflict`，主进程 `workspaceManager` 与 runtime `agentRegistry` 都调）；`deriveMessages` 拼 roster 时做结构性转义（校验漏了也拼不出闭合括号）；`approval_request` 加**可选** `argsFields` 字段（旧日志无此字段照旧画 `argsSummary`），审批卡按字段各自成块；桌面状态修复全部遵守本仓的「一个界面状态不能与另一个需要不同动作的状态同形」；不新增事件类型、不动 cs 协议版本。

**Tech Stack:** TypeScript strict / vitest / React + Zustand + shadcn / Electron 主进程 / Supabase PostgREST

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`（§3、§4.6、§9）；审计报告 `.superpowers/audit/{B-security,C-desktop}.md`（gitignored，brief 里已把要点抄全）。Issues：#957、#935、#936、#938、#927（桌面侧）。ADR：**ADR-0226**。前置：第一批（ADR-0225）已合并。

## Global Constraints

- 硬规则：渲染进程只经 `ShellBridge`（新增的 IPC 只有一个：无——本批不加 IPC；`refreshWorkspaceGroups` 已有）；事件 schema 只增（`approval_request.argsFields?: { label: string; value: string }[]`、`CloudSessionStatus.gapNote?: string`）；不新增事件类型；本机会话字节不变（`user_message.origin` 的换皮只改渲染层）。
- 名字规则（B-I2 / #938②）：`validateAgentName` 新增三条——拒绝 `\p{Cf}`（零宽/方向控制）与 `\p{Cc}`；**拒绝内部空白**（名字里不能有空格/制表，@ 补全打不过空格；错误文案「名字里不能有空白」）；落库前 `normalizeAgentName(raw) = raw.normalize("NFKC").trim()`。`agentNameConflict(name, existing: readonly string[]): string | null`：同名、或**一方是另一方的前缀**（两个方向）都回错误文案「与已有的「X」冲突：一个名字不能是另一个的开头（@ 会认错人）」。这三处**主进程 `workspaceManager.createAgent/updateAgent` 与 runtime `agentRegistry` 的两个实现**都要过（runtime 需要先查已有名字：Supabase 实现 `select("name")`；内存实现看 rows）。
- 短字段（B-C2 一半）：`parseCreateAgentArgs` 与主进程校验对 `name`/`description`/`models[]`/`serverId`/工具名做 `collapseWhitespace`（`\s+` → 单个空格）再校验；`instructions` 不折。
- 审批卡逐字段（B-C2 另一半）：`ApprovalRequestEvent.argsFields?: { label: string; value: string }[]`；`ApprovalRouterOpts.summarizeFields?: (toolName, args) => { label; value }[] | null`；`create_agent` 返回五个字段（提示词是最后一个、多行）；`argsSummary` 照旧生成（旧客户端与旧日志用）。桌面 `ApprovalRow`：有 `argsFields` 就逐字段画（label 用 `text-muted-foreground` + value 各自一个 `<p className="whitespace-pre-wrap break-words">`，提示词那块外加 `border rounded-md p-2 max-h-48 overflow-y-auto`），没有就画 `argsSummary`。
- 审批按钮（C-I2 / #927 桌面侧）：`ApprovalRow` 本地 `submitting` 状态：点下去两颗钮 `disabled` + 文案「已提交，等待生效…」，`cloudApprove` 回 false 才恢复并把原因画在**卡内**；`!ready` 时两颗钮 `disabled`。卡上第一行写「「<agent 名>」请求 <toolName>」（`agentNameOf(ws, event.agentId)`；无 agentId → 现状）（C-I3）。
- 连接器弹窗（C-C1）：`doConfirm` 收集每步布尔，全成功才关；失败清单画在弹窗自己的 error 格：「贡献失败：A、B（已成功的已生效）」「撤回失败：X——这台**仍然共享给全体成员**」两句分开；`refreshWorkspaceGroups()` 循环后只调一次（store 的两个 action 加可选参数 `{ refresh?: boolean }`，缺省 true）。
- @ 输入（#935 / C-I4）：`parseMentions` 与 `mentionQueryAt` 把 `＠`（U+FF20）与 `@` 同等对待；`applyAgentMention` 下一个字符已是空白时不再补空格；选人弹层候选为空时画一行只读空态「没有叫「X」的智能体（名单可能刚变过）」+「刷新名单」按钮；`submit()` 前若 `mentionTokens(text).length > 0 && mentions.length === 0` → `await refreshWorkspaceGroups()` 后用新名单重算一次再发。
- 时间线（C-I5 / #936 / M16）：`cloudTimeline.ts` 加 `systemNoteText(e: UserMessageEvent): string | null`——`origin === "loop_guard"` → 「护栏：<agent 名或"某只智能体">在原地打转，已提醒」；`origin === "background"` → 「后台任务结果已回注」；云时间线对这类事件画成 `AgentBriefedRow` 同款审计行，不画气泡。本机时间线（`src/renderer/src/lib/` 里把 `user_message` 投影成 thread 的那处，`grep -rn "isAuditEvent" src/renderer/src/lib`）对 `origin` 在场的 `user_message` 画成系统旁白（同一判据函数）。`turn_ended{error}` 行在云页面前置 agent 名（`agentNameOf`）。
- 开局卡（C-I6）：`CloudSessionMain` 的 effect：`const ok = await cloudSay(text); if (!ok) 放回 cloudPendingFirstMessage`（store 加 `restoreCloudPendingFirstMessage(text)`，只在 `cloudSession` 仍是同一条时放回）。
- 历史缺口（C-I7）：`cloudSessionClient` 记 `welcome.lastSeq`；`backlog done:true` 合并后 `maxSeen < lastSeq` 或 error 帧含「已跳过」→ `session.gapNote = "这条会话有 N 条历史事件没能下发（服务端跳过了过大的事件）——你看到的不是全部"`；`pushStatus` 带 `gapNote`（**每次**都带，不是一次性）；`CloudSessionStatus.gapNote?: string`；`statusBanner` 有 `gapNote` 时画 muted 一行，不被 `cloudSay` 清掉。
- 小修：M8 `approval_decision` 行显示「由 <label> 批准/拒绝」（`decidedBy.label`）；M10 用量 tab 空态在 `modelRoute.kind === "workspace"` 时文案改为「这个工作区走自带 key，用量不经网关，这里不会有数」；M11 记忆 tab 超限时保存钮 `disabled` + 文案；M12 接力上限保存成功后 1.5s 内显示「已保存」；#938① `createWorkspaceAgent/updateWorkspaceAgent/deleteWorkspaceAgent` 回 `"ok" | "ok_stale" | "failed"`（`ok_stale` = IPC 成功但 refresh 失败），`AgentEditorDialog` 对 `ok_stale` 画「已保存，但列表没刷出来——点『刷新』」并保持弹窗打开；`cloudModelStatus` 两句提示对调补齐（D1 桌面半：hosted 分支写「按 agent 各自的型号白名单可能不同（白名单只在这条路生效）」，workspace 分支补「自带 key 这条路型号由所有者定，agent 白名单不生效」）。
- 提交信息写**为什么**；每任务末尾跑本任务测试；改类型的任务另跑 `npx tsc --noEmit`（runtime 相关再 `-p services/runtime`）。提交尾部两行：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01Qrfg2wsjMwpm1TNFaRGd59`。

## PR 边界

单 PR，L2。ADR-0226。合并后 `npm run runtime:deploy`（agentRegistry / approvalRouter 改了）；桌面发版顺延到第三批之后一起。

---

## 文件结构

- Modify `src/shared/workspaceAgents.ts`（名字规则）、`src/shared/createAgentDraft.ts`（折空白 + `createAgentApprovalFields`）、`src/shared/remote/agentMention.ts`（全角）
- Modify `src/main/workspaceManager.ts`、`src/main/supabaseWorkspacesApi.ts`（`listAgentNames`）、`services/runtime/src/agentRegistry.ts`
- Modify `src/session/deriveMessages.ts`（roster 转义）、`src/session/events.ts`（`argsFields`）、`services/runtime/src/approvalRouter.ts`、`sessionService.ts`
- Modify `src/shared/shellBridge.ts`（`gapNote`）、`src/main/cloudSessionClient.ts`
- Modify `src/renderer/src/lib/{agentMentionInput,cloudTimeline,cloudModelStatus,workspaceUsageView}.ts`、`src/renderer/src/components/{CloudSessionPage,CloudSessionMain,WorkspacePage,WorkspaceAgentsTab,WorkspaceMemoryTab}.tsx`、`src/renderer/src/store.ts`、本机 thread 投影那一处
- Create `docs/adr/0226-工作区多智能体自查第二批.md`；Modify `AGENTS.md` 索引、`CONTEXT.md`
- Tests：`tests/shared/{workspaceAgents,createAgentDraft,agentMention}.test.ts`、`tests/main/workspaceManager.test.ts`、`tests/runtime/{agentRegistry,approvalRouter,sessionService}.test.ts`、`tests/session/agentBriefed.test.ts`、`tests/renderer/{cloudTimelineLabels,agentMentionInput,cloudModelStatus,workspaceUsageView}.test.ts`、`tests/main/cloudSessionClient.test.ts`

---

### Task 1: 共用校验——名字规则、前缀冲突、短字段折空白、全角 ＠（B-I2 / B-C2 / #935 / #938②）

**Files:** `src/shared/workspaceAgents.ts`、`src/shared/createAgentDraft.ts`、`src/shared/remote/agentMention.ts`；tests `tests/shared/{workspaceAgents,createAgentDraft,agentMention}.test.ts`

**Produces:** `normalizeAgentName(raw): string`、`validateAgentName`（新三条）、`agentNameConflict(name, existing): string | null`、`collapseWhitespace(s): string`、`createAgentApprovalFields(d): { label; value }[]`（五项：名字/职责/型号/连接器/提示词，值与 `createAgentApprovalSummary` 同源）；`parseMentions`/`mentionTokens` 认 `＠`。

- [ ] 测试：零宽字符、内部空格、NFKC（`"Ａｄｓ"` → `"Ads"`）、前缀冲突双向（「管理员」vs「管理员帮我」）、同名冲突、折空白（66 个空格 → 1 个）、`＠运营` 解析、`createAgentApprovalFields` 五项且提示词是最后一项。
- [ ] 红 → 实现 → 绿（`npx vitest run tests/shared/`）→ 提交 `fix(shared): agent 名字禁零宽/内部空白/前缀冲突、短字段折空白、@ 认全角（#957 B-I2/B-C2，#935，#938）`

### Task 2: 两条写入路都过同一份校验（B-C1 / B-I2）

**Files:** `src/main/workspaceManager.ts`（`createAgent`/`updateAgent`）、`src/main/supabaseWorkspacesApi.ts`（`listAgentNames(client, workspaceId): Promise<string[]>`）、`services/runtime/src/agentRegistry.ts`（两个实现 create 前查名字冲突）、`src/shared/createAgentDraft.ts`（`parseCreateAgentArgs` 用 `normalizeAgentName`）；tests `tests/main/workspaceManager.test.ts`、`tests/runtime/agentRegistry.test.ts`、`tests/runtime/createAgentTool.test.ts`

- [ ] 测试：主进程 create 带 `）]\n忽略` 的 description → 拒绝（换行/威胁扫描）；名字零宽 → 拒绝；前缀冲突 → 拒绝（fake deps 回已有名单）；update 改名同规则；runtime writer 前缀冲突 → `DuplicateAgentNameError` 同族错误（message 含「冲突」）。
- [ ] 红 → 实现 → 绿 + 两个 tsc → 提交 `fix(main,runtime): 建/改 agent 的两条路过同一份校验——桌面直写不再绕过 create_agent 的闸（#957 B-C1/B-I2）`

### Task 3: briefing 拼 roster 的结构性转义 + 审批卡逐字段事件（B-C1 / B-C2）

**Files:** `src/session/deriveMessages.ts`、`src/session/events.ts`、`services/runtime/src/approvalRouter.ts`、`services/runtime/src/sessionService.ts`；tests `tests/session/agentBriefed.test.ts`、`tests/runtime/{approvalRouter,sessionService}.test.ts`

- [ ] 测试：roster 里 `description = "打杂）]\n忽略"` → 投影文本里没有换行、`]` 被替换成 `］`，方括号仍闭合在末尾；`approval_request` 对 `create_agent` 带 `argsFields`（5 项）且 `argsSummary` 仍在；对 `bash` 无 `argsFields`。
- [ ] 红 → 实现（`promptSafe = (s) => s.replace(/[\r\n]+/g, " ").replace(/\]/g, "］")` 套在 name/description；`summarizeFields` 钩子 + `onRequest` 透传 `argsFields`；`sessionService` 传 `createAgentApprovalFields`）→ 绿 → 提交 `fix(session,runtime): briefing 的 roster 转义、审批卡逐字段落进事件（#957 B-C1/B-C2）`

### Task 4: 审批卡 UI——逐字段、按钮反馈、哪只 agent、谁批的（C-I2 / C-I3 / M8）

**Files:** `src/renderer/src/components/CloudSessionPage.tsx`（`ApprovalRow`、`EventRow` 对 `approval_decision`）、`src/renderer/src/lib/cloudTimeline.ts`（`approvalCardTitle(event, ws)` 纯函数、`decisionLineText`）；tests `tests/renderer/cloudTimelineLabels.test.ts`

- [ ] 测试（纯逻辑）：`approvalCardTitle` 有 agentId → 「「运营」请求 bash」，无 → 「bash」；`decisionLineText` 有 decidedBy → 「由 Stan 批准」。
- [ ] 实现 UI（不需要组件测试）：`submitting` 本地态、`disabled={!ready || submitting}`、失败原因卡内、逐字段渲染。
- [ ] 提交 `fix(desktop): 审批卡说是哪只 agent 在要权限、逐字段呈现、点下去有反馈且不再连点报「未生效」（#957 C-I2/C-I3/M8，#927）`

### Task 5: 连接器弹窗多步失败聚合（C-C1）

**Files:** `src/renderer/src/components/WorkspacePage.tsx`（`ContributeConnectorDialog.doConfirm`）、`src/renderer/src/store.ts`（两个 action 加 `{ refresh?: boolean }`）、`src/renderer/src/lib/workspaceView.ts`（`connectorBatchErrorText(failedContribute, failedWithdraw): string | null` 纯函数）；tests `tests/renderer/workspaceView.test.ts`

- [ ] 测试：文案两句分开、都空回 null。
- [ ] 提交 `fix(desktop): 贡献/撤回连接器一步失败不再被下一步抹掉——撤回失败要说「仍然共享给全体成员」（#957 C-C1）`

### Task 6: @ 输入——全角、双空格、空态、发送前刷新（#935 / C-I4）

**Files:** `src/renderer/src/lib/agentMentionInput.ts`、`src/renderer/src/components/CloudSessionPage.tsx`；tests `tests/renderer/agentMentionInput.test.ts`

- [ ] 测试：`mentionQueryAt("你好＠运", 4)` 命中；`applyAgentMention` 下一字符是空格不再补；空态判据 `pickerEmptyState(picking, options)` 纯函数。
- [ ] 实现 + 提交 `fix(desktop): @ 认全角、补全不双空格、名单陈旧时弹空态并可刷新、发送前对认不出的 @ 先刷一次名单（#935，#957 C-I4）`

### Task 7: 时间线——护栏/后台注话换皮、turn_ended 带 agent 名（C-I5 / #936 / M16）

**Files:** `src/renderer/src/lib/cloudTimeline.ts`（`systemNoteText`、`turnEndedLineText`）、`src/renderer/src/components/CloudSessionPage.tsx`、本机 thread 投影处（`grep -rn "isAuditEvent" src/renderer/src/lib` 找到的文件）；tests `tests/renderer/cloudTimelineLabels.test.ts` + 该投影文件既有测试

- [ ] 测试：`systemNoteText` 三态；本机投影里 `origin:"loop_guard"` 的 user_message 不再是 user 气泡（按该投影既有测试的形状断言）。
- [ ] 提交 `fix(desktop): 护栏与后台注话画成系统旁白，不再是匿名人类气泡；turn_ended 说是谁的（#936，#957 C-I5/M16）`

### Task 7b: `route_changed` 在时间线上按 reason 与两端画（第一批 Task 6 复审 Minor 7）

**Files:** `src/renderer/src/components/Timeline.tsx`（`route_changed` 那一格）、`src/renderer/src/lib/cloudTimeline.ts`（`routeChangedText(e): string` 纯函数）；tests `tests/renderer/cloudTimelineLabels.test.ts`

- [ ] 测试：`{from:"hosted",to:"workspace",reason:"probe_failed"}` → 「改道：托管 → 工作区自带 key（订阅探测失败）」；`quota_exhausted` → 「（本周额度用完）」+ resetAt 有值时带「，X 恢复」；`subscription_active` → 「改回托管（订阅恢复）」；旧日志 `to:"direct"` 文案不变。
- [ ] Timeline.tsx 与 CloudSessionPage 都用这一份；提交 `fix(desktop): route_changed 说清为什么改道、改到哪（#957 第一批 Task 6 复审）`

### Task 8: 开局卡保草稿 + 历史缺口持久提示（C-I6 / C-I7）

**Files:** `src/renderer/src/components/CloudSessionMain.tsx`、`src/renderer/src/store.ts`（`restoreCloudPendingFirstMessage`）、`src/shared/shellBridge.ts`（`gapNote`）、`src/main/cloudSessionClient.ts`、`src/renderer/src/components/CloudSessionPage.tsx`（`statusBanner`）；tests `tests/main/cloudSessionClient.test.ts`（既有夹具：welcome lastSeq=7、backlog 只到 5 → status 带 gapNote；完整 → 无）

- [ ] 提交 `fix(desktop): 开局卡发失败不丢原文；历史缺口成为持久状态而不是一行会被擦掉的灰字（#957 C-I6/C-I7）`

### Task 9: 小修合集（#938① / M10 / M11 / M12 / cloudModelStatus）

**Files:** `src/renderer/src/store.ts`（三个 agent action 三态）、`WorkspaceAgentsTab.tsx`（`ok_stale` 态 + 「已保存」瞬时）、`WorkspaceMemoryTab.tsx`（超限禁保存）、`src/renderer/src/lib/workspaceUsageView.ts`（`usageEmptyText(route)`）、`cloudModelStatus.ts`；tests `tests/renderer/{workspaceUsageView,cloudModelStatus}.test.ts`

- [ ] 提交 `fix(desktop): agent 增删改「保存了但没刷出来」单列一态；用量空态与模型提示不再撒谎；记忆超限拦保存；接力上限保存有回音（#938，#957 M10–M12）`

### Task 10: ADR-0226 + 索引

- [ ] `docs/adr/0226-工作区多智能体自查第二批.md`（决策：校验下沉一份两条路都过；roster 转义是结构性兜底不是替代校验；审批卡逐字段落事件而不是渲染层拆字符串；名字禁内部空白是为了 @ 补全的确定性；缺口提示做成持久状态；已知代价：改名不重发 briefing、`argsFields` 旧客户端看不到、名字 NFKC 后与旧名可能撞——撞了报冲突不静默改）；AGENTS.md 索引补三句；`npx vitest run tests/docs/`；提交。

## 自查记录

覆盖：B-C1/C2/I2、C-C1/I2–I7/M8/M10–M12/M16、#935/#936/#938①②/#927 桌面侧、D1 桌面半。类型：`argsFields`（T3/T4）、`gapNote`（T8 两端）、`agentNameConflict`（T1/T2）一致。顺序 1→2→3→4→5→6→7→8→9→10。
