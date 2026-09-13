# 手机端 M2：任务栏 —— 设计

> 上位文档：`2026-09-11-mobile-app-redesign-design.md`（界面层总纲）§4.2、§5；
> 数据层契约：`2026-09-10-task-session-cloud-sync-design.md`（任务会话云端日志）§3.1–3.3、§3.6、§3.9。
> issue #1254（③ 手机任务会话客户端）。demo：`.demo/mobile-app-redesign.html` 的 `tasks` / `taskNew` / `taskChat` / `archive` / `search`。

## 0. 这份 spec 只回答上面两份没回答的

契约那两份已经钉死了：表、RPC、笔、事件形状、五屏各自的源。**没人回答过的是这几件**，全在客户端这一侧：

1. 事件怎么投影成手机上的一屏（现成那份投影不能用，§3）；
2. 手机从不握笔 ⇒ 哪些动作做得了、哪些做不了（§4）；
3. 离线读什么、写不写得了（§5）；
4. 五屏各自的「还没查到 / 读不到 / 没有 / 没权限」分别说什么（§6）；
5. 抽屉这个新构件由谁第一个用、带进哪两个依赖（§7）。

## 1. 边界

**做**：demo 的五屏（列表 / 开局 / 会话 / 已归档 / 搜索）+ 三张抽屉（模型、附件、上下文）+ 会话菜单抽屉；直连 Supabase 读写；realtime 跟随；附件上传；离线可读。

**不做**（各有理由，不是漏了）：
- **问卷卡的写回**：`task_answer` 这个 RPC **在 0036 里不存在**（那份 migration 只有 `task_append` + 笔的三条）。#1254 正文说它「走 ② §3.10」，而 ② 的 spec 还没写。M2 把问卷**画出来但不可答**，并说清「去电脑上答」。
- **审批的批准 / 拒绝**：见 §4，这是笔的结构性后果，不是省事。
- 全文搜索（v1 只搜已加载的，照总纲 §4.2）、附件的本地缓存淘汰、真机验收（跟着 #907 那张单子走）。
- 后端一格不动：不加表、不加 RPC、不改 0036。

## 2. 数据层

薄到无逻辑，形状照 `mobile/src/friendsApi.ts`（手机端直连 Supabase 的既有先例）：新 `mobile/src/tasksApi.ts`。

| 动作 | 怎么做 |
|---|---|
| 列表 | `select id,title,archived,last_seq,pen_holder,pen_until,updated_at from task_sessions order by updated_at desc`（RLS 只给本人） |
| 列表跟随 | `supabase.channel('task-sessions-<uid>').on('postgres_changes', {event:'*', table:'task_sessions'})`，同 friendsApi 那两条通道的写法 |
| 事件 | `select … from task_session_events where session_id = ? and seq > ? order by seq limit 500`（`PULL_PAGE`，shared 常量） |
| 发话 | `rpc('task_append', {p_session_id, p_expected_seq, p_holder: holderId('phone', deviceId), p_events: [userMessage]})` |
| 建会话 | 同上，`p_expected_seq = 0`、两条事件：`session_created{workspaceKind:'default'}`（**不带 `workspace`**）+ `user_message`；id 用 `src/shared/sessionId.ts` 的 `newSessionId()` |
| 归档 / 恢复 / 改名 / 换型号 | 同一条 `task_append`，都是 human 类事件，免笔 |
| 错误 | 按 `TASK_SQLSTATE`（P0010 seq_conflict / P0011 pen_required / P0012 forbidden / P0013 no_session）**认码不认文案**，shared 里已有 |

**`last_seq` 是唯一的「有没有新东西」信号**（同 §3.1 不订事件表：单条 `tool_result` 能到 1 MB，realtime 的 payload 上限会把它静默丢掉）。realtime 掉线没人看着（#913 那一族），所以另有两个兜底触发点：**窗口重新聚焦**（同 #1064 的取舍：会看到它的那一刻必然是人回到屏幕前）与**下拉刷新**。不做定时轮询。

## 3. 时间线投影：新写一份，不复用 `projectTimelineForMobile`

`src/shared/remote/timeline.ts` 那份**不能用**，而且不是「改一下就能用」：

- 它是 ADR-0094 那条链路上「**什么东西离开这台机器**」的收口闸 —— 判据是隐私与带宽（只认三种事件、剥 reasoning、正文 2000 字 / 工具输出 400 字就截）。任务会话的事件是手机**自己**从 Supabase 读的，压根没有「离开电脑」这一步，那些判据在这里一条都不成立。
- 而总纲 §4.2 要求画的东西它全都丢掉了：`executor_changed` 的那行分隔、审批卡、`turn_ended` 的收口、问卷。
- 让同一个函数回答两个不同的问题，是这仓里反复点名的那种成本最高的复用。

**新 `src/shared/taskTimeline.ts`**（纯逻辑、跟着根门禁跑，同总纲 §7）：

- `taskTimeline(events) → TaskTimelineItem[]`，item 四种：`say`（人 / Otto 的一段话）、`tools`（连续工具调用折一组，同现有 `groupTimeline`）、`divider`（`executor_changed` → 「电脑睡着了，这一轮由云端接手」/「回到电脑」/「换到另一台电脑」，文案取 `executorOfLog` 的口径）、`card`（审批 / 问卷，只读）。
- **判据是一张穷举 `Record<SessionEvent["type"], TimelineVerdict>`**，形状同 `PRIVACY_VERDICTS` / `OTHER_AGENT_VERDICTS` / `PEN_VERDICTS`：新事件类型不表态 `tsc` 直接红。这是新事件类型检查清单的**第 13 处**，要写进 AGENTS.md 索引里那条清单。
- **不截断**：手机是这条会话的完整客户端，不是投影窗口。长工具输出靠折叠组 + 「展开」承担。
- `reasoning` **不画**（同云会话那侧的口径，ADR-0263）。

## 4. 手机从不握笔：能做什么、不能做什么

`PEN_VERDICTS`（shared，RPC 里的白名单从它抄进 SQL）把事件分两类，**手机永远拿不到 executor 那一类**：

- **做得了**（human 类，免笔）：发话、建会话、改名、归档 / 恢复、换文字 / 图像模型、记忆手改、`session_shared`。
- **做不了**：审批的批准 / 拒绝（`approval_decision` 是 executor 类）、答问卷、停止正在跑的那一轮。

**审批那条要说清楚**：demo 里那张「要动真东西」的抽屉带着「批准这一次 / 拒绝」两颗钮——那是**团队栏**（M3，走 cs 帧，批的是 runtime）。任务会话里不成立：批准要落一条 executor 类事件，而落它要握笔，握笔要把正在跑 turn 的那一方挤掉。技术上 `task_pen_acquire` 对 authenticated 是开着的，手机**抢得到**这支笔 —— 正因为抢得到，这里要明写**不抢**：抢了就是在电脑正跑一半时把它的写权夺走。

所以 M2 的审批卡**只读**：画清是哪把刀、什么参数、谁发起的，配一句「去电脑上批」。**这是一条真代价，不是暂缓**——要它能批，需要一个新的 human 类事件（比如 `approval_vote`）让执行方去认领，那是 ① / ② 的改动，另开 issue。

「等对面说完」那一格按 `pen_holder` 画（`holderKindOf` 分 desktop / cloud / phone）：非空 = 有人在跑，输入框上方一行小字说是谁（「电脑正在回复」/「云端正在回复」）。**不禁用输入框**：人话免笔，照样发得出去，正在跑的那一轮会在增量采样里读到它（ADR-0205 那条路）。

**「没人会答」三条同时成立才说**（总纲 §4.2）：笔空 **且** `profiles.last_seen_at` 陈旧（>90 s，同 §3.3 的宽限窗）**且** 没订阅（读 edge 的 `/billing/v1/me`）。任一不成立就不说 —— 三条里少查一条就会对一个电脑正醒着的人说「没人会答」。**查不到订阅 ≠ 没订阅**（同 ADR-0240 / 0217 的 `unknown` 一态）：查不到就不说这句话。

## 5. 离线：读得到，写不了

- **读**：列表与「最近打开的那条会话的事件尾」在 kv-store 留一份轻量副本（同一个 storage，key 前缀 `otto.tasks.`）。冷启动先画缓存再拉网络，拉到了整份替换。
- **写：离线不排队，当场拒绝并说清。** 与桌面**故意相反**（桌面离线照跑，因为它自己就是执行器）：手机没有执行器，排队发出去的那句话**没有人会答**，而它会在回网的某一刻突然起一轮 —— 一个用户早就忘了的时间点。拒绝的那句话要说「这句话还没发出去」，并把原文留在输入框里（同 ADR-0228 `unknown` 那条的纪律：别让人以为发过了）。
- 闸门这一侧另有一条已经定了的改动（**这一条属于 M1 的收尾，不属于 M2，但 M2 依赖它**）：离线冷启动且 access token 已过期时，`getSession()` 会回 `session: null`（盘上那份 session **没被删**，只是读路径这么答），于是人被弹回登录卡。改成照桌面 ADR-0183 的形状判 —— 读 kv-store 里那条记录，有非空 `access_token` 就算登录过。维护者 2026-09-12 拍板。

## 6. 五屏与四态

四态文案一律分开说（总纲 §5）：**还没查到**（没画过一次网络）/ **读不到**（查了，错了）/ **没有**（查了，是空的）/ **没权限**。

| 屏 | 要点 |
|---|---|
| 列表 `tasks` | 在跑的置顶画成 hero（完整说出它此刻在说什么，不截成一行灰字）；其余按 `updated_at` 分「今天 / 更早」；每行带执行方 pill（本机 / 云端 / 另一台电脑，`holderKindOf`）；底下一行「已归档 N」。导航栏：大标题 +「1 条在跑 · 4 条闲着」+ 搜索 / ＋ / 头像 |
| 开局 `taskNew` | 「今天要做点什么？」+ 四个示例话头 + composer。**不挑文件夹、不挑模型**（那是电脑的事，总纲 §4.2）。发出去 = 建会话并推进会话屏 |
| 会话 `taskChat` | §3 的时间线 + composer；导航栏右上电话（M7 之前先不画，或画成禁用并说明）+「⋯」会话菜单 |
| 已归档 `archive` | 列归档的，行尾「恢复」= `session_unarchived` |
| 搜索 `search` | 三栏共用一屏，从哪一栏进就搜哪一栏；v1 只搜**已加载**的标题 + 最近一句，空结果说「没有命中」而不是「没有会话」 |

## 7. 抽屉与新依赖

- 底部抽屉（下拉可关、带动量、吸附）**第一个消费方是模型选单**，照总纲 §10 第 5 条与 ADR-0293 决定 3：`react-native-reanimated` + `react-native-gesture-handler` 跟 M2 一起进。
- **开工第一步要在模拟器上验一句**：这两个包在 Expo Go SDK 57 里是不是自带原生模块。ADR-0293 决定 3 的前提就是「依赖只取 Expo Go 自带的」，验不过就得改方案（退回 RN 自带 `Animated` + `PanResponder`，手感差一档但不换运行时）。**不引第三方 bottom-sheet 库**。
- 模型选单的三条判据原样搬桌面：「文字 / 图像」两格的开关**在滚动列表外面**；图像那格**不共用**文字那格的选中态；**每次打开回到「文字」格**（ADR-0261 / 0249）。落 `model_changed` / `image_model_changed`（human 类，免笔）。
- 表单与确认仍用居中弹窗（`mobile/src/dialog.tsx`，ADR-0293 决定 7）；选择器才用抽屉。

## 8. 附件

对象名 `<uid>/<sha256 hex>`（内容寻址 = 去重 + 幂等，同 §3.6）。sha256 用 `expo-crypto` 的 `digest(SHA256, bytes)`；bucket `task-attachments` 的四条策略已经在 0036 里，authenticated 可以直传自己那层文件夹。

**先 PUT 字节再 append 事件**，永不推出一条悬空引用（同桌面）。字节层复用 `mobile/src/attach.ts` 的 `pickPhotos` / `pickFiles` / `prepareForUpload` / `tooBig`；超上限的图先缩再传走 `src/shared/imageFit.ts`（两端共用那份阶梯，ADR-0208）。

## 9. 测试与验收

- 纯逻辑（`taskTimeline` 的穷举表与四种 item、执行方文案、「没人会答」三条、离线拒绝的判据）进 `src/shared/` + `tests/shared/`，跟根门禁跑。
- **手机端类型检查现在在门禁里**（#422 / ADR-0294 已合或在合），不再需要手跑后抄进 PR 正文。
- 验收形态照 #1254：电脑建会话聊两轮 → 手机列表出现、内容一致；手机发一句 → 电脑醒着时拿笔答、手机看到「电脑正在回复」；手机新建 → 电脑侧栏任务栏出现并接着聊。
- 模拟器逐屏对照 demo，偏差记进总纲 §10。

## 10. 已知代价

1. **手机批不了审批**（§4）。电脑跑着一轮、撞上要批的刀时，人在手机上只能看。要它能批需要一个新的 human 类事件，另开 issue。
2. **停不了正在跑的那一轮**（同一条理由）。
3. **问卷只读**，`task_answer` 等 ②。
4. 离线发不出话（§5，是决定不是缺陷）。
5. 搜索只搜已加载的。
6. realtime 掉线靠聚焦 + 下拉兜底，最坏情况是列表陈旧到人再次回到窗前。
7. 真机一次没跑过；毛玻璃 / 抽屉手感 / 键盘推起输入框三样在 RN 上一定有偏差（总纲 §8 第 2 条）。

## 11. 否决的候选

- **复用 `projectTimelineForMobile`**：§3，两个不同的问题。
- **手机抢笔来批审批**：§4，会在电脑跑一半时夺走写权。
- **离线写入排队**：§5，会在用户忘了的时刻起一轮。
- **订事件表的 realtime**：单条 `tool_result` 能到 1 MB，payload 上限会把它静默丢掉（§3.1 已判过）。
- **第三方 bottom-sheet 库**：多一个原生依赖、且 Expo Go 不一定带得动；抽屉只要一种行为，自己用 reanimated 写一层就够（同桌面 ADR-0264 自写弹簧的取舍）。
