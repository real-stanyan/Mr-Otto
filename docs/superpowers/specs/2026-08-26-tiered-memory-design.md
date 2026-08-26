# 记忆分级：USER / MEMORY / PROJECT — 设计

日期：2026-08-26
推翻：`docs/superpowers/specs/2026-08-22-memory-design.md` 决策表里的「文件作用域：全局一份 `~/.mr-otto/memories/`，不分 workspace」
参考：`~/.hermes/hermes-agent`（`tools/memory_tool.py`、`agent/memory_provider.py`、`hermes_cli/profiles.py`、`tools/skill_manager_tool.py`）

## 问题

`MEMORY.md` 是一份 2200 字符的全局文件，而项目数量线性增长。真正的缺陷不是「项目 A 的记忆在项目 B 里显得吵」，而是**互相驱逐**：`applyOps` 超限时报错、不自动淘汰（`src/shared/memoryStore.ts`，逼模型自己 remove/replace 腾地）——所以在项目 B 里写记忆，模型为了腾空间会去删项目 A 的条目。项目越多，记忆越是一份不断自我覆写的滚动窗口。

Otto 已经有项目轴（`session_created.workspace` 是一等会话事实，`projectInstructions.ts` 按 workspace 注入 AGENTS.md/CLAUDE.md），只有模型自己能写的那份笔记没接上去。

### hermes 为什么没有这一档

扒过源码，hermes 的记忆是三层，**没有一层是项目**：

1. **文件层**（Otto 抄的这份）：`MEMORY.md` + `USER.md`，2200/1375，冻结快照注入。它自己的 docstring 把 "project conventions" 明确塞进这个全局桶——同一个坑，它没解决。
2. **profile 层**（`hermes_cli/profiles.py`）：分级轴是**人格/身份**，一个 profile = 一整个 HERMES_HOME。`--clone` 特意复制 `memories/*`，注释称记忆是 "part of the agent's curated identity"。立场是「换项目不换记忆，换人格才换记忆」。
3. **provider 层**（`agent/memory_provider.py` + `plugins/memory/*`，八个可插拔后端，同时只允许挂一个）：接口要害是 `prefetch(query)` —— **按需检索**注入。这才是 hermes 对「记忆装不下」的正式答案：不是分级，是分层。

provider 的 `initialize()` kwargs（`agent_identity` / `agent_workspace` / `agent_context` / `user_id`）全是身份与平台维度，没有一个是 project 或 cwd。

**结论**：hermes 不需要项目档，是因为它不知道自己在哪个项目里。Otto 知道。照抄它等于照抄一个空缺。检索层（第 3 层）Otto 确实也缺，但每轮注入会打穿 ADR-0060 买到的前缀缓存，那是另一件事。

## 决策（已确认）

| 问题 | 决定 |
|---|---|
| 作用域键 | 项目根 = workspace 向上第一个 `.git`；**worktree 折叠回主仓** |
| 档数 | 三档：`USER` / `MEMORY`（全局）/ `PROJECT` |
| 预算 | `USER 1375` / `MEMORY 1100` / `PROJECT 2200`，合计 4675（原 3575，+31%） |
| 无 `.git` 时 | **没有项目档**，`target` 枚举里不出现 `project` |
| 存量迁移 | **不迁移**，靠写入时自然收敛 + 设置页手搬按钮 |

### 决策理由（会被什么前提推翻）

- **三档而非两档**：全局档保留，因为「本机环境」这类记忆真实存在且跨项目为真（`gh CLI 已登录 real-stanyan`、`跑 npm 要先 export PATH`）。两档方案下它们只能挤进 1375 字符的 USER，语义被迫变成「关于用户和他的机器」。hermes 的 profile clone 把 `MEMORY.md` 当身份的一部分，是同一判断的独立佐证。
  推翻前提：如果实践中全局档长期只有两三条，说明这一档不值一个独立预算。
- **全局档 2200 → 1100**：三档后它的职责变窄（项目约定全搬走），不该还占原额。
- **上限不做成可配置**（hermes 是可配的，`config.yaml` 的 `memory.*`）：紧上限不是为了省 token（三档合计才 ~1200 token），是为了逼出策展。做成可配置，第一次超限时人会去调大数字而不是合并条目——那正是这套设计要防的行为。加容易，收回难。
- **不迁移**：迁移代码跑一次就废，最容易带 bug 又最难测，还得永远躺在仓库里。且上限只在写入时校验，存量超限文件照样完整注入，第一次写入时模型被自然逼着整理。

## 一、磁盘布局

```
~/.mr-otto/memories/
  USER.md                          1375   关于用户
  MEMORY.md                        1100   跨项目通用（本机环境、工具怪癖）
  projects/
    <sha256(projectRoot)[:16]>/
      root.txt                            项目根绝对路径
      MEMORY.md                  2200   该项目专属
```

哈希目录名沿用 `workspaceStoreName()`（`src/world/checkpoints.ts`，checkpoints 影子库已用同一招）：路径里的斜杠/空格/中文不适合直接当目录名。

`root.txt` 让目录**自描述**——设置页要显示「这份记忆属于哪个项目」。不引入中心索引文件：索引是派生物，会和磁盘现实脱节；目录自带就不会。删一个项目的记忆 = 删一个目录，不留孤儿。

## 二、作用域解析

新模块 `src/main/projectRoot.ts`，fs 以接口注入（同 `projectInstructions.ts` 的形状，测试喂假实现）：

```ts
resolveProjectRoot(workspace: string, reader: InstructionFsReader): string | null
```

从 workspace 向上爬找 `.git`，最多 12 层（沿用 `MAX_ASCEND`）：

| `.git` 是什么 | 处理 |
|---|---|
| 目录 | 这一层就是项目根 |
| 文件，`gitdir:` 含 `/worktrees/` | **worktree** → 剥掉 `/worktrees/<名>` 得主仓 `.git`，其父目录 = 项目根 |
| 文件，`gitdir:` 含 `/modules/` | **submodule** → 不折叠，就地当独立项目（子模块是独立仓库，约定不属于父仓） |
| 爬到顶没找到 | `null` = 无项目档 |

`gitdir:` 可能是相对路径，按 `.git` 文件所在目录解析。

不起 `git` 子进程——纯读文件。主进程模块本来就允许碰 fs，且比 spawn 快、无超时面。

**为什么 worktree 必须折叠**：`.claude/worktrees/<名>/.git` 是个文件（内容 `gitdir: <主仓>/.git/worktrees/<名>`），`existsSync` 对它为真，爬升会在 worktree 这一层停下。而 worktree 是一次性的（合并后 `gearbox prune` 删掉），不折叠的话项目记忆会跟着每次换班出生、死亡，**永远学不到东西**——比现状更差。

（`projectInstructions.ts` 今天也有这个行为，但对它无害甚至正确：worktree 里的 AGENTS.md 本就该按 worktree 那份读。对记忆则是错的。）

## 三、事件与投影

`memory_loaded` **加两个可选字段**，不加新事件类型：

```ts
export interface MemoryLoadedEvent extends SessionEventBase {
  type: "memory_loaded";
  memory: string;
  user: string;
  project?: string;      // 项目档内容
  projectRoot?: string;  // 归属（UI 显示 + 审计）
}
```

必须是可选字段，理由双向：

- **旧日志 → 新版本**：没有这两个字段 ⇒ `renderMemoryBlocks` 少渲一块 ⇒ 投影与今天**逐字节一致**（硬规则：旧日志必须永远可重放）。
- **新日志 → 旧版本**：`assertReplayable`（issue #383 的向前兼容拒读）拒绝**未知事件类型**，但认得已知类型上的多余字段。新加 `project_memory_loaded` 类型会让旧版本直接拒读整个会话。

投影侧：`renderMemoryBlocks(memory, user, project?)` 渲三块。`renderMemoryPrompt` 里那段照实讲机制的话必须改——现在写着「会话开始时整份快照注入，没有按相关性检索」，要补「项目档按当前工作区的 git 仓库挑，换项目换一份」。这段的存在意义就是被问到时不脑补，留旧描述等于让它说谎。

## 四、工具契约

`MemoryTarget` 加 `"project"`。`MEMORY_FILES: Record<MemoryTarget, string>` 这个常量映射撑不住了（项目档路径依赖运行时 projectRoot），改成函数：

```ts
memoryFilePath(target: MemoryTarget, projectRoot?: string | null): string
```

`createMemoryTool()` → `createMemoryTool(projectRoot: string | null)`。`projectRoot === null` 时 `target` 枚举里不出现 `project`，工具描述里那句判据也不出现——模型看不见的档就不会误写，比给它一个必然报错的选项干净。

判据写进工具描述，一句话：

> `project` = 只在当前项目为真的事；`memory` = 换个项目也成立的事（本机环境、工具怪癖）；`user` = 关于用户本人。拿不准就写 `memory`。

「拿不准写 `memory`」是故意的：错放全局只是噪音，错放项目档是**丢失**（换项目再也看不见）。

## 五、并发与装配

`withMemoryFileLock` 现在按 `MemoryTarget` 加锁。key 换成**文件相对路径**——否则两个不同项目的会话并发写各自的项目档会被同一把 `"project"` 锁串起来。锁语义不变，只换 key。

`readMemoryFiles()`（`src/main/index.ts`）签名带上 workspace：

```ts
readMemoryFiles(workspace: string): { memory: string; user: string; project?: string; projectRoot?: string }
```

保持同步读——`createAgent` 是同步的，快照必须在调它之前就在手上。这个约束不变。

## 六、UI

`MemorySettings.tsx` 两区变三区。项目档那一区要能**切换查看哪个项目**（枚举 `projects/*/root.txt`），否则你只能看当前会话那份，历史项目的记忆变成看不见的黑洞。配一个「删掉这个项目的记忆」（目录级删除）。

**加一个「移到项目档」按钮**——这是「不写迁移代码」这个决策的配套，手搬存量条目靠它。

`memory-chips` 的「忘掉」与 `forgetMemory` IPC 要带上 projectRoot；`isMemoryTarget` 那道 IPC 守卫（issue #186）跟着扩。

## 七、子会话与 nudge

`memory-reviewer`（`src/main/builtinSubagents.ts`）现在只看 MEMORY/USER。要把项目档一起喂给它，并在它的指令里写明三档判据——否则 nudge 派出去的整理会把项目级条目往全局档塞，正好反着来。

子会话本身不挂 memory 工具（`shouldNudge` 对 `spawnedBy` 直接 false），这条不变。

## 八、测试与门禁

测试放 `tests/`，镜像 `src/`：

- `tests/main/projectRoot.test.ts` — 重点是 worktree 折叠：`.git` 是目录 / worktree 文件 / submodule 文件 / 相对 gitdir / 爬到顶找不到。喂假 reader，不碰真磁盘
- `tests/shared/memoryStore.test.ts` — 扩三档 `applyOps`、`memoryFilePath`、锁 key 换路径后的并发
- `tests/session/deriveMessages.test.ts` — **旧日志（无 `project` 字段）投影逐字节不变**，硬规则的可执行版
- `tests/main/memoryEdit.test.ts` — 项目档的 `memory_user_edit` 落证

门禁 `npm test`（tsc --noEmit + vitest run）。GUI 改动的 PR 按 ADR-0058 贴 `npm run e2e` 结果。

## 九、不做

- **检索层**（hermes 的 provider/`prefetch(query)`）：每轮注入打穿 ADR-0060 的前缀缓存，另开一件事
- **上限可配置**：见决策理由
- **跨项目记忆共享 / 软链**：等真出现「一个域横跨多个 repo」的实际需求
- **自动迁移**：见决策理由
- **按 profile/人格分档**（hermes 的第 2 层）：Otto 的 bot 身份模型还没到那一步

## 落地顺序

1. `projectRoot.ts` + 测试
2. `memoryStore` 三档（类型、路径函数、预算、锁 key）
3. 事件与投影 + 向后兼容测试
4. 工具契约（动态枚举、判据文案）
5. 装配（`readMemoryFiles`、`createMemoryTool` 传参）
6. UI（三区、项目切换、移动按钮、IPC 守卫）
7. `memory-reviewer` 指令

每步单独 commit。前 5 步做完就已可用（只是还没法在设置页手编项目档）。

按 AGENTS.md：一个新 ADR（编号 merge 时认领，当前最大 0108）+ Task issue + 分支 PR。
