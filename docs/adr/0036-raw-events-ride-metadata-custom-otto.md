# ADR-0036: 装不进 assistant-ui 消息模型的两类东西，原样挂 `metadata.custom.otto`，交给既有组件渲染

日期：2026-08-20　状态：已接受

## 背景

`toThreadMessages`（`src/renderer/src/aui/toThreadMessages.ts`）把事件日志投影成
`ThreadMessageLike[]`。这套目标类型的 `content` 是一个穷尽的 part 联合
（`text` / `reasoning` / `tool-call` ……），描述的是"模型说了什么"，不是
"会话里发生了什么"。有两类日志里的真实事实，装不进这个模型：

1. **八类非对话审计事件**：`session_created`/`archived`/`renamed`、`model_changed`、
   `skill_invoked`、`image_described`、`approval_decision(denied)`、
   `turn_ended`（非 `completed`）。它们不是对话内容，`ThreadMessageLike` 的
   part 类型里没有它们的位置，但本仓的时间线视图（`Timeline.tsx` 的
   `EventRow`）一直把它们渲成看得见的行——迁移的前提是保留这份视觉。
2. **用户消息的附件**（图片引用 / 文本文件快照）：`ThreadMessageLike` 有
   `attachments` 字段，但它假定投影时就能同步产出内容。本仓图片走内容
   寻址存储、经 IPC 懒取（ADR-0009），而 `toThreadMessages` 是纯函数——
   `toThreadMessages.ts:100-102` 的注释写明了这条线："投影是纯函数不碰
   IPC"。往 `attachments` 字段里塞东西，要么在投影里发起 IPC（违反纯函数），
   要么预先把所有图片读出来转 base64 塞进去（把大块字节搬进渲染热路径，
   正是 ADR-0009 一开始要躲开的那类代价）。

## 决定

两类都不装进 `content`/`attachments`，而是把**原始 `SessionEvent` 整个**
挂在 `metadata.custom.otto` 上（`toThreadMessages.ts:74-82` 的 `toAuditMessage`，
`:95-104` 的 `user_message` 分支），角色标成 `"system"`（审计事件）或正常的
`"user"`（附件走同一条 user 消息的 metadata）。`OttoThread.tsx` 用 `thread.tsx`
新增的两个 override 槽把它读回来：

- `SystemMessage` override 从 `metadata.custom.otto` 取出事件，直接喂给
  既有的 `EventRow`——一行没重写。
- `UserAttachments` override（`OttoUserAttachments`）同样取出事件，喂给
  既有的 `UserAttachments` 组件——它自己走 IPC 懒取、自己缓存、自己在图片
  丢失时降级成占位卡，这些行为不该在投影层重做一遍。

## 理由（已否决的备选）

**备选一：为这两类东西各建一条独立渲染路径**（比如审计行在 assistant-ui 的
`Thread` 外面单独渲一段时间线，附件走一个自定义 part 类型）。否决：
`EventRow` 和 `UserAttachments` 已经把这些场景的视觉打磨过一轮（图标、
文案、审批态展示、懒取/缓存/降级），第二条路径要么重写一遍去够回同样的
保真度，要么保真度打折——两种都是这次迁移明确不接受的代价。而且两条
路径以后要一起改：Timeline.tsx 改了展示逻辑，第二条路径不会自动跟着变。

**备选二：给 assistant-ui 的 part 类型或 attachments 字段做扩展**（自定义
一个 `audit-event` part 类型，或者绕过同步限制往 `attachments` 里塞一个
"待解析"占位）。否决：`ThreadMessageLike` 的 part 是穷尽 union，这几类
审计事实本质上不是"模型说的话"，往 content 里塞等于扭曲这套类型自己的
语义模型；`attachments` 同理假定的是同步已知的数据，本仓的懒取模型
（ADR-0009）从设计上就不满足这个假设——不是"暂时没做"，是这套字段的
契约本来就不是为这种数据形状设计的。

`metadata.custom` 是 assistant-ui 官方开放的、类型为
`Record<string, unknown>` 的自由字段，专门给"这条消息还带着哪些宿主应用
自己的数据"用——用它承载一个不属于消息内容模型、只有本仓渲染层认识的
`SessionEvent`，是这个字段本来的用途,不是滥用。

## 代价

`components/assistant-ui/thread.tsx` 是 `shadcn add` 装进来的 copy-in
文件，upstream 的骨架版本没有这三个槽（`SystemMessage`、
`UserAttachments`、`RunIndicator`——第三个是 ADR-0034 之外另一处回归修复，
同样靠槽实现，参见 `thread.tsx:72-80`）。这三处是本仓手工加在 upstream
骨架里的扩展点，每次跑 `shadcn add --overwrite` 重新安装或升级这个组件，
这三处都会被覆盖掉，要对着 diff 手工加回来。已经在每个槽的定义处留了
注释说明它是本仓加的、干什么用的（降低升级时漏掉或看不懂为什么要加回去
的概率），但这依然是一笔跟着每次 registry 升级重复出现的成本，不是
一次性的。

## 什么前提倒了会推翻它

assistant-ui 自己长出等价能力——比如给 `attachments` 一个真正支持异步
懒解析的 adapter 接口（不要求投影同步产出内容），或者给消息类型加一个
官方支持的"系统/审计"角色渲染扩展点且语义覆盖到这八类事件。到那时候，
`metadata.custom.otto` 这条路子可以换成官方接口，`SystemMessage` /
`UserAttachments` 这两个手工槽也就不用每次升级都补一遍。
