# Domain context — Mr Otto

Domain glossary. All agents' understanding of domain terms is grounded here; code naming stays consistent with the terms defined here.

## Terms

| Term | Definition | Notes |
|---|---|---|
| single source of truth | Rules are written in exactly one place (`AGENTS.md`); other agent configs (e.g. `CLAUDE.md`) only `@`-reference it, never copy it | Prevents rules from drifting across multiple locations |
| empty-shell contract | `CLAUDE.md`'s content is exactly one line, `@AGENTS.md` — a physical guarantee that Claude Code and Z Code read the same rules | The structural self-check script asserts this |
| handoff | One agent passes a task to another agent — **this only happens the moment an issue closes / a PR merges**, never mid-task | It isn't a handoff just because things were "explained clearly" — it's a handoff only when the issue closes |
| protocol gap | A question the repo's persistent artifacts (AGENTS.md / ADR / CONTEXT.md) can't answer | Hitting one requires opening an issue — silent judgment calls are not allowed |
| The three issue roles | The three non-overlapping uses of issues/PRs in this protocol: **Task** / **Memory** (handoff memory) / **Protocol gap** | Every issue should fall into exactly one of these — see AGENTS.md |
| gate | The command that must be all-green before ending a shift. See the Gate section in AGENTS.md for this repo's command | CI runs the same command — red means no merge |
| L1/L2 tiers | Two authorization tiers for protocol changes: **L1 strict tier** (Hard rules / Gate / Tech stack / the "Changing the protocol itself" section itself) requires explicit maintainer agreement before merging; **L2 autonomous tier** (the rest of Working agreement / indexes) the agent can merge on its own | ADR-0006; boundary criteria in ADR-0012 |
| Mechanism reference (criterion) | Any new content that references L1/L2, Hard rules, Working agreement, or other protocol mechanisms (by keyword or semantic dependency) is treated as L1 | ADR-0012, "mechanism reference takes priority"; guards against using "optional + pure addition" as an L2 loophole to expand the protocol |
| Memory five-part format | The minimum valid format for a handoff comment: ① what's done ② what's blocked ③ what's next ④ close the issue if the task is complete ⑤ rationale/trade-offs (write "none" if no decision was made) | ADR-0004; missing any item makes the handoff invalid |
| terminal shift | The form a shift ends in when archiving / confirming there's no next shift: a handoff issue may be skipped, but the last closed issue must explicitly declare "no next shift" + a reason. Repo-level, not lane-level — invalid while another lane is still live | ADR-0009; a silent ending doesn't count as terminal; repo-level scope per ADR-0048 |
| blocking edge | A literal `Blocked by: #N` line in a dependent Task issue's body, declaring one prerequisite Task per line | ADR-0044; a hygiene convention — a stale edge costs a judgment call, not a violation |
| frontier task | An open Task issue with no open blockers — the only kind of task a shift may claim; when a blocker closes, its dependents join the frontier | ADR-0044 |
| claim | Self-assignment on a Task issue (`gh issue edit <N> --add-assignee @me`), first wins; a "claiming this" comment where assignment isn't possible. An open frontier task with no assignee and no claim comment is free | ADR-0047; single-human repos may skip — the value begins at the second human |
| lane | One shift plus the tasks it has claimed; parallel shifts are allowed iff lanes are disjoint (each works only on frontier tasks it claimed) | ADR-0048; handoff issues are per-lane |
| context-only handoff | A handoff issue whose lane finished with nothing to transfer — kept for its Memory comment, closed by its first reader after reading | ADR-0048 |
| downstream | A project that copies this Gearbox protocol and then evolves independently; sync status is self-checked downstream via `gearbox-version` (pull-primary, ADR-0026 — the upstream fleet dashboard was retired in ADR-0033) | See ADR-0026 |
| backfill | Downstream pulls Gearbox protocol improvements into its local copy; **pull-triggered** — downstream runs `gearbox-version` at the start of a shift to self-check, and `gearbox-update` if it's behind, with no dependency on upstream pushing; it's alignment, not enforcement — downstream can decline | ADR-0013 → ADR-0026 (push-triggered was downgraded to pull-triggered) |
| protocol version number | A semver-variant tag: **major** = cross-tool/cross-repo contract change; **minor** = a new mechanism added; **patch** = revision of an existing file. Every protocol PR declares a `Version bump`; the author tags after merge; the downstream local version is recorded in the `.gearbox-version` stamp (written and read by tooling) | ADR-0023; baseline v0.0.0 |
| 终端面板（Terminal panel） | 会话里内嵌的真 PTY 终端，纯人用。输出不进事件日志、不进模型上下文（ADR-0031）——它不是任何事实的投影，是人的旁路工具。 | |
| 回滚缓冲（terminal ring buffer） | 主进程为每个终端保留的末尾约 200 KB 输出。面板关掉时渲染层的 xterm 实例就没了而 pty 还在吐，靠它接住；重开面板一次性灌回去。内存态，不落盘，与 pty 进程同生共死。 | |
| 轨迹（Trajectory） | 会话日志的第二种投影（第一种是聊天区）：一步一行，工具请求 + 审批 + 开跑 + 结果按 toolCallId 合成一行，顶部泳道时间轴（Input / Model / Tools）按 Duration / Turns / Calls 三种刻度铺开。对标 deepseek-harness 的 trajectory 视图。纯渲染层、只读、不进 store；取代了早期的「画布 + 函数轨迹」教学式回放（#151）。 | `src/renderer/src/replay/trajectory.ts` |
| MCP（Model Context Protocol） | 一个标准协议，让 Otto 作为 **client** 连外部**server**，把 server 提供的 tools / resources / prompts 接进来。v1.x 只做 client 这一半，不做 server；不算插件系统——server 是跨进程外部程序，不向 Otto 进程注入代码 | ADR-0049、ADR-0050 |
| MCP server | 一个外部程序，通过标准协议（stdio 或 streamable-http）向 client 提供 tools / resources / prompts。Otto 只认协议返回的形状（`McpClientConn`），不加载、不执行 server 的任何代码 | ADR-0049；配置见 `~/.otter/mcp.json` |
| transport（stdio / streamable-http） | MCP 连接的传输方式：`stdio` = 本地 `spawn` 一个子进程，走标准输入输出对话；`streamable-http` = 连一个远程 HTTP 端点。配置里有 `command` 走前者，有 `url` 走后者，两者都有则报错不猜 | ADR-0050；`src/main/mcpClient.ts` |
| elicitation | MCP 协议里 server 调用到一半反过来向用户要字段的机制。设计上打算复用既有的 `elicitation-form` 元素（原为 `ask_user` 准备）多接一个调用方；**本版（tasks 1–7）尚未接线**，只是协议里存在、设计文档里点过名的一个词条 | 设计文档 `docs/superpowers/specs/2026-08-21-mcp-design.md` §八 |
| 工作区在场（WorkspacePresence） | 一个人此刻「在哪个仓库、哪根分支」：`{repoKey, branch}`。repoKey = 规范化 remote URL 的 sha256 前 16 位（只能比对同不同仓库，看不到地址）；branch 是本地短名，detached 为 null。两条腿广播——Realtime presence 的 track meta ∪ 心跳写入 `profiles.repo_key/repo_branch`——Git Graph 把同仓库好友的头像贴到对应分支徽章上 | ADR-0055；`src/shared/repoKey.ts`、`src/main/workspacePresence.ts`、`src/shared/friendBranches.ts` |

## Key invariants

- `AGENTS.md` is always the single source of rules; `CLAUDE.md` is always just the `@AGENTS.md` empty shell
- No `HANDOFF.md` is created — handoffs happen via issue comments (append-only, timestamped)
- The gate command must be byte-identical in AGENTS.md and ci.yml (CI == Gate contract)
- One agent completes a task from start to finish; handoffs only happen at task boundaries
