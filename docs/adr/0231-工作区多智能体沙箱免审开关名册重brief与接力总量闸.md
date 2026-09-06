# ADR-0231：工作区多智能体——沙箱内工具的工作区级免审开关、名册变了重 brief、一次点火的接力总量闸

- 状态：已接受
- 日期：2026-09-06
- 关联：issue #977；上游 ADR-0199（容器是隔离面）/ 0200（凭据不进容器）/ 0219（brief 与隔离）/ 0223（接力两层刹车）/ 0224（create_agent 的已知代价）/ 0225（D8：自带 key 路无花费天花板；A-7：审批冻结）/ 0230（第五批）
- 来源：第五批合并后对整套工作区多智能体逻辑的一次全量复审（会话内评估，十条候选里选了三条）

## 背景

复审把「已知代价」之外没被记账的问题排了序，前三条是：

1. **云端每一次 `bash` / `write_file` 都要人批。** `src/loop/approvalGate.ts` 只看 `tool.requiresApproval`；runtime 的 `approvalRouter` 没有桌面 `src/main/agent.ts` 那套 `approvalMode`（ask / bypass）和 ADR-0041 的「记住这把刀」。叠上 `drain` 串行 + 10 分钟默认超时：一只 agent 跑 10 条命令 = 群冻 10 次。而容器本来就是隔离面（ADR-0199），凭据不进容器（ADR-0200）——这道闸挡的是空气，付的是整个群的等待。
2. **名册只在 `instructions` 变时重 brief。** `briefIfNeeded` 只比对提示词；别人新建 / 改名 / 改职责的 agent 对这只永远不可见。ADR-0224 只把 `create_agent` 那一种记成已知代价，其实任何名册变化都一样。它的 roster 焊在 system 里、最新一条胜出（ADR-0225 A-3），可它一直没有「最新一条」。
3. **接力总量无闸。** `relay_max_depth` 封的是一条**分支**的长度：一轮 @ 了 N 只就分叉 N 条独立计数的链，最坏 `N^maxDepth`；自带 key 的路没有额度兜底（ADR-0225 D8）。

## 决策

### 1. 沙箱内工具要不要人批，是**工作区**一格（`workspaces.sandbox_approval`）

- migration `0026_workspace_sandbox_approval.sql`：`text not null default 'ask' check in ('ask','auto')`。owner 能改靠 0024 已有的 `ws_update_owner`，不再动策略。
- **默认 `ask` = 今天的行为一字不变**：迁移不改任何工作区的安全姿态，owner 自己在智能体 tab 翻开关。
- **只管沙箱那两把刀**（`bash` / `write_file`）。好友代理连接器用的是点火者的授权、`create_agent` 改的是工作区名册——两者不在容器隔离的射程内，照旧要批。
- runtime 侧是**包在 router 外面的一层 approver**（`sessionService.policyApprover`），不改 `approvalGate`：门只认 `requiresApproval` 这一个布尔，「谁来批、批不批」从来是 approver 的事，桌面的 `approvalMode` 也是这么包的。判据按**工具身份**（`tool === bashTool || tool === writeFileTool`）不按名字。
- **放行也落 `approval_decision`**（engine 的 `onDecision` 照旧写），`reason: "工作区设置：沙箱内工具免审"`——重放日志时一串没人批过的危险操作才解释得通（ADR-0041 那条理由）。不落 `approval_request`：卡本来就不该弹。
- **每个 job 第一次撞门时现查一次、这一轮复用**：没撞门的 turn 一次都不查；owner 中途翻开关下一轮生效（同 `relayMaxDepth`「每条会接力的 turn 现查」的纪律）。查询失败（0026 没跑、Supabase 抖）回落 `ask`——往严的一边倒。
- 桌面 `fetchWorkspace` 把 `sandbox_approval` 放在**单独一条容错查询**里，不拼进 `relay_max_depth` 那条 select：ADR-0223 部署顺序那一节的教训——拼进去的话 0026 落地前整份快照打不开。代价是每个工作区多一次单行主键查询。
- 不动 cs 协议：桌面写库、runtime 读库，两端靠表相遇（`relay_max_depth` 那条线的原路）。

### 2. brief 的判据是三样不是一样

`briefIfNeeded` 比对 `instructions` + `name` + roster 指纹（`[name, description]` 按名字排序后 JSON）。指纹排序而不是照 `workspace_agents` 的 `created_at` 顺序：判据不该押在别人的排序上。

### 3. 一次人话点火之后，整条接力总共最多 24 棒

`decideRelay` 加第二道闸：`chain.length >= RELAY_MAX_HOPS_PER_IGNITION` 回 `cap_total`，群里一句「这一轮接力总共已经 N 棒……分支太多而不是链太长」，交回给人。

- 判据就是 `relayChain` 的长度——它本来就为周期护栏算出来了，多一条比较而已；人再说一句就重置（同 depth 的语义：人话点火 = 新的授权）。
- **排在分支闸之后**：两者都命中时说「分支太长」（这一棒的直接原因）。
- 24 = 默认 depth 6 × 4：够一条 3 只 agent 全互 @ 的接力网跑完两轮护栏周期（12 跳）再喊一次，又把 `2^6 = 64` 那种展开压到三分之一。**不按 depth 派生**：owner 把 depth 调到 20 时总量不该跟着长到 80。

## 否决的备选

| 备选 | 为什么否 |
|---|---|
| 云端默认免批（`auto` 为默认） | 迁移那一刻静默改变每个存量工作区的安全姿态。默认沿用今天的行为，翻开关是 owner 的一个明确动作 |
| 改 `approvalGate`，加一个 `policy` 参数 | 门只认一个布尔，本机那条路也走它；策略是 approver 的事（桌面 `approvalMode` 就包在 approver 外面） |
| 把开关塞进 cs `config` 帧 / `workspaceConfigStore` | 要进协议版本（ADR-0221 的既有约定），桌面与 runtime 得一起发版；而 `relay_max_depth` 那条「桌面写库、runtime 读库」的路已经证明不动协议也走得通 |
| 按 agent 配免审 | 隔离面是容器不是 agent——同一个容器里两只 agent 一只免批一只要批，挡不住任何东西，只多一格要解释的设置 |
| 把 ADR-0041「记住这把刀」带上云 | `auto` 之下不需要；`ask` 之下它只是把冻结从每次变成每工具一次。要的话是另一条 issue |
| 每 turn 起跑时查策略 | 每 turn 多一次往返，而多数 turn 根本不撞门；第一次撞门时查同样是「这一轮现读」 |
| 总量闸按 `depth × k` 派生 | owner 调 depth 的意图是「一条链能多长」，不是「总共能烧多少」，两个数各管各的 |
| roster 指纹用 `created_at` 顺序直接 JSON | 排序是别人的实现细节，换一次查询顺序就是一轮多余的 brief |

## 已知代价

- **免审之下模型可以在容器里跑任何命令**（含网络访问，若容器有）。容器内没有凭据（ADR-0200），破坏面是这个工作区的工作副本；`bash` 的产物照旧进日志，人事后看得见。这是 owner 翻开关时接受的账，开关旁边那句提示说的就是这个。
- `sandbox_approval` 多一次单行查询：桌面每个工作区一次（列表刷新时）、runtime 每个撞门的 job 一次。
- 名册指纹变了就多落一条 `agent_briefed`（永久事件，打断一次前缀缓存）——名册变化本来就少。
- 总量闸命中时同一轮里后面的 target 各说一句（chain 不再长）；一轮 @ 了三只就三句。
- 0026 是外向副作用，要维护者在生产执行；没跑之前两端都按 `ask`（桌面读不到那一列、runtime 查询失败回落），开关翻了存不进去、撞「无权修改」之外的一句 DB 错误（已过 `humanizeWorkspaceError`）。

## 真机验收清单（UNVERIFIED）

1. 生产跑 0026 → 智能体 tab 出现「沙箱内免审」开关（非 owner 只读一行）；翻开 → 下一轮 @ 一只 agent 让它 `ls`：不弹卡、时间线上工具行照常、日志里 `approval_decision.reason` 是「工作区设置：沙箱内工具免审」；关掉 → 下一轮又弹卡。
2. 开着免审时让管理员 `create_agent` / 调一个连接器：照旧弹卡。
3. 新建一只 agent 后 @ 一只旧的：它的回复里认得新同伴（或让它列一遍「群里还有谁」）。
4. 两只 agent 互相 @ 不停：默认 depth 6 时先撞分支闸；把 depth 调到 20、三只互 @：第 24 棒撞总量闸，群里那句写「总共已经 24 棒」。

## 推翻它的前提

- 若 owner 普遍把开关一直开着、而「连接器仍要批」成了新的冻结点——那时该谈的是连接器级的免审（按 server 白名单），不是把这一格扩成「全免」。
- 若容器被证明能拿到不该拿的东西（网络侧信道、宿主挂载）——决策 1 的前提（ADR-0199/0200）先破，开关跟着退回 `ask` 强制。
- 若 24 在真实接力网里经常先于分支闸命中、且人认为那是正常协作——先调常量，不加第三个可配项。
