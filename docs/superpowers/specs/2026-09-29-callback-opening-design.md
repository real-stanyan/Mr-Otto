# 回电接通就开口：打电话时写好开场白，响铃时预合成 —— 设计

- 日期：2026-09-29
- Task issue：#1420
- 关系：#1411 智能体回电（ADR-0331）的后续。真机验收（#1417）时维护者说：「接起智能体打过来的电话之后，它还要等一会儿才说话。它为什么不想好了要说什么才打这通电话？」

## 维护者已拍板（2026-09-29）

1. **开场白在打电话那一刻写好**，接通时不再现想。
2. **手机在响铃那几十秒里先把开场白合成好**，接起来直接放。代价他知道：开场白随推送经过 Apple 的服务器（与锁屏那句 `reason` 一样）；没接的那一通，预合成那几句照样花听的人自己的语音额度。
3. 锁屏那条路受 iOS 限制（普通推送不叫醒 App），只能从点开通知那一刻开始合成；要做到锁屏也全省得加 Notification Service Extension，这次不做。

## 0. 已验前提（读代码核过）

1. 现在接通后的等待是两段串行：runtime 在 `setVoiceCall` 认出接听（`ringer.answer`）→ `greetNewcomers` 落一条 `user_message{greeting:"callback"}`、入队、**起一轮模型**（`callbackGreetingText` 只给了 `reason`，模型要现想说什么）→ 模型的回复流下来 → 手机按句（`splitSpoken`）调 `/llm/v1/speech` 合成 → 放。
2. `call_user` 只有一个参数 `reason`（≤60 字，锁屏那句）。一次响铃是 `call_ring` 事件（ringing → answered / missed），投影 `callRingFoldOf` 在 shared，runtime 与手机共用。
3. 接听那一刻，打电话的那只**可能还在跑它那一轮**：`call_user` 回给模型一句「已经打过去了」，模型可以接着干活。这时往日志里插一整段「它说了开场白、这一轮收口」会和 engine 正在写的那一轮交叉，还会用我们的 `turn_ended` 把它正在跑的那一轮在账本（`openTurns`）上提前收口。
4. `assistant_message.model` 是必填，语义是「实际生成这条的模型（事实，非配置）」。开场白是模型在调 `call_user` 那一刻写的，所以这个事实在日志里：打电话那条 `assistant_message`（`toolCalls` 里有 `call_user`）的 `model`。
5. 手机放音走 `voiceSession` 的 `speak(text, voiceId)`；音色 `agentVoiceId(agentId, roster)`，手机的 roster 是 `homeSnapshot().home?.agents ?? []`。预合成用同一个函数、同一份 roster，算出来的 `voiceId` 与接通后放音时一致。
6. 云会话线上帧对事件只做浅校验，`call_ring` 加一个可选字段不用升协议版本（ADR-0331 已验）。

## 1. runtime

### 1.1 `call_user` 加 `opening`（必填）

- 描述：「他接起来之后你先说的那段话。口语、说给人听的，别用列表和记号；200 字以内。」
- 规整 `normalizeRingOpening`（shared，`callRing.ts`）：空白折成一个空格、去首尾；**超过 200 字拒绝**（抛错让模型缩短），不截断——截在半句上念出来比没有更糟；空串拒绝。
- `reason` 不动，仍是锁屏那句。

### 1.2 `call_ring` 事件带 `opening?: string`

- 可选字段：旧日志 / 旧版 runtime 落的那几条没有它，照常重放。ringing 之后的 answered / missed 照抄（同 `reason` 的写法）。
- `RingState` 加 `opening: string | null`，`applyCallRing` 从 ringing 那条取。
- 模型不可见：`call_ring` 本来就不进模型上下文，开场白进模型是靠 §1.3 落的那条 `assistant_message`。

### 1.3 接通：替它把开场白说出来（不起模型调用）

`setVoiceCall` 里 `ringer.answer` 回来的那一通带着 `opening`，并且**这只此刻没有开着的一轮**时（判据只一处：`openTurns(日志)` 里没有它——排着队的与正在跑的，开场白都在日志里、都算开着；不看 `coordinator.isRunning()`，那是全会话的，别的 agent 在跑不妨碍这只开口），同步连落三条，然后不入队：

1. `user_message`：`callbackAnsweredText(agentName, userLabel)`——`[系统] 「名字」打给 某某 的电话接通了。`；`fromUid` = 接电话的人，`mentions: [agentId]`，`greeting: "callback"`（时间线照旧不画）。
2. `assistant_message`：`agentId`、`content = opening`、`model` = 打电话那条 `assistant_message` 的 `model`（从日志倒着找这只最近一条 `toolCalls` 含 `call_user` 的；找不到用这只的最近一条 `assistant_message` 的 `model`；再没有用 `"unknown"`）。不带 `usage` / `route` / `creditCostMicro`：这一条没有花钱，钱在打电话那一轮里已经算过。
3. `turn_ended`：`outcome: "completed"`、`agentId`、`readUpToSeq` = 第 1 条的 seq。账本就此收口，「正在回复」那盏灯不亮。

三条在同一个同步段里 append（JS 单线程，中间插不进别的事件）。之后人说的第一句话照常起一轮，模型看到的上下文是连贯的：「接通了」→ 它自己说的开场白 → 人的回话。

**回落到现在那条路**（落带 `greeting:"callback"` 的开场白 + 入队起一轮），两种情况：

- 这一通没有 `opening`（旧 runtime 打的、或者日志里是存量）；
- 这只此刻有开着的一轮（§0 第 3 条）。这时 `callbackGreetingText` 多带一句「你打电话时准备的开场白是：……，先照这个说」，模型照念，只省掉「现想」不省排队。

### 1.4 推送载荷

`RingPush` 加 `opening?: string`；`ringFromPayload` 容忍缺席（旧推送），类型不对当缺席（不拒整条——开场白只是预合成的料，缺了照样能接）。200 字 UTF-8 最多 600 字节，离 APNs 4 KB 上限远。

## 2. 手机

### 2.1 预合成缓存 `createSpeakCache`（shared，`src/shared/speakCache.ts`）

- 包住 `speak(text, voiceId)`，回同形状的函数，外加 `prefetch(texts, voiceId, untilTs)`。
- 键 = `voiceId + "\n" + text`。`prefetch` 对每句发一次 `speak`，把 promise 存起来；之后同键的 `speak` 直接拿这个 promise（**用一次就删**，同一句不会被放两遍时还占着内存）。
- 失败的不留：promise 落成 `ok:false` 就删掉，下一次 `speak` 照常现合成。
- 过期：每条带 `untilTs`（= 响铃时限 + 接听宽限），过了就删。没人接的那一通不会一直占着。
- 只对 `prefetch` 过的键起作用；别的 `speak` 原样透传。

### 2.2 接线

- `voiceStore`：`createVoiceSession` 的 `speak` 换成缓存包过的那一个。
- `ringStore.enqueue`：这一通带 `opening` → `prefetch(splitSpoken(opening), agentVoiceId(ring.agentId, roster), ring.expiresTs + RING_ANSWER_GRACE_MS)`。前台收到的、点通知进来的、冷启动那一条都经过 `enqueue`，一处接齐。
- 切句用放音那条路同一个 `splitSpoken`：接通后 `voiceFeed` 拿到的是整条 `assistant_message`（没有流式碎片），切出来的句子与预合成时逐字相同，键才对得上。

## 3. 不做的

- Notification Service Extension（锁屏收到就合成）：原生扩展 + App Group 共享缓存，改动大，等真机上觉得锁屏那条路还慢再说。
- 桌面端预合成：桌面没有来电页。
- 开场白的「过时」处理：打电话之后、接通之前又发生了什么，开场白不会知道；人回话之后模型那一轮看得到全部上下文，接得上。

## 4. 测试

- shared：`normalizeRingOpening`（折空白、200 字边界、空串）；`applyCallRing` 带 / 不带 `opening`；`ringFromPayload` 带 / 缺席 / 类型不对；`createSpeakCache`（命中一次后删、失败不留、过期删、未预取的透传、同键并发只发一次）。
- runtime：`call_user` 缺 `opening` / 超长报错；接通时这只空闲 → 日志里正好三条、`model` 取自打电话那条、没有入队、`openTurns` 里没有它；这只正开着一轮 → 走回落路、开场白进了 `greeting` 文案；没有 `opening` 的旧响铃 → 行为与改动前一致。
- 手机：接线靠 tsc；预合成的效果真机验（接起来的等待时间）。

## 5. 上线

runtime 重新部署（#791）；手机只改 JS，开发版重启 Metro 即生效，不用重打原生包。先部署 runtime 再用：旧 runtime 不认 `opening` 参数也不往推送里放，新手机照常工作（没有料可预合成）。

## 6. 决策记录

ADR-0332：「接通时由 runtime 替智能体落开场白，不起模型调用」——这是仓里第一处不经 engine 写 `assistant_message` 的地方，判据（只在这只空闲时、`model` 取自日志里写下开场白的那一次调用）要写进 ADR。
