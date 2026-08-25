# ADR-0086：harness 加固一轮——对照 dsh 与 hermes 的六笔借鉴

> 原为 ADR-0085：与 main 上先合入的「官方停供 token」ADR 撞号，按 ADR-0074 在合并前改号。

- 状态：已接受
- 关联：issue #383；对照研究 deepseek-harness（dsh）与 NousResearch/hermes-agent
- 先例：批量权衡 ADR 的形态沿用 ADR-0077 / ADR-0079

## 背景

对照读了两个参考仓库（AGENTS.md 头部点名的 dsh，以及 hermes-agent），过滤掉本仓已有
能力（投影/微压缩/跨会话搜索/沙箱档位/execpolicy/钩子/steer/fork…）后，剩下六个
「对方有、我们没有、且与 event-sourced + ExecutionWorld 架构相容」的缺口，一轮补齐。
每笔独立可回滚；测试各自钉住。

## 决定 1：请求信封落盘（request_envelope，dsh request/header 对照）

每次模型调用前，把**实际发出的请求里日志推不出的那半**落成 log-only 事件：
渲染后的 system 全文、工具声明表（name/description/parameters 全量）、
model/wireModel/thinking。对话消息那半本来就是日志的投影，不重复存。

- 为什么：工具表来自磁盘/MCP 的动态状态，thinking 是刻意不落日志的运行时偏好，
  system 渲染代码随版本变——三样都不在日志里，「模型当时看到了什么」重放不出来。
  落了它，任何历史请求可从日志逐字节重构（dsh：every request is a pure function
  of the log）。
- 去重：信封与上一条相同不落（比较键 = 内容 JSON）；进程重启从日志播种，
  播种失败（有界重建截掉了头部）的代价是多一条相同信封——审计冗余，无害。
- 模型不可见（投影丢弃）；`ignorable: true`（旧版本跳过它照常重放）。
- 会推翻它的前提：信封体积失控（MCP schema 巨大且频繁变化）——届时改存
  「首条全量 + 后续 diff」，事件语义不变。

## 决定 2：单调守卫层（ToolGuard，dsh monotonic guard 对照）

Pre 钩子之后、执行留痕之前加一道 **deny-only** 闸：守卫返回 reason = 拒绝
（`tool_result(denied)` + `tool_hook{action:"guard_deny"}` 审计），返回 undefined =
弃权。刻意没有 allow 返回值——注册顺序永远翻不了案。

- 它堵的真实的洞：审批门在管线最外层，Pre 钩子的 revise_args 跑在它**之后**——
  批的是原参数、执行的是改后参数，改后的命令没人再看一眼。守卫看到的是
  **最终生效参数**，内置第一只守卫在这复查 execpolicy forbidden 规则。
- 与钩子的分工：钩子是可干预的观察者（fail-open，超时弃权）；守卫是安全层
  （fail-closed，进程内受信代码，不设超时——挂死是 bug 不是可容忍状态）。

## 决定 3：向前兼容拒读（ignorable + assertReplayable，dsh 对照）

硬规则只定义了向后兼容（旧日志永远可重放）；OTA 上线后「旧版读新日志」是现实
（升级后回滚）。契约：`SessionEventBase.ignorable?: true`；resume 装配前读到
**未知且未标 ignorable** 的事件类型 → 抛 `UnknownSessionEventError`（话术指向升级），
不静默跳过。

- 默认拒是刻意的：忘标 ignorable 的代价 = 多拒一次（不便）；静默跳过的代价 =
  复活一个模型视野残缺的会话（说谎）。
- 只把 resume（继续对话）的门；列表/只读回看保持宽容——列表打不开比看见一条
  不认识的事件糟得多。
- 写新事件类型的纪律：模型不可见的注记类标 true；参与模型视野推导的不标。

## 决定 4：崩溃合成收口（turn_ended:"interrupted"）

resume 时最后一条 turn_ended 之后仍有 turn 活动（消息/工具事件）= 上一进程在
turn 中途退出。在悬空工具调用修复（ADR-0005）之后补一条
`turn_ended{outcome:"interrupted"}`。

- interrupted 是 **loop 永不产生**的值——「修的」和「跑出来的」永远可区分（dsh 同款）。
- 修复 = 追加，不截断不改写；幂等（补过即收口，再 resume 不重复）。
- 副产品：崩溃在模型开口前的空跑 turn，此前 barrenTurns「判不出来→留着」，
  用户每次崩溃重试都在上下文里多囤一句同样的话；现在被 outcome !== completed
  的既有语义正确跳掉（ADR-0042 的设计意图补全）。

## 决定 5：新鲜区工具输出折叠（maxFreshToolOutputChars，hermes spillover 对照）

投影的老区折叠（DEFAULT_COMPRESSION 400 字符）不变；新鲜区（保真区）新增独立
上限 50,000 字符——此前完全无上限：bash 自截 8K，但 read_file / MCP 工具 /
web_extract 一条超长输出直接吃穿窗口。

- hermes 把超限结果 spill 到磁盘换 locator；我们不需要外部存储——日志本来就存
  全文（事实不丢、UI 整段渲染、compact 摘要人照读），折叠住在投影层 =
  确定性纯函数，可推导性白捡。
- 折叠标记带原始长度（沿用 clip 的既有文案）：模型知道被折过、知道原文多长，
  要完整内容可分段重取。
- 字段可选：缺席 = 不折（旧行为逐字节一致）；COMPACT 档无保真区用不上。
- 刻意不动 contextEstimate：估算侧本来就不模拟老区折叠（锚点靠真实账单自校正），
  新鲜区同理——两边的既有误差模型一致。

## 决定 6：钩子超时（HOOK_TIMEOUT_MS = 10s）

Pre/Post 钩子单次调用超时按**弃权**处理（fail-open）。出处是 hermes 的
pi/OpenCode 插件对比 RFC 的原话："Neither system has hook timeouts. Both have
shipped hang-class failures because of it."——一只挂死的钩子不该挂死整个 turn。
今天没有内置钩子，这是给将来用户钩子的前置纪律；安全边界在守卫和审批门，
不靠钩子（所以 fail-open 成立）。

## 本轮明确不做（差距清单里量级大的）

错误分类→failover 策略引擎、后台完成事件以新 turn 回注、PTC/code mode、
运行时不变量注册表、keyless 回放测试体系——各自够一个独立 issue，见 #383 正文。
