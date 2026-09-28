# 智能体的状态画在头像上 —— 设计

- 日期：2026-09-28
- Task issue：#1282（需求在 2026-09-28 那条评论里扩大了）
- 关系：动效用 ADR-0316 现成的 17 档像素脸，一格都不改。这一版补的是数据源（#1282 点名缺的那一格）和接线。
  桌面那一半等 #1403（桌面微信式布局，另一条 lane）合了另开 issue。

维护者原话：「状态展示：在智能体不同的运行状态下，没有用动态来展示」。

## 维护者已拍板（2026-09-28）

1. 先做状态展示，回电（#1411）排在后面。
2. **列表也动**：会话列表、通讯录、资料页、聊天页都按真实状态画。聊天记录里每条消息旁的头像不动，它们代表的是过去。
3. **数据源走新表 + Supabase 实时推送**。否决了两条：状态塞进会话表一列 jsonb（状态和「最后一句」两种写入节奏会搅在一起）；runtime 经中继直接广播（要新造房间、长连接和快照三样）。
4. 动效是现成的，不出 demo，直接按下面的默认做，做完在模拟器和真机上看：
   - 闲着时静止。一列头像一起呼吸是噪音，ADR-0316 判过；这样「动」就等于「在干活」。
   - 干完了回到静止。有新消息靠未读红点说，不另画笑脸，免得同一件事说两遍。
   - 画角标：脸负责近看，角标负责扫一眼（ADR-0316）。
   - 群头像：九宫格里在忙的那一格动，整个群头像只挂一个角标。
   - 列表第二行照旧是最后一句，不换成状态字。

## 0. 已验前提

1. 像素脸 17 档，各自的动法、角标颜色都在 `src/shared/ottoFace/states.ts`。今天只有 4 档接了真状态：
   `dmFaceState`（`src/shared/ottoFace/adapt.ts`）只会给 `plain / queued / working / solving`，
   用在桌面私聊头部和手机聊天页「此刻」那一行；另外就是通话里的几张脸。
2. 手机上画列表头像的 `FaceTile`（`mobile/src/wx/Avatar.tsx`）会按状态动，但**不画角标**，而且所有调用点都不传状态：
   会话列表（`SpecAvatar`）、群九宫格（`GridTile`）、通讯录、聊天信息页、选人弹层，一律静止。
3. 聊天页外面拿不到「谁在跑」。手机同一时刻只连一条云会话（`mobile/src/cloud/chatStore.ts` 文件头）。
   `supabase_realtime` publication 里只有 friendships / messages / profiles / game_invites / task_sessions / workspace_mentions，
   `workspace_sessions` 不在。「最后一句」（0040）只在进页签、回前台时拉一次（`fetchCloudLasts`）。
4. runtime 每条事件都经 `sessionService.ts` 的 `notify()` 出门，这是唯一出口；daemon.ts 直接 append、绕开它的
   那四类（chat_message / model_usage / route_changed / session_created）与状态无关。流式正文走 engine 的
   `onAssistantDelta`（daemon 接了 `onDelta`）。审批请求与决定、工具开始、turn 收口都落日志：
   `approval_request` / `approval_decision` / `tool_execution_started` / `turn_ended{outcome, errorClass}`，都带 `agentId`。
5. 额度用完有两条路。第一次撞上是网关回 429，错误分类是 `reroute`（`src/model/openaiCompatible.ts`）。
   之后窗口内的 turn 走「已知用完」，直接 `throw new Error(route.reason)`，**不带分类**
   （`services/runtime/src/hostedRoute.ts` 的 `chat()`）。不补的话，这一种会被画成「出错」。
6. 现成的权限助手：`is_ws_member(workspace_id, uid)`（团队 / 主场成员）、`is_session_guest(session_id text, uid)`（主场群客人，0043）。
   runtime 写库用 service key，绕过 RLS（同 0030 / 0040）。

## 1. 状态怎么判

判定写一份，放在 `src/shared/agentActivity.ts`（纯函数，进 vitest）。runtime 写库、手机聊天页现算，都调它。
这样列表（runtime 写的行）和聊天页（本地折叠）由构造就是同一个判据，不会各说各的。
runtime 其实比日志知道得更准（队列、正在跑的 job 都在它手上），但照那个判，列表和聊天页就成了两份判据。

### 1.1 状态

每条会话里，每只智能体有一个状态：

| 状态 | 什么时候 | 脸 | 角标 |
|---|---|---|---|
| `queued` 排队中 | 欠它一轮，还没开始 | `queued`（唯一完全不动的） | 灰 |
| `composing` 思考中 | 这一轮在跑，此刻没在用工具，这一步也还没吐字 | `composing`（眼睛游走） | 蓝 |
| `searching` 检索中 | 在跑只读工具 | `searching`（眼睛乱瞟） | 蓝 |
| `working` 执行中 | 在跑其余工具；认不出的工具也归这一档 | `working`（眯眼盯着） | 蓝 |
| `solving` 作答中 | 这一步已经在吐字 | `solving`（嘴在动） | 蓝 |
| `waiting` 等你处理 | 有一张审批卡还没批 | `waiting`（唯一左右摆的） | 琥珀 |
| `limited` 额度用完 | 上一轮因为额度用完没跑成 | `limited` | 琥珀 |
| `failed` 出错 | 上一轮以错误收口 | `failed`（晕眼，不动） | 红 |
| `idle` 闲着 | 以上都不是 | 列表里 `plain`（静止）；单张大脸（资料页、私聊开头）照旧 `alive` | 无 |

「不知道」不是一种状态，是读不到这一行，或者这一行太旧（§3.3）。它一律画 `plain`、不画角标，不声称任何事（ADR-0316 对 `plain` 的定义）。

不做「压缩中」：日志里只有压缩的结果（`context_compacted`），没有「开始压缩」这件事。
不做「在听 / 在说」：只在通话里有，而且是每台设备自己的事，通话界面已经接好了。

### 1.2 从日志折叠出事实

每只智能体记五样事实，`foldActivity(fold, event)` 逐条推进，纯函数、不回头读日志：

- **欠不欠它一轮、在不在跑**：语义与 `openTurns`（`src/shared/turnLedger.ts`）逐条相同。点了它的 `user_message`
  （含接力、招呼开场白）让它欠一轮；它之后的任何一条事件把「排队」翻成「在跑」；它的 `turn_ended` 在
  `readUpToSeq ≥` 那条开场白的 seq 时才收口。跑到一半才到的点名，这一轮没看见过，收口后照旧欠着。
- **手上的工具**：它最近一条 `assistant_message` 要的工具里，还没等到 `tool_result` 的。下一条 `assistant_message` 或 `turn_ended` 清掉。
  从「模型要了」那一刻算起，不等 `tool_execution_started`：中间那段它在等审批或等容器锁，干的就是这件事，不是在思考。
  工具分两类：`read_file`、`wiki_read` 是检索，其余都是执行。
- **在不在吐字**：收到这只的正文碎片置位，它的 `assistant_message` 或 `turn_ended` 清掉。
  碎片不是事件，runtime 从 `onAssistantDelta` 喂，手机从 delta 帧喂（`applyCloudDelta` 那条路）。
- **没批的审批**：`approval_request` 加，`approval_decision` 或这一轮的 `turn_ended` 去。
- **上一轮怎么收口**：`turn_ended` 的 `outcome=error` 且 `errorClass=reroute` 记为额度用完，其余 `error` 记为出错；
  `completed` / `aborted` / `interrupted` 清掉。你按停止是 `aborted`，不算出错。

### 1.3 从事实到状态

`activityOf(facts)` 按下面的顺序取第一条成立的：

1. 在跑：有没批的审批 → `waiting`；在吐字 → `solving`；手上有工具 → `searching` / `working`；否则 `composing`
2. 欠一轮但没在跑 → `queued`
3. 上一轮额度用完 → `limited`；上一轮出错 → `failed`
4. `idle`

「额度用完」「出错」挂着，直到它在这条会话里又欠一轮：新的点名一来，第 2 条先成立。

### 1.4 一只智能体、好几条会话

通讯录和资料页只有一张脸，只看此刻在进行的几档，取最要紧的：等你处理 > 作答 > 执行 > 检索 > 思考 > 排队；出错、额度用完是某一条会话里上一轮的结局，留在那条会话那一行上（群头像那一枚角标照旧按这条会话里的几只取，包括出错与额度用完）。

`mostUrgent(states)` 的完整次序：

等你处理 > 作答 > 执行 > 检索 > 思考 > 排队 > 额度用完 > 出错 > 闲着

群头像那一枚角标也用它，取群里各只的最要紧。聊天页「此刻」那一行（`nowRowOf`）去掉最后三档后用同一个次序。

### 1.5 对拍

`openTurns` 已经是 runtime 重启补跑和聊天页「此刻」那一行的判据。「欠不欠、在不在跑」这两样，在 200 份
伪随机日志上与 `openTurns` 对拍（手法同 #958）。它的已知缺陷（同一只被点第二次会读成在跑，`turnLedger.ts` 头注）跟着进来，不在这里修。

## 2. 手机端怎么画

- **`FaceTile` 加角标**：右下角一个圆点，直径约为边长的 1/4（48 的头像上约 12），外面一圈卡片底色的描边。
  颜色取 `BADGE_COLORS`。右上角已经是未读数和红点，所以状态角标放右下，两枚不打架。
  减弱动效时脸画静止一帧，角标照画，状态仍然看得出来。
- **会话列表**（`mobile/src/tabs/ChatListRow.tsx`）：
  - 智能体私聊：那只在这条会话里的状态。
  - 群（主场群、团队群、别人拉我进的群）：九宫格里每只智能体那一格各按自己的状态动，格子太小不画角标；
    整个群头像右下角挂一枚，取群里最要紧的那只。
  - 朋友私聊不变。
  - 第二行照旧是最后一句。
- **通讯录**「智能体」那一段：这只在主场所有会话里此刻在进行的几档里最要紧的那个；出错、额度用完不上这张脸，由那条会话那一行说（§1.4）。
- **资料页**（`mobile/src/agent/AgentScreen.tsx`）那张大脸：同通讯录。闲着时照旧 `alive`。
- **聊天页**：「此刻」那一行的脸与头部的状态字都换成完整的 6 档（排队 / 思考 / 检索 / 执行 / 作答 / 等你处理），
  由本地折叠现算，不等 runtime 那一行，所以跟正文同步。头部状态字只在这 6 档时出现，同今天。
  出错、额度用完由时间线上那一行错误来说。
- 其余画头像的地方照旧静止：消息旁的头像、@ 选人、挑成员、用量页、聊天信息页。

## 3. 数据通路

### 3.1 表（`supabase/migrations/0044_agent_activity.sql`）

```sql
create table if not exists public.agent_activity (
  session_id   uuid not null references public.workspace_sessions(id) on delete cascade,
  agent_id     text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  state        text not null,
  since        timestamptz not null,  -- 进入这个状态的时刻
  beat         timestamptz not null,  -- 最后一次心跳
  primary key (session_id, agent_id)
);
alter table public.agent_activity enable row level security;
create policy aa_select on public.agent_activity for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()) or public.is_session_guest(session_id::text, auth.uid()));
-- 不给 insert / update / delete：写方只有 runtime（service key）
alter publication supabase_realtime add table public.agent_activity;     -- 幂等写法同 0030
alter publication supabase_realtime add table public.workspace_sessions; -- 同上
```

- 一行 = 一条会话里的一只智能体。闲下来写 `idle`，**不删行**：Realtime 对 DELETE 不查 RLS，会把主键推给所有订阅者。
- `state` 不加 CHECK。以后 runtime 多一档状态时，旧手机把认不出的值当「不知道」，库也不用跟着改。
- `workspace_sessions` 顺带进 publication，好让列表里的最后一句、排序跟着脸一起实时变。不然会出现脸已经不动了、那一行文字还停在上一句。

### 3.2 runtime 写

- **`services/runtime/src/activityWriter.ts`**：每条会话一个，形状同 `lastWriter`。
  - `set(agentId, state)`：和上次写的一样就不动；变了就记下。
  - 首尾两沿合帧，窗口 1 秒，一次把这条会话里变了的几只一起 upsert。
  - 每 60 秒给此刻在进行的几档（排队到等你处理）补一次心跳，只更新 `beat`。出错、额度用完不心跳（§3.3）。
  - 一只智能体第一次出现就是 `idle` 的不写：没有那一行就是闲着，客户端两者画法相同。
  - 写失败只记日志、不抛（同 `cloudSessionMeta.write`）。表不存在（42P01 / PGRST205）每条会话只记一行，免得 0044 没跑时刷屏。
  - 写库走 `CloudSessionMeta` 上新加的 `setActivity`，不另加装配参数。它是接口方法，漏实现编译不过；测试里 106 处装配也不用各改一行。
- **`sessionService.ts`**：
  - 装配时对整份日志折叠一次（就是重启补跑 `openTurns(seed)` 用的那份 `seed`），之后在 `notify()` 里逐条推进，同 `bounds` / `voiceCall` 的手法。
  - `onAssistantDelta` 顺手喂「在吐字」。
  - 每次推进完，把各只的新状态交给 writer（没变的 writer 自己跳过）。
  - 归档收摊时把所有智能体写成 `idle` 并立刻写出去。删除先走归档（ADR-0245），不另写。
- **`daemon.ts`**：启动时在补开房间**之前**，把 `state <> 'idle'` 的行全写回 `idle`。只有一个 daemon，所以这些行都是上一个进程留下的。
  各房间装配时再按自己的日志写回真状态，重启补跑起来后状态跟着走。顺序反过来的话，这一步会盖掉刚写上的真状态。
  daemon.ts 进不了 vitest，这条顺序由一条读源码的断言钉住（同 `freeKib` / `approveAll` 那几条）。
- **`hostedRoute.ts`**：「已知额度用完」那条 blocked 抛的错补上 `reroute` 分类（§0 第 5 条）。只动分类，措辞不动。

### 3.3 陈旧

手机端一行是此刻在进行的几档（排队到等你处理）、且 `beat` 早于此刻 3 分钟，就当「不知道」（画 `plain`，不画角标）。
心跳 60 秒一次，3 分钟 = 连着丢三次。手机上每 30 秒重判一次陈旧。daemon 崩了、没来得及写 `idle` 时，最多 3 分钟后列表回到静止。
出错、额度用完说的是上一轮的结局，不是「此刻在干嘛」的声称，所以不过期、也不心跳。daemon 重启时它们先被归零，再由装配按日志写回来。

### 3.4 手机读

- **`mobile/src/activity/activityStore.ts`**：
  - 登录后、回前台时全量拉一次，RLS 已经把范围收在我能看的会话里。
  - 订 `agent_activity` 的 INSERT 和 UPDATE，**不订 DELETE**（同 §3.1 的理由）。
  - 按 `session_id:agent_id` 存。
- **订 `workspace_sessions` 的 INSERT 和 UPDATE**：
  - UPDATE 带来的最后一句当场补进手上那份（`homeStore` / `teamsStore` 各加一个就地补的口），不重拉。agent 说话时这一列最快 3 秒写一次，每次都重拉整份清单太贵。
  - INSERT / UPDATE 另外节流重拉一次清单，最多 10 秒一次，接住新会话、改名、归档这类结构变化。
- **读不到时**（表不在、断网）：这一格为空，全部画 `plain`，也就是今天的样子。
- **订阅健康不并进好友那一份**：理由同 ADR-0256，0044 没跑的那段时间里它一直报错，并进去等于让一次没跑的 migration 看起来像「好友连不上」。
- **生命周期**同 `friendsApi`：换号、登出时移除频道。
- **拼行**：`wechatInbox` 的 `inboxRows` 多收一个查状态的函数。九宫格里每一格脸带上自己的状态，每行多一格 `activity`（这一行最要紧的那个，角标颜色与读屏文字都从它来）。不传这个函数时输出与今天逐字相同。判据在 shared，手机只画。

## 4. 部署顺序

0044（在生产库上执行要维护者点头）→ 部署 runtime（`npm run deploy:check` 核指纹）→ 打手机包装到真机。
任何一步没做，都退回今天的样子（列表静止），不报错。

## 5. 测试

- `tests/shared/agentActivity.test.ts`：
  - 逐档造日志断言状态：点名 → 排队 → 思考 → 读文件时检索 → 跑命令时执行 → 吐字 → 等审批 → 批了回到执行
    → 收口；出错；两种额度用完；按停止不算出错；新的点名让出错让位给排队。
  - `mostUrgent` 的次序。
  - 工具分类，认不出的算执行。
  - 与 `openTurns` 在 200 份伪随机日志上对拍。
- `tests/runtime/activityWriter.test.ts`：注入时钟和定时器，测合帧的首尾两沿、心跳只给不在 idle 的、写 idle、写失败不抛、表不存在只记一次。
- `tests/runtime/sessionService.test.ts`：内存 writer，真跑一轮（点名 → 工具 → 收口），断言写出去的状态序列；归档时写 idle。
- `tests/runtime/*`：读 `daemon.ts` 源码，断言重置写在补开房间之前。
- `hostedRoute` 的用例：已知用完那条带 `reroute`。
- migration：读 0044 的 SQL，断言 RLS 开着、没有给 authenticated 的写策略、两张表都进了 publication。
- 手机：陈旧判定、行上的状态与角标颜色（纯函数进 shared）；`FaceTile` 画角标的渲染用例。

## 6. 切片

1. `src/shared/agentActivity.ts` + 测试。
2. 0044 + 测试。
3. runtime：writer、`sessionService` 与 `daemon` 接线、`hostedRoute` 分类 + 测试。
4. 手机：store、`FaceTile` 角标、列表 / 九宫格 / 通讯录 / 资料页 / 聊天页接线 + 测试。
5. 部署：0044（要维护者点头）→ runtime → 真机包。在模拟器和真机上各派一次活看一遍。

桌面等 #1403 合了另开 issue，用同一份 `agentActivity.ts` 和同一张表。

## 7. 已知代价与推翻前提

- **写库**：每条活跃会话最多 1 秒一次，每只在忙的智能体每分钟一次心跳。
- **Realtime 开销**：每次变更都要按每个订阅者查一遍 RLS，量大了换成 Broadcast。
- **「不知道」和「闲着」在列表上长得一样**：都静止、无角标。这是有意的，不知道的时候不声称任何事。
- **陈旧窗口**：daemon 崩了之后，最多 3 分钟还画着旧状态。
- **列表与聊天页可能差一秒**：列表读 runtime 写的行，聊天页本地现算。判据是同一份，时间上会差一个合帧窗口。
- **聊天页只载尾巴（ADR-0300）**：很久以前那次出错如果不在已加载的窗口里，聊天页头部不画「出错」，列表那格照画。
- **`openTurns` 的已知缺陷跟着进来**（§1.5）。
- **不订 DELETE**：会话被删时，它那几行级联删掉，手机收不到推送。那一行本来就跟着会话一起从列表消失，不影响画面。
- **桌面这一版不动**。
- **推翻前提**：如果 postgres_changes 在这个量级上撑不住，或者 RLS 检查太贵，换 Broadcast from Database，表和判据都不变。
