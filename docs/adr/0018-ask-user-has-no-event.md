# ADR-0018：向用户提问不落新事件，问卷组件手写

- 状态：已接受
- 日期：2026-08-18
- 相关：#42，ADR-0017（todo 清单不落事件）、ADR-0006（turn 中断）

## 背景

Otto 在动手规划一个非平凡任务之前，应该先把关键抉择抛给用户，而不是自己
替用户拍板（参照 Claude Code 的 AskUserQuestion）。落地需要三个决定。

## 决定一：不新增 `question_asked` / `question_answered` 事件

问题存在 `assistant_message.toolCalls[].args` 里，答案存在 `tool_result.output`
里——两头本来就落盘、本来就进投影。再加一个事件类型就是把同一件事记两遍，
而两份记录会漂移（谁是准的？）。

这是 ADR-0017 的同一条法理（"推得出的不落盘"），更早的先例是被砍掉的
`turn_started`。日志依然是唯一事实来源：把日志重放一遍，"模型问了什么、
用户答了什么"逐字可复现。

**代价**：

- 与工具名 `ask_user` 耦合——改名就等于改了投影的语义。
- 时间线要认出这次调用是"提问"，只能靠工具名 switch（`toolSummary`），
  跟 `todo_write` 同一处代价。

**什么情况下该推翻**：如果将来用户能在 UI 上主动发起提问、或能事后修改
已交的答卷，那就出现了不在任何 toolCall/tool_result 里的新信息——那一刻
必须落盘，不能再靠投影推导。

## 决定二：`Tool.run` 加可选第三参 `{ toolCallId, signal }`

`ask_user` 是唯一一个"世界是人"的工具：它要悬停等一次 UI 往返。这需要
两样东西——自己这次调用的 id（唤醒挂起 Promise 的钥匙）和 turn 中断信号
（ADR-0006：中断时必须立刻收场，否则整条管线卡死等一个永远不会来的人）。

考虑过的另外两条路：

1. **做成中间件**（像审批门那样）。但审批门是"放行/短路"的关卡，
   `ask_user` 是干活的那一层本身；把它写成中间件等于用洋葱层伪装一个工具。
2. **给 Tool 加 `emits` 出口**，让工具自己推事件。那会把事件 schema 的耦合
   扩散到每一个工具身上，代价远大于收益。

可选参数意味着现有工具一个字都不用改，`ExecutionWorld` 的硬规则也没被碰：
`ask_user` 不 import fs / child_process，它依赖注入进来的 `Asker` 接口。

取消时 `ask_user` 返回 `concludesTurn: true`：没人回答就不该继续猜着往下做。

## 决定三：问卷 UI 手写，不装 shadcn 的 Questionnaire

`shadcn add questionnaire` 装不下来——文档页在（2026-08 发布），但注册表
条目 `r/styles/new-york-v4/questionnaire.json` 一律 404，CLI（latest 和
canary 都试过）取不到。而文档主推的 Base UI 变体会给仓库引进第二套
primitive（现有 UI 全部基于 radix-ui）。

于是按文档公开的 API 自己实现：同名的零件、同样的 `items` + `onSubmit`
契约。将来注册表上线可以原地替换，调用方（QuestionnaireCard）不用改。
