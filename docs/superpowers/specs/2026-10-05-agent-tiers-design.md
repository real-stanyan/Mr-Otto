# 智能体分级调度制（L0 管理员 / L1 专员 / L2 子工）—— 设计

- 日期：2026-10-05
- Task issue：#1571
- 维护者原话（2026-10-05）：「OTTO 中的 AGENT 需要有等级之分，比如管理员是最高级，管理所有 AGENT 以及所有任务，那么其他 AGENT 就要有第二级、第三级。我希望 OTTO 中 AGENT 制度是严格的，完成任务是高效的，而不是每个 AGENT 都可以跨界完成各种任务。比如我下发一个我明天要出游的任务，那么管理员 AGENT 就要快速分配任务给相对应的 AGENT，如果没有管理员就自己创建一个。」
- 关系：账号级智能体（ADR-0297）、主场免审（ADR-0298）、接力与刹车（ADR-0223 / 0238）、好友代办只认管理员（ADR-0363）、子 agent 不能再派子 agent（ADR-0047）、定时任务（ADR-0359）、聊天页收口与状态行（#1566）
- 范围：**shared 判据 + Supabase schema + 云 runtime + 手机端**。桌面只跟着 schema 读、不做新 UI（另开 issue）。

## 0. 维护者已拍板（2026-10-05，会话里）

1. **管理员可以自己动手**——前提是它判断这是一件非常简单的任务；复杂的拆开派给专员。
2. **没有对应域的专员时，管理员建议建一只**（弹一张卡，主人一点就建）；不自动建、不退回说「没人能干」。
3. **L2 要做，但 L2 不进智能体列表**：列表（通讯录 / 聊天页的「智能体」格）只显示 L0 与 L1；L2 只在它上级那只 L1 的资料页里显示。
4. **职责域 = 固定清单 + 可加自定义**。
5. **上线后之前所有智能体清除，重新来过**——不做迁移、不做「未分配」兜底。
6. **先把能 OTA 的先推上去**。
7. **除管理员外都能删**（追加，同日）：沿 0021 的策略；删 L1 连带删它的 L2。

## 1. 已验前提（2026-10-05，只读核过）

- 今天的智能体是**扁平的**：`workspace_agents` 没有等级、没有域、没有上下级；任何一只都能被 @、都能用自己白名单里的工具。唯一的特殊角色是 `admin`（`ADMIN_AGENT_ID`，0021 触发器 seed、`ADMIN_CANNOT_DELETE`），但它**没有任何特权**。
- 代办（ADR-0363）已经是「管理员 → 专员」的雏形：`delegationRoster` 把管理员排第一、`guestTargetsInLane` 把客人点名改到管理员、`delegationRolePrompt` 按身份加提示词——**但只在公开给好友的车道里生效**，主人自己的主场里仍是扁平的。
- 接力：`relayAfterTurn`（`sessionService.ts:87`）扫这只说的话、@ 到谁就落一条 `agent_relay`；`decideRelay`（`agentRelay.ts:212`）只看棒数 / 预算 / 空转，**不看谁派给谁**。这就是「横向 / 越级」要加闸的位置。
- 工具：`filterGrantedByAllow`（`agentToolAllow.ts`）按 `tools: AgentToolAllow[]`（连接器 → 工具名）过滤，在 `sessionService.ts:214` 装进 spec——**只有连接器粒度，没有「域」**。内置工具（读写文件 / bash）不在这份白名单里，等级闸要连它们一起管。
- 自起 turn 只有一条路（ADR-0359 §1 核过）：往日志追加带 `mentions` 的 `user_message`（可带 `relay` / `greeting`）→ `coordinator.enqueue` → `startDrain`。派任务走的就是它，不新开路。
- 状态：`agent_activity` 每条会话每只一行（ADR-0330），#1566 之后手机智能体页按它画「执行中 · 在〈群名〉」——**没有「任务」可挂**，要挂得先有任务实体。
- 最新 migration 是 0059；`profiles.public_agent_id`（0057）是「代办目标」的开关，这一设计不动它的语义。
- 手机建智能体的表单在 `src/shared/agentSettingsForm.ts`（`AgentForm` 五格）+ `mobile/src/agent/NewAgentDialog.tsx`；没有「域」那一格。
- 定时任务（0058）由 runtime tick 起 turn，开场白 `fromUid` 是主人——任务实体不能跟它冲突：routine 是「什么时候起」，task 是「起了之后干什么、派给谁」，两张表、两个概念。

## 2. 制度

### 2.1 三级

| 级 | 叫法 | 几只 | 接谁的活 | 能派给谁 | 工具 |
|---|---|---|---|---|---|
| **L0** | 管理员 | 每主场**有且只有一只**（`admin`），缺了自愈 | 主人、好友（代办） | L1 | 全部（它判断「非常简单」时自己做；判据写在提示词里，见 §5） |
| **L1** | 领域专员 | 主人建的，每只一个**主域** | 主人直接说的、L0 派的 | 自己的 L2 | 自己域里的 |
| **L2** | 子工 | L1 的下属（`parent_agent_id` 指着那只 L1） | 自己上级那只 L1 派的 | 没有（ADR-0047） | 自己域里的，且 ⊆ 上级的 |

**方向**：派活只能往下一级，报结果只能往上一级。兄弟之间（L1↔L1、L2↔L2）**不接力**。越级（L0 直接派 L2、L2 直接报 L0）也不行——L2 的结果由它的 L1 汇总后上报。

**主人是例外**：主人直接 @ 任何一只都行（主权）。但那只仍**不越域**：L1 / L2 收到域外的事，不做，回一句「这不归我，已转管理员」并真的 @ 管理员（这一条 @ 是允许的「上报」）。

### 2.2 职责域

固定清单（`src/shared/agentDomain.ts`，键是英文、显示是中文）：`travel 出行` / `writing 写作` / `support 客服` / `ops 运维` / `dev 开发` / `finance 财务` / `life 生活` / `research 调研` / `design 设计` / `schedule 日程`。**加自定义**：`custom:<名字>`（≤ 12 字，NFKC + trim，同一主场不重名）。

每只 L1 / L2 一个**主域**（`domain`，非空）。L0 的 `domain` 固定为 `admin`。域不是标签云：一只一个域，匹配才可靠；一只想干两个域的活就建两只。

**工具与域的绑定**：`domainTools(domain)` 给出这个域的默认工具面（内置工具 + 连接器类别），建智能体时按域预填 `tools`，主人可以收窄、**不能越出域的面**（表单层与 runtime 层各判一次，同今天的名字校验分两层）。自定义域的默认面 = 只读工具，主人自己加。

### 2.3 硬闸（runtime 卡，不靠提示词）

| 闸 | 位置 | 规则 |
|---|---|---|
| 接力方向 | `relayAfterTurn` 落 `agent_relay` 之前 | `canDispatch(from, to, roster)`：L0→L1 ✓、L1→自己的 L2 ✓、L1→L0 ✓（上报 / 转交）、L2→自己的 L1 ✓；其余一律丢弃并落一条系统旁白「X 不能直接找 Y」。主人点名不经过它 |
| 工具域 | tool middleware（`filterGrantedByAllow` 那一层）| `inScope(agent, tool)`：L0 全部；L1 / L2 只有 `domainTools(domain)` ∩ 自己的白名单；L2 再 ∩ 上级的。不在面里的工具**模型看不见**（不是调用了再拒） |
| 管理员自愈 | runtime 开房 + 手机 `ensureHome` | 主场里没有 `admin` 行就补一行（名字「管理员」、tier 0、domain admin）。0021 的触发器在建主场时已 seed，这一条是对删库 / 手工误删的兜底 |
| 唯一 L0 | DB 部分唯一索引 | `(workspace_id) where tier = 0` 唯一；`agent_id = 'admin' ⇔ tier = 0` 用 check 约束钉死 |
| 删除 | `deleteAgentEverywhere` | 删 L1 连带删它的 L2（fk cascade）；删之前列表上说清「连同 N 只子工」 |

### 2.4 任务实体（event-sourced）

任务是**事件**，先落日志再投影（Hard rule）。事件落在**管理员那条私聊**的会话日志里（任务由它建、由它收口，一个任务的全生命周期在一条日志里可重放）：

| 事件 | 字段 | 谁落 |
|---|---|---|
| `task_created` | `taskId` / `title` / `parentTaskId?` / `brief` | L0（工具 `create_task`） |
| `task_assigned` | `taskId` / `toAgentId` / `sessionId`（派到哪条会话） | L0 / L1（工具 `assign_task`；runtime 同时落 `agent_relay` + 带 `relay` 的开场白，开场白里带 `taskId`） |
| `task_progress` | `taskId` / `note` | 被派的那只（工具 `report_task`） |
| `task_done` / `task_failed` | `taskId` / `summary` | 被派的那只 |
| `task_needs_owner` | `taskId` / `question` | 任何一级（这一条出一张卡给主人） |

投影 `tasks` 表（migration 0061，runtime 写、客户端读）：`id` / `workspace_id` / `parent_id` / `title` / `assignee_agent_id` / `session_id` / `status`（`open` / `assigned` / `running` / `needs_owner` / `done` / `failed`）/ `created_at` / `updated_at`。**客户端只读这张表**，不自己折日志。

状态行从它来：`agent_activity` 那一行有 `session_id` → 查 `tasks` 里 `assignee = 这只 and session_id = 那条 and status in (assigned, running)` → 「执行中 · 任务：明天出游 › 订票」。没有任务的照旧「执行中 · 在〈群名〉」。

**SessionEvent schema 加五种 type，向后兼容**：旧日志没有它们照常重放；旧客户端对认不出的 type 按今天的规矩跳过（`events.ts` 线上只浅校验 base 四格）。

### 2.5 一次完整的派发

主人对管理员说「我明天要出游」：

1. L0 判断：不是「非常简单」→ `create_task`「明天出游」→ 拆 `create_task` × 4（天气 / 路线 / 订票 / 打包）
2. 按域匹配：`travel` 有专员「出行」→ 前三个 `assign_task` 给它；`life` 没人 → `task_needs_owner`「建一只生活助理？」（一张卡，主人点「建」= 走现成的建智能体，预填 domain `life`，建完 L0 接着派）
3. 「出行」收到带 `taskId` 的开场白，在**自己的私聊**里干（不开群——群是主人要看过程时才开）；要订票这种动作，若自己有 L2「订票员」就 `assign_task` 下去
4. 每只 `task_done` → L1 汇总自己那几件 → `task_done` 父任务那一段 → L0 收齐**一次**对主人总结；中途要拍板的（订哪趟车）→ `task_needs_owner` 一张卡
5. 手机：智能体页上「出行」显示「执行中 · 任务：明天出游 › 订票」；管理员私聊里一张任务卡（父任务 + 子任务进度）

刹车原样：每次派发是一棒 `agent_relay`，24 棒 / 预算闸 / 空转探测（ADR-0238）一条不少。分级**减少**棒数（不再乒乓），不是放开。

## 3. 清除与重来（拍板第 5 条）

上线这一版 = migration 0060 里 **`delete from workspace_agents where agent_id <> 'admin'`**（连带 cascade：会话名单、routines、shares、activity），管理员行补 `tier = 0, domain = 'admin'`。主人打开 app 看到的是只有管理员的主场 + 一句说明「智能体制度升级了，重新建你的专员」。**不留旧数据、不做迁移**——维护者原话。生产跑之前在 issue 里再确认一次（这一条不可逆）。

## 4. Schema（migration 0060 / 0061）

```sql
-- 0060_agent_tiers.sql
alter table workspace_agents
  add column tier smallint not null default 1 check (tier in (0, 1, 2)),
  add column domain text not null default 'custom:未分配',
  add column parent_agent_id text null;
alter table workspace_agents add constraint workspace_agents_admin_tier
  check ((agent_id = 'admin') = (tier = 0));
alter table workspace_agents add constraint workspace_agents_l2_parent
  check ((tier = 2) = (parent_agent_id is not null));
alter table workspace_agents add constraint workspace_agents_parent_fk
  foreign key (workspace_id, parent_agent_id) references workspace_agents (workspace_id, agent_id) on delete cascade;
create unique index workspace_agents_one_admin on workspace_agents (workspace_id) where tier = 0;
-- 清除（§3）
delete from workspace_agents where agent_id <> 'admin';
update workspace_agents set tier = 0, domain = 'admin' where agent_id = 'admin';
```

`0061_tasks.sql`：§2.4 那张表 + RLS（主场成员可读；只有 runtime 的 service role 可写）。

## 5. 提示词（`src/shared/tierPrompt.ts`，替换 `delegationRolePrompt` 的主场那一半）

- **L0**：「你是 {主人} 的管理员。主人的要求你先判断：**一句话能答完、不用动手、不用查**的直接做；其余拆成任务派给专员（现有专员与域：…）。没有合适的域就提议建一只（`task_needs_owner`）。派出去的事你不做，等结果汇总；一次只给主人一份总结。别替主人答应任何事。」
- **L1**：「你是 {主人} 的 {域} 专员。只做 {域} 的事；主人直接说的域外的事回『这不归我，已转管理员』并 @管理员。管理员派的任务带 taskId，做完 `report_task`。你有子工：…（可 `assign_task` 给它们）。」
- **L2**：「你是 {上级} 的子工，只做 {域} 里 {上级} 派的事，做完报给 {上级}，不找别人。」

好友车道里的那一段（ADR-0363）照旧，只把「主人指定的代办智能体」改成「按域派给对应的专员」。

## 6. 手机端

- 建智能体：`AgentForm` 加 `domain`（固定清单九宫 + 「自定义…」）与 `tier`（在 L1 资料页里点「加子工」才出 L2，`parent` 自动填）。
- 列表（通讯录「智能体」段、聊天页「智能体」格、AgentChats 页）：**只画 tier ≤ 1**（`visibleAgents(ws)` 纯函数，所有列表共用）；L1 资料页加一段「子工」列它的 L2。
- 智能体页状态行：§2.4 的任务优先于群名。
- 管理员私聊：任务卡（父任务 + 子任务进度 + needs_owner 的按钮）。
- **能 OTA 的**：以上全部是 JS。**但要等 0060 / 0061 跑过、runtime 部署之后**才有字段可读可写——先发 OTA 的话手机写不进 `domain`（PostgREST 对不存在的列报错）。顺序只能是：migration → runtime → OTA。

## 7. 落地顺序（每步一个 PR）

| 步 | 内容 | 能不能 OTA |
|---|---|---|
| 1 | `agentDomain.ts` / `agentTier.ts`（`canDispatch` / `inScope` / `visibleAgents` / `domainTools`）+ `tierPrompt.ts` + 测试；migration 0060 / 0061 | 不是（库） |
| 2 | runtime：接力方向闸、工具域闸、ensureAdmin、`create_task` / `assign_task` / `report_task` 三个工具、tasks 投影 | 不是（部署） |
| 3 | SessionEvent 加五种 task 事件（向后兼容）+ 时间线画任务卡（手机 + 桌面读） | 手机那半能 |
| 4 | 手机 UI：建智能体选域、列表只画 L0 L1、L1 页画 L2、状态行挂任务、管理员私聊任务卡 | 能（等 1、2 上线后发） |

## 8. 否掉的备选

- **等级只写在提示词里**：模型「觉得」不该跨界 ≠ 不能跨界；维护者要的是「严格」，闸必须在 runtime（同 ADR-0363 否决「只在手机上收口」的理由）。
- **任务用独立的表不走事件**：违反 Hard rule（先落日志、投影可推导）；而且任务的来龙去脉本来就在管理员那条日志里，重放即审计。
- **自由文本域靠模型匹配**：不可靠，匹配错了就是「跨界」。固定清单 + 自定义。
- **旧智能体迁移成「未分配」**：维护者选了清除重来。

## 9. 推翻它的前提

- 哪天主场允许多只管理员（分部门）→ §2.3 的唯一索引与 `admin` 字面量都要重想。
- 哪天 L2 也要出现在列表里 → 只改 `visibleAgents`，闸不动。
- 哪天任务要跨主场（派给朋友的专员）→ 任务事件得落在两条日志里，§2.4 的「一条日志可重放」不再成立。
