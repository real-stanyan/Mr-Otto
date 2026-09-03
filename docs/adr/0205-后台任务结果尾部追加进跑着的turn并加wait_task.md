# ADR-0205：后台任务结果尾部追加进跑着的 turn，并加 wait_task 让模型在同一 turn 里等

- 状态：已接受
- 关联：issue #871；修订 ADR-0088 决定 2（「完成即以新 turn 回注，永不 mid-splice」）；对照 Claude Code 的 task-notification / TaskOutput
- 不推翻：ADR-0109（后台任务在 UI 上是一等公民）、ADR-0103（回注消息的身份记在事件上）、ADR-0073（微压缩攒批以保前缀缓存）

## 背景

维护者看一段真实轨迹（迁移 + 部署，四个后台任务）：每个后台任务完成后都另开一轮对话，「一件事拆成好几段会话」。他的话：后台任务应该在同一段会话里全部完成，参考 Claude Code 是怎么把完成结果传给模型的。

Claude Code 的做法（以本仓 agent 自己所在的 harness 为准）：

- 完成通知是 harness 写的 `<task-notification>` 系统块，不是 user message；
- **turn 还在跑**：通知搭下一条 tool_result 一起回给模型——纯尾部追加，模型下一次采样就看到，同一 turn 里接着干；
- **turn 已结束**：harness 重新唤起模型一次（这一点避不开）；
- 模型能**主动等**：`TaskOutput` / `Monitor` 阻塞到结果出来或条件满足，指令里明说「已委托出去的活不要自己再跑一遍、等通知」。

本仓现状（ADR-0088 决定 2）：turn 在跑就攒进 `pendingBg`，收口后另开一轮。理由引 ADR-0073——「turn 中途改投影中段 = prefix cache 全废」。

## 诊断

**ADR-0088 那条理由不成立。** ADR-0073 讲的是微压缩把中段消息**拿走**——前缀断裂。后台结果走 steer 同一条路是**尾部追加**：`deriveMessages` 的插话顺序修复（issue #344）把工具组开着时落的用户消息推迟到组的结果之后再进上下文，前缀字节一个不变，cache 照常命中。engine 的 `steer()` 现成，零 engine 改动就能追加。

轨迹证据：bg-4 在 seq 283 完成时 turn 还活着（seq 285 才收口，差 24 秒），照样被攒到收口后另开一轮（seq 287）。按尾部追加，模型在 seq 284 那次采样就该看到，同一 turn 收尾。

附带一个 bug：seq 314 / 317 是用户按「重试」重发回注 turn，渲染层 `resend` 走 `sendMessage`，而那个 IPC 入口刻意不透传 `background`（防伪造，ADR-0103）——回注消息一重试就丢了 `origin`，变成用户亲口说的。

## 决定

### 一、turn 在跑 → 当场尾部追加；idle 才另开一轮

`handleBackgroundDone` 三条路，按优先级：

1. **有 wait_task 正等着**（`BackgroundCompletion.claimed`）：结果已从那把工具的 tool_result 回给模型，只落审计事件。再追加 = 同一份结果进两次上下文；
2. **turn 在跑**：`engine.appendBackground(text, taskIds)` 追加一条 `user_message(origin:"background")`，模型下一次采样看到。事件形状与从前逐字节一致（ADR-0103 的 origin / backgroundTaskIds 都在），UI 照旧画成「不是你发的」系统卡（#452），只是它现在出现在 turn 中间而不是 turn 之后；
3. **idle**：`handleSendMessage` 另开一轮——模型已经交卷，只能把它叫回来。这是 Claude Code 也避不开的那一半。

②失败（压缩进行中）退回 `pendingBg` 攒着，收口后合并另开一轮——ADR-0088 的路只剩这个兜底用途。

**采样窗口的处理**（engine 内部）：模型正在采样时到的结果不当场落盘，攒到这条 `assistant_message` 落盘之后再追加。当场落的话日志序是 `user(后台结果) → assistant(模型正说的话)`，投影出来像模型已经答过这个结果了——它根本没看见。攒到它说完再落，日志序才是它的真实视野。采样中断/暴死同样落盘（在 `turn_ended` 之前）：完成是已发生的事实，不能随 turn 蒸发。

**收口前多看一眼**：模型这步没要工具（要收口）时，engine 查一次「这次投影之后有没有落新的用户消息」——有就再采样一圈。没有这一眼，模型说「没事了」的当口到的结果会永远挂在日志尾上没人答。代价只在真撞上这个窗口时付，且每圈都消费掉新消息，不会空转。这一眼对 steer 同样生效（插话撞上模型最后一句话的窗口原来也是没人答，顺手修了）。

### 二、新工具 `wait_task(task_id, timeout_seconds)`

模型在同一 turn 里阻塞等一个后台任务出结果（Claude Code TaskOutput 对照）。三种结局是 `kind`（ADR-0193 同款立场，事实不是线索）：

- `done`：带完整结果（与 `formatCompletion` 同款文案与截断）；
- `timeout`：任务还在跑，带此刻的输出尾巴，可以再等一次；默认 300 秒，上限 1800 秒（与任务自身的 30 分钟超时对齐——等得比任务活得还久没有意义）；
- `unknown`：没这个任务（id 打错，或上一次 app 运行留下的——进程早没了）。

中断 = 用户按了停止：reject 成 AbortError 让 turn 走 aborted 收口，不伪装成「等超时了」。`available` 现查 `armed`——没接回注的装配（subagent）起不了后台任务，这把刀从声明表里消失。接口 `BackgroundWaiter` 声明在工具层（与 `BackgroundStarter` 同款分层），`BackgroundTasks` 实现它。

这是「同一段会话里全部完成」真正靠的那一条：光有决定一，模型说完「等 CI」就交卷，idle 重唤起照样发生。bash 的三处文案（工具描述 / 参数说明 / 转后台的回执）从「以新消息注回，无需轮询等待」改成「结果自动进入对话；后面的步骤依赖它就 wait_task 等，别结束回合」。

### 三、重试保留身份

新 IPC `resendMessage(sessionId, seq, attachments)`：正文与 `origin` / `backgroundTaskIds` 由主进程从日志里那条事件上取，渲染层只报 seq。`sendMessage` 那个入口继续不透传 background（防伪造的立场不变），重试一条回注消息就不会再把它变成用户亲口说的。附件仍由渲染层翻译（`lib/resendPayload.ts`），与 sendMessage 同形。

## 否决的路

- **攒收件箱等用户领取**（issue #454）：模型可能正在等那个结果，用户不点 = 那件事永远做不完。本 ADR 与它不冲突——那条的硬风险正好由 wait_task 化解，要不要做收件箱可以另议。
- **让 appendBackground 在采样中当场落盘**：见上，投影会撒谎。
- **给 user_message 加「投影时刻」字段来纠正顺序**：schema 改动换来的东西，攒一拍再落就有了。

## 后果

- 后台任务完成时 turn 还活着的情形（轨迹里 4 个任务里的 1 个）不再另开一轮；模型用 wait_task 的话，剩下 3 个也能收进同一 turn。
- 「不是你发的」那张卡会出现在工具组之间，位置比从前更靠近它发生的时刻。
- e2e `backgroundOrigin.e2e.ts` 的断言不变（两个气泡、回注卡带 origin），只是回注现在多半发生在同一 turn 里。
- 兜底 `pendingBg` 只在压缩进行中才会被用到；测试仍钉住它。
- 会让本决定翻转的前提：某家模型 API 不接受「tool 消息之后紧跟一条 user 消息」——OpenAI 方言与 Anthropic 都接受，steer（issue #344）上线以来没撞过。
