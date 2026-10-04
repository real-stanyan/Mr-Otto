# ADR-0357：智能体的定时任务——runtime 里一只 tick 加一张表，到点起 turn 走现成那条路
原为 ADR-0353（合并主干时撞号改为 0356）；原为 ADR-0356（再次撞号——主干上 0356 被「公开智能体」占了——改为 0357；migration 同时由 0057 改为 0058，代码注释与 migration 头已同步改）

日期：2026-10-04 · issue #1283 · spec `docs/superpowers/specs/2026-10-04-agent-routines-design.md` · 维护者在会话里拍板

## 背景

维护者原话：「给每个智能体加一个定时任务的功能，用户可以口头描述要求，然后智能体记住定时时间，按照用户的要求去执行。
这个定时任务会在智能体的设置里面显示，用户后期可以点进去调整。」分两类：永久（每天 / 每周几固定时间）与日抛（一次性）。
ADR-0298 把个人主场的审批整个免掉时，点名说 routine 要重判——没人在场的那一轮，刀与钱怎么管。

## 决定

1. **调度器放云 runtime daemon**：`agent_routines` 一张表 + 30 秒一拍的 tick，`update … where next_run_at = 读到的值` 原子认领。
   否决 pg_cron + webhook（runtime 没有对外 HTTP 入口）与 edge cron / DO alarm（Quota DO 刻意无 alarm，最后还是要叫 runtime）。
   **先推进 `next_run_at` 再起 turn**：起不成不会每 30 秒重试烧钱。每一行包在自己的 try/catch 里（一行坏数据挡不住这一拍、也挡不住清理），
   每行现取一次时钟（`deps.now()` 在循环里调：`run` 要开房、读名单、落盘入队才返回——它**不**等那一轮跑完，`started` 的意思是「已入队」——
   拍头那个 `now` 到第 N 行可能已过期）。**一条坏行不能堵死调度器**：Supabase 的 `due()` 逐行映射（`splitDueRows`），
   `schedule` 读不懂的行用 service key 隔离（停用 + `next_run_at` 清空 + `failed`）并记日志；`tz` 认不出、算不出下一跳的行照样先认领
   （`next_run_at = null`）再标 `failed` 停用。表上另有 `schedule` / `tz` 两条形状 check 在入口挡。
   **停用 = 不再到点**：两份 store 的 `setStatus(…, enabled=false)` 顺手清空 `next_run_at`，`due()` 只读 `enabled = true` 的行
   ——否则认领已把 `next_run_at` 推到明天，一条因私聊没了而停用的每日任务明天照响。
2. **表里没有 `session_id`，私聊到点现查**：按 0037 的唯一索引找（`chat_kind='dm'`、`agent_ids[1]`），查不到 = `failed` 并停用。
   手机手动新建前先让 runtime 幂等地保证私聊存在。
3. **起 turn 不造第二种机制**（ADR-0223）：到点在它的私聊里落 `user_message{greeting:"routine", routine:{id,title}}`，
   `fromUid` 是主人，然后 `coordinator.enqueue` → `startDrain`——与回电开场白、外联汇报、新智能体问候同一条路。`greeting`
   加取值不进协议位。开场白正文是 `任务：<instruction>`，标题不重复（标题在手机那条灰条上）。开场白**不带 `tz`**：正文已写明时间与时区，
   带上会让投影的「今天是」改按任务建时的时区算。名单读不出来（`degraded`，一次查询失败）时 `runRoutine` 抛错——调度器标 `failed`
   但不停用、下一跳再试；`no_agent` 只留给「名单好好的、那只真不在」，一次网络抖动不该永久关掉主人的任务。
   手机时间线**画**这条开场白（一条灰条）：别的 greeting 都有前一条可见事件解释它为什么开口，这条没有。**桌面照旧藏**
   （`hiddenFromCloudTimeline` 对 `greeting` 一族与 `routine_note` 都回 true）——桌面不在本期，只有手机画。
4. **routine 轮视同主人亲口**（维护者选的）：主场免审照旧；`openingTraits` 的 `ownerSpoke` 对 `greeting:"routine"` 放行，
   否则 `call_friend` 在定时轮里永远灭着，「定时打给好友」做不成。这是唯一放宽的一处。
5. **刹车不靠审批靠两道门**：起跑前剩余周额度 < 10%（沿用 `RELAY_BUDGET_FRACTION_OF_REMAINING`）不起、落 `routine_note`；
   engine 加可选 `maxRounds`，routine 轮 40 圈。`maxRounds` 每轮只读一次，到数**抛错走既有的 `turn_ended{outcome:"error"}`**
   （与 `loopGuardMaxNudges` 同一条收口路径），不造新事件、不伪造一条 `assistant_message`。有人在场的轮不封顶（ADR-0006 那句仍成立）。
6. **任务只属于主人的家**：`agent_routines` 的 insert / update RLS 除 `owner_uid = auth.uid()` 外还要
   `exists (select 1 from workspaces w where w.id = workspace_id and w.owner_uid = auth.uid() and w.kind = 'home')`——谁也种不进别人的主场，
   团队空间的所有者也不能借它种一条免审的轮；runtime 起 turn 前再核一次（`routineRun.ts` 的 `homeOwnerOf` 依赖：daemon 现查 `workspaceFacts`，
   不是主场回 `null`），`null` 或对不上 `row.ownerUid`（主场易主之类，行上的 `ownerUid` 是建任务那一刻的旧话）→ `failed` 并停用，不替前主人起。
   **启用中 ≤ 20 条在库里也兜住**：`before insert or update` 触发器在一行「变成启用」时数同一只名下其它启用行，`>= 20` 以 `check_violation` 拒
   （只在变成启用时数：已启用行的改标题、调度器的认领不该因并发多出的一条被拒）；工具与手机设置页先挡的那两处保留（话更好懂）。
7. **时区从日志来**：手机 `say` 帧带设备 IANA 时区，runtime 落到 `user_message.tz`；投影的「今天是」按最近一条带 tz 的人话算
   ——仍是纯函数、不读库。账号上的设备时区存 `user_settings.timezone`（只有本人读写的 RLS），由手机在前台、设备时区变了才 upsert，
   只给调度器建任务时当默认值。**不放 `profiles`**：`profiles` 的 select 策略是 `using (true)`，所有登录用户都读得到，
   一个出差就会变的时区挂在那儿等于让任何人跟踪你人在哪。
   非 @ 的 `chat_message` 路径不带 `tz`（私聊里每句话都是 `user_message`，它无关）。打给好友的任务，工具说明里写死「先问好友所在城市」。
8. **形状只到每天 + 每周几**，不做 cron；墙上时间 + IANA 时区，不存 UTC cron。夏令时按 ICU / Java 惯例：
   跳过的墙上时间按跳过的长度后移（02:30 → 03:30），重复的取先到的；`wallClockToUtc` 往两侧各探 ±24 小时（±12 小时对 UTC+12 / +13 的时区太窄）。
9. **漏跑宽限**：一次性 2 小时、重复 10 分钟；超了一次性标 `missed` + 注记 + 停用，重复直接等下一跳不解释。
10. **7 天清理只清一次性**（`schedule->>kind = 'once'` 且 `done` / `missed`）：停用的重复任务是人暂停的，不是跑完的，不能被删。
    手机「已完成」段同口径只放一次性的 `done` / `missed`；暂停的重复任务留在「重复」段，开关拨到关。
11. **设置页只做手机**（维护者选的），纯 JS 时间滚轮、不加原生依赖；桌面另开 issue。编辑一条任务（改标题也算）会把暂停的它重新启用
    （手机 `save` 在改了时间或行本来就是停用时写 `enabled: true`）；只改标题且本来启用的行**不**重算 `next_run_at`。

## 已知代价

- routine 轮里 `call_friend` 的监督与主人当场派它一样松。出事先收窄 routine 的刀（ADR-0298 的原话），不收窄私聊。
- VPS 停机半天，那天的早报不会来也不会解释（重复任务的漏跑不注记）。
- 模型知道的「现在」是最近一条人话的时区；人换了地方还没在这条聊天说过话，它看到的是上一地的。
  多时区的群聊里，「今天是」那行会随最近一位说话的人的时区来回翻——前缀缓存会因此失效（投影前缀不再逐字稳定）。
- 工具只校验 IANA 合法，不校验「好友真在那个城市」。
- **编辑暂停的任务会让它重新启用**：是产品决定，不是疏漏——人点进去改了，多半就是想让它跑；想继续暂停就别保存，或保存后回列表拨开关。
  代价是「只想改个错别字、仍想暂停」的人得多拨一下开关。
- 行上的 `owner_uid` 是建任务那一刻的旧话，主场易主后旧任务只会 `failed` 停用，不会迁给新主人。
- `created_by='agent'` 的任务正文是模型写的，不是主人逐字写的；一次被注入的轮可能留下一条免审且 `call_friend` 亮着的重复任务。
  后续：智能体建的任务要主人在设置页确认过才算主人亲口（另开 issue）。
- 20 条的库内上限挡不住两笔并发同时插第 20 条（都会过），最多超一条，接受。

## 推翻条件

- 改成按需开房（ADR-0297 的推翻条件）：`openOriginRoom` 仍幂等，只是 tick 的 limit 50 要再看。
- routine 轮真出了事：先给它一张比私聊窄的工具表（`available` 那个口子），不动审批。
- 引擎有了按钱停的机制：圈数上限换成花费上限。
