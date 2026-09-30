# Mr Otto

Mr Otto（曾用名 otter，仓库目录沿用 Otter）是 macOS 桌面 GUI agent 工具（每个 bot 是一只会用工具、有独立沙箱的水獭）。MVP 完成标准：单 agent + 3 工具（读/写文件、bash）+ event-sourced 会话日志 + replay UI + 危险操作审批 UI + 模型切换 + ExecutionWorld 接口（LocalWorld 实现）。明确不做：通用多 agent 编排框架——工作区群聊里 agent 互相 @ 接力是唯一例外（带周期护栏与棒数上限，ADR-0223；本机子 agent 仍不能再派子 agent，ADR-0047）、插件系统（skill 库是纯提示词注入，不算插件系统，见 docs/adr/0007）。MCP 做 client 那一半（接外部 server 的 tools/resources/prompts，见 docs/adr/0049），不做 server。

架构参考项目（学习/对照用，不引入为依赖）：
- **DeepSeek Harness**：三原则 —— event-sourced 会话日志 / 工具中间件管线 / capability seam（ExecutionWorld）
- **pi**（https://github.com/earendil-works/pi）：极简 agent harness。对照点：append-only AgentMessage 流（"消息完成后不可修改"）、细粒度生命周期事件（turn_start/tool_execution_start…）、工具 execute 抛异常报错 + 返回 `{content, details}`、刻意不做内置权限系统（隔离交给容器层 —— 与 otter 的 ExecutionWorld/v2 Docker 思路互证）

> This file is the single source of truth for ALL AI coding agents, whatever the tool (Claude Code, Z Code, Cursor, Codex, etc.). Rules live here and only here.
> The block between the `gearbox:protocol` markers is the Gearbox protocol, managed by `gearbox-agents` — don't edit it. Project rules go in the sections outside it.

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

## Gate

```bash
npm test
```

> The Gate contract (what must be green, and when) is in the protocol below. This section holds only this project's command; `.github/workflows/ci.yml` runs it byte-for-byte.

> `npm test` 断言三件事：`tsc --noEmit` 通过、手机端 `mobile/` 的 `tsc --noEmit` 通过、`vitest run` 通过
> （项目 ADR-0053；手机端那一条是 ADR-0294 加的，#422）。
>
> 手机端有自己的 package.json 与 node_modules，所以**跑门禁前先 `npm --prefix mobile ci`**（一次即可）；
> 忘了装的话 `pretest` 的 `scripts/check-mobile-deps.mjs` 会当场说清去装哪一句，而不是让你读一串 `tsc: not found`。
> CI 在 `npm test` 之前跑同一句安装——安装是门禁的前置管线，不是门禁本身，**Gate 命令仍逐字是 `npm test`**。
> vitest 走 esbuild，只剥类型不校验类型——没有前半段，一个 TS strict 错误可以顶着全绿的门禁进 main。
> 写代码时的内循环用 `npx vitest --watch`（只跑测试）；`npm test` 是提交前和 CI 上跑的那一次。

## Roster

> One line per GitHub account: `human: Name` (only that person), `shared: Name` (the person and their agents) or `agent, run by Name`; `— maintainer` marks the accounts whose actions approve L1 (ADR-0053).

- `real-stanyan` — shared: stanyan — maintainer
- `RicksZhang` — shared: stanyan

<!-- gearbox:protocol v2.0.0 sha256:5cfee13d97b7; managed by gearbox-agents, do not edit by hand; project additions go in "## Local protocol extensions" -->
## Working agreement (multi-agent)

> This block is the Gearbox protocol — byte-identical in every repo that runs it (ADR-0050). In a downstream repo it changes only through `gearbox-agents update`; record project deviations in `## Local protocol extensions` instead of editing here. In the Gearbox repo itself it is edited under the tiers in "Changing the protocol itself".
>
> Any clause marked **Hard rule** — in this block, in `## Hard rules`, or in `## Local protocol extensions` — counts as part of the `## Hard rules` section and is protected under L1: the criterion anchors to the marking itself, not to where the clause lives (ADR-0018).

### On starting a shift (the start-of-shift steps)

1. **Sync, then read**: `git fetch origin` + fast-forward the local default branch (`git pull --ff-only` while on it) — the repo is the only shared memory, and an unfetched clone is somebody's stale cache of it (a stale clone even means stale *rules*: this very file is version-controlled). Fast-forward impossible = the local default branch has diverged: stop, open an issue, don't build on a forked base (ADR-0046). Then `git log --oneline -10` — see what happened recently
2. Check GitHub Issues, in order (ADR-0054): **open handoff issues** — each is one lane's unfinished Tasks plus its Memory (ADR-0005); take over at most one: claim its listed Tasks, then close it, and leave other lanes' handoffs alone (see "Parallel shifts"). Then **open `Waiting on:` lines**: clear each whose event GitHub already shows (a merged PR) — delete the line, comment the evidence. Then the **frontier** (see "Task ordering"). Rebuild context from git log, the Tasks and their PRs
3. Run the gate command (`## Gate`) to confirm the baseline is green — if it's red, fix it first or open an issue; don't start work on a broken baseline
4. (Downstream repos) Run `npx gearbox-agents version`: `behind` → run `npx gearbox-agents update` and merge its `docs/gearbox-backfill-*` PR through this repo's L1 flow (ADR-0026/0050); `hand-edited` → move the local rules into `## Local protocol extensions`, then re-apply the fence with `npx gearbox-agents update --force` — never edit the fence itself; `v1 layout` → `npx gearbox-agents update` migrates it

### While working

- Commit in small steps; the message should spell out the **why**, not just the what
- **Protocol files stay committed — never add them to `.gitignore`**: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/gearbox-adr/`, `.gearbox-version`, `.github/workflows/ci.yml`. The repo is the only shared memory between shifts; an ignored protocol file exists locally but never reaches the next agent's clone (ADR-0037)
- One agent sees a task through from start to finish; an unfinished Task changes hands only through a handoff issue (see On ending a shift)
- Non-trivial changes go through a branch + PR; typo-level tweaks can go straight into main
- **Project-owned** architectural decisions go in `docs/adr/`, one decision per file, named after the issue that settles it: `docs/adr/<issue>-<slug>.md`, cited `ADR-<issue>` — issue numbers are unique, so parallel lanes never collide; older numbered files keep their numbers, and no ADR is ever renumbered (ADR-0052). Protocol ADRs live in `docs/gearbox-adr/`, managed by the gearbox tooling — don't hand-edit them
- Look up domain-term definitions in `CONTEXT.md`; add new project terms under its `## Project terms` as they come up (protocol terms live in its fence)
- **One fact, one repo**: work that spans sibling repos is tracked — its Task, handoff and `Waiting on:` lines — in the repo where it is done; the others link to it, never copy it (ADR-0054)
- **Never edit between the `gearbox:` markers** (in `AGENTS.md` or `CONTEXT.md`). Project rules go in the project sections; additions to the protocol go in `## Local protocol extensions`, each with `- Extends:` (the section it extends) and `- Upstream:` (an upstream issue link, `project-specific`, or `undecided`) (ADR-0050)
- **Keep `AGENTS.md` within 32 KiB**: every agent loads it in full at session start, and Codex silently drops everything past its first 32 KiB. "Where to find things" gets one line per entry — a path plus what's there; longer maps go in `docs/INDEX.md`. `gearbox-agents check` enforces the budget (ADR-0051)

### Roles of issues & PRs

Issues and PRs are the timestamped, append-only, non-decaying conversation carriers between agents (and between agents and humans). In this protocol they have **three non-overlapping roles** — every issue/PR should fit into one of these:

| Role | When to use | When to close |
|---|---|---|
| **Task** | There's an actionable thing to do | The task is done and the gate is green |
| **Memory** (handoff memory) | On the **handoff issue** a shift opens when it leaves Tasks unfinished (see On ending a shift): it lists them and carries the five-part Memory | The next shift claims those Tasks and closes the handoff = handoff complete |
| **Protocol gap** | Hit a question the repo can't answer (rule not written, ambiguous, boundary unclear) | The gap gets folded into AGENTS.md / CONTEXT.md / an ADR |

Hard rules:

- **When you hit a question this repo can't answer, you must open an issue (Protocol gap type) — silent judgment calls are not allowed.** This is the only entry point for the protocol's self-repair — it turns gaps from "tacit understanding" into something explicit, discussable, and closeable.
- **Memory five-part format** (the minimum valid format for a handoff comment, ADR-0004): ① what's done ② what's blocked ③ what's next ④ close the issue if the task is complete ⑤ **rationale / trade-offs** — required whenever this shift made a non-default decision (what was chosen, why, and what premise failing would overturn it); if no decision was made, write "none" — don't omit it. Missing any one item means the handoff doesn't count. Across all five parts: content already captured in a durable artifact (ADR / issue / PR / commit / diff) is referenced by number or path, not restated — copies decay, references don't (ADR-0045). Inline belongs only what no artifact carries.
- **Handoff = the moment the next shift claims the listed Tasks and closes the handoff issue**, not just feeling like things were "explained clearly." An unfinished Task changing agents any other way violates the previous section.
- **A PR is the implementation vehicle for a Task, not a separate role**: a PR references the Task issue it implements, and closes that issue on merge. New issues found during PR review get their own issue — don't pile them up in PR comments.

**Task ordering (blocking edges, ADR-0044)**: when one Task depends on another, the dependent issue's body declares each prerequisite with a literal `Blocked by: #N` line (one per blocker). A shift claims only **frontier** tasks — open tasks with no open blockers and no `Waiting on:` line; when a blocker closes, its dependents join the frontier unless waiting. Plain text, grep-able, no Projects/labels needed. This is a hygiene convention — a stale edge costs a judgment call at claim time, nothing more.

**Waiting on a person (ADR-0054)**: a Task whose next step only a person can take (a merge, a device test, a decision) carries one literal `Waiting on: <person> — <what>` line per wait, `<person>` as named in `## Roster`. It needs no handoff and stays off the frontier until the line is cleared — by that person, or by a shift that sees the event already happened on GitHub (delete the line, comment the evidence). Standing debt is one Task per item, never a list copied from shift to shift.

**Claiming (ADR-0047)**: a claim = assigning yourself on the Task issue (`gh issue edit <N> --add-assignee @me` — the GitHub account the agent acts under); first assignment wins, visible and timestamped. No triage permission → a "claiming this" comment instead. An open frontier task with no assignee and no claim comment is free. A shift ending with the task unfinished states in its progress comment whether the claim is released (unassign) or carried; a dangling assignment from a shift that left no comment is stale, not binding. Single-human repos may skip claiming — with one queue reader it informs nobody; its value begins at the second human.

> Why use an issue comment instead of a standalone handoff file: see `docs/gearbox-adr/0003-issue-roles.md`. Why Memory lives in an open handoff issue rather than a closed Task issue: see `docs/gearbox-adr/0005-handoff-lives-in-an-open-issue.md`.

### PR disposition (merge rules)

Four rules (ADR-0007):

- **Always merge via merge commit** — never squash, never rebase: the why behind small-step commits is a protocol asset (the repo is the only shared memory between sessions), and squashing is equivalent to deleting memory; locking in one style keeps history predictable.
- **Who merges**: the PR's author agent merges it themself once CI is green. Protocol changes follow the tier system (see "Changing the protocol itself"): L1 waits for the maintainer's approval — in a multi-human repo the maintainer merges it — L2 is autonomous.
- **A second agent's review is not mandatory**: in serial repos only one shift is present at a time, and forcing mutual review would block at handoff boundaries; parallel lanes (ADR-0048) don't change this — review stays optional, because the quality backstop never depended on serialization: the CI gate + the maintainer's after-the-fact veto (revert + reopen the issue), plus branch protection where configured (ADR-0042).
- **Don't take over someone else's open PR** — that's a mid-task handoff (see While working). Exception: the handoff issue explicitly transfers it, or the maintainer directs it.

If a PR is still hanging open at shift-end, the task isn't done: per item 3 of On ending a shift, write progress into the Task issue's comment and leave the PR open.

### Changing the protocol itself (rules for changing this file)

Where the protocol text lives decides how it changes (ADR-0050). In the **Gearbox repo**, the fenced protocol is edited under the tiers below. In a **downstream repo**, the fence changes only through upstream releases (`gearbox-agents update`); a local deviation goes in `## Local protocol extensions` and is tiered as if it were written into the section it extends — the ADR-0012 criterion applies unchanged. The maintainer's accounts are the `maintainer` lines of `## Roster`, which lists every account as `human`, `shared` (a human and their agents) or `agent` (ADR-0053).

Agents can modify AGENTS.md, but **the change is tiered by its content** (ADR-0006):

| Tier | Content | Process |
|---|---|---|
| **L1 strict tier** | Hard rules / Gate command / Tech stack / Roster / this section itself | issue + ADR + PR, **and the agent may only merge after the maintainer's approval (below)** |
| **L2 autonomous tier** | Working agreement (except the Gate contract) / Division of labor / the index (Where to find things) | issue + ADR + PR, agent may merge autonomously |

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
| Modifying an existing protocol file (Hard rules / Gate / Tech stack / Roster / Working agreement content) | **L1** | ADR-0006 |
| Modifying the index (Where to find things) | L2 | ADR-0005 |
| A CONTEXT.md entry **defines** an existing mechanism (changes only CONTEXT.md + cites its source ADR + adds no new obligation/changes no process boundary — all three conditions required) | L2 | ADR-0019 |

**Definition exemption** (ADR-0019): the criterion targets **legislating** (adding/changing mechanism semantics), not **describing** (writing an already-legislated rule into the glossary). If any of the three conditions isn't met, or you're unsure → default to L1; don't grant yourself the exemption. Changing semantics under the guise of a definition is a violation — revert + reopen the issue.

L1's explicit agreement comes only from the maintainer: an `agreed` PR comment or an Approve review from a `maintainer` account, or agreement in the session. It covers the commits it saw; a later push needs a new one. **Multi-human repos** (more than one person on the `human`/`shared` lines of `## Roster`): only the maintainer's own merge approves, and agents never merge an L1 PR — agents act under the humans' accounts, so no comment or review proves who wrote it (ADR-0042/0053). In every repo, an agent never writes an approval — no `agreed`, no Approve, no approval record — for anyone. GitHub's Approve button stays optional; the maintainer as L1 bottleneck is an accepted cost.

**Protocol updates** (ADR-0026/0050): pull-triggered. Start-of-shift step 4 (`gearbox-agents version`) and the optional weekly `gearbox-sync` Action run `gearbox-agents update`, which rewrites both fences, copies new protocol ADRs and bumps `.gearbox-version` on a `docs/gearbox-backfill-*` branch; merging that PR adopts the new protocol version and is L1 in the receiving repo. The fence markers and `.gearbox-version` carry the protocol version — tooling maintains them, humans don't. (The upstream-side release rules — the `Affects downstream` declaration, version bumps, tags, npm publish — are the Gearbox repo's own local extension.)

### Gate contract (must be all-green before merge and shift-end)

The Gate command lives in the project's `## Gate` section. CI's `gate` job (`.github/workflows/ci.yml`) runs it byte-for-byte — the CI == Gate contract. The `gearbox-check` job runs `npx gearbox-agents check`: fences intact, `AGENTS.md` within 32 KiB, required sections present, CI == Gate (ADR-0051; in the Gearbox repo, `scripts/check-gearbox.js` runs the same checks inside the gate). Both must be green to merge; if either is red, merging is not allowed.

### On ending a shift (shift-end rules)

1. The gate and the protocol check are green (see Gate contract)
2. commit + push
3. Close finished Task issues as usual; for half-finished ones, write progress into that issue's comment
4. **Hand over unfinished Tasks** (ADR-0054): if this shift leaves Tasks it owns unfinished and not waiting on a person — claimed, or worked on where claiming is skipped; an open PR counts — open a **handoff issue** (Task type, kept open, ADR-0005) listing them, with this shift's five-part Memory (ADR-0004) as its comment; context that must outlive the shift goes in its body or a standing tracking Task. Otherwise open none: progress lives in the Tasks and PRs, waits on people in `Waiting on:` lines. No open handoff means nothing is in flight — there is no terminal declaration

### Parallel shifts (multi-human repos, ADR-0048)

Serial single-human repos need none of this — with one live shift, the rules above already suffice and every rule below degenerates to them.

- **A lane = one shift + its claimed tasks.** Parallel shifts are allowed iff each works only on frontier tasks it has claimed (ADR-0044/0047). Disjoint claims = disjoint lanes; no other lock exists or is needed — task-level overlap is prevented at claim time, file-level overlap resolves in the PR merge like any concurrent development.
- **Handoff issues are per-lane**: a starting shift reads **all** open handoff issues, takes over **at most one** lane (claim its listed Tasks, close its handoff), and leaves other lanes' handoffs open — closing another live lane's handoff is stealing its baton.
- A stalled lane is released by the maintainer: unassign its tasks, close its handoff (the stale-claim rule in ADR-0047 already makes dangling assignments non-binding).

### Branch hygiene (optional)

Before shift-end (or when you hit stale refs at shift-start), run `npx gearbox-agents prune`. It cleans up four things (ADR-0030/0043):

- Leftover linked worktrees from agent sessions (`--apply-worktrees`, `git worktree remove` on merged + clean ones only — dirty or locked worktrees are reported, never removed; runs before the branch pass because a worktree checkout blocks `git branch -d`)
- Locally merged branches (`git branch -d` safe-deletes, fails loudly)
- stale remote-tracking refs (`git fetch --prune`)
- Remote merged branches (`--apply-remote`, prints the list + asks for confirmation before deleting)

Dry-run by default — deletes nothing; a whitelist protects the current branch / the default branch / `gearbox-backfill-*` / the main worktree and the worktree you run from; never force-deletes (`-D`, `worktree remove --force`). This doesn't replace GitHub's `delete_branch_on_merge` setting — turning that on is the recommended root fix for repo owners; the tool is a backstop (`--check-settings` checks it and prints the command to enable it, without changing it automatically).

### Division of labor

Division of labor is a project property, declared in the project's `## Division of labor` section (ADR-0008). When that section is absent or blank, the default applies: **Task-issue claim-based ownership** — whoever claims a task sees it through start to finish; tasks aren't routed by agent specialty.
<!-- /gearbox:protocol -->

## Local protocol extensions

> Project additions to the fenced protocol. Each `###` entry names the fenced section it extends (`- Extends:`) and where it stands upstream (`- Upstream:` an upstream issue link, `project-specific`, or `undecided`). An entry is tiered as if it were written into the section it extends (ADR-0006/0012).

### Collision search before a new Task (project ADR-0148)

- Extends: On starting a shift
- Upstream: undecided

**Before opening a new Task issue, or claiming one from the frontier, search for a collision first — closed issues included** (project ADR-0148): `gh issue list --state all --search "<关键词>"` plus `git branch -a --list '*<关键词>*'`. A hit gets read before anything else: already done → don't redo it (open a new issue referencing it if it still needs changes); half done → continue from there, don't restart. Step 1's `git log --oneline -10` does not cover this — skimming the last ten commits builds a background impression of what happened, it is not a search for one specific need. A compliantly closed issue is exactly the blind spot (issues #611/#612 were the same need done twice)

### Task issue first; verify "can't do" (project ADR-0148 / ADR-0134)

- Extends: While working
- Upstream: undecided

- **A need in hand gets its Task issue opened before the exploring starts** (project ADR-0148), not after the work is done or half done — one line of the need as stated plus "exploring" is enough at that point. This is what survives an abnormal end: a session killed by an app quit gets no chance to write anything, so the only reliable trace is the one already in the repo while it was still alive — an issue opened up front is still open and unassigned afterwards, and the next shift's step 2 walks into it. Issues opened but not finished are the intended cost: an open empty issue says "somebody touched this and didn't finish", which is the sentence missing at collision time. At shift-end they follow On ending a shift item 3 like any other
- **读到「做不了 / 不在本仓 / 只能维护者做」这类判断时，先花五分钟验前提本身再决定跳过**（`ssh` 能不能连、`ls` 有没有那个目录、`grep` 有没有那个符号）——这类判断读起来像调查结论，实际往往只是上一班没试，写进 handoff 就成了下一班的既定前提，本仓已连错四次（ADR-0134）。验完确实做不了，把**验的方法和结果**写进 issue，让下一班不用再验

### Worktree discipline (project ADR-0149)

- Extends: Working agreement (multi-agent)
- Upstream: undecided

The main checkout is **frozen on the default branch and read-only**. Every shift works inside its own worktree.

- **Open one to start work**: `npm run lane -- <任务名>` (ADR-0150). It first searches same-topic issues (**closed included**) and branches and prints what it finds — that is the collision check of start-of-shift step 2, moved onto an action you already have to take (ADR-0154); it reports, it does not block. Then it fetches, opens `.claude/worktrees/<slug>-<随机>` off `origin/<default>`, and gives the branch a random suffix so two lanes on the same task name cannot collide; an existing directory or branch is refused rather than reused. Repo-local, no Gearbox involved.
- **A worktree is single-use**: one worktree serves one task, thrown away when done, and **never `git checkout`s to a different branch**. `npm run lane` stamps the branch it opened into the worktree's admin dir, and `pre-commit` refuses a commit made on a different branch (ADR-0154) — a worktree opened by hand carries no stamp and is not checked. A long-lived worktree that switches branches *is* a second main checkout — the branch-switching is back, just in another directory. Isolation comes from the single-use part, not from the word "worktree".
- **Why this one rule suffices**: under worktrees, having a branch pulled out from under you is *physically impossible* — git refuses to check the same branch out twice (`fatal: 'main' is already used by worktree at ...`). Nobody working in the main checkout ⇒ the branch switch never happens ⇒ no clause is needed to forbid it.
- **`npm run wip` instead of stashing** (ADR-0154): in your own worktree nothing can touch uncommitted work, so a WIP commit does the job and lives on your own branch, where nobody else's `pop` can reach it. Undo with `git reset --soft HEAD~1`.
- **Never bare `git stash` / `git stash pop`**: worktrees isolate files and HEAD, but `.git` is shared — **so is the stash stack**, and that is the one leak in the model (issue #543 symptom 2 was another lane's `pop` walking off with somebody else's work). Use `git stash push -u -m "<唯一标签>"`, capture your entry's SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (never `pop`), then re-find `stash@{n}` by tag and drop it. Better still: in your own worktree nothing can touch uncommitted work, so a WIP commit beats stashing.
- **Clean up at shift-end**: `npm run lane:prune` (dry-run; `-- --apply` to act) removes merged+clean worktrees and merged local branches. It never force-deletes, never touches a dirty worktree, and **never deletes a branch nobody has committed on** — that shape is a freshly opened lane, not a leftover twig (#449). Repo-local; this is why the repo no longer depends on `gearbox-agents prune` (ADR-0150).
- **Mechanical backstop**: `.githooks/pre-commit` refuses commits made in the main checkout on a non-default branch. Installed automatically by `npm install` (the `prepare` script, ADR-0150 — a setup command you must remember to run fails the same way a rule you must remember to follow does); to do it by hand: `git config core.hooksPath .githooks`. Its ceiling is stated in the hook itself — git has no pre-checkout hook, so the branch switch itself cannot be blocked; `--no-verify` is a deliberate escape hatch.

### lane:prune instead of gearbox-agents prune (project ADR-0150)

- Extends: Branch hygiene
- Upstream: https://github.com/real-stanyan/gearbox/issues/141

> **This repo uses its own `npm run lane:prune` instead** (ADR-0150) — it carries the zero-work-branch protection this tool lacks (#449 / upstream gearbox#141). The fenced "Branch hygiene" section is the upstream description, kept for the other three things the upstream tool covers.

## Division of labor

No fixed division of labor (ADR-0008 option 2): Task-issue claim-based ownership — whoever claims a task sees it through start to finish.

## Where to find things

- `CONTEXT.md` — domain glossary (protocol terms, fenced + this project's terms)
- `docs/gearbox-adr/` — protocol ADRs (managed by tooling — don't hand-edit)
- `docs/adr/` — this project's own architectural decisions, one file per decision named `<issue>-<slug>.md` after the issue that settles it (ADR-0052; not listed here one by one)
- `docs/INDEX.md` — the full map of where things live (kept out of this file so it stays within 32 KiB)
