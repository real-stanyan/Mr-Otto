# 智能体的定时任务（routine）—— 设计

- 日期：2026-10-04
- Task issue：#1283
- 维护者原话：「给每个智能体加一个定时任务的功能，用户可以口头描述要求，然后智能体记住定时时间，按照用户的要求去执行。这个定时任务会在智能体的设置里面显示，用户后期可以点进去调整时间以及任务详情等。」「定时任务分为永久的和日抛的：永久的就是每天固定时间执行，日抛的就是用户非常随机的一个需求，比如今天几点打电话提醒我干什么。」「智能体在接到定时任务，如果是对人触发，需要先询问对方所在城市确认时区。并且智能体可以读取当前用户时区。」
- 关系：账号级智能体（ADR-0297，#1280）、主场全免审批（ADR-0298，它点名说 routine 要重判）、接力刹车换成额度（ADR-0238）、回电（ADR-0331 / 0332 / 0335）、派智能体打给好友（ADR-0337）、消息推送（ADR-0338）、起 turn 只走一条路（ADR-0223）
- 范围：**手机端 + 云 runtime**。桌面的设置页不在本期（另开 issue）。

## 0. 维护者已拍板（2026-10-04，会话里）

1. **两类任务**：永久（每天 / 每周指定几天，固定时间）与日抛（一次性，到点执行完即废）。
2. **「对人触发先问城市」里的「对方」是好友**（`call_friend` 那条路）：任务要打给好友时，智能体建任务前先问好友所在城市定时区；主人本人的时区直接读设备上报的，不问。
3. **没人在场时的审批：和主人亲口说的一样免审**。任务是主人建的，视同主人发起，主场里一张审批卡都不出（沿 ADR-0298）。刹车靠额度与工具白名单，不靠审批。
4. **重复形状只到「每天 + 每周指定几天」**，不做 cron。
5. **设置页只做手机**。
6. **调度器放 runtime daemon**：一条 tick 循环 + 一张表（否决 pg_cron + webhook：runtime 今天没有对外 HTTP 入口；否决 edge cron / DO alarm：Quota DO 刻意无 alarm，且最后还是要叫 runtime 起 turn）。
7. 第 2–10 节的设计整体通过。

## 1. 已验前提（2026-10-04，只读核过）

- 仓里**没有任何调度器**：runtime 只有 5 分钟一次的 `sweepIdle` / `runReconcile`、审批超时、响铃定时器；edge `quota.ts` 自述「全部惰性：没有 alarm、没有定时器」；`wrangler.jsonc` 没有 `triggers.crons`。
- **自起 turn 只有一条路**：往会话日志追加一条带 `mentions` 的 `user_message`（可带 `greeting` / `relay` 记号）→ `coordinator.enqueue(job)` → `startDrain()`。回电开场白、外联汇报（`reportOutreach`，跨会话、房间可能没开，用 `openOriginRoom` 开）、新智能体问候（`greetNewAgent`）全走它。`greeting` 加取值**不进协议位**（`events.ts` 的注释：线上只浅校验 base 四格，旧客户端照收，时间线按「`greeting` 在场就不画」藏）。
- 所有云会话开机即开房：`daemon.ts` 启动时读全部 `kind='cloud' and archived=false` 的 `workspace_sessions`，错峰 1500ms 一条 `openSessionRoom`（幂等，`liveOr`）。ADR-0297 的推翻条件里写了「哪天改成按需开房，#1283 要跟着想」——本设计用 `openSessionRoom` 取房，按需开房那天也不用改。
- 主场免审的判据在 `sessionService.ts` 的 `policyApprover`：`approveAll && currentInitiator === ownerUid && !supervisedTurn()`。`supervisedTurn` 由 `guestTurn / reportTurn / foldedNonOwner` 三旗决定；`ownerSpoke`（`call_friend` 亮不亮）由 `openingTraits`（`src/shared/outreach.ts:135`）算：**每一条开场白都是主人本人、无 `relay`、无 `greeting`** 才为真。
- 预算：`relayRemainingMicro`（`daemon.ts:1044`）= `me.windows.week.limitMicro - usedMicro`，三种「没有数」回 `null`；`RELAY_BUDGET_FRACTION_OF_REMAINING = 0.1`（`agentRelay.ts:83`）。引擎**没有硬圈数上限**，只有 `LONG_TURN_ROUNDS = 30` 时喊一声（`src/loop/engine.ts:52`）。
- 时区：仓里零管道。模型投影里的「今天是 YYYY-MM-DD（本机时区）」从日志事件的 `ts` 按**进程所在机器的时区**算（`deriveMessages.ts:40`）——云会话在 VPS 上就是 UTC。`say` 帧（`cloudSession.ts:352`）没有时区格；`profiles` 没有 `timezone` 列。
- 推送：ADR-0338「这一轮答的是谁说的话，就推给谁」按开场白的 `fromUid`；routine 开场白 `fromUid` 是主人 → 推给主人，无需新规则。
- `call_user` 只能打给叫起这一轮的人（`callUserTool.ts` 的 `deps.initiator()`），routine 轮的 initiator 是主人 → 能打给主人。
- 手机设置页：`mobile/src/agent/AgentScreen.tsx` + `AgentRows.tsx`（`Group` / `Row`，点一行开居中 `Dialog`）；表单规则在 `src/shared/agentSettingsForm.ts`，写路径 `updateAgentChecked`。手机**没有** `@react-native-community/datetimepicker`，加原生依赖就不能走热更新（ADR-0340）。
- 最新 migration 是 0055；协议 `CS_PROTOCOL_VERSION = 24`。

## 2. 形状：一张表 + 一个纯函数

### 2.1 `agent_routines`（migration 0057）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces | 主人的 `kind='home'` 主场 |
| `agent_id` | text | 与 `workspace_agents.agent_id` 配对（fk `(workspace_id, agent_id)` on delete cascade）。**表里没有 `session_id`**：结果落的私聊（`chat_kind='dm'`，`agent_ids[1] = agent_id`）到点按 0037 的唯一索引现查，唯一索引保证只有一条 |
| `owner_uid` | uuid → auth.users | 建任务的人 = 主场的主人。runtime 起 turn 时的 `fromUid` |
| `title` | text | 一句话标题（≤ 40 字），列表与灰条用 |
| `instruction` | text | 任务原话（≤ 2000 字），到点原样进开场白 |
| `schedule` | jsonb | 见 2.2 |
| `tz` | text | IANA 时区（`Asia/Shanghai`）。墙上时间按它解释 |
| `enabled` | boolean | 关掉 = 不调度，行还在 |
| `next_run_at` | timestamptz null | 下一次应执行的绝对时刻。`enabled=false` 或一次性已跑完 → null。**调度器只看这一列** |
| `last_run_at` | timestamptz null | |
| `last_status` | text null | `done` / `skipped_quota` / `missed` / `failed` |
| `created_by` | text | `'user'`（设置页建的）/ `'agent'`（智能体用工具建的） |
| `created_at` / `updated_at` | timestamptz | |

- 索引：`(next_run_at) where next_run_at is not null`（tick 扫它）；`(workspace_id, agent_id)`（设置页列它）。
- 形状 check：`schedule` 是对象且 `kind in ('once','daily','weekly')`；`tz` 1–64 字、只含 `[A-Za-z0-9_+\-/]`（入口挡住绕过客户端的写入；漏进来的坏行由调度器隔离，见 3.3）。
- RLS：本人（`owner_uid = auth.uid()`）读写删；**insert / update 另要求 `exists (select 1 from workspaces w where w.id = workspace_id and w.owner_uid = auth.uid() and w.kind = 'home')`**——谁也种不进别人的主场，团队空间也种不进（runtime 起 turn 前还要再核一次，见 3.5）；runtime 用 service key。不进 realtime publication（设置页进页现查，列表很短；同 `chat_mutes` 的理由——只有本人读，DELETE 不查 RLS）。
- 上限：每只**启用中**的任务 ≤ 20 条。工具与手机设置页先查（话更好懂），**库里再由 `before insert or update` 触发器兜一次**（终审 I2：只在客户端查等于 REST 接口照收无限多条）——一行「变成启用」时数同一只名下其它启用行，`>= 20` 以 `check_violation` 拒；已启用行的改动（改标题、调度器认领）不数。

### 2.2 `schedule` 三种形状

```ts
type RoutineSchedule =
  | { kind: "once"; at: string }                       // 本地墙上时间 "YYYY-MM-DDTHH:mm"
  | { kind: "daily"; time: string }                    // "HH:mm"
  | { kind: "weekly"; days: number[]; time: string };  // days ⊂ 1..7（1 = 周一），非空、去重、升序
```

- 维护者说的「永久」= `daily` / `weekly`，「日抛」= `once`。
- 墙上时间 + `tz`，**不存 UTC 的 cron**：人改时区、夏令时切换，墙上的「九点」都还是九点。

### 2.3 `nextRunAt(schedule, tz, after: Date): Date | null`（`src/shared/routines.ts`）

纯函数，只此一份：runtime 算下一跳、手机画「下次 明早 9:00」、工具回显都用它。

- `once`：`at` 在 `tz` 里解成绝对时刻；`<= after` → `null`（过了就没有下一次）。
- `daily`：从 `after` 所在的 `tz` 日期起，今天的 `time` 若 `> after` 取今天，否则明天。
- `weekly`：从 `after` 起往后找 ≤ 8 天内第一个命中的 `days` 且时刻 `> after`。
- 夏令时：用 `Intl.DateTimeFormat(…, { timeZone })` 把「`tz` 里的 Y-M-D HH:mm」逐步逼近成 UTC（标准的「猜 UTC → 格式化回 tz → 修差」两步法，不引第三方库）。不存在的墙上时间（春季跳过的那一小时）**按跳过的长度后移**（02:30 → 03:30，ICU / Java 的惯例）；重复的墙上时间取先到的那一次。两种情况各一条测试。`wallClockToUtc` 往两侧各探 ±24 小时（±12 小时对 UTC+12 / +13 的时区太窄）。
- 无效输入（`days` 空、`time` 非 `HH:mm`、`tz` 不被 `Intl` 认）→ 抛错，校验在 `parseRoutineSchedule` 一处（表单与工具都调它）。

## 3. 调度器（runtime daemon）

`services/runtime/src/routineScheduler.ts`，daemon 启动末尾起、关机时停。

1. **tick 每 30 秒**（与 `sweepIdle` 的 5 分钟同一只 `setInterval` 家族，但自己一只——周期不同）。
2. **认领是原子的**：`update agent_routines set next_run_at = <按 schedule 算的下一跳或 null>, last_run_at = now() where id = $1 and next_run_at = $2 returning *`——`$2` 是刚读到的值。两个实例同时 tick（#1412 那类重启交叠），只有一个 `returning` 有行。认领成功才起 turn；认领失败 = 别人跑了，跳过。**先推进 `next_run_at` 再起 turn**：起 turn 失败不会让它每 30 秒重试一次烧钱（失败记 `last_status='failed'`，重复任务等下一跳，一次性任务到此为止）。
3. 每次 tick 一条 SQL 读 `enabled = true and next_run_at <= now()`，按 `next_run_at` 升序、limit 50；一轮处理完再等下一 tick——不并发起 50 个 turn。**每一行包在自己的 try/catch 里**（一行坏数据挡不住这一拍，也挡不住第 6 步的清理）；**每行现取一次时钟**（`deps.now()` 在循环里调：`run` 要开房、读名单、落盘入队才返回——不等那一轮跑完，`started` = 已入队——拍头取的 `now` 到后面几行可能已过期，漏跑判据与认领的 `last_run_at` 都会算偏）。**坏行不堵队头**：`due()` 逐行映射，`schedule` 读不懂的行当场隔离（停用 + `next_run_at` 清空 + `failed`，记日志）；`tz` 认不出、算不出下一跳的行照样先认领（`next_run_at = null`）再标 `failed` 停用——不认领它就永远排在队头，50 条就占满 limit。**停用 = 不再到点**：`setStatus(…, enabled=false)` 顺手清空 `next_run_at`。
4. **漏跑**（daemon 停机期间错过的；判据是 `now() - next_run_at`）：一次性任务晚 ≤ 2 小时照跑，> 2 小时不跑、标 `missed`、私聊里落一条灰条「定时任务「x」错过了（原定 10-05 09:00）」；重复任务晚 ≤ 10 分钟照跑，更晚的直接推到下一跳、不落灰条（人没醒着的时候一天的早报都迟到三小时才来，不如不来）。宽限常数两枚放 `routines.ts`。
5. **起 turn**：`openSessionRoom(workspaceId, sessionId, ownerUid, ownerUid, approveAll=true)` 取房（幂等），调新方法 `session.runRoutine({ routineId, title, instruction, tz, firedAt })`（第 4 节）。私聊按 0037 唯一索引现查（`findDmSession(workspaceId, [agentId])`），查不到 / 已归档 / 智能体已删 → `failed`，并把任务 `enabled=false`。智能体名单读不出来（`degraded`，一次查询失败）**不算**智能体已删：`runRoutine` 抛错，调度器标 `failed` 但不停用，下一跳再试。**起 turn 前再核归属**：`routineRun.ts` 的 `homeOwnerOf` 依赖（daemon 现查 `workspaceFacts`，不是主场回 `null`；行上的 `ownerUid` 是建任务那一刻的旧话），`null` 或对不上 `row.ownerUid` → `failed` 并停用，不替前主人起 turn。
6. **清理**：同一 tick 顺手 `delete … where schedule->>'kind' = 'once' and enabled=false and last_status in ('done','missed') and last_run_at < now() - interval '7 days'`（日抛跑完留 7 天给人看）。**只清一次性**：停用的重复任务是人暂停的、不是跑完的，不能被删（设置页里的「已完成」同口径，见 8.2）。
7. 不做：没有「立刻跑一次」的按钮（人想现在跑，直接在私聊里说一句就是了）。

## 4. 起 turn 的载体与投影

### 4.1 事件

`UserMessageEvent.greeting` 加取值 `"routine"`，并加一格：

```ts
/** 定时任务到点（#1283）：runtime 替主人落的开场白。`mentions` 是那只，`fromUid` 是主人。
    同样只是记号、同样不进协议位；**与别的 greeting 不同，时间线画它**（一条灰条），
    见 ADR。`routine` 只在 greeting === "routine" 时在场 */
routine?: { id: string; title: string };
```

开场白正文（模型读的就是这段，所以时间与时区**写在正文里**，模型可见即已落盘；正文里只有 `任务：<instruction>`，**标题不重复**——标题在手机那条灰条上）：

```
【定时任务到点】现在是 2026-10-05 09:00（Asia/Shanghai，周一）。
任务：<instruction>
按任务去做。要叫我接电话就用 call_user；要打给好友用 call_friend。做完在这里说一句结果。
```

### 4.2 `CloudSession.runRoutine`

与 `greetNewAgent` 同形：名单现读（那只还在不在；读不出来抛错，见 3.5）→ 追加 `user_message{greeting:"routine", routine, mentions:[agentId], fromUid: ownerUid}`（**不带 `tz`**：正文里已写明时间与时区，带上会让投影的「今天是」改按任务建时的时区算） → `notify` → `coordinator.enqueue({agentId, fromUid: ownerUid, opening})` → `"start_turn"` 则 `startDrain()`。`"queued"`（它正忙）就排队——早报等它干完手上的活再写，不丢。

### 4.3 投影

- **时间线画一条居中灰条**「⏰ 定时任务「早报」」（`mobileChat.chatRows` 新一种 `routine` 行，与 `ring` 行同一个居中灰条样式）。否决「藏掉」：别的 greeting 都有前一条可见事件解释「为什么它开口了」（通话名单变了、新建了它、电话接通了），routine 没有——藏了就是回话凭空冒出来。**桌面照旧藏**（`hiddenFromCloudTimeline` 对 `greeting` 一族与 `routine_note` 都回 true）：桌面不在本期，只有手机画灰条。
- `missed` / `skipped_quota` 的说明灰条：新事件 `routine_note { routineId, title, reason: "missed" | "skipped_quota", plannedAt }`，`ignorable`、模型不可见（同 `call_ring` 的纪律：不带 `agentId`，免得被 `openTurns` / 活动折叠认成它的一轮）。
- 推送：不加规则。开场白 `fromUid` 是主人，ADR-0338 的「答的是谁的话就推给谁」自然推给主人；「正看着就不推」照旧。
- `isHumanOpening` 不改：routine 开场白算一次新点火（接力预算与棒数从它起算），与 greeting 一族一致。

## 5. 审批、监督、刹车

1. **免审**：`fromUid = ownerUid` → `currentInitiator === ownerUid` → `policyApprover` 走主场全免那一格，不改代码。
2. **`ownerSpoke` 对 routine 开场白为真**（本设计唯一放宽的一处）：`openingTraits` 的 `ownerSpoke` 判据改为「每条开场白都是主人、无 `relay`、且 `greeting` 为 undefined **或 `"routine"`**」；`tightenSupervision` 对应放行。理由：任务原话是主人亲手写的，与主人当场说一句逐字等价（`created_by='agent'` 的行不成立，见第 10 节已知代价）；不放行则 `call_friend` 在 routine 轮里永远灭着，拍板第 2 条「定时打给好友」做不成。代价写进 ADR：routine 轮里 `call_friend` 的监督与主人当场派它一样松。
3. **额度刹车（起跑前）**：`relayRemainingMicro()` 回数且 `< limitMicro * 0.1`（沿用 `RELAY_BUDGET_FRACTION_OF_REMAINING`）→ 不起，`last_status='skipped_quota'`，落 `routine_note`；回 `null`（探针不可达）→ **照跑**（与 ADR-0238 的降级一致：问不出钱不等于没钱；且这是主人自己建的任务，不是接力失控）。重复任务下一跳照常算，不因为跳过而停。
4. **圈数硬上限**：engine 加可选项 `maxRounds?: number`，每轮只读一次；到数就**抛错走既有的 `turn_ended{outcome:"error"}` 收口路径**（与 `loopGuardMaxNudges` 同一条路，不新造事件，**不伪造一条 `assistant_message`**）；错误文案里写清是定时任务的硬上限，手机上画成「「x」这一轮出错」那条灰条。缺席 = 不限（老行为逐字不变）。routine 轮传 40。普通轮不传——人在场自己会按停止。
5. **数量上限**：每只启用中 ≤ 20 条；同一任务两次执行间隔 ≥ 60 秒（`nextRunAt` 的 `after` 取 `max(now, firedAt + 60s)`）。
6. 不做：单次执行的花费上限（引擎中途没有按钱停的机制，圈数上限 + 10% 预算门够用；哪天出事再加）。

## 6. 时区管道

1. **`say` 帧加可选 `tz: string`**（设备 IANA，`Intl.DateTimeFormat().resolvedOptions().timeZone`）。runtime 校验是合法 IANA 后写到 `user_message.tz`（新可选字段，缺席 = 旧日志 / 桌面）。协议**不升**：可选字段，旧 runtime 忽略，旧客户端不发。非 @ 的 `chat_message` 路径**不带** `tz`（私聊里每句话都是 `user_message`，它在这里无关）。
2. **投影里「今天是」按最近一条带 `tz` 的人话算**：`deriveMessages` 的 `today` 从「日志里最后一条事件的 `ts`」变成「同一个 `ts`，按最近一条 `user_message.tz` 格式化」，没有 tz 的日志逐字节不变（老投影断言不动）。括号里的「本机时区」改成具体时区名。**这是模型知道「现在几点、哪个时区」的唯一来源**，可从日志推导，不读库。多时区的群聊里，「今天是」那一行会随最近一位说话的人的时区来回翻——前缀缓存因此失效（见第 10 节已知代价）。读取的纯函数是 `userTzOf`（`deriveMessages.ts`）。
3. **`user_settings.timezone`**（同一份 0057 新建的 `user_settings` 表，uid 主键、只有本人读写的 RLS）：手机前台时（`AppState` → `active`）设备 tz 与上次写的不同才 `upsert`（手机写，runtime 用 service key 读、不写；调度器只在建任务时读它当默认值）。**不放 `profiles`**（终审 C3）：`profiles` 的 select 是 `using (true)`（0001），所有登录用户都读得到，一个出差就会变、前台就会改写的时区挂在那儿等于让任何人跟踪你人在哪。调度器建任务时 `tz` 省略 → 读它；读不到 → 拒绝建任务并让智能体问一句「你在哪个城市」。桌面不写（桌面不在本期）。
4. **打给好友的任务**：`schedule_task` 的说明里写死「任务里要打给好友的，先问好友所在城市，换成 IANA 时区传 `tz`；没问到别建」。模型做城市 → 时区这一步（它会），工具只校验 IANA 合法。

## 7. 模型侧工具（私聊里给每只；外联会话一把都没有，照旧）

| 工具 | 参数 | 返回（落日志） |
|---|---|---|
| `schedule_task` | `title, instruction, schedule: RoutineSchedule, tz?` | `{ id, nextRunAt: "2026-10-05 09:00（Asia/Shanghai，周一）" }` |
| `list_schedules` | 无 | 这只的全部任务（id / title / 形状一句话 / 下次 / 启用否 / 最近状态） |
| `update_schedule` | `id, patch?: { title?, instruction?, schedule?, tz? }, enabled?: boolean, delete?: true` | 改后的那一条 |

- 都 `requiresApproval: false`（同 `wikiTool` 的「记忆写入」口径）。`created_by='agent'`。
- 工具只在 `chat_kind='dm'` 且主人点火的轮里亮（`available`）——群里、客人轮、汇报轮不亮，省得群里一句「每天提醒大家」建到某只名下。
- 工具说明里的三句规矩：建完要用人话复述「下次执行」给人确认；人说的是相对时间（「今天下午三点」「明早」）按正文里的「现在是」换算；打给好友的先问城市。
- 实现：`services/runtime/src/routineTools.ts`，注入 `RoutineWriter`（读写表 + `nextRunAt`），同 `createAgentTool` 的注入形状；校验走 `src/shared/routines.ts` 的 `updateRoutineChecked`（表单同一份）。

## 8. 手机 UI

1. **入口**：`AgentRows` 加一行「定时任务」，值 = `3 个 · 下次 明早 9:00`（没有 = 「没有」）。`ChatInfoScreen` 复用 `AgentRows`，顺带也有。
2. **列表页** `mobile/src/agent/RoutinesScreen.tsx`：三段 `Group`——「重复」「一次性」「已完成」（后者只放**一次性**里 `last_status` 为 `done`/`missed` 的，灰字，与 3.6 的清理同口径；**暂停的重复任务留在「重复」段**，开关关着）。每行：标题 / 副行「每天 09:00 · Asia/Shanghai」或「10-05 15:00」/ 右侧 `Switch`（直接拨 `enabled`，不进弹窗）。右上「+」手动新建。空态一句话：「跟它说一句『每天早上九点……』就能建」。
3. **编辑弹窗**（居中 `Dialog`，不用抽屉——沿用手机端表单类流程的既定口径）：标题、任务原话（多行）、形状分段（一次 / 每天 / 每周）、时间（**纯 JS 的时 / 分两列滚轮**，不加原生依赖，可走热更新）、`once` 多一个日期（今天起 30 天内的横向日期条）、`weekly` 多一排周一到周日 chips、时区（默认设备，点开从 `Intl.supportedValuesOf("timeZone")` 里搜）、底部「删除」。校验与报错文案来自 `src/shared/routines.ts`。
4. 写路径：手机直接 `supabase.from("agent_routines")`（同 `updateAgentRow` 的方式），RLS 兜底；`next_run_at` 由手机按 `nextRunAt` 算好一起写——runtime 不信它，认领时按 `schedule` 重算下一跳，所以手机算错最多早/晚一次。**编辑一条暂停的任务（改标题也算）会把它重新启用**：手机 `save` 在改了时间、或行本来就是停用时写 `enabled: true`（产品决定，见第 10 节）；只改标题且本来启用的行**不**重算 `next_run_at`。
5. 桌面：`AgentSettingsDrawer` 不动，开 issue。

## 9. 测试（`tests/` 镜像 `src/`）

- `tests/shared/routines.test.ts`：`nextRunAt` 的 once / daily / weekly、跨日、跨周、夏令时跳过与重复、`after` 恰等于时刻、无效输入；`parseRoutineSchedule`；`updateRoutineChecked` 的 20 条上限与字段长度。
- `tests/services/runtime/routineScheduler.test.ts`（假 Supabase、假时钟）：到点认领一次、两实例同时 tick 只起一次、认领失败不起 turn、一次性跑完 `next_run_at=null`、漏跑两档宽限、7 天清理、额度不足跳过并落 `routine_note`、`null` 额度照跑。
- `tests/shared/outreach.test.ts`：`openingTraits` 对 `greeting:"routine"` 的 `ownerSpoke`。
- `tests/shared/mobileChat.test.ts`：`routine` 灰条行与 `routine_note` 行。
- `tests/session/deriveMessages.test.ts`：带 `tz` 的日志「今天是」按 tz 算；不带的逐字节不变。
- `tests/loop/engine.test.ts`：`maxRounds` 到数收口；缺席不限。
- 工具三件：参数校验、`available` 只在私聊主人轮亮、回显文案。
- 手机：`tsc --noEmit` 过门禁；真机冒烟（建一条 1 分钟后的一次性任务 → 到点私聊里出灰条 + 回话 + 推送）记在 issue 里。

## 10. 部署顺序与已知代价

部署：**0057 → runtime → 手机热更新**（没有原生改动）。反过来 runtime 读不到表会在 tick 里报错一次然后静默。

已知代价：

- routine 轮里 `call_friend` 的监督与主人当场派它一样松（第 5.2 条）。出事先收窄 routine 的刀（ADR-0298 的原话），不收窄私聊。
- 一次性任务最多补跑 2 小时、重复任务 10 分钟：VPS 停机半天，那天的早报不会来，也不会解释。
- 模型知道的「现在」是**最近一条人话的时区**；人在飞机上换了时区、还没在这条聊天说过话，它看到的是上一地的时区（routine 开场白正文带自己的时区，不受影响）。
- 工具只校验 IANA 合法，不校验「好友真在那个城市」。
- 多时区的群聊里，「今天是」那行随最近一位说话的人的时区来回翻，投影前缀不再逐字稳定，前缀缓存失效。
- **编辑暂停的任务会让它重新启用**：产品决定——人点进去改了，多半就是想让它跑；只想改个错别字、仍想暂停的人得再拨一下开关。
- 行上的 `owner_uid` 是建任务那一刻的旧话：主场易主后，旧任务只会 `failed` 停用，不会迁给新主人。
- `created_by='agent'` 的任务正文是模型写的，不是主人逐字写的；一次被注入的轮可能留下一条免审且 `call_friend` 亮着的重复任务。后续：智能体建的任务要主人在设置页确认过才算主人亲口（另开 issue）。
- 库内 20 条上限挡不住两笔并发同时插第 20 条，最多超一条，接受。

不做：cron 任意表达式；按事件触发（「收到邮件就…」，#1283 标题里的「触发」留给下一条 issue）；桌面设置页；立刻跑一次；单次花费上限；群里的定时任务。

## 11. 推翻条件

- 哪天改成按需开房（ADR-0297 的推翻条件）：`openSessionRoom` 仍幂等，调度器不改；只是开房成本从「已开」变成「现开」，tick 的 limit 50 要再看。
- 哪天 routine 轮真出了事（没人在场的 bash 删了东西）：先给 routine 轮一张比私聊窄的工具表（第 5 节留了 `available` 这个口子），不动审批。
- 哪天引擎有了按钱停的机制：圈数上限换成花费上限。
