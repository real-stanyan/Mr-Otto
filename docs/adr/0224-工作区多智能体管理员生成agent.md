# ADR-0224：工作区多智能体的管理员生成 agent（切片 6）——只挂管理员、卡片逐字段全文、created_by 是点火的人、不新增事件类型

- 状态：已采纳
- 日期：2026-09-05
- 关联：issue #954（切片 6）；设计稿 `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md` §3 / §4.2 / §9 / §10；实现计划 `docs/superpowers/plans/2026-09-05-workspace-multi-agent-6.md`；先例 ADR-0118（`mcp_configure` 必过审批门、卡片逐字段）、ADR-0222（云侧工具只依赖注入的读写口）、ADR-0220（名册每 turn 现取）、ADR-0202（每次现读不定死）；编号按 ADR-0074 在合并前复核

## 背景

切片 1–5 之后，建 agent 只有桌面设置页一条路。用户原话（#928）里还有一句：「用户也可以叫管理员生成用户自己描述的 Agent」。spec §10 把它排在最后一片：`create_agent` 工具过审批门（同 ADR-0118），只有管理员那只有。

## 决策

### 1. 只挂在管理员那台 engine 上，判据是 `agentId === 'admin'`

`sessionService.engineFor` 按 `spec.agentId === ADMIN_AGENT_ID` 决定工具表里有没有这把刀。判据是稳定键不是名字（名字随时能改；`'admin'` 是 0021 触发器种下、RLS 与 `validateAgentName` 共用的同一个字面量）。**否决**「任何 agent 都能建」：spec §10 原话；且接力链里一只 agent 能生出另一只再 @ 它，等于绕过棒数上限造工作量。

### 2. 必过审批门，卡片逐字段、提示词**全文**

`requiresApproval: true`。审批卡文案不走 `approvalRouter` 默认的 `JSON.stringify(args).slice(0, 200)`——一条 4000 字的提示词截成 200 字，等于让人批一段没看见的提示词（ADR-0118 第二条：卡片含糊 = 闸形同虚设）。于是 `ApprovalRouterOpts` 多一个可选 `summarizeArgs` 钩子，`create_agent` 走 `createAgentApprovalSummary`（名字 / 职责 / 型号 / 连接器 / 提示词全文），别的工具一字不变。参数不合法时卡上直接说「批准也会失败」，人先看见比批完再报错省一次审批。代价：一张卡可以有 4000 字，桌面那张卡的 `<p>` 是 `whitespace-pre-wrap` 会被撑长——接受，上限就是为此定的。

### 3. `created_by` = 点火的那个人

spec §4.2 不给 agent 发伪 uid。工具在 `run` 那一刻现取 `currentInitiator`（接力链里也是点火的人），查不到就拒绝而不是伪造。后果按 §9 矩阵：那个人与 owner 能改/删这只 agent——与他在桌面上亲手建的完全一样。

### 4. 校验比桌面表单严，且不 fail-open

模型是写入方，形状不对一律抛人话让它改：`tools` 严格 `[{serverId, tools: string[]}]`，**不**复用 `normalizeAgentTools` 的「形状不对整份回 []」——那条 fail-open 的前提是「唯一写入方是带类型的 IPC」，而 `[]` 在这张表里的意思是整池放行。职责/提示词过 `scanThreat`（提示词会成为永久 system 提示）。上限：职责 200、提示词 4000、型号 8。型号 id **不校验**存不存在（同桌面表单「这里不校验」的口径，真闸在网关）。

### 5. 不新增事件类型；桌面靠反查刷新名册

桌面的名册住在 `WorkspaceSnapshot.agents`，没有推送通道。**否决**新增 `agent_created` 事件——那是十一处检查清单的代价，而日志里已经有 `assistant_message.toolCalls` + `tool_result` 两条能反查出「create_agent 落地了」。`createAgentLanded` 看到 `tool_result{ok}` 配对到 `create_agent` 就 `refreshWorkspaceGroups()`。代价：日志被裁过（找不到配对的 tool_call）时不刷新，人手点一次刷新。

### 6. 不加 migration

daemon 用 service key 直插 `workspace_agents`；RLS 是桌面那条路的闸，在籍闸在 frameHandler 已经过了（同 ADR-0222 决策 5 的口径）。agentId 与桌面同一形状（`a_` + 12 hex）。

## 已知代价（接受）

- **重名在审批之后才报**：`run()` 在审批之后跑，没有审批前预检的钩子；人批了一张卡换来一句「已有同名」，模型换名再弹一张。工具描述里要求先看花名册，缓解不根治。
- **别的 agent 的花名册不因新成员而重发**：`briefIfNeeded` 只在 `instructions` 变了才重 brief（ADR-0219 既有行为，桌面建的也一样）。管理员自己从 tool_result 知道，其余 agent 要等各自提示词变了才看见新同伴。
- **模型给的 `models` 不校验**：写错的型号 id 在那只 agent 第一次开口时才报错（同桌面）。
- **一张 4000 字的审批卡**：见决策 2。

## 推翻它的前提

- 若「只有管理员能建」被证明太窄（用户成规模地让运营 agent 自己拉帮手）——那时该谈的是接力链里的建 agent 配额，而不是把这把刀发给所有人。
- 若审批前预检成了刚需（重名反复浪费审批）——`approvalGate` 该长出一个 `preflight` 钩子，而不是在 `summarizeArgs` 里偷偷做副作用检查。
- 若名册开始高频变动（十几只 agent、多人同时建）——反查刷新会变成每条 tool_result 扫一遍日志，那时该加推送（`cs_event` 之外的一条名册帧），或者把它做成事件类型。
