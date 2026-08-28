# ADR-0149：主 checkout 只读，开工一律在一次性 worktree 里

- 状态：已接受
- 日期：2026-08-28
- 关联：issue #543（本决策的三个待答问题）、#449（prune 会删并行 lane 未提交的分支）、#616 / ADR-0148（同一件事的需求侧）、#620（同一个洞的产品侧）
- 相关 ADR（协议）：gearbox 0030 / 0043（Branch hygiene、prune）、0048（并行 lane）

## 背景

issue #543 记了一次事故：一条 lane 对主工作区的改动**被无声重置三次**——工作区被另一条 lane `git checkout` 到别的分支、`git stash` 被 apply 两次又 drop、期间混进第三条 lane 的半成品文件，同一批改动最终以**不同 SHA** 落在两条不同的半成品分支上。

它开着两天、0 回应，期间同一个洞又被踩了一次：#612 那条 lane 在主 checkout 上开工，留下 4 个 untracked 文件裸奔和一个野改的 `.gitignore`。

ADR-0048 按 issue 划 lane，但 **lane 是逻辑的，checkout 是物理的**：两条 lane 的 claim 可以完全不相交，工作区却只有一份。协议管到了「谁做哪个任务」，没管到「谁在哪个目录里做」。

## 决策

### 1. 主 checkout 冻结在默认分支，只读

不在主 checkout 上开工。它只用来快速查看、跑只读命令、以及协议允许的 typo 级直提 main。

**这条为什么就够**：worktree 模型下「分支被人从脚底下切走」**物理上不可能**——git 自己拒绝同一分支被两个 worktree 同时 checkout：

```
fatal: 'main' is already used by worktree at '/Users/stanyan/Github/Mr_Otto'
```

所以不需要任何条款去约束「别切别人的分支」。只要没人在主 checkout 上干活，**切分支这个动作就不存在**，冲突面随之消失。规则管的是「人在哪儿干活」这一件事，剩下的交给 git。

### 2. worktree 必须是一次性的

一个 worktree 只服务一个任务，用完即弃，**从不 `git checkout` 换活**。

这条是本仓现场逼出来的：`.worktrees/share-session-friend` 服务过 #611，之后 HEAD 被切成 `fix/share-strip-project-instructions` 去做 #617。一个长期存在、会切分支的 worktree **就是一个小号主 checkout**——切分支的动作又回来了，只是换了个目录。「有 worktree」不等于「有隔离」，隔离来自一次性。

位置统一 `.claude/worktrees/<任务名>`。现在有两套（harness 建的三个在 `.claude/worktrees/`，手搓的一个在 `.worktrees/`），两套位置 = prune 漏一半。

### 3. 禁裸 `git stash` / `git stash pop`

worktree 隔离工作区文件、隔离 HEAD，但 `.git` 是共享的——**stash 栈是共享的**。这是 worktree 模型唯一的漏点，也正是 #543 现象 2 那次污染的成因：另一条 lane 的 `pop` 弹走了不属于它的东西。

改用 `git stash push -u -m "<唯一标签>"`，立刻 `git stash list --format='%H %gs'` 记下自己那条的 SHA，恢复用 `git stash apply <sha>`（**永不 `pop`**），用完按标签重新定位 `stash@{n}` 再 drop。更好的做法是根本不 stash：在自己的 worktree 里，未提交改动没人碰得着，直接开一个 WIP commit 更省事。

### 4. 机制兜底：`.githooks/pre-commit`

规则写在 AGENTS.md 里只是文字；#543 已经证明了这类文字会被跳过（#612 那条 lane 并没有违反任何写下来的规则——协议当时就没有这一条）。所以配一个钩子：主 checkout 上、非默认分支的提交直接拒绝。

安装是每个 clone 一次的一行命令，对该 clone 的**所有 worktree 生效**：

```bash
git config core.hooksPath .githooks
```

判定「我是不是主 checkout」用 `--git-dir` vs `--git-common-dir`（linked worktree 两者不同），不靠路径字符串匹配——手搓在约定位置之外的 worktree 一样认得。

**天花板明说**：git 没有 pre-checkout 钩子，**切分支本身拦不住**；能拦的只有「在主 checkout 上提交」。够用的理由是切走别人分支的动机来自「想在这儿干活」，堵住提交就堵住动机。`--no-verify` 的逃生门故意留着——机制是给「忘了」兜底的，不是给「明知故犯」上锁的。

## 为什么不选另外三种

| 候选 | 否决理由 |
|---|---|
| 「做完立即 commit（哪怕 WIP）」写成硬规则（#543 的问题 2） | 它是决策 1 的推论而不是独立规则：在自己的 worktree 里未提交改动没人能碰，攒一批再提没有风险。真正该单独写的是禁裸 stash（决策 3）——那才是 worktree 不隔离的那一块 |
| 只加协议文字，不加钩子 | #543 的三个问题开了两天没人答，期间又踩一次。这类规则的失败模式是「没人读到」，而不是「读到了不服」——所以需要一个在动手那一刻说话的东西 |
| 用 `git worktree lock` / 独立 clone 做隔离 | lock 防的是误删不是并发写；独立 clone 隔离得更彻底但每份几百 MB，且分支要跨 clone 同步，成本远高于收益 |

## 后果

- 接受：开工多一步 `git worktree add`；收工多一步 prune。
- 接受：钩子要每个 clone 手动装一次（`core.hooksPath` 是 clone 级配置，进不了版本库自动生效）。装不装不影响门禁——没装的 clone 退回纯文字约束。
- 接受：`--no-verify` 能绕过。见上，这是设计而非疏漏。
- 遗留：现存两个 harness worktree 已经僵了（`branch-marker-bash` 是 locked 且远程分支 gone、`default-workspace-559` 落后 main 46 个 commit），清理受 #449 阻塞——`prune --apply-local` 会删掉并行 lane 刚开还没提交的分支，两条要一起定。
- 不变：ADR-0048 的 lane 模型、0047 的 claim、0044 的阻塞边都不动。本 ADR 只回答「lane 在哪个物理目录里干活」，不碰「哪条 lane 干哪个任务」。
