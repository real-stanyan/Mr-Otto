# 会话区交互补全（对照 assistant-ui primitives）

日期：2026-08-19
状态：待实现

## 背景

Otto 的输入区（composer）已经很完整：slash / `$skill` 菜单、附件三入口（粘贴/拖拽/＋）、
发送键原位变停止键、上下文占用环、会话偏好折叠。但**消息区**几乎是裸的——
只有事件铺开渲染，没有任何针对"读"和"取用"的交互。

对照 [assistant-ui](https://www.assistant-ui.com/) 的 primitive 清单
（Thread.Viewport / ScrollToBottom / Suggestion、Message.Parts、ActionBar、
GroupedParts / ToolGroup、SelectionToolbar、Error），逐条比对后确认了 8 个缺口。

**不引入 `@assistant-ui/react` 依赖。** 该包的核心是 runtime + 消息树状态层，
而 Otto 的事实来源是 append-only 事件日志、投影走 zustand，硬规则写死
「任何投影必须可从日志推导」。装它等于再塞一套状态层，两边打架。
本设计只搬它的**交互行为**，实现继续用现有 shadcn / Tailwind / radix 栈。

明确不做：
- **建议 chips**（Thread.Suggestion）——Otto 接的是真实工程目录，硬编的
  「帮我重构代码」对不上任何实际仓库，是噪音。
- **消息编辑 / 分支**（ActionBar.Edit / BranchPicker）——与 append-only 冲突，
  要改历史。重试用追加语义替代（见下）。

## 缺口与设计

### 1. 粘性自动滚动

现状 `App.tsx:2196`：每次事件/流式片段变化都无条件 `bottomRef.scrollIntoView()`。
后果：模型正在流式输出时，用户往上翻历史会被一下下拽回底部，根本读不成。

改成 assistant-ui Viewport 的 stick-to-bottom：

- 滚动监听算 `atBottom`（`scrollHeight - scrollTop - clientHeight <= 48`）。
- 只有 `atBottom === true` 时才跟随新内容。
- 用户往上滚 → 脱离跟随；滚回底部 → 自动恢复跟随。
- **自己发消息永远滚到底并恢复跟随**：发送这个动作本身就是"我要看结果"。

落在 `lib/useStickToBottom.ts`（纯逻辑 + ref，可测阈值判定）。

### 2. 「回到最新」浮钮

脱离跟随时，消息区右下浮一颗胶囊（`↓ 回到最新`）。
脱离期间有新事件到达时，胶囊上加一颗小圆点——告诉用户"下面有你没看到的东西"。
点击：滚到底 + 恢复跟随 + 清掉圆点。

落在 `components/ThreadViewport.tsx`，把现在那个 `<section>` 连同滚动逻辑一起收进去。

### 3. 连续工具调用折成一组

现状：`EventRow` 把每个 `toolCalls` 项渲染成一行 `ToolRow`，全程平铺。
一个 turn 读 12 个文件就是 12 行，把真正的模型回复顶出屏外。

对应 assistant-ui 的 `MessagePrimitive.GroupedParts` / `ToolGroup`：

- 新增纯函数 `lib/threadGroups.ts`：把 `SessionEvent[]` 投影成渲染项数组
  （`{kind:"event"} | {kind:"toolGroup", calls, ...}`）。
  **分组规则**：相邻的工具调用（中间没有非空 `content` 的 assistant 正文）合成一组。
  跨 `assistant_message` 事件也算相邻——agent 循环里"调工具→拿结果→再调工具"
  本来就是连续的一段动作。
- **单个调用不加壳**：一个调用套一个折叠容器是纯粹的视觉噪音，照旧渲染 `ToolRow`。
- **≥2 个才折**。折叠头显示：动作摘要 + 总耗时，例如 `读了 5 个文件、改了 2 处 · 2.4s`。
  摘要复用现有 `toolSummary()` 的 verb。
- **执行中自动展开**（看得见进度），全部完成后自动收起。
- **有失败就不自动收**，且失败数染红。错误绝不能因为折叠被藏掉。
- **用户手动点过之后停止自动驱动**：自动行为不该抢用户已经表达过的意图。

落在 `lib/threadGroups.ts`（纯函数 + vitest）+ `components/ToolGroup.tsx`（UI）。

### 4. 消息动作条（复制 / 重试）

对应 assistant-ui 的 ActionBar。assistant 消息 hover 时，正文下方浮出一行动作：

- **复制**：复制的是 **markdown 原文**（`event.content`），不是渲染后的可见文字。
  用户要粘进编辑器的是源码不是排版结果。
- **重试**：只挂在最后一条 assistant 消息上。

**重试语义（append-only 约束下的取舍）**：
assistant-ui 的 Reload 是"重新生成、换掉旧回复"，Otto 做不了——那要改历史。
Otto 的重试 = **把上一条 `user_message` 的正文原样再发一遍**，
追加新的 `user_message` + 新 turn，旧日志一字不动。
时间线上会出现两条一样的用户消息——这就是事实：你确实又问了一遍。

原消息带附件时不能一键重发（附件本体在附件库，重新暂存要新增 bridge 方法，
超出本轮范围）。这种情况按钮改成**「填回输入框」**：正文填进 composer 并聚焦，
用户自己重新把图拖进去。按钮文案随状态变，不做静默降级。

落在 `components/MessageActions.tsx`。

### 5. 代码块复制键

`<pre>` 右上角，hover 出现。现在已经有 `rehype-highlight`，只差这一层。
桌面 agent 工具里"把模型给的命令/代码抠出来"是最高频的动作。

落在 `components/CodeBlock.tsx`（作为 react-markdown 的 `pre` 覆盖组件）。
复制反馈（勾号 1.5s 后复原）抽成 `components/CopyButton.tsx`，
被 4 / 5 / 工具详情三处共用。

### 6. 错误行带重试

对应 assistant-ui 的 Error primitive：失败不只是一行红字，自带恢复出口。
`[turn 失败]` 那行右侧挂一颗重试，动作与 4 完全相同（同一个函数）。

### 7. 思考折叠头显示真实耗时

现状：折起来只写「思考过程」，不知道里面有多少东西、想了多久。
assistant-ui 的对应物是「Thought for Xs」。

**耗时必须是日志事实，不能是 UI 猜的**（硬规则：投影必须可从日志推导）。
`assistant_message.ts` 减前一条事件的 ts 只能得到"整次模型调用耗时"，
不是纯思考时间。所以给 `AssistantMessageEvent` **加一个可选字段** `reasoningMs`。

- schema **只加不改**，旧日志无此字段照常重放（向后兼容硬规则满足）。
- 测量点在 `src/loop/engine.ts`：`onAssistantDelta(text, kind)` 已经按
  `kind: "content" | "reasoning"` 分频道。引擎包一层，记下
  **第一个 reasoning 碎片**和**第一个 content 碎片**的时刻，
  差值即纯思考耗时；没有 content 碎片时用调用结束时刻兜底。
- 非流式路径（`onAssistantDelta` 未传）测不到 → 字段缺席 → UI 退回只显示字数。
  缺席不是错误，是"这条日志没这个事实"。
- 折叠头文案：`思考 420 字 · 6.2s`；无 `reasoningMs` 时只写 `思考 420 字`。

这条改动跨到主进程 + 事件 schema，需要一份 ADR（`docs/adr/0032-*`）。

### 8. 划词引用

对应 assistant-ui 的 SelectionToolbar。在消息区内选中一段文字 → 选区旁浮出
「引用」→ 点击后以 `> ` 前缀引进输入框并聚焦。编码 agent 里这是高频动作
（「这段函数改一下」），现在只能手动复制再粘。

输入框的 `input` state 是 `App` 的局部 `useState`，选区组件够不着。
走 store 传一个 `pendingQuote: string | null`，`App` 用 effect 收下、拼进 `input`、
清空 `pendingQuote`。不把 composer 的输入状态提到 store——那是更大的重构，
本轮不碰。

落在 `components/SelectionQuote.tsx` + store 的一个字段和一个 action。

## 文件划分

App.tsx 已经 2538 行，且同一 repo 另有 3 个 agent 在并行改它
（侧栏分区 / 终端面板 / 背景）。新代码尽量落新文件，并把消息区从 App.tsx 搬出来：

```
src/renderer/src/lib/useStickToBottom.ts      滚动粘性（阈值判定可测）
src/renderer/src/lib/threadGroups.ts          事件流 → 渲染项分组投影（纯函数）
src/renderer/src/components/Timeline.tsx      EventRow + ToolRow（从 App.tsx 搬出）
src/renderer/src/components/ThreadViewport.tsx 滚动容器 + 回到最新浮钮
src/renderer/src/components/ToolGroup.tsx     工具调用折叠组
src/renderer/src/components/CopyButton.tsx    复制 + 勾号反馈（三处共用）
src/renderer/src/components/MessageActions.tsx assistant 消息 hover 动作条
src/renderer/src/components/CodeBlock.tsx     markdown pre 覆盖 + 复制
src/renderer/src/components/SelectionQuote.tsx 划词浮钮
```

改动的既有文件：
- `src/session/events.ts` — `AssistantMessageEvent` 加可选 `reasoningMs`
- `src/loop/engine.ts` — 测量并写入 `reasoningMs`
- `src/renderer/src/store.ts` — `pendingQuote` 字段 + `quoteToComposer` action + 重试 action
- `src/renderer/src/App.tsx` — 消息区换成 `<ThreadViewport>`，删掉搬走的组件和旧滚动 effect
- `docs/adr/0032-*.md` — 事件 schema 加 `reasoningMs` 的决策记录

## 测试

vitest，统一放 `tests/`，镜像 `src/` 结构：

- `tests/renderer/threadGroups.test.ts` — 分组投影：单个不成组、连续跨事件合并、
  正文打断分组、失败调用的分组状态、空事件流。
- `tests/renderer/useStickToBottom.test.ts` — 阈值判定：正好在底、差 47px、差 49px、
  内容变高时的跟随判定。
- `tests/loop/reasoningMs.test.ts` — 引擎按 delta 时序算出的耗时，
  以及无 reasoning / 无 content 碎片时字段缺席。

现有测试必须全绿（`npm test` 是硬门禁）。

## 错误处理

- **剪贴板写入失败**（Electron 里罕见但可能）：`CopyButton` 捕获，
  勾号不出、改闪一次失败态，不弹 toast——复制失败不值得打断。
- **重试时上一条用户消息不存在**（会话第一条就失败等）：重试按钮不渲染。
- **`reasoningMs` 为负或异常大**：UI 侧不渲染时间，只显示字数。日志照原样存
  （日志记事实，不做美化）。
- **划词选区跨越多条消息**：照常引用选中的全部文本，不做拆分。

## 风险

- **App.tsx 并行冲突**：另外 3 个 agent 同时在改这个文件。缓解方式是
  尽量往新文件放、对 App.tsx 只做"删除搬走的代码 + 换掉消息区那一段"的集中改动，
  合并时冲突面小且位置明确。
- **`reasoningMs` 溢出到内核**：本轮唯一跨进程的改动。它是可选字段、
  只加不改、缺席即退化，风险可控，但必须有 ADR。
