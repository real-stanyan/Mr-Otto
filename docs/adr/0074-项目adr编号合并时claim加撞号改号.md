# ADR-0074：项目 ADR 编号在合并时 claim，已撞的三对改号 + 留 alias 行

日期：2026-08-23 ｜ 状态：已采纳 ｜ Issue #230 ｜ 相关：gearbox ADR-0048（Parallel shifts）、gearbox ADR-0010（门禁断言的 L1/L2 边界）

## 背景

`docs/adr/` 里有三对同号文件：

| 号 | 两份 | 合并时间 |
|---|---|---|
| 0014 | `0014-branch-picker.md` / `0014-friend-system-supabase.md` | 2026-08-18 15:58 / 16:32 |
| 0031 | `0031-terminal-rides-the-world-seam-and-stays-out-of-the-log.md` / `0031-thinking-is-a-model-property.md` | 2026-08-19 14:32 / 15:52 |
| 0068 | `0068-子智能体继承父会话已启用的skill.md` / `0068-微压缩攒批以保前缀缓存.md` | 2026-08-23 17:09 / 17:12 |

最后一对是两条并行 lane 各自开号、相隔三分钟合进来的。

撞号的代价不是文件重名——文件名后半截不一样，两份在磁盘上共存得好好的。代价是
**引用失去指向**：仓里现在有六处 `ADR-0068` 指向其中一份、四处指向另一份，读的人
得靠上下文猜。同一件事在 0014 / 0031 上各发生过一次。

规则上的缺口：AGENTS.md 的「Parallel shifts」写了

> **Protocol changes serialize at merge time**: two lanes may each open a protocol PR,
> but ADR numbers and the version bump are claimed at merge, not at branch time.

它明确说的是 **protocol** changes，也就是 `docs/gearbox-adr/` 那一侧。项目自有的
`docs/adr/` 只有一句「one decision per file, starting at 0001」，没有说号在什么时候
claim。分支时开号 + 并行 lane = 必然撞号，只是概率问题。

## 决定

三条，一起生效：

1. **项目 ADR 的号也在合并时 claim。** 合并前 re-fetch；撞了就在自己这个 PR 里把
   本篇改成当时最大号 +1，不是让先合的那篇让路。写进 AGENTS.md 的 Working
   agreement（L1 改动）。

2. **已经撞掉的三对改号，较晚合并的那篇让位**：

   | 原号 | 改成 | 篇名 |
   |---|---|---|
   | 0014 | **0071** | 好友系统走 Supabase 直连 |
   | 0031 | **0072** | thinking 是型号的属性 |
   | 0068 | **0073** | 微压缩攒批以保前缀缓存 |

   改号的同时：改号那篇顶部写一行「原为 ADR-00XX」，留在原号那篇顶部写一行
   「这个号曾经有两份，另一份已改号为 00YY」，仓内所有指向被改号那篇的引用一并更新
   （15 处：5 处文档 + 10 处代码/测试注释）。

3. **门禁加一条断言**（`tests/docs/adrNumbers.test.ts`）：`docs/adr/` 下不得有两个
   文件共用同一个四位前缀；顺带断言不跳号。这是纯新增的更严断言，按 gearbox
   ADR-0010 属 L2，随本 PR 一起走。

## 为什么改号，而不是留着互相注明

留着的方案更省事，代价是每一次读到 `ADR-0068` 都要多做一次判断，而这个成本
按引用次数收，只增不减。改号是一次性成本。

改号动不了的只有一样：**2026-08-23 之前的 commit message 和已关闭 issue 里写的
旧号**。commit message 改不了（改了就是重写历史，而 AGENTS.md 的 PR disposition
明确禁止 squash/rebase，理由正是"历史是协议资产"）。所以两边都留 alias 行——
读旧 commit 的人落到任一篇，第一行就告诉他这个号曾经有两份、另一份在哪。

## 备选与否决

- **只立规则、撞号留着**：新增防住了，存量的解释成本按引用次数继续收。而且门禁
  断言加不上去——加上当场就红，只能给三个历史例外开豁免，一条带三个例外的断言
  读起来像"这条规则不太当真"。
- **较早那篇让路**：先合的那篇已经被更多引用指着（0014-branch-picker 在仓里有 6 处
  引用，friend-system 只有 3 处），让引用多的那篇改号是把成本放大。
- **两篇都改号**：原号变成空号，跳号断言就得放弃；而且旧 commit message 里的号
  指向一个不存在的文件，比指向两个候选更糟。

## 什么前提垮了会推翻它

如果哪天 `docs/adr/` 改成不按序号命名（比如日期 + slug，像 `docs/superpowers/plans/`
那样），撞号这件事本身就不存在了，第 1 条和第 3 条一起失效。
