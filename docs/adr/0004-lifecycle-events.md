# ADR-0004: 细粒度 lifecycle 事件（tool_execution_started / turn_ended）

## 状态

已接受（2026-08-16）

## 背景

日志记录的是对话史（user_message / assistant_message / tool_result），但系统运行本身
也有事实，此前全部丢失：

1. **turn 死亡无痕**：API 报错 / 工具抛错只走 IPC reject 给当时的 UI，
   日志里 turn 戛然而止。错误信息成了只存在于一帧屏幕上的"平行真相"——
   UI 知道的比日志多，违反"日志唯一事实来源"。
2. **时间结构无痕**：`tool_result.ts - assistant_message.ts` 混着审批卡等人的时间，
   日志推不出工具真正执行了多久，回放轨迹要么不标注要么编。
3. **取证盲区**：工具执行到一半 app 崩溃，日志停在 assistant_message（带 toolCall），
   看不出执行开始过没有——世界可能已被改了一半，日志却说"什么都没发生"。

参考 pi 的细粒度生命周期事件（turn_start / tool_execution_start / …）：
生命周期节点本身就是 append-only 事件，回放轨迹从日志推导而非手写。

## 决定

新增两个事件类型：

- **`tool_execution_started { toolCallId }`**：穿过审批门、`tool.run` 即将执行的瞬间落盘。
  真执行耗时 = 配对 `tool_result.ts` − 它的 `ts`（审批等待不计入）。
  崩溃后重启，日志里"有 started 无 result" = 悬空执行，提示世界可能已被部分变更。
  被拒绝的调用没有此事件（审批门短路，执行器未达）。
- **`turn_ended { outcome: "completed" | "error", error? }`**：turn 收口或暴死都落盘。
  `error` 只在 outcome = "error" 时存在，记异常信息。刻意没有 steps 字段——
  模型调用次数 = 数两条 turn 边界间的 assistant_message，推得出的不落盘。
  错误照旧向上抛（IPC reject 不变）——落盘是补记事实，不是吞错。

**刻意不加 `turn_started`**：otter 的 turn 恒以 user_message 开场（pi 的 turn 不与用户
输入一一对应，所以 pi 需要它）。从日志推得出来的信息不配成为事件——事件必须携带
推不出的事实，否则是仪式。

两类事件对模型不可见：deriveMessages 明确丢弃（生命周期是系统事实，不是对话内容）。
投影不变性：同一段日志加不加 lifecycle 事件，投影结果逐字节一致（有测试钉住）。

## 后果

- 旧日志无此事件照常重放（union 纯增，向后兼容硬规则）。
- 回放轨迹的耗时/死因从此是推导值：`steps.ts` 找配对事件算时差，找不到（旧日志）就不标注——
  不知道就不说，不编。
- 聊天时间线不渲染 lifecycle 噪音（tool_execution_started / 正常 turn_ended 返回 null），
  只有 turn_ended(error) 渲染失败行——错误从此是持久事实，重开 app 还在。
- 日志体量每 turn 多 1 条 + 每次工具执行多 1 条，可忽略。

## 曾考虑的替代方案

- **turn_started/turn_ended/tool_execution_started/tool_execution_ended 四件套（照抄 pi）**：
  turn_started 可从 user_message 推导，tool_execution_ended 与 tool_result 完全重合。
  只留携带新事实的两个。
- **错误落进 tool_result 或专门的 turn_error 事件**：turn 级错误未必与某个工具调用相关
  （API 超时发生在 chat() 里），turn_ended 带 outcome 统一收口和暴死，一个类型讲完整个故事。
- **执行耗时记在 tool_result 里（duration 字段）**：合成值。两个时间戳都落盘，
  耗时永远可重新推导——存事实，不存推导结果（投影层原则）。
