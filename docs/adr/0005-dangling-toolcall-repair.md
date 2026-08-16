# ADR-0005: 悬空工具调用的两层修复（崩溃自愈）

## 状态

已接受（2026-08-16）

## 背景

app 在工具执行中途退出（崩溃 / 强杀 / 审批卡挂着就关窗），日志末尾停在
`assistant_message(带 toolCalls)`，没有对应 `tool_result`。OpenAI 方言硬性要求
assistant 的每个 tool_call 后面必须跟对应的 `role:"tool"` 消息——悬空调用让投影
产出非法序列，API 400。日志 append-only，那条 assistant_message 永远在历史里，
每次全量投影都带着这个洞：**会话永久中毒**，连 /compact 也救不了（它也要先投影喂模型）。

## 决定

两层修复，各管一头：

1. **投影层自愈（deriveMessages，保命层）**：投影完成后补一趟——assistant 的
   tool_call 若无紧随的 tool 回应，就地合成占位 tool 消息。确定性纯函数（同日志
   同输出），与压缩同一法理：从日志推得出的不需要落盘。老日志不经任何修复流程、
   任何入口读取都自动痊愈。
2. **resume 补事件（createAgent，留痕层）**：恢复会话时扫描悬空调用，追加合成的
   `tool_result { status: "error" }` 事件。修复 = 追加，永不改写（append-only 无损）。
   事故从此是时间线事实：聊天区工具行显示"出错"、回放有步骤、重开 app 还在。
   幂等：补过的调用已配对，再 resume 不重复追加。

合成文案按 `tool_execution_started`（ADR-0004）区分，不含糊：

- **有 started 无 result**：执行已开始但结果未落盘——世界可能已被部分变更，结果未知，建议检查现场。
- **无 started**：调用未开始执行就被中断（审批未决或 app 退出）——执行器未达，世界未被此调用变更
  （engine 不变量保证：started 落盘在 tool.run 之前）。

这不是造假："执行被打断"本身就是事实，诚实记录。

## 后果

- 崩溃会话恢复即可用，中毒路径消灭。
- 两层文案有意保持一致；留痕层跑过之后调用已配对，自愈层自然不再触发——
  同一会话不会出现双重占位。
- 悬空 turn（无 turn_ended 收尾）不修：turn_ended 对投影隐形，不影响 API 合法性；
  留痕已由合成 tool_result 承担，再补 turn_ended 是仪式。

## 曾考虑的替代方案

- **只做投影层**：处处生效但事故在聊天区隐形（合成消息不落盘，UI 时间线看不到），
  取证价值丢失。
- **只做 resume 层**：修复只挂在一个入口，任何绕过 resume 的日志读取（将来新入口）
  仍会投影出非法序列。
- **resume 时改写/删除悬空 assistant_message**：违反 append-only 硬规则，历史不可篡改。
