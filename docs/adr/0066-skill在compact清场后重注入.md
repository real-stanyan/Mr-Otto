# 0066 — skill 在 compact 清场后重注入：纯投影，不落新事件

日期：2026-08-23　状态：已采纳（issue #214）

## 背景

ADR-0007 把 skill 注入定为「快照落 skill_invoked 事件 + 投影成 user 消息」，并在代价里
记了一句「skill 常驻上下文直到 /compact」。当时 compact 只有手动一条路，这是可接受的
边角；自动压缩上线（ADR-0062）后它变成主路径上的 bug：context_compacted 清场
（deriveMessages 里 `messages.length = 0`）把 skill 指令连历史一起抹掉——用户没说停，
技能却无声失效，且 UI 无任何提示。

调研 ponytail（github.com/DietrichGebert/ponytail，提示词技能的工业级样本）确认这是
提示词技能的通病，它的解法是状态文件 + 每轮 hook 重注入。otto 有更便宜的位置。

## 决定

**context_compacted 清场后，把此前启用过的 skill 重注入——在投影层做，不落新事件。**

- deriveMessages 顺扫时维护台账（Map<name, 快照>）：按名去重、后启用覆盖先启用；
  空跑 turn（ADR-0042）里的 skill_invoked 不进台账（模型压根没读到过）。
- 清场时在摘要之后、当前请求兜底（issue #193）之前，按台账逐条重注入，
  文案「skill「x」在压缩前已启用，仍然生效」。次序与首次注入一致：先说明书后任务。
- 快照取台账里那份（事件里的原文），不回磁盘现读——文件后来改/删不影响重放，
  与 ADR-0007 的快照语义一脉相承。
- 语义：**启用过 = 仍然生效**。当前没有「停用 skill」动作；将来若加，
  停用应落事件，台账在投影时按它剔除。
- 微压缩不用处理：nextMicroExchange 规则⑥（microCompact.ts）保证 skill_invoked
  永不进吸收区。

## 备选与否决

- **compact 时追加新的 skill_invoked 事件**：日志变肥（每次 compact 复制一份全文快照）、
  auto/manual 两条路都要改 engine，且旧日志得不到修复。投影方案零新事件、
  旧日志追溯受益（重放老会话时 skill 也能撑过历史上的 compact），硬规则
  「投影必须可从日志推导」原样满足——重注入的内容全部来自已落盘的事件。
- **ponytail 式每轮重注入**：上下文里同一份说明书出现 N 次，token 白烧；
  otto 的投影是从日志整体推导的，不需要按轮打补丁。

## 代价（接受）

- 大 skill 在 compact 后照样占上下文——这是「技能生效」的本义，不是泄漏；
  用户想卸掉只能等停用动作（见上，将来的事）。
- 摘要专用投影（COMPACT_COMPRESSION）走同一条路：二次 compact 时摘要人也会
  读到重注入的 skill 指令，输入略肥，但摘要人知道技能在场反而更准。
