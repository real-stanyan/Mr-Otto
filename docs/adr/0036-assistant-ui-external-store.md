# ADR-0036: assistant-ui 走 ExternalStoreRuntime —— 投影，不是第二个事实来源

日期：2026-08-20　状态：已接受

## 背景

会话区要接 assistant-ui 的 `Thread` 组件。assistant-ui 是完整框架：`Thread`
必须包在 `AssistantRuntimeProvider` 里，它的 runtime 想自己持有消息流、自己管
`onNew`/`onEdit`/`onReload` 这套写入接口。本仓硬规则是「append-only 事件日志是
唯一事实来源」。两者直接对撞——runtime 自己的状态就是第二个事实来源。

## 决定

用 `useExternalStoreRuntime`（`src/renderer/src/aui/useOttoRuntime.ts`）：状态归本仓所有，
`buildOttoAdapter`（`src/renderer/src/aui/ottoAdapter.ts`）只做格式翻译，不持有任何状态。

- `messages` = 纯函数 `toThreadMessages(events, live)` 的结果——事件日志的只读投影
- 写入方向 `onNew` 回 `input.send`、`onCancel` 回 `input.cancel`，都是既有的 ShellBridge 路径
- **刻意不提供 `onEdit` / `setMessages`**

## 理由

`toThreadMessages` 与 `src/session/deriveMessages.ts` 同性质：都是从同一份日志
推导的只读投影，一个喂模型、一个喂 UI。硬规则「任何投影必须可从日志推导」
在这条线上成立。

不给 `onEdit` / `setMessages`，是因为本仓没有消息编辑、也没有对话分支。
给了就等于凭空长出一条绕开事件日志的写路径——那才是真正违反硬规则的地方，
而不是「引入了一个第三方 runtime」本身。

## 代价

`ExternalStoreAdapter<T>` 在 `T = ThreadMessageLike` 时强制要求 `convertMessage`
（类型定义：`T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>`，
`ThreadMessageLike` 不满足前者），本仓传恒等函数 `(m) => m`。这是纯粹的类型仪式，
无运行时成本。

投影不做 compact 的历史替换（`deriveMessages` 做）：喂模型的那份必须真替换，
喂人的这份必须留着给人翻。两份投影**刻意不同**，改其中一份时别顺手对齐另一份。

## `onReload` 的反复：接了，又不算破戒

草案阶段（迁移设计初期）`onReload` 和 `onEdit`/`setMessages` 一样被划进「刻意不提供」：
`ottoAdapter.ts` 当时的理由是本仓的重试有 fill 档（原消息带附件时把正文填回输入框、
不重发），语义上不是 assistant-ui 期待的纯粹 regenerate，接上去等于给用户一个有时
什么都不生成的「重新生成」键。**在当时这个判断是对的**——旧的 `ThreadViewport` 上还挂着
`MessageActions`，每条模型回复悬停都有独立的重试/重发键，`onReload` 空着不影响任何功能，
只是 assistant-ui 自带的 `ActionBarPrimitive.Reload` 按钮被晾成哑按钮。

`ThreadViewport` 随旧渲染路径一起被删掉后，`MessageActions` 这个入口跟着消失了——
留下的只有 `turn_ended(error)` 那一条错误行上的 `RetryButton`，覆盖不到「回复得好好的
也想重来一次」这种场景。这时「`onReload` 语义不够纯」和「重试功能整体消失」两个代价
不再是同一量级：前者是接口哲学上的洁癖，后者是真实功能回归。于是接回：

```ts
// 接回 onReload:本仓的重试有 fill 档(原消息带附件时把正文填回输入框,不重发),
// 语义上确实不是纯粹的 regenerate。但接线后 MessageActions 那个入口没了,
// 「语义不够纯」远轻于「功能没了」—— fill 档也不是什么都不做:
// 正文落进输入框、用户确认后自己发,这正是本仓自己选的降级(见 lib/retry.ts)
onReload: async () => {
  input.retry();
},
```

`onReload` 没有违反本 ADR 的核心决定：它转交的 `retry`（`useOttoRuntime.ts`）落到
`lib/retry.ts` / `lib/retryAction.ts`，走的还是既有 ShellBridge 写入路径，没有绕开
事件日志。真正的界线只在 `onEdit` / `setMessages`——那两个才是会让 runtime 自己
凭空产生消息状态的入口，至今仍然刻意空着。

## 什么前提倒了会推翻它

本仓开始支持消息编辑或对话分支。那时 `setMessages` 就不再是「绕开日志的
写路径」，而是需要一套分支事件来支撑——届时重开这个决定。
