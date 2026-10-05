# 管理员车道与镜像卡（#1605）

> 跨主场找对面的管理员，今天要么没发出去却说发了（#1610 收紧了说话），要么到了对面主人也看不到来龙去脉。
> 这份 spec 定的是第 2 / 3 条：管理员之间的往来放一条**独立的管理员车道**，两位主人各看一张**带镜像的卡**，对面主人不批 **24 小时**算失败。

## 0. 维护者已拍板（2026-10-05，会话里）

1. 管理员↔管理员的往来放独立的管理员车道（每对好友一条，两位主人都能点开，默认折起），不在公开车道里。
2. 镜像卡**带到目前的结果**：发起主人的那句原话 + 发起管理员的说明 + 结论；中间过程不带。
3. 对面主人不批 24 小时算失败，发起方任务卡标「对面没回」。

## 1. 已验前提（2026-10-05，只读核过）

- 今天的跨主场只有车道桥：A 的管理员 `invite_collaborator` → `laneBridge.send` → 落进 **B 公开给 A 的那条车道**，是 B 那边的一条客人轮（`services/runtime/src/laneBridge.ts:43-88`，`daemon.ts:1251-1292`）。
- **客人轮里 B 的管理员每一把刀都要 B 批**（`sessionService.ts` 的 `supervisedTurn` / 工具包装那一行，ADR-0358 第 2 条），接力轮的审批超时是 120 秒（`approvalRouter.ts` `RELAY_APPROVAL_TIMEOUT_MS`），而**朋友私聊页没有审批卡**（#1526 一直没做，`docs/adr/0356` 与 docs map 都写着「没有」）。
  → 结论：B 的管理员只要想查一下日程 / 文件就卡在一张 B 永远看不到的审批上，两分钟后这一轮失败。**这不是幻觉，是机制上跨主场的协作只能「纯嘴答」**。B 不在线时连嘴答都没有——这就是截图里「Stan 的管理员并没有去找他」。
- `workspace_sessions` 一个主场对一个 peer 只允许一行 `pair`（0056 的 `ws_sessions_one_pair_per_peer_v2`）；`chat_kind` 有 check。管理员车道要么是新的 `chat_kind`，要么改索引。
- 没有任何「引用另一条对话」的事件形状：`dispatchQuote` 是拼进文本的（ADR-0352）；外联是**双写**（`OutreachEvent` 一份在原聊天带 `transcript`、一份在外联会话带 `originSessionId`，`outreachHub.ts`）——这是镜像能照抄的先例。
- 智能体只能在自己主场的 runtime 里跑（工作区 / wiki / 记忆都在那）：**不存在一条两家管理员共用的会话**，任何「一条车道」在底下都是两份日志互相镜像。

## 2. 它是什么（一句话 + 三个不同）

**管理员车道** = 每对好友之间、两家管理员私下说话的地方；两位主人都看得到全文，但它折在朋友私聊页里，不是主聊天。
**镜像卡** = 主聊天里唯一露出来的东西：一张卡说「谁的管理员找我的管理员、为什么（主人的原话）、要我这边做什么、到目前的结果」，带 **接 / 不接**。

与今天的三个不同：

| | 今天（ADR-0358 / 0368） | 这份 |
|---|---|---|
| 往来放哪 | B 公开给 A 的车道里，和主人的话混在一起 | 独立的管理员车道，默认折起 |
| B 那边怎么动 | 客人轮，每把刀要 B 批，没有审批卡，120 秒超时 | B 点「接」= **B 自己点起的一轮**，刀按 B 自己的规矩用，不再是客人轮 |
| B 看到什么 | 一句 `[协作邀请 t_…]` | 镜像卡：原话 + 说明 + 结果 + 接 / 不接 |

## 3. 形状

### 3.1 会话：一对好友两份日志，互相镜像

- `workspace_sessions.chat_kind` 加 `'admins'`（migration 0064：扩 check、`ws_sessions_one_admins_per_peer on (workspace_id, peer_uid) where chat_kind='admins'`）。**每家各一行**：A 的主场里一条 `admins/peer=B`，B 的主场里一条 `admins/peer=A`。名单固定 `[admin]`，`humans = [peer]`（对面主人是客人、只读）。
- 两份日志靠桥互相镜像：A 的管理员在 A 那份里说一句 → `adminLaneBridge.send` → 落进 B 那份，形状同今天的车道桥（`user_message` + `relay{fromAgentId, depth}` + 标签「雨姐（继爸的管理员）」）。深度 6 / 每小时 30 / 两边都得有管理员——**四道闸原样复用**（ADR-0358 第 3 条），不另写。
- 今天的公开车道**不动**：主人和对面管理员直接说话还走那条；`invite_collaborator` 改走管理员车道（§3.3）。

### 3.2 两个新事件（都在管理员车道那份日志里，两边各一份）

```ts
/** 协作请求（镜像卡的事实）。A 那份由 invite_collaborator 落；B 那份由桥镜像过去（同 requestId） */
interface CollabRequestEvent extends SessionEventBase {
  type: "collab_request";
  requestId: string;           // 两边同一个
  taskId: string;              // A 主场里那条任务（B 那份只记 id，不解析）
  title: string;
  /** 镜像：发起主人的那句原话 + 发起管理员的说明（拍板 2） */
  quote: { ownerName: string; ownerLine: string; note: string };
  /** 到目前的结果（拍板 2）：A 的管理员邀人时任务里已有的结论，没有就空串 */
  result: string;
  expiresTs: number;           // ts + 24h（拍板 3）
  byAgentId: string;
  ignorable: true;
}
/** 对面主人的决定 / 超时。B 点的落 B 那份、镜像回 A；超时由 runtime 两边各落一条 */
interface CollabDecisionEvent extends SessionEventBase {
  type: "collab_decision";
  requestId: string;
  decision: "accepted" | "declined" | "expired";
  byUid: string | null;        // 超时 = null
  ignorable: true;
}
```

登记清单同 `task_*`（KNOWN / agentView keep / persistencePolicy / PRIVACY strip / PEN executor / contextEstimate 不计 / cloudTimeline 藏 / deriveMessages：`collab_request` 投影成一句「[协作请求 r_…] …」给 B 的管理员读，`collab_decision` 投影成「[对面主人：接了 / 不接 / 没回]」给 A 的管理员读）。
`tasks.ts` 的 fold：`collab_decision` 不动任务状态，只把 `collaborator.state` 推成 `pending | accepted | declined | expired`——任务卡上「协作：Stan 的管理员 · 等 TA 点头 / 在办 / 不方便 / 对面没回」。

### 3.3 发起这一侧（A）

`invite_collaborator(taskId, note)` 改做四件事（工具面不变，只换落点）：
1. 从 A 那条任务的日志里取**主人点起的那句**（`task_created` 之前最近一条主人的 `user_message`，或任务 `brief`）当 `quote.ownerLine`；任务里已有的 `summary` / 最后一条 `task_progress` 当 `result`。
2. 在 A 的管理员车道落 `collab_request`，同时落 `task_collab`（今天就有）。
3. 桥镜像 `collab_request` 到 B 的管理员车道（B 那份不触发任何一轮——**没有「接」之前 B 的管理员不动**）。
4. 回执：「已交给 Stan 的管理员，等 Stan 点头；24 小时没回算失败」（#1610 那句的机制版）。

### 3.4 对面这一侧（B）

- B 的朋友私聊页出一张**镜像卡**（从 B 的管理员车道日志折出来，同 `laneTasksOf` 的路子）：
  「继爸的管理员 雨姐 找你的管理员」/ 原话「@我的管理员 你带上 Stan 的管理员…」/ 说明 / 结果「9 月 $78,807.51 …」/ **接 · 不接**。
- **接**：手机落 `collab_decision accepted`（B 自己的 uid），runtime 以 B 的名义在 B 的管理员车道点起一轮——`greeting: "collab_accept"`、点名 admin、`currentInitiator = B`。这是**主人轮，不是客人轮**：刀按 B 自己的审批规矩，B 看得见自己的审批卡（主聊天那套）。B 的管理员按 `collabAuthPrompt` 的档位答（ADR-0368 第 2 条不变）。
- **不接**：落 `declined`，镜像回 A；A 的管理员读到「[对面主人：不接]」，按没有继续、告诉 A（今天的提示词已这么说）。
- B 的管理员每一句回复都镜像回 A 的管理员车道（桥），A 的管理员读到后 `report_task` 把结论写进 A 的任务——A 的任务卡「结果」一栏变。

### 3.5 24 小时（拍板 3）

runtime 一个扫描（同 `reportScheduler` 的样子）：`collab_request` 落了、`expiresTs` 过了、还没有同 `requestId` 的 `collab_decision` → 两边各落 `expired`。A 的任务卡「协作：Stan 的管理员 · 对面没回」，A 的管理员下一轮读到「[对面主人：没回]」告诉主人。B 那张卡变灰「已过期」，按钮没了。

### 3.6 手机

- 朋友私聊页：镜像卡（新 ChatRow `collab`，与任务卡并排按时间合成）；页底一行可折的「管理员之间 · N 条 ›」进 `AdminLaneScreen`（只读全文 + 谁在说；主人不在这里说话——要说对自己的管理员说）。
- 接 / 不接写 `collab_decision`：走 `ShellBridge` 的云会话 `say`（greeting 形状），不直接写事件表。
- 两位主人都能点开，但**只有 B 看得到按钮**（`byUid` 必须是请求的对面主人；runtime 校验）。

### 3.7 隐私

镜像里只有三样：发起主人**那一句**原话、发起管理员写的说明、任务里已经形成的结论。A 的其余过程（店铺管家的中间结果、A 家的别的任务）不进镜像。A 主人那句原话点了名（「带上 Stan 的管理员」）即视为授权带过去；没点名的，管理员只带自己写的说明（`ownerLine` 为空串）。管理员车道全文两位主人都看得到，所以管理员在里面说的每一句都是「对面主人也在听」——`collabAuthPrompt` 加这一句。

## 4. 分期

| 期 | 内容 | 能不能 OTA |
|---|---|---|
| **1 卡 + 接 / 不接 + 24h** | 0064、两个事件 + 登记、`invite_collaborator` 换落点、B 的「接」= 主人轮、超时扫描、手机镜像卡（卡从管理员车道日志折出） | 表与 runtime 不能；手机能 |
| **2 车道可见** | `AdminLaneScreen` 只读全文、折叠行、任务卡「协作：… · 状态」 | 能 |
| **3 群** | 群里的桥与 N 人协作（ADR-0368 「没做」那条）另开 spec | — |

## 5. 否掉的备选

- **一条两家共用的会话**：智能体跑在自己主场的 runtime 里，共用会话意味着一家的管理员要读另一家的工作区——不存在。两份日志互相镜像是唯一形状（外联双写的先例）。
- **留在公开车道、只加镜像卡**：卡解决了「懵」，解决不了「客人轮每把刀要批、没有审批卡、120 秒超时」——B 的管理员还是只能嘴答。
- **只做 #1526 的审批卡**：解决了刀，解决不了「懵」，而且 B 要在不知道为什么的情况下批一把刀。
- **24 小时改短 / 改成通知对面**：对面不在线就是不在线；通知走今天的推送（对面有卡就有推送），超时只是收口。

## 6. 推翻它的前提

- 如果 B 的「接」能做成**不开新一轮、直接解除客人轮的审批**（即 #1526 做出来并且让客人轮按主人规矩走），§3.4 的主人轮可以省掉——但那等于让 B 替 A 的请求背全部审批，今天的 ADR-0358 明确不要。
- 如果 `workspace_sessions` 以后不再按 `(workspace_id, peer_uid)` 唯一，`admins` 可以并回 `pair` 加一个 `facing='admins'`——形状不变，只是少一个 `chat_kind`。
