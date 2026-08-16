# ADR-0006: turn 中断（AbortSignal 贯穿三个悬停点）

## 状态

已接受（2026-08-16）

## 背景

turn 一旦跑起来没有任何办法停：模型死循环烧 token、bash 卡死、审批卡不想批都只能干等。
中断必须能穿透 turn 可能卡住的全部三个位置：

1. 模型调用中（fetch 等响应 / SSE 流读到一半）
2. 工具执行中（bash 子进程在跑）
3. 审批等待中（UIApprover 的 Promise 挂起等人点按钮）

## 决定

**一根 AbortSignal 贯穿三处。** engine 每个 turn 建一个 `AbortController`（一次性，
turn 结束置 null），`abortTurn()` = 翻转信号：

- **模型线**：`ModelAdapter.chat` 加可选 `signal` 参数，直递 fetch——请求阶段和
  SSE body 读流共用一根线，abort 时 `reader.read()` 自动 reject `AbortError`。
- **工具线**：`ExecutionWorld.exec` 加可选 `opts.signal`；LocalWorld 递给
  `child_process.exec`（原生支持，abort = SIGTERM）。工具代码零改动——engine 用
  `withAbortSignal` 装饰器把信号焊进 world 再递给工具，硬规则「工具实现只依赖
  ExecutionWorld」原样成立。被杀不是命令自己的失败（exitCode ≠ 0 是"世界的正常
  反馈"），LocalWorld 检测到 abort 后 throw，按 error 结果落盘。
- **审批线**：`Approver.decide` 加可选 `signal` 参数；UIApprover 挂 abort listener，
  中断时把挂起的 Promise resolve 成 `denied("turn 被用户中断")`——走既有 denied
  管道，`approval_decision` + `tool_result(denied)` 照常落盘，零新事件类型。

**日志语义**：

- `turn_ended.outcome` 加 `"aborted"`（union 加宽 = 向后兼容；投影本来就丢弃
  turn_ended，投影不变量不破）。
- 中断不是错误：`runTurn` 认出 AbortError 后落盘 `aborted` 并正常返回（不 rethrow），
  UI 不当故障渲染。
- 中断路径不留悬空 toolCall：执行中被杀 = error 结果；审批中 = denied 结果；
  还没轮到执行的剩余调用由 engine 补 error 结果（"调用未执行"）——OpenAI 方言要求
  每个 tool_call 都有答复（ADR-0005 的教训）。万一崩在缝里，ADR-0005 两层修复兜底。
- 流式半截文本**丢弃不落盘**：日志只收完整消息（pi 的"消息完成后不可修改"边界）。

## 否决的替代方案

- **保留半截流式文本（Claude Code 的做法）**：把已流出的碎片落成截断的
  assistant_message。否决：打破"事件 = 凝固的完整事实"边界，且截断消息喂回模型
  需要额外的"[被中断]"标注协议。半截文本的价值 < 不变量的干净。可在日后单独 ADR 翻案。
- **新增 turn_aborted 事件类型**：outcome 加宽已足够表达，新类型徒增投影分支。
- **工具层感知 signal（`tool.run(args, world, signal)`）**：工具多一个参数 = 每个
  工具都要学会转发；装饰器让 world 自带信号，工具永远无感。capability seam 的正确用法。
- **compact 可中断**：compact 数秒即完、无工具无审批，中断收益低。不做。

## 后果

- 停止键 / Esc 随时可停；被杀的 bash 进程收 SIGTERM，世界可能被部分变更——
  被杀调用的 tool_result 文案会说明。
- 信号是一次性的：每 turn 新建 controller，idle 时 abortTurn 幂等无操作。
- v2 云端化时 stopTurn 走 WebSocket 版 ShellBridge，engine 侧零改动。
