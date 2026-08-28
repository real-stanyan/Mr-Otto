# ADR-0150：开 lane 这件事自动化，本仓自带，不依赖 Gearbox

- 状态：已接受
- 日期：2026-08-28
- 关联：issue #623；#543 / ADR-0149（主 checkout 只读、一次性 worktree）、#449（prune 删掉并行 lane 刚开的分支）、上游 gearbox#141
- 相关 ADR（协议）：gearbox 0030 / 0043（prune）、0048（并行 lane）

## 背景

ADR-0149 把「主 checkout 只读、开工用一次性 worktree」写成了规则，并配了 `.githooks/pre-commit` 拦住在主 checkout 上的提交。那是**「拒绝」那一半**。

缺的是「自动」那一半。Claude Code 的 agent 不互踩，不是因为它们有纪律：session 一开，worktree 已经在那儿了，分支名带随机后缀，一个 worktree 只服务一个任务。**选择被删掉了**——没有协议、没有人需要读文档，互斥交给 git 自己（它拒绝同一分支被两处 checkout）。

而本仓的规则说「请开 worktree」，还是靠自觉；`git worktree add` 的语法要现查，「图省事就地干」的动机原封不动。#612 那条 lane 就是这么在主 checkout 上开的工。

另外，清理这一步当时借的是上游的 `npx gearbox-agents prune`——本仓 worktree 这条线上**唯一**的 Gearbox 依赖（创建和拦截都已经是自己的）。而那个工具正好有一个会踩并行 lane 的 bug（#449 / gearbox#141）。

## 决策

三件，全在本仓，纯 git 操作，不依赖 Gearbox。

### 1. `npm run lane -- <任务名>`（`scripts/lane.mjs`）

一条命令开一条 lane。三条性质对上 ADR-0149：

- **从同步过的 `origin/<default>` 开**——先 `fetch`。从落后的 base 开出来的 lane，第一件事就是解冲突。
- **分支名带 6 位随机后缀**（`claude/<slug>-<hex>`，照 Claude Code 的形状）——两条 lane 同时开同一个任务名也撞不了。
- **目录或分支已存在就拒绝**——不复用。复用就是第二个主 checkout，互斥等于关掉。

任务名里没有可用于分支名的字符（例如纯中文）时**报错**，而不是产出一个只剩随机后缀的名字：名字是给人看的，看不出是哪条 lane 就白搭了。中文写进 issue 标题。

### 2. `prepare` 自动装钩子（`scripts/install-hooks.mjs`）

`npm install` 之后自动 `git config core.hooksPath .githooks`。

ADR-0149 当时把安装留成了一行要人手跑的命令。但 `core.hooksPath` 是 clone 级配置、进不了版本库——**装不上就等于那条兜底不存在**。而「一条要人记得跑一次的安装命令」和「一条要人记得遵守的规则」，失败模式是同一个；ADR-0149 的整个论点就是不该指望后者。

幂等、失败不阻断（不是 git 仓 / git 不在 PATH / 已经配好都安静跳过），且**不覆盖别人已配的 `core.hooksPath`**——报一声让人自己决定。装依赖不该因为钩子装不上而失败。

### 3. `npm run lane:prune`（`scripts/lane-prune.mjs`）

本仓自带的清理，默认 dry-run，`--apply` 才动手。清两样：残留 worktree（已合并 + 干净）、已合并的本地分支。

硬约束照抄上游那套并**补上零工作量保护**：

- 永不 force（没有 `branch -D`，没有 `worktree remove --force`）——git 自己对未合并分支/脏 worktree 的拒绝是第二道保险；
- 脏 worktree（含未跟踪文件）只报告；
- **没人提交过的分支一律不删**：它的 tip 就是 default 的 tip，在 git 眼里 100% 已合并，但那正是一条刚开还没干活的 lane 的形态（#449 现场：prune 删掉了另一个活着的 agent 正要用的分支）。判据两条，任一满足即跳过并写明理由——A：tip == `origin/<default>` 的 tip；B：reflog 里没有任何提交类条目（覆盖「开自较早的 default」，A 看不见）。

做完这件，本仓不再依赖 `gearbox-agents prune`。上游那条修复（gearbox#141 / PR #142）继续挂着给别的仓用，本仓不等它。

### 测试：起真仓、spawn 真脚本

`tests/scripts/laneTooling.test.ts`，照 `tests/hooks/preCommitWorktree.test.ts` 的路子。要钉的主要是那些**不做**的事——不复用已存在的 worktree、不删没人提交过的分支、不删脏 worktree。这些是保护性行为，坏了不会报错，只会安静地把保护取消掉，所以必须有断言盯着。

脚本是 `.mjs`，从 TS 测试里 import 会撞 `allowJs`；走子进程反而更接近它们实际被调用的样子。

## 为什么不选另外三种

| 候选 | 否决理由 |
|---|---|
| 只写文档，教大家 `git worktree add` 的用法 | 这就是 ADR-0149 的状态，#612 已经证明了它的失败模式：规则在，人不查 |
| 用 git 钩子在切分支时自动开 worktree | git **没有 pre-checkout 钩子**（ADR-0149 已经记过这个天花板）；`post-checkout` 只能事后知道，拦不住 |
| 等上游把 prune 修好（gearbox#141），继续用它 | 本仓的清理不该卡在另一个仓的合并节奏上。三个脚本加起来两百行，比协调两个仓便宜 |

## 后果

- 接受：多三个脚本要维护（约 200 行纯 git 操作，无依赖）。
- 接受：`prepare` 在每次 `npm install` 时多跑一次——它自己会秒退。
- 接受：零提交分支会攒着。它们不占空间，一旦有提交就回到常规判定。
- 与上游的关系：`gearbox-version` / `gearbox-update` 那两步不动（协议同步仍然走上游）；只有 `prune` 这一件换成了本仓自己的。
