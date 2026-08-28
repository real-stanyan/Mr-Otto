# Mr Otto

Mr Otto（曾用名 otter，仓库目录沿用 Otter）是 macOS 桌面 GUI agent 工具（每个 bot 是一只会用工具、有独立沙箱的水獭）。MVP 完成标准：单 agent + 3 工具（读/写文件、bash）+ event-sourced 会话日志 + replay UI + 危险操作审批 UI + 模型切换 + ExecutionWorld 接口（LocalWorld 实现）。明确不做：多 agent 编排、插件系统（skill 库是纯提示词注入，不算插件系统，见 docs/adr/0007）。MCP 做 client 那一半（接外部 server 的 tools/resources/prompts，见 docs/adr/0049），不做 server。

架构参考项目（学习/对照用，不引入为依赖）：
- **DeepSeek Harness**：三原则 —— event-sourced 会话日志 / 工具中间件管线 / capability seam（ExecutionWorld）
- **pi**（https://github.com/earendil-works/pi）：极简 agent harness。对照点：append-only AgentMessage 流（"消息完成后不可修改"）、细粒度生命周期事件（turn_start/tool_execution_start…）、工具 execute 抛异常报错 + 返回 `{content, details}`、刻意不做内置权限系统（隔离交给容器层 —— 与 otter 的 ExecutionWorld/v2 Docker 思路互证）

> This file is the single source of truth for ALL AI coding agents, whatever the tool (Claude Code, Z Code, Cursor, etc.).
> Rules live here and only here. Do not duplicate them elsewhere.

## Tech stack

Electron（主进程 = Node agent 核心，ADR-0001）
React + Zustand（渲染进程）
Tailwind CSS + shadcn/ui（渲染进程样式/组件库，ADR-0010；存量 app.css 待 harness 完工后整体迁移，新增 UI 即日遵守）
TypeScript（strict）/ Node.js
SQLite（better-sqlite3，事件日志持久化）
vitest（测试统一放 `tests/`，镜像 `src/` 结构；不与源码同目录）
直连 OpenAI-compatible API（不用 LangChain）；模型 adapter 切换 DeepSeek / Claude / GLM
`@modelcontextprotocol/sdk`（MCP 客户端；只允许 `src/main/mcpClient.ts` import，见 docs/adr/0050）
Swift + SwiftUI + DynamicNotchKit（native/MrOttoIsland；macOS 灵动岛原生 helper，主进程 spawn，stdio NDJSON 桥；ADR-0061）
v2：Docker per bot（dockerode，自托管 VPS）

## Hard rules

- append-only 事件日志是唯一事实来源；先落盘再喂模型（model-visible means logged），任何投影（模型上下文/UI）必须可从日志推导。
- 渲染进程只通过 `ShellBridge` 接口与后端通信，禁止直接触碰 Node API（ADR-0001 的后悔药）。
- 工具实现只依赖 `ExecutionWorld` 接口，禁止直接 import fs / child_process。
- SessionEvent schema 变更必须向后兼容（旧日志必须永远可重放）。

> Any clause in the protocol body marked **Hard rule** (e.g., the hard rule in the "Roles of issues & PRs" section) **counts as part of this section and is protected under L1**: the criterion anchors to the marking itself, not to which section the clause physically lives in (ADR-0018).

## Working agreement (multi-agent)

### On starting a shift (the three start-of-shift steps)

1. **Sync, then read**: `git fetch origin` + fast-forward the local default branch (`git pull --ff-only` while on it) — the repo is the only shared memory, and an unfetched clone is somebody's stale cache of it (a stale clone even means stale *rules*: this very file is version-controlled). Fast-forward impossible = the local default branch has diverged: stop, open an issue, don't build on a forked base (ADR-0046). Then `git log --oneline -10` — see what happened recently
2. Check GitHub Issues — **first look for open handoff issues** (the previous shift's Memory is in there; reading one and closing it = taking over that lane, see ADR-0005. Several open = parallel lanes: take over at most one, leave the rest untouched — see "Parallel shifts" (ADR-0048). If none found → check whether the most recently closed issue has a "no next shift" terminal declaration: if yes = a compliant terminal shift (ADR-0009), start work normally; if no = the previous shift ended out of compliance, open a Protocol gap issue to record it — either way, rebuild context from git log + open issues), then check other open tasks and notes.
   **Before opening a new Task issue, or claiming one from the frontier, search for a collision first — closed issues included** (project ADR-0148): `gh issue list --state all --search "<关键词>"` plus `git branch -a --list '*<关键词>*'`. A hit gets read before anything else: already done → don't redo it (open a new issue referencing it if it still needs changes); half done → continue from there, don't restart. Step 1's `git log --oneline -10` does not cover this — skimming the last ten commits builds a background impression of what happened, it is not a search for one specific need. A compliantly closed issue is exactly the blind spot (issues #611/#612 were the same need done twice)
3. Run the gate command (see below) to confirm the baseline is green — if it's red, fix it first or open an issue; don't start work on a broken baseline
4. Run `npx gearbox-agents version` to self-check the protocol version — if behind, run `npx gearbox-agents update` to backfill (pull-triggered, ADR-0026/0028; this step is the receiving end aligning with upstream, not upstream pushing. If a local Gearbox checkout is installed, you can also run `gearbox-version`/`gearbox-update` directly)

### While working

- **A need in hand gets its Task issue opened before the exploring starts** (project ADR-0148), not after the work is done or half done — one line of the need as stated plus "exploring" is enough at that point. This is what survives an abnormal end: a session killed by an app quit gets no chance to write anything, so the only reliable trace is the one already in the repo while it was still alive — an issue opened up front is still open and unassigned afterwards, and the next shift's step 2 walks into it. Issues opened but not finished are the intended cost: an open empty issue says "somebody touched this and didn't finish", which is the sentence missing at collision time. At shift-end they follow On ending a shift item 3 like any other
- Commit in small steps; the message should spell out the **why**, not just the what
- **Protocol files stay committed — never add them to `.gitignore`**: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/gearbox-adr/`, `.gearbox-version`, `.github/workflows/ci.yml`. The repo is the only shared memory between shifts; an ignored protocol file exists locally but never reaches the next agent's clone (ADR-0037)
- One agent sees a task through from start to finish; handoffs only happen at task boundaries (issue closed / PR merged), never mid-task
- Non-trivial changes go through a branch + PR; typo-level tweaks can go straight into main
- **Project-owned** architectural decisions go in `docs/adr/` (one decision per file, starting at 0001); protocol ADRs live in `docs/gearbox-adr/`, managed by the gearbox tooling — don't hand-edit them. **Project ADR numbers are claimed at merge, not at branch time** (project ADR-0074, mirroring what "Parallel shifts" already says for protocol ADRs): before merging, re-fetch; if another PR landed on your number, renumber your ADR to `max + 1` inside your PR, add an `原为 ADR-00XX` line at the top of the file, and update every in-repo reference to it. Commit messages can't be rewritten, so the alias line is what keeps old references resolvable. The gate asserts no two files share a four-digit prefix (`tests/docs/adrNumbers.test.ts`)
- Look up domain-term definitions in `CONTEXT.md` — **two sections: protocol terms and product/technical terms** (ADR-0070); add new terms to the matching section as they come up (product concepts belong there too; no back-filling of historical debt)
- **读到「做不了 / 不在本仓 / 只能维护者做」这类判断时，先花五分钟验前提本身再决定跳过**（`ssh` 能不能连、`ls` 有没有那个目录、`grep` 有没有那个符号）——这类判断读起来像调查结论，实际往往只是上一班没试，写进 handoff 就成了下一班的既定前提，本仓已连错四次（ADR-0134）。验完确实做不了，把**验的方法和结果**写进 issue，让下一班不用再验

### Roles of issues & PRs

Issues and PRs are the timestamped, append-only, non-decaying conversation carriers between agents (and between agents and humans). In this protocol they have **three non-overlapping roles** — every issue/PR should fit into one of these:

| Role | When to use | When to close |
|---|---|---|
| **Task** | There's an actionable thing to do | The task is done and the gate is green |
| **Memory** (handoff memory) | Leave a comment on the **handoff issue** (see On ending a shift) at shift-end, five-part format | The next shift reads it and closes the handoff issue = handoff complete |
| **Protocol gap** | Hit a question the repo can't answer (rule not written, ambiguous, boundary unclear) | The gap gets folded into AGENTS.md / CONTEXT.md / an ADR |

Hard rules:

- **When you hit a question this repo can't answer, you must open an issue (Protocol gap type) — silent judgment calls are not allowed.** This is the only entry point for the protocol's self-repair — it turns gaps from "tacit understanding" into something explicit, discussable, and closeable.
- **Memory five-part format** (the minimum valid format for a handoff comment, ADR-0004): ① what's done ② what's blocked ③ what's next ④ close the issue if the task is complete ⑤ **rationale / trade-offs** — required whenever this shift made a non-default decision (what was chosen, why, and what premise failing would overturn it); if no decision was made, write "none" — don't omit it. Missing any one item means the handoff doesn't count. Across all five parts: content already captured in a durable artifact (ADR / issue / PR / commit / diff) is referenced by number or path, not restated — copies decay, references don't (ADR-0045). Inline belongs only what no artifact carries.
- **Handoff = the moment the issue closes / the PR merges**, not just feeling like things were "explained clearly." Switching agents without closing the issue is a mid-task handoff, which violates the previous section.
- **A PR is the implementation vehicle for a Task, not a separate role**: a PR references the Task issue it implements, and closes that issue on merge. New issues found during PR review get their own issue — don't pile them up in PR comments.

**Task ordering (blocking edges, ADR-0044)**: when one Task depends on another, the dependent issue's body declares each prerequisite with a literal `Blocked by: #N` line (one per blocker). A shift claims only **frontier** tasks — open tasks with no open blockers; when a blocker closes, its dependents join the frontier. Plain text, grep-able, no Projects/labels needed. This is a hygiene convention — a stale edge costs a judgment call at claim time, nothing more.

**Claiming (ADR-0047)**: a claim = assigning yourself on the Task issue (`gh issue edit <N> --add-assignee @me` — the GitHub account the agent acts under); first assignment wins, visible and timestamped. No triage permission → a "claiming this" comment instead. An open frontier task with no assignee and no claim comment is free. A shift ending with the task unfinished states in its progress comment whether the claim is released (unassign) or carried; a dangling assignment from a shift that left no comment is stale, not binding. Single-human repos may skip claiming — with one queue reader it informs nobody; its value begins at the second human.

> Why use an issue comment instead of a standalone handoff file: see `docs/gearbox-adr/0003-issue-roles.md`. Why Memory lives in an open handoff issue rather than a closed Task issue: see `docs/gearbox-adr/0005-handoff-lives-in-an-open-issue.md`.

### PR disposition (merge rules)

Four rules (ADR-0007):

- **Always merge via merge commit** — never squash, never rebase: the why behind small-step commits is a protocol asset (the repo is the only shared memory between sessions), and squashing is equivalent to deleting memory; locking in one style keeps history predictable.
- **Who merges**: the PR's author agent merges it themself once CI is green. Protocol changes follow the tier system (see "Changing the protocol itself"): L1 waits for `stanyan` agreement, L2 is autonomous.
- **A second agent's review is not mandatory**: in serial repos only one shift is present at a time, and forcing mutual review would block at handoff boundaries; parallel lanes (ADR-0048) don't change this — review stays optional, because the quality backstop never depended on serialization: the CI gate + the `stanyan`'s after-the-fact veto (revert + reopen the issue), plus branch protection where configured (ADR-0042).
- **Don't take over someone else's open PR** — that's a mid-task handoff (see While working). Exception: the handoff issue explicitly transfers it, or the `stanyan` directs it.

If a PR is still hanging open at shift-end, the task isn't done: per item 3 of On ending a shift, write progress into the Task issue's comment and leave the PR open.

### Changing the protocol itself (rules for changing this file)

Agents can modify AGENTS.md, but **the change is tiered by its content** (ADR-0006):

| Tier | Content | Process |
|---|---|---|
| **L1 strict tier** | Hard rules / Gate command / Tech stack / this section itself | issue + ADR + PR, **and the agent may only merge after the `stanyan` explicitly agrees, in the session or in a PR comment** |
| **L2 autonomous tier** | Working agreement (except Gate) / the index (Where to find things) | issue + ADR + PR, agent may merge autonomously |


The boundary of "Gate command" (ADR-0010): the command line itself, and **loosening/deleting/rewriting an existing gate-script assertion** = L1; **adding a new, stricter assertion** = L2, riding along with its own PR. Pure refactors (behavior unchanged) count as L2, with the burden of proof on the agent making the change.

**Test-type gates** (vitest / tsc / lint, ADR-0020): the config layer follows the rule above directly (tightening = L2 / loosening = L1 / the command line = L1); the test-content layer is tiered by **motive** — tests added/removed/changed in the same PR as the product code they follow = L2 routine development; **deleting to go green** (deleting / `.skip`-ing / weakening a test with no corresponding product-code change in the diff) = L1, and a silent skip is a violation. Deleting or skipping a test must state its motive in the commit message or PR body.

General rules (apply to both tiers):

- **All three pieces are required, none optional**: a matching issue (usually Protocol gap type) + an ADR (recording the decision and its rationale) + a branch PR (CI must be green to merge; closes the issue on merge).
- **A protocol change without an issue + ADR is out of compliance** and should be reverted, regardless of which tier it belongs to.
- **Protocol changes carry more weight than code changes**: code only needs an ADR for architectural decisions, but protocol changes always need one.
- **Humans retain an after-the-fact veto**: reverting the corresponding PR + reopening the issue undoes the change — even if it wasn't caught at the time.

**L1/L2 boundary criterion** (ADR-0012, **mechanism reference takes priority**): any new content that **references the L1/L2 tiering / Hard rules / Working agreement mechanism** (regardless of whether it's "optional" or touches an existing file) is treated as **L1**. Objective criterion — the text contains mechanism keywords like `L1` / `L2` / `Hard rule` / `Working agreement` / "tiered authorization", or semantically depends on these mechanisms to function (e.g., subagent routing that depends on L1/L2 to decide who gets assigned).

| Scenario | Classification | Basis |
|---|---|---|
| New template/subsystem that **references** a protocol mechanism | **L1** | ADR-0012 |
| New purely informational document (e.g. "how to contribute") that **references** no protocol mechanism | L2 | ADR-0012 |
| Modifying an existing protocol file (Hard rules / Gate / Tech stack / Working agreement content) | **L1** | ADR-0006 |
| Modifying the index (Where to find things) | L2 | ADR-0005 |
| A CONTEXT.md entry **defines** an existing mechanism (changes only CONTEXT.md + cites its source ADR + adds no new obligation/changes no process boundary — all three conditions required) | L2 | ADR-0019 |

**Definition exemption** (ADR-0019): the criterion targets **legislating** (adding/changing mechanism semantics), not **describing** (writing an already-legislated rule into the glossary). If any of the three conditions isn't met, or you're unsure → default to L1; don't grant yourself the exemption. Changing semantics under the guise of a definition is a violation — revert + reopen the issue.

> Why so strict: agents easily use "optional + purely additive" as an L2 channel to expand the protocol's boundaries (see the PR #21 retrospective — subagent-system referenced L1/L2 but self-merged as L2). This criterion closes off that path.

L1's "explicit agreement" is a weak-b form: it's enough for the `stanyan` to say "agreed" in the session or write "agreed" in a PR comment, and the agent presses the merge button itself. **For the PR-comment path, only a comment authored by the GitHub account `stanyan` names counts (ADR-0034)** — anyone else's "agreed" is not L1 approval. **In a repo with more than one human collaborator, only the PR-comment path is valid L1 approval (ADR-0042)** — in-session agreement stops counting (including in the maintainer's own session): in-session approval leaves no verifiable trace, so a merged L1 PR without the maintainer's comment would be indistinguishable from an impersonated approval. Single-human repos keep both paths. **GitHub's Approve button is not required** — the cost is that the `stanyan` becomes the L1 bottleneck, and that cost is accepted.

> This repo is downstream of Gearbox. Backfill follows the pull model (ADR-0026): step 4 of the three start-of-shift steps runs `gearbox-version` to self-check the protocol version, and `gearbox-update` to backfill if it's behind — it doesn't depend on upstream pushing, it proactively aligns with upstream.

> This repo doesn't publish protocol versions; the root `.gearbox-version` records the upstream Gearbox version at onboarding time, maintained by gearbox-install / gearbox-update, and read/compared by `gearbox-version` (upstream ADR-0023).

### Gate (the hard gate — must be all-green before shift-end)

```bash
npm test
```

> Fill in the gate to match your actual project — any command that can automatically assert "nothing's broken" works (rationale: ADR-0002). See ADR-0020 for how test-type gates (vitest/tsc/lint) map onto the L1/L2 tiers. The command must be byte-identical to `.github/workflows/ci.yml` (CI == Gate contract).

> `npm test` 断言两件事：`tsc --noEmit` 通过，且 `vitest run` 通过（项目 ADR-0053）。
> vitest 走 esbuild，只剥类型不校验类型——没有前半段，一个 TS strict 错误可以顶着全绿的门禁进 main。
> 写代码时的内循环用 `npx vitest --watch`（只跑测试）；`npm test` 是提交前和 CI 上跑的那一次。

CI (`.github/workflows/ci.yml`) runs the same set of commands; if it's red, merging is not allowed.

### On ending a shift (shift-end rules)

1. The gate is all-green
2. commit + push
3. Close finished Task issues as usual; for half-finished ones, write progress into that issue's comment
4. **Open a handoff issue for the next shift** (Task type, kept open, ADR-0005): the body states the current state and suggestions for next steps, and this shift's Memory comment (five-part format, ADR-0004) goes here. In multi-human repos the body also lists the Task issues this lane still owns (takeover = claiming exactly those), or marks itself **"context only"** when nothing transfers (ADR-0048). **This is the only entry point the next shift is guaranteed to encounter** — Memory no longer gets buried in a casually closed Task issue. **The sole exception — a terminal shift** (ADR-0009): when archiving / confirming there's no next shift, you may skip opening one, but you must explicitly declare "no next shift" + the reason in a comment on the last closed issue. A silent terminal doesn't count as terminal. Terminal is repo-level: with another lane still live (someone else's open handoff or claimed task), a terminal declaration is invalid — that's just a lane end (ADR-0048).
   **Closing someone else's "context only" handoff does NOT count as taking over a lane** (ADR-0069): that hands you context, not the baton. The shift that closed one still owes this rule — open its own handoff issue, or declare terminal. Two options, no third.

### Parallel shifts (multi-human repos, ADR-0048)

Serial single-human repos need none of this — with one live shift, the rules above already suffice and every rule below degenerates to them.

- **A lane = one shift + its claimed tasks.** Parallel shifts are allowed iff each works only on frontier tasks it has claimed (ADR-0044/0047). Disjoint claims = disjoint lanes; no other lock exists or is needed — task-level overlap is prevented at claim time, file-level overlap resolves in the PR merge like any concurrent development.
- **Handoff issues are per-lane**: shift-end rule 4 unchanged in shape, but a starting shift reads **all** open handoff issues, takes over **at most one** lane (claim its listed tasks, close its handoff), and leaves other lanes' handoffs open — closing another live lane's handoff is stealing its baton. A **"context only"** handoff (lane finished, nothing transfers) is closed by its first reader after reading.
- **Terminal declarations (ADR-0009) are repo-level, not lane-level** — see On ending a shift.
- **Protocol changes serialize at merge time**: two lanes may each open a protocol PR, but ADR numbers and the version bump are claimed at merge, not at branch time. Before merging: re-fetch; if a competing protocol PR landed first, renumber your ADR and recompute the version (latest tag + segment, ADR-0028) inside your PR, then merge.
- A stalled lane is released by the `stanyan`: unassign its tasks, close its handoff (the stale-claim rule in ADR-0047 already makes dangling assignments non-binding).

### Worktree discipline (project ADR-0149)

The main checkout is **frozen on the default branch and read-only**. Every shift works inside its own worktree.

- **Open one to start work**: `npm run lane -- <任务名>` (ADR-0150). It first searches same-topic issues (**closed included**) and branches and prints what it finds — that is the collision check of start-of-shift step 2, moved onto an action you already have to take (ADR-0154); it reports, it does not block. Then it fetches, opens `.claude/worktrees/<slug>-<随机>` off `origin/<default>`, and gives the branch a random suffix so two lanes on the same task name cannot collide; an existing directory or branch is refused rather than reused. Repo-local, no Gearbox involved.
- **A worktree is single-use**: one worktree serves one task, thrown away when done, and **never `git checkout`s to a different branch**. `npm run lane` stamps the branch it opened into the worktree's admin dir, and `pre-commit` refuses a commit made on a different branch (ADR-0154) — a worktree opened by hand carries no stamp and is not checked. A long-lived worktree that switches branches *is* a second main checkout — the branch-switching is back, just in another directory. Isolation comes from the single-use part, not from the word "worktree".
- **Why this one rule suffices**: under worktrees, having a branch pulled out from under you is *physically impossible* — git refuses to check the same branch out twice (`fatal: 'main' is already used by worktree at ...`). Nobody working in the main checkout ⇒ the branch switch never happens ⇒ no clause is needed to forbid it.
- **`npm run wip` instead of stashing** (ADR-0154): in your own worktree nothing can touch uncommitted work, so a WIP commit does the job and lives on your own branch, where nobody else's `pop` can reach it. Undo with `git reset --soft HEAD~1`.
- **Never bare `git stash` / `git stash pop`**: worktrees isolate files and HEAD, but `.git` is shared — **so is the stash stack**, and that is the one leak in the model (issue #543 symptom 2 was another lane's `pop` walking off with somebody else's work). Use `git stash push -u -m "<唯一标签>"`, capture your entry's SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (never `pop`), then re-find `stash@{n}` by tag and drop it. Better still: in your own worktree nothing can touch uncommitted work, so a WIP commit beats stashing.
- **Clean up at shift-end**: `npm run lane:prune` (dry-run; `-- --apply` to act) removes merged+clean worktrees and merged local branches. It never force-deletes, never touches a dirty worktree, and **never deletes a branch nobody has committed on** — that shape is a freshly opened lane, not a leftover twig (#449). Repo-local; this is why the repo no longer depends on `gearbox-agents prune` (ADR-0150).
- **Mechanical backstop**: `.githooks/pre-commit` refuses commits made in the main checkout on a non-default branch. Installed automatically by `npm install` (the `prepare` script, ADR-0150 — a setup command you must remember to run fails the same way a rule you must remember to follow does); to do it by hand: `git config core.hooksPath .githooks`. Its ceiling is stated in the hook itself — git has no pre-checkout hook, so the branch switch itself cannot be blocked; `--no-verify` is a deliberate escape hatch.

### Branch hygiene (optional)

> **This repo uses its own `npm run lane:prune` instead** (ADR-0150) — it carries the zero-work-branch protection this tool lacks (#449 / upstream gearbox#141). The paragraph below is the upstream description, kept for the other three things the upstream tool covers.

Before shift-end (or when you hit stale refs at shift-start), run `npx gearbox-agents prune`. It cleans up four things (ADR-0030/0043):

- Leftover linked worktrees from agent sessions (`--apply-worktrees`, `git worktree remove` on merged + clean ones only — dirty or locked worktrees are reported, never removed; runs before the branch pass because a worktree checkout blocks `git branch -d`)
- Locally merged branches (`git branch -d` safe-deletes, fails loudly)
- stale remote-tracking refs (`git fetch --prune`)
- Remote merged branches (`--apply-remote`, prints the list + asks for confirmation before deleting)

Dry-run by default — deletes nothing; a whitelist protects the current branch / the default branch / `gearbox-backfill-*` / the main worktree and the worktree you run from; never force-deletes (`-D`, `worktree remove --force`). This doesn't replace GitHub's `delete_branch_on_merge` setting — turning that on is the recommended root fix for repo owners; the tool is a backstop (`--check-settings` checks it and prints the command to enable it, without changing it automatically).

### Division of labor (optional, fill in as needed)

Division of labor is a project-level property; the template doesn't presume one (ADR-0008). Pick one of three:

1. **Fill it in**: which kind of task goes to which agent (split by capability, not tied to a specific tool). <Unvalidated candidate example: mechanical bulk edits, filling in tests → an agent good at bulk execution; architectural design, hard bugs → an agent good at deep reasoning>
2. **Leave it blank**: the default rule = **Task-issue claim-based ownership** — whoever claims a task sees it through start to finish (see While working); tasks aren't routed by agent specialty.
3. **Single-agent project**: delete this whole section (it's not a gate anchor, so deleting it won't break the gate).

## Where to find things

- `CONTEXT.md` — domain glossary (protocol terms + product/technical terms, two sections, ADR-0070)
- `docs/gearbox-adr/` — protocol ADRs (copied from Gearbox, managed by tooling — don't hand-edit)
- `docs/adr/` — this project's own architectural decisions (starting at 0001, human-authored)
- `docs/distribution-macos.md` — macOS 打包 / 签名 / 分发
- `docs/dev-two-accounts.md` — 本机同时跑两个账号（好友功能联调）
- `tests/architecture.test.ts` — Hard rules 的可执行版（越界 import 在这里红，错误信息带修法，ADR-0058）
- `tests/docs/adrNumbers.test.ts` — `docs/adr/` 编号唯一 + 不跳号的可执行版（撞号在这里红，ADR-0074）
- `scripts/wip.mjs` — `npm run wip [说明]`：把手上的活落成一个提交而不是 stash（多 worktree 共享同一个 stash 栈，#543 踩过；撤销 `git reset --soft HEAD~1`，ADR-0154）
- `scripts/lane.mjs` / `scripts/lane-prune.mjs` / `scripts/install-hooks.mjs` — 开一条 lane / 收工清理 / 自动挂钩子（`npm run lane -- <任务名>`、`npm run lane:prune`；零工作量分支为什么不删见 ADR-0150 与 #449）
- `.githooks/pre-commit` / `tests/hooks/preCommitWorktree.test.ts` — 「主 checkout 只读、开工用一次性 worktree」的机制兜底 + 它的可执行版（装一次：`git config core.hooksPath .githooks`；天花板与逃生门写在钩子文件头，ADR-0149）
- `src/shared/fileRefs.ts` / `src/renderer/src/lib/rehypeFileRefs.ts` / `src/renderer/src/lib/codeLines.ts` — 正文里的「文件:行号」认成可点 chip，点了跳到 Files 面板的那一行（ADR-0110；rehype 插件的装配顺序有两条不会报错的坑，见该 ADR 第二节）
- `src/shared/askUser.ts` / `src/renderer/src/lib/askUserCard.ts` — 问卷答卷的编解码（`formatAnswers` 的逆函数在这儿）+ 时间线上那张「已作答」卡的纯逻辑（ADR-0111）
- `src/main/filesService.ts` / `src/shared/files.ts` — Files 面板的主进程数据源与纯逻辑层（只读；三条安全边界钉在 `tests/main/filesService.test.ts`，ADR-0092）
- `tests/e2e/` — Playwright-electron 端到端（`npm run e2e`，不在 gate 里；跑不跑随你，不是 PR 的义务，ADR-0138 取消了 ADR-0058 那条）。既是冒烟，也是四张真机验收清单的落地处：`harness.ts` 换 `HOME` 做隔离、`fakeModel.ts` 是本机假模型，见 ADR-0076
- `src/main/islandBridge.ts` / `src/main/islandProjection.ts` — macOS 灵动岛：主进程 stdio 桥 + 事件投影器，接一个原生 Swift helper 进程（ADR-0059 推翻版）
- `native/MrOttoIsland/` — macOS 灵动岛原生 Swift helper（ADR-0061，推翻 0059；ADR-0063 演进为多会话 fleet 列表）
- `src/main/simulatorHub.ts` / `src/main/simInputBridge.ts` — iOS 模拟器：simctl 台账 + 画面轮询 + 输入桥（ADR-0092）
- `native/MrOttoSimInput/` — iOS 模拟器输入/无障碍 helper（Swift，CGEvent + AXUIElement；ADR-0092）
- `src/shared/remote/` / `src/main/remoteBridge.ts` — 手机端远程投影与审批：帧协议、握手与密封流（`src/shared/remote/` 是纯层，手机端 import 同一份）+ 与 islandBridge 平级的桌面侧装配（ADR-0094 / 0095 / 0096 / 0097 / 0100 / 0106）
- `src/shared/remote/wire.ts` / `wsTransport.ts` — 中继的线上约定（按 cid 寻址的帧、`:peer`/`:gone` 等控制消息、子协议、帧上限，**三方共用一份**）+ 桌面与手机**共用的那一份** WebSocket 传输（两个运行时都有原生 WebSocket，ADR-0129 / 0130）
- `services/edge/` — 边缘服务：OAuth 落地页 + 中继。`src/relay.ts` 是配对的纯逻辑（跑在根门禁里），`src/worker.ts` 是 Cloudflare Worker 入口 + Durable Object（唯一依赖运行时的文件，单独一份 tsconfig）。运行时那一层由 `checks/relay.mjs` 打真 workerd 验（ADR-0129）
- `src/main/proxy*.ts` / `src/shared/remote/proxyInvite.ts` / `proxyProtocol.ts` / `src/renderer/src/lib/proxyShare.ts` — 好友代理：@好友接替你的身份操作已接通的 MCP 服务（Shopify/Google Ads…），**凭证不出你的机器**（ADR-0151）。信任根是邀请码里那把**一次性 secret 的持有证明**，不是频道号——`proxyConnection` 的 `tryPair`，与自远程共用 `pairing.ts`；长期信任落 `proxyStore` 的 pin，撤销把授权/pin/频道一起清（ADR-0162）。执行侧三道闸、顺序固定：**身份**（帧里自称的 `fromUid` 只用来核对，查授权一律按通道绑定的那个）→ **关系**（删好友 = 代理权限跟着死；名单三态，`null`=还没同步好也拒）→ 白名单（ADR-0164）。取消是一条要真发出去的帧，且**取消 ≠ 没发生**——照样记审计并说清「可能已经动过」（ADR-0165）。B 侧借来的服务**按好友短标签加前缀**合并进会话（`proxyNamespace.ts`），不换掉本地那份；前缀取 uid 不取昵称（昵称过不了 `safe()`、又会变，而审批记忆按完整工具名记），通道没了**抛错不回落本地**（ADR-0166）。线上单帧有 256 KiB 上限而 relay 超限是**关掉发送方连接**，所以 `sendSealed` 回 boolean、超限不发；执行器最前面还有一道并发+令牌桶（第四道防线，保护的不只是凭证还有审计账），被限流的一个时段只记一笔（ADR-0167）。「借进来的」和「借出去的」记在同一本台账的两栏，断线的那条**仍然留在列表里**（「配过但没连上」≠「从没配过」，ADR-0168）；同理**撤销要说出口**——`proxy_revoked` 是一帧真发出去的话，靠「清单空了 + 连接断了」推断的话，它和「对方关机了」产生的观测一模一样，而这两件事该做的动作相反（标记不删除，`usableBorrows` 不再连它但 `allBorrows` 仍然列它）。A 侧那块表（`hostStatus`）与 B 侧严格对称，`inflight > 0` = **此刻**正在用我的凭证——审计是结果出来才写的，所以这一格另有 `onActivity` 一条信号源；改授权走 `proxyUpdateGrant`**不重发邀请码**（重发 = 重新配对，而调权限不是），ADR-0169。`hostStatus` 的 `pairing` 三档给「A 发码后退出 app」那个死锁**取了个名字**——secret 只活在内存里，重启后 `resume()` 因为没 pin 而跳过，房间再也不开；判据是既有数据的一个函数（有 pin / 无 pin+房间开着+没过期 / 其余），**落盘 secret 和无证明配对两条路都否决了**（ADR-0170）。线上白名单里 `tools: []` = **整服务放行**，勾选表的换算钉在 `proxyShare.ts`
- `mobile/src/friends.tsx` / `mobile/src/friendsApi.ts` / `src/shared/friendsQuery.ts` — 手机端好友：加好友 / 收发请求 / 私信（直连 Supabase，不经中继；纯逻辑与桌面共用 `friendsQuery.ts`，ADR-0114）
- `src/shared/remote/pairing.ts` / `src/renderer/src/lib/qr.ts` — 扫码配对：一次性二维码 + 持有证明的纯逻辑（三边共用），和把它画出来的模块矩阵。**目录仍然不是信任来源**，桌面验的是「谁能对 secret 签出名」（ADR-0142，推进 ADR-0095 后果表第三行）
- `src/shared/remote/stats.ts` / `src/shared/sessionActivity.ts` — 手机端设置页那两块：会话热力图 + 各模型用量。**拉取不订阅**（`stats` 帧对），`trim.ts` 那道闸门不动（ADR-0115）
- `src/shared/sessionWorktree.ts` / `src/main/sessionWorktreeService.ts` — **每只**水獭都拿一份独立工作副本（git worktree，落在 userData 不进用户的仓库；判据一条：工作区在 git 仓里，ADR-0157 取消了 0156 的「第一只不隔离」）。水獭从系统提示里知道它在副本上、**动文件前要先告诉用户项目目录不会变**、合回去先问一句合到哪；**提示里不写死分支名**（自动标题出来后分支会改名，日志里那份就成了历史记录，ADR-0158）。会话活着时副本被 `git worktree lock` 锁住，原因串带 sessionId + pid，给回收程序判活用。 合回项目与回收在 `merge` / `recycle`：**合到项目目录此刻所在的那条分支**、脏了拒绝、冲突 `--abort` 回滚（绝不把用户的 checkout 留在冲突态）；回收只收「干净且已合并」的，其余留着（ADR-0159）。UI 是头部那枚常驻 chip + 「更多」菜单里的一项。推翻了 ADR-0152 对候选 1 的否决，那条互斥与 ADR-0155 的跨进程锁留作兜底（ADR-0156 / 0157）
- `src/shared/coworkLog.ts` / `src/main/coworkLogFile.ts` / `src/main/coworkMiddleware.ts` — 非 git 文件夹里多只水獭同时干活：工作区根目录一本明文协作记录（谁/何时/动了哪个文件/为什么，`write_file` 的 `reason` 参数供料）+ 按需注入 + **文件级**的闸（撞同一个文件拦一次要求重读，不同文件一律放行）。追加走 `node:fs` 的 `O_APPEND`——读改写会把「两个进程同时写」这个问题原样重现。天花板：`bash` 里的 `mv`/`rm`/重定向管不着（ADR-0161）
- `src/shared/workspaceExclusion.ts` — 同一个文件夹同一时刻只跑一条 turn（纯逻辑；接线在 `index.ts` 的 turn 起跑处，紧挨着 `runningSessions` 那条自检）。沙箱围的是路径，围不住共享的 `.git`；同家族（子会话/SideChat）不互斥（ADR-0152）。**只在 git 仓里还这么拦**——非 git 目录改走 `coworkLog` 那条文件级的路（ADR-0161）
- `src/shared/workspaceLock.ts` / `src/main/workspaceLockFile.ts` — 工作区互斥的**跨进程**那一半（两个 app 实例指同一个文件夹）。锁在机器级临时目录、按路径哈希取名——不进用户的仓库；陈旧锁靠心跳过期 + pid 探活自愈，**自愈比挡住更重要**（一次崩溃不该把文件夹永久锁死，ADR-0155）
- `src/shared/gitSafety.ts` / `src/main/dirtyTreeApprover.ts` — 破坏性 git（`reset --hard` / `clean -f` / `checkout -- 路径` / `restore` / `stash drop`…）+ 工作区脏 = 越过 bypass 模式问人一次。**裸 `git checkout <分支>` 不在名单里**——git 自己会拒绝覆盖，拦它只会训练用户闭眼点批准（ADR-0153）
- `src/main/workspaceLens.ts` — 岛的分组镜头：workspace →「哪个项目 + 是不是副本、副本在哪条分支」（30s TTL 记忆化，因为 `pushFleet` 跟着每条事件跑）。**组头回答「这是哪个项目」，副本身份下沉成行上的 chip**；投影层靠注入这只镜头保持纯函数，默认镜头 = 不折叠 = 旧行为（ADR-0172）
- `src/main/projectRoot.ts` — 记忆的项目作用域解析：workspace 向上第一个 `.git` = 项目根，纯读文件不起 `git` 子进程。`resolveWorkspaceOrigin` 一次爬升同时得出根与 worktree 分支（分支从 `<主仓>/.git/worktrees/<名>/HEAD` 读，**现查不读日志**——日志那份会陈旧，ADR-0158/0172），`resolveProjectRoot` 是它的投影。**worktree 折叠回主仓**（取舍：worktree 是一次性的，不折叠的话项目记忆跟着每次换班出生死亡；代价是 worktree 里读不到 `.git` 时不折叠）——与 `projectInstructions.ts` 的爬升同源但结论相反，两边不共用函数（ADR-0116）
- `src/main/mcpOAuth.ts` / `src/main/mcpAuthStore.ts` — MCP 的 OAuth 授权：loopback 回调 + 0600 凭据落点（ADR-0121）
- `src/tools/mcpConfigure.ts` — agent 自助配置 MCP，过审批门（ADR-0118）
- `src/renderer/src/lib/runtimeHydration.ts` / `src/main/index.ts` 的 `sessionRuntime` handler — 推送之外那扇查询窗口：重载后补回 turn 状态/压缩标记/挂起的审批问卷。**只填空不覆盖**（为什么这条规则就够，见 ADR-0133）
- `src/renderer/src/lib/fileTree.ts` / `src/renderer/src/components/elements/file-tree.tsx` — 「这一组工具动了哪些文件」那棵树：独生目录链压一行、工作区外的文件不进树、同一文件写两次行数相加（纯逻辑）+ 挂在工具组折叠头底下、点一行在 Files 面板打开。取代原来每个写入一张可下载的文件卡（ADR-0140）。行末那对 `+N/−M` 来自 `tool_result.diffStat`（写盘那一刻由 `main/turnDiff.ts` 的 `writeStat` 算好落盘，**不是**渲染层现算，也不是 turn 级聚合那一份，ADR-0141）
- `src/renderer/src/lib/sidePanel.ts` / `src/renderer/src/lib/useBackgroundWatch.ts` — 右侧槽位那一族面板的单一开关（`panelKeyOf` / `panelFlags`，互斥由构造保证，不再每个 action 手抄一遍）+ 后台任务的常驻盯梢：轮询 live 名单、0→非 0 时自己把面板掀开。**只在槽位空着时掀**（ADR-0139）
- `src/renderer/src/lib/agentPhase.ts` — 运行指示条那枚药丸写什么、配哪个 orb。六档，审批最优先；调用方保证 turn 在跑（ADR-0133 / issue #549）
- `src/renderer/src/lib/liquidGlass.ts` / `src/renderer/src/components/LiquidGlass.tsx` — 液态玻璃卡片：位移贴图（纯逻辑）+ 挂滤镜的壳，材质配方在 `app.css` 的 `.liquid-glass`。失败模式是**静默的**（整条 backdrop-filter 被丢掉），所以 e2e 里有一条专门盯它（ADR-0132）
- `src/main/imageIntake.ts` / `src/renderer/src/components/elements/image-generation.tsx` — 工具产出的图：字节落附件库、日志只记 ref 的那道中间件 + 显示它的卡。**上游那张卡没有 `<img>`**（完成态画的是一坨写死的渐变），本仓改动一览写在文件头（ADR-0144）
- `src/shared/mcpCatalog.ts` — 常见 MCP server 的目录数据（人手维护、会过时；字段与占位符自洽由 `tests/shared/mcpCatalog.test.ts` 钉住，ADR-0118）
- `src/main/projectPackager.ts` / `src/tools/packageProject.ts` — 「打包为项目」：把 Default 工作区的产出搬进 `文档区/Mr Otto/<项目名>`（唯一故意越出围栏的工具能力，两道闸与被否掉的路见 ADR-0135）；`src/main/workspaceSettingsStore.ts` 是默认工作文件夹/内置 Default 的落盘与解析（#559）
