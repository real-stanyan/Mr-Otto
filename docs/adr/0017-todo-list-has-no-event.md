# ADR-0017：任务清单不发新事件，投影自 todo_write 的调用参数

日期：2026-08-18
状态：已接受
相关：issue #38、ADR-0004（lifecycle 事件）

## 背景

Otto 需要"把大任务拆成小任务并可视化进度"。清单是有状态的东西：模型写一版、
改一版，UI 要显示"当前这版"。

直觉方案是加一个 `todo_updated` 事件，携带整表快照，engine 落盘，UI 投影。
这也是 issue #38 最初的写法。

问题在于：工具执行路径上根本没有"工具产事件"这条通道。`Tool.run` 只返回
`string | { output, concludesTurn }`，事件全由 engine 按固定形状追加。要落
`todo_updated`，得给 `Tool` 接口开一个 `emits` 出口（任何工具都能往日志里塞
任意事件），或者在 engine 里按工具名特判——前者把事件 schema 的耦合面从
engine 一处扩散到每个工具，后者是明着开后门。

## 决策

**不加事件、不改 Tool 接口。清单投影自 `todo_write` 调用自身的参数。**

模型每次改写清单，本来就会产生一条 `assistant_message`，其 `toolCalls` 里
`name = "todo_write"`、`args = { items: [...] }` —— 整张表已经逐字躺在
append-only 日志里了。再落一份 `todo_updated`，存的是同一份数据的第二个副本。

`deriveTodos(events)` 于是是纯投影：扫日志，认最后一次**成功执行**的
`todo_write` 的 args。

认 `tool_result.status === "ok"` 而不是认 `assistant_message`：被审批拒绝、
被用户中断、参数非法的调用同样留在 `toolCalls` 里，但它们从未生效。只认落了
ok 结果的那次，清单才与"实际发生了什么"一致。

## 理由

**这是仓库既有原则的直接应用，不是新发明。** `events.ts` 里 `TurnEndedEvent`
写着："刻意没有 steps 字段：模型调用次数 = 数两条 turn 边界间的
assistant_message，推得出的不落盘（同一原则砍掉了 turn_started）。"清单是同一
类东西 —— 推得出，所以不落盘。

顺带的好处：

- schema 零变更，向后兼容问题不存在（老日志投影出空清单）
- `deriveMessages` 不需要任何特判：`todo_write` 走普通 toolCall 通道，模型看到
  的就是自己写的表 + 一句回执，不多不少
- engine 零改动，`Tool` 接口零改动 —— 没有新的耦合面

## 代价与推翻条件

**代价 1：投影耦合到工具名字符串。** `deriveTodos` 得知道有个叫 `todo_write`
的工具。用 `TODO_TOOL_NAME` 常量收成一处出口，改名只改一行。

**代价 2：扫全日志而不是读最后一条快照。** 长会话里每次渲染都要走一遍事件数组。
和 `deriveMessages` 同量级，渲染层已经这么干了，不构成新问题。真成瓶颈时先加
memo，而不是回头加事件。

**代价 3：`context_compacted` 之后模型会忘掉这张表**，但 UI 还显示着（投影扫
的是全日志，压缩收的是模型上下文）。可接受：模型重写一份即可覆盖。

**推翻条件：** 如果将来清单需要**非模型**来源的改写（比如用户在 UI 上手动勾掉
一项），那一刻起清单就不再"推得出"了 —— 用户的勾选是新信息，必须落盘
（model-visible means logged 的同一法理）。届时补 `todo_updated` 事件，
`deriveTodos` 改成同时认两个来源。
