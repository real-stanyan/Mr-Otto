# 0067 — skill 参数：`$名字(参数) 任务` 语法，args 进事件可选字段

日期：2026-08-23　状态：已采纳（issue #214）

## 背景

ponytail 的档位（lite|full|ultra）证明行为类 skill 普遍需要参数（严格度、语言、
输出长度），Claude Code 用 frontmatter `argument-hint` 声明提示。otto 的 `$` 指令
语法是「`$名字 任务正文`」——首个空白之后整段是任务，参数没有容身之处。

## 决定

1. **语法 `$名字(参数) 任务正文`**：括号显式分隔，不与任务正文抢地盘。
   参数是单 token（不含空格）——档位/语言这类值够用；要长参数的那天再扩。
2. **SkillInvokedEvent 加可选 `args` 字段**：向后兼容（旧日志没有此字段，
   投影逐字节不变——测试钉住）；投影头带「（参数：x）」，compact 重注入
   （ADR-0066）同样带。参数是模型可见的新信息，必须落盘——快照语义不变。
3. **skills.ts 解析 frontmatter `argument-hint`**（沿用 Claude Code 同名约定，
   剥外层引号）进 SkillInfo，`$` 菜单把它拼进条目 description 展示。
   提示是给人看的：不校验参数合法性——skill 是自由文本，值的语义由 skill 正文
   自己解释，harness 不当裁判。

## 备选与否决

- **`$名字 参数 任务`（首 token 当参数）**：参数与任务正文无法区分——
  「$tdd 严格一点实现登录」里「严格一点」是参数还是话头？歧义即否决。
- **`$名字:参数`**：skill 名来自外部目录名/frontmatter，冒号可能是名字的一部分
  （Claude Code 的 plugin:skill 就带冒号），撞了解析不回来。括号在目录名里罕见得多。
- **args 不落盘、只拼进任务正文**：模型看到的和日志推不出的差一段——违背
  model-visible means logged。直接排除。

## 代价（接受）

- 参数不能含空格（单 token 上限）。
- 输入框高亮 chip 只包 `$名字`，`(参数)` 段是普通文本——formatter 不认括号，
  功能不受影响，观感将就；要包进 chip 得改 ottoDirectives 的解析，等有人抱怨再说。
