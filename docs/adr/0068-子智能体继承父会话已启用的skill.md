# 0068 — 子智能体继承父会话已启用的 skill：快照复制进子日志，skills: none 退出

日期：2026-08-23　状态：已采纳（issue #217）

## 背景

ponytail 踩过同一个坑（其 SubagentStart hook 注释：SessionStart context is
parent-thread only and never reaches subagents）：用户给主 agent 启用行为约束，
派出去的子 agent 不受约束。otto 同构：子智能体是独立会话（ADR-0047），
subagentRunner 只拼三层前置词（ADR-0048），父会话 `$` 启用的 skill 不随派活走——
「$ponytail 然后 spawn」的子 agent 想写多少写多少。

## 决定

1. **默认继承**：派活时算父会话的已启用台账（activeSkills.ts，与 ADR-0066 的
   compact 重注入共用同一份语义——按名去重、后启用覆盖），逐条**复制快照**落进
   子日志（skill_invoked，含 args），位置在 subagent_briefed 之后、task 之前：
   先「我是谁」，再说明书，最后任务。用户 $ 启用的行为约束默认覆盖整个任务，
   包括派出去的部分——ponytail 的 fail-open 同思路。
2. **复制而不是引用**：子日志必须自包含，重放不跨日志取证（ADR-0007 的快照
   理由原样成立）。代价同 0007：全文多存一份。
3. **subagent frontmatter 可写 `skills: none` 退出**：机械型/分类型 agent 不该被
   行为 skill 污染。只认 none 这一个值，写别的（含 inherit）= 缺席 = 继承——
   开关不是清单，非法值的安全解释就是默认档。serializeSubagent 同步写回
   （丢字段即数据丢失）。内置子智能体（ADR-0051）没写 = 继承。
4. 组合免费：子会话自己 compact 时，ADR-0066 的重注入对这些事件自动生效。

## 备选与否决

- **ponytail 式 matcher（环境变量正则圈 agent_type）**：作用域该由定义自己声明，
  不该住在定义之外的一个全局旋钮里——谁的行为谁的文件说了算。
- **默认不下发、frontmatter opt-in**：违背最小惊讶——用户启用 skill 的意图是
  「这样干活」，不是「主 agent 这样干活、分包出去的不算」。
- **拼进三层前置词而不落事件**：模型可见的东西日志推不出来，违背硬规则。排除。

## 代价（接受）

- 每次派活复制全文快照，子日志随 skill 体积变肥（同 ADR-0007 的账）。
- 设置页暂不给编 skills 键，frontmatter 手写是唯一入口——UI 欠账记在 #217。
