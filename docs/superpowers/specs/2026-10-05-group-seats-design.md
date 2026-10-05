# 多人多智能体群聊：每人带着自己的管理员 —— 设计（P1）

- 日期：2026-10-05
- Task issue：#1682（讨论稿 v1 与全部拍板在 issue 评论里）
- 关系：**取代 ADR-0325 的「群 = 群主主场里的一条群聊、智能体都是群主的」**；ADR-0367 第 1 条（主场群里客人点谁都改成群主的管理员）
  在新群里不再适用；ADR-0368「群里 N 个人的协作…群里的桥另开」就是这一份。复用管理员车道（ADR-0368 / admins spec）的镜像与桥。

## 0. 维护者拍板（2026-10-05 会话）

| # | 结论 |
|---|---|
| A | 不拉智能体：人进群，TA 的 L0（管理员）自动在场 |
| B | L0 之间可以协作；别人可以使唤你的 L0，**动手**要你点头；**纯聊天不用点头** |
| C | L1 只听拉它的 L0，以干活为主，派活和改需求都经 L0，群里折叠（P2） |
| D | 点头卡 10 分钟没人点 → 过期，L0 在群里说一句 |
| E | 人（包括主人）不能 @ L1 |
| F | L1 看不到群聊，只拿 L0 写的任务说明（P2） |
| G | 谁的 L0 干活花谁的额度 |
| H | 旧群转成新群 |
| I | 成员能加自己的好友进群 |
| J | 点头卡要；每位成员按群设「别人使唤我的管理员：每次问我 / 全部放行」 |
| K | 群主退群转给最早入群的人 |
| L | @ 除了打字，长按群里对方头像也能 @ |

## 1. 已验前提（只读核过，2026-10-05）

- 智能体只能在自己主场的 runtime 里跑：工作区 / wiki / 记忆 / 连接器 / 定时任务都按 workspace 装配
  （`daemon.assembleSessionRoom`）；**不存在两家共用的会话**，管理员车道（`ensureAdminsSession` + `adminsBridge`）就是两份日志靠桥互相镜像。
- 所有主场都在同一个 runtime 进程里（`activeSessions` / `storeFor(workspaceId)`），桥是进程内调用，不经网络。
- 今天群里客人 @ 谁都被 `guestTargetsInLane` 改成群主的管理员；客人起的一轮每一把刀都弹给群主批，接力棒上 2 分钟过期
  （runtime 日志 2026-10-05 12:33：「日程管家在等 Stan Yan 批准」，实际只有继爸批得了）。
- 群里 `schedule_task` 只在 `chatKind === "dm"` 挂（`sessionService.ts` routineTools），群里调就是「未知工具」。

## 2. 形状

### 2.1 两种会话

| 会话 | 在哪 | 里面有谁 | 作用 |
|---|---|---|---|
| **群**（`chat_kind='group'`，座位制） | 建群人的主场 | 只有人；不起任何 turn | 正本：人说的话、各家 L0 的回话、点头卡的镜像 |
| **座位**（`chat_kind='seat'`，新） | **每位成员自己**的主场，一群一条 | 该成员的管理员 | 管理员在这里跑：主人的额度 / 工具 / 记忆 / 定时 / 连接器 |

座位是后台会话：手机聊天列表不画它，人不进它的房。

### 2.2 群的名单（日志事实）

`chat_roster_changed` 多一格可选的 `seats: GroupSeat[]` —— **在场 = 这是一个座位制的群**：

```ts
interface GroupSeat { uid: string; name: string; agentName: string; policy?: "open" }  // policy 缺席 = 每次问我
```

- 座位 = 群里的每一个人（含群主），按入群顺序；`agents` 恒为 `[]`、`humans` = 除群主之外的人（保持旧客户端读得懂）。
- 多一格可选 `groupOwnerUid`（群主，缺席 = 工作区所有者）。群主退群 → 转给 `seats` 里最早的那位。
- 智能体的 id 在群里写成 `seat:<uid>`（`seatAgentId`），@ 解析、回话、头像都按它。

### 2.3 一句话进群（`say`，座位制）

1. 落一条 `chat_message`（新可选格 `seatMentions: string[]`）。**不落 user_message**：群里不起 turn，`openTurns` 不能把它算成排队中。
2. 没 @ 智能体 → 到此为止（人跟人聊天；不过分类器）。@ 了人 → 收件箱 + 推送（原样）。
3. 每个被 @ 的座位 → `seatHub.deliver(座位主人, {fromUid, label, text, depth: 0})`。

### 2.4 座位那一侧（`seatDeliver`）

1. **补上下文**：把群里从这个座位上次镜像到的地方起的每一句（人的话、别家 L0 的回话、系统话）镜像成 `chat_message{mirror:{seq}}`；
   自家 L0 的回话不镜像（它本来就在座位日志里）。新座位从群的最后 40 句开始。
2. **谁在说**：
   - **主人本人** → `user_message{fromUid: 主人, mentions:[admin]}`，主人自己的一轮：全套工具、免审批、`schedule_task` / `message_friend` 都在。
   - **别人**（人，或别家 L0 带着它主人的 uid 来协作）：
     - 这个座位设了「全部放行」→ 直接落**授权开场白**（见 3），不弹卡。
     - 否则 → `user_message{fromUid: 别人}`，**客人轮**：手上只有 `ask_owner` 一把刀，只能聊天（按好友档位，提示词里写）。
3. **授权开场白**：`user_message{fromUid: 主人, greeting: "seat_grant", mentions:[admin]}`，正文「[系统] X 点了头：Y 让你：<原话>…」。
   主人轮的规矩，但 `greeting` 在场 → 不算「主人亲口」→ 打给 / 发给别人、定时、改设置那几把刀照旧拒（超出这件事再 `ask_owner`）。

### 2.5 点头卡

- `ask_owner(要做什么)` → 座位落 `seat_request{requestId, seatUid, fromUid, fromName, agentName, ownerName, ask, summary, expiresTs}`，
  桥镜像到群（同 requestId）、推送给座位主人；这一轮回一句「等 X 点头」就收。
- 座位主人在群里点【接】/【不接】（新上行帧 `seat_decide`）→ 群转给座位 → 座位落 `seat_decision`，镜像回群。
  接 → 落授权开场白起一轮；不接 → 管理员在群里说「X 没同意，这件就不办了」（固定一句，不花模型）。
- 10 分钟没人点：座位落 `seat_decision{expired}`，群里一句「X 没回，这件先放着」。
- 「全部放行」：成员在群信息页切（新上行帧 `seat_policy`）→ 群落一条名单事件（那个座位的 `policy` 变了）；deliver 时把此刻的策略带给座位。

### 2.6 回话回到群

座位里管理员每说一句（`assistant_message`，非空、非 ack）→ 桥 → 群落 `assistant_message{agentId: seat:<uid>}`（模型名照抄），
推送给这一轮的发起人。回话里 @ 了别家 L0 → 群替它 deliver（`depth + 1`，`fromUid` = 这家主人：对对方来说是「别人使唤」）。
刹车：深度 ≤ 6、一个群每小时 ≤ 60 次座位间 deliver（同车道桥的两道闸）。

### 2.7 名单变动

- 加人：群主或任何成员（只能加自己的好友）；新座位立刻在名单里，座位会话在第一次被 @ 时才建。
- 退群 / 被踢：座位撤；那个座位上还在等的卡全部按 expired 收。
- 群主退群：`groupOwnerUid` 转给最早的那位；日志仍放在原群主的主场（只是存放处），他不再在籍、发不了言、进不了房。
- **旧群迁移**（拍板 H）：开房时，主场里一条有客人（`humans` 非空）却没有 `seats` 的群 → 落一条名单事件（`agents: []`、座位 = 群主 + 客人）
  + 一句系统话「群聊升级了：每个人都带着自己的管理员」。只有群主和自己智能体的群（没有客人）不动。

## 3. 协议 30 → 31

- welcome 的 `chat` 多 `seats`、`groupOwnerUid`。
- 上行：`seat_decide {requestId, decision}`、`seat_policy {policy}`。
- `create` 帧带 `humans` 的主场群 → 座位制（`agentIds` 忽略）。

## 4. 库（migration 0068，手动在 SQL editor 跑；**先跑它、再部署 runtime、再发手机热更新**）

- `chat_kind` 多 `'seat'`；`ws_sessions_chat_shape` 多一支 `seat`（`agent_ids = {admin}`、`group_session_id` 非空）。
- `workspace_sessions.group_session_id uuid`；唯一索引 `(workspace_id, group_session_id) where chat_kind='seat'`。

## 5. 不在 P1

L1 折叠工位、`task_revise`（P2）；「今天免问」、私下回、群公告、定时投到群（P3）。P1 里 L1 若被座位里的管理员派活，
在**座位**里干（群里看不到它，只看到管理员的总结）。
