# ADR-0263：云会话的流式输出 —— `delta` 帧走累计快照，不进事件日志

- 状态：已采纳
- 日期：2026-09-08
- 关联：#1107；ADR-0199（云会话）、ADR-0250（云会话只剩输入指示器）、ADR-0214（流式光标）、#278（本机 delta 合帧）、#341（delta 不落日志的契约）；协议 13→14
- 来源：维护者原话 ——「工作区的智能体输出要流式输出」

## 背景

本机会话早就有流式：adapter 的 `onDelta` → engine 透传 → 主进程 16ms 合帧 →
IPC → 渲染层 `streamingBySession`，终态 `assistant_message` 一到整份覆盖预览
（#278 / #341 / ADR-0214）。云会话这条链路在同一处断掉：`sessionService.ts` 的
`engineFor` 从来不传 `onAssistantDelta`，于是 `openaiCompatible` 走非流式分支，
群里的人要干等到 turn 收口才看得见一个字——中间只有一枚输入指示器
（ADR-0250），而 runtime 那一侧的 adapter 链（`hostedRoute`）本来就原样透传
`onDelta`，**差的只有装配那一行**。

## 决策

### 一、碎片是帧不是事件——新事件类型的十一处检查清单一处都不用碰

delta 走 `CsDown` 的一个新帧类型（`{t:"delta", agentId, kind, text}`），
**不落事件日志**：预览不是事实（`persistencePolicy` 的 `TransientPushKind`
与本机逐字同一条）。若做成 SessionEvent，`events.ts` union、
`persistencePolicy`、`deriveMessages`、`deriveSections`、`isAuditEvent`、
`deriveUsage`、`contextEstimate`、`agentView.OTHER_AGENT_VERDICTS`、
`PRIVACY_VERDICTS`、`DURABLE` 那一整串穷举表全部要表态，而每一条的答案都是
「这不是事实」——它本来就不是事件。帧不进 backlog、不带 seq、不参与去重，
旧客户端认不出它会被静默丢（握手精确相等本来就挡住新旧混跑），协议号
13→14。

### 二、`text` 走累计快照，不走增量

帧里带的是「这只 agent 这一轮到此刻为止的完整正文」，不是这一片新字。
理由是一条链路上三个真实的洞：**中继掉帧**（256 KiB 上限、对端掉线都丢帧）、
**客户端中途 join**（它只能从 join 那一刻起收碎片，增量语义下开头永远是缺的）、
**gone 之后重连**（断开窗口里的增量永远到不了）。增量语义下每个洞都在预览上
咬出一个窟窿；快照语义下丢一帧只是少一次刷新。代价是流量从 O(正文) 变
O(正文²/帧长)——一段 2KB 的回复按 50ms 合帧不过几十 KB，比它大两个数量级的
backlog 全量每天都在发。

### 三、合帧放在 runtime 源头（50ms），桌面不再二次缓冲

中继不懂 payload（base64url 的 JSON），帮不上；桌面再合一次只会让「最新文字」
晚到。runtime 的 `deltaStream.ts` 按 (agentId, kind) 分桶、50ms 一帧
（本机是 16ms 因为 IPC 就在本机；云上隔着一跳中继，人眼读不出差别、帧数省
三分之二）。限速桶一概不碰——那套只管上行帧，下行的泄洪闸就是合帧本身。
分槽键是 **agentId** 不是会话：群里同一刻可能有好几只在打字。

### 四、顺序闸：任何事件出门之前先 flush（与本机 `send` 包装同一处纪律）

`sessionService.notify()` 开头无条件 `deltas.flush()`，终态事件落盘后再
`clearAgent(agentId)`（不清的话下一轮的预览从上一轮的残句开头）。不守这条，
一条迟到的尾巴会在 `assistant_message` 之后到达，渲染层清完缓冲又冒出一段
鬼影文字——本机那一侧的同一条纪律写在 `src/main/index.ts` 的 `send` 包装里。
daemon 的广播与 delta 走同一个 `globalSend`，同一 cid 上到达序 = 调用序。

### 五、reasoning 不过线

终态气泡（`AssistantMessageRow`）只画 `content`，**预览不该展示终态不存在的
东西**；推理模型的思考流还往往是正文的几倍长，不过线同时是流量考量。`kind`
字段留在帧里（decoder 两种都收），将来想在云会话画思考流时不需要再进位。

### 六、渲染层落在「正在回复」那一行上，不新开一处 UI

`PendingTurnLines` 的 running 气泡原来只有三点指示器；现在这只 agent 的
`cloudStreaming` 缓冲非空就把点换成正在长的文字——同一张 `muted` 气泡、同一个
位置、同一把排版尺，终态落下时像素一动不动（ADR-0250 的「点变成字」变成
「点变成字，字长成答案」）。queued 照旧一行小灰字不给气泡（一个 token 都没跑
的 turn 画上打字气泡是 #722 撒谎的勾）。`queued`/`running` 的投影
（`openTurns`）一个字没动。

### 否决的候选

- **复用本机 `deltaCoalescer`**：那一份的 key 字面量里有真的 NUL 字节
  （#841 在册），且 `src/main` 不该被 `services/runtime` import。共享的是
  契约（头注四条），不是代码。
- **渲染层继续拼接增量**：见决策二，三个洞。
- **进事件日志（带 `ignorable`）**：见决策一——那不是事实，且把十一处
  穷举表全部拖进来。

## 后果

- 云会话 agent 的回复逐段长出来，与本机会话同体感；turn 中间的「工具回合
  间隙」照旧退回三点（那一刻确实没有正文在长）。
- 部署依赖：runtime 一半（`sessionService`/`daemon`）**要重新部署 VPS 才
  生效**（#791 的纪律）；握手精确相等，新桌面连旧 runtime 会在 hello 被拒并
  给出「云端还没升级」的方向性文案（协议 6 起 `denied` 带服务端版本号）。
- 计费不变：hosted 适配器的流式分支本来就从 SSE 尾注读 `creditCostMicro`，
  hold-settle 与 `usage_event` 走同一条路。
- 已知代价：中继多一路扇出（50ms × 在线成员 × 同时在写的 agent 数），量级
  由合帧封顶；reasoning 在云会话仍然完全不可见（与本机不一致，见决策五）；
  协议 14 与并行的 #1102（也占了 13→14）在合并时后合的一方要把版本号再进一。
