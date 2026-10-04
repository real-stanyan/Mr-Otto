# ADR-0366：免打扰时段与管理员的定时汇报——都挂在 notify_prefs 上；时段里一条不推；到点由管理员打电话或发消息把朋友消息与代办汇报给主人

原为 ADR-0365（另一条 PR #1573 先占了 0365；按项目 ADR-0074 改成 max + 1）。

日期：2026-10-05 · issue #1569 · 维护者原话：「个人可以设置免打扰时间，在此期间所有收到的消息以及任务，将由管理员统一收集，
管理员加一个功能，用户可以设定按天或者每天什么时候准时向自己汇报，可以选择打电话方式或者发消息方式。」

## 背景

推送的开关（#1442，`notify_prefs`）只有「这一类推不推」；代办（ADR-0363 / 0364）之后，朋友的请求会在主人睡觉时源源不断
进来——每一条都推是打扰，一条都不推又漏。维护者要的是两件事合起来：一段时间**不打扰**，这段时间的东西**到点一起说**，
说的方式由主人定（打电话 / 发消息）。

## 决定

1. **两样设置都挂在 `notify_prefs` 上**（0062：`quiet` / `report` / `tz` 三列 + `report_next_at` / `report_last_at` 两根指针），
   不另建表：一人一行、RLS 现成、runtime 本来就按人读它。`quiet = { start, end, days? }`（跨夜允许）；`report = { schedule, mode }`，
   `schedule` 复用定时任务的形状（daily / weekly，不收 once），`mode` 是 call / message。时区按手机写的 IANA 名。
2. **免打扰只拦推送**（`notifier.send` 多一道 `inQuietWindow`）：消息照常落库、打开 App 照样看得见、来电（RingPush）照响——
   「所有收到的消息以及任务」指的是文字，电话另有免打扰那一格（chat_mutes）可用。查不到时段（0062 没跑 / 抖了）当没开，
   免打扰是锦上添花，不能让推送全停。
3. **「管理员统一收集」不另记收件箱**：汇报那一刻**从事实现算**——朋友发来的消息（`messages`，recipient = 主人、created_at >
   上一次汇报）+ 公开车道里朋友点起的代办任务（同私聊页任务卡的 `laneTasksOf` 投影，ADR-0364）。收集 = 查询，不是写一张
   会漂的表；第一次汇报覆盖计划时刻往前 24 小时。
4. **汇报走管理员私聊里的一轮**：runtime 的 `reportScheduler`（60 秒一拍，先认领再跑，与定时任务同一套纪律，ADR-0359）到点拼好
   开场白（`reportOpeningText`），以主人名义落一条 `greeting: "dnd_report"` 给管理员并入队。**打电话** = 开场白要求它用现成的
   `call_user` 打给主人、把要点口语化念出来（没接就写在聊天里）；**发消息** = 直接写在聊天里（主人收到智能体回答的推送——
   那时免打扰已经过了）。否决了 runtime 自己响铃：那要再搭一条「接通之后念什么」的路，而 call_user 那条路从接通到念开场白
   全是现成的。
5. **这一轮受监督，只有 call_user 不掀**（`openingTraits.ownerReport`）：开场白正文是别人的话的转述（同 outreach_report），
   每一刀都要主人批；但打给主人本人是汇报的方式本身、也只打得给这一轮的发起人（主人），不掀。
6. **错过不补**：到点之后超过 2 小时才轮到（runtime 停过、时区换了）就只推进指针——半夜补一通汇报电话比漏一次更糟。
   刚设好的第一跳只排不跑。

## 没做 / 之后

- 未接的人↔人来电不进摘要（没有服务端记录）；团队群里 @ 我的不进摘要（有 mention inbox，留给下一版）。
- 免打扰不拦来电、不拦车道里智能体的回话落库；不做「免打扰期间自动回朋友一句」。
- 不做按日期的一次性汇报（只有每天 / 按星期几）。

## 影响的文件

`supabase/migrations/0062_quiet_report.sql`、`src/shared/quietHours.ts`、`services/runtime/src/reportScheduler.ts`、`notifier.ts`（quiet）、
`daemon.ts`（`runDndReport` + 调度接线）、`sessionService.ts`（`runReport`、ownerReportTurn）、`src/session/events.ts`（greeting `dnd_report`）、
`src/shared/outreach.ts`（openingTraits）、手机 `QuietHoursScreen` / `notifyStore` / 设置页一行。部署：0062 → runtime → 热更新。
