# 团队 agent 的记忆换成 LLM wiki —— 设计稿

日期：2026-09-09 ｜ issue：#1140 ｜ 状态：设计已定，待实现
ADR：0279（ADR-0074 claim-at-merge：写稿时下一个空号是 0267，合并前与 main 上先落的 ADR 撞号，改到 0279）；推翻 ADR-0222

## 0. 背景

ADR-0222 给团队里的每只 agent 装了记忆：`workspace_memories` 一档一行，SHARED 2200 字 +
OWN 1100 字，`§` 分隔的条目，每 turn 整份注入。它把「云 runtime 零记忆」修成了「有一块小黑板」，
四天真机下来的形状是：

| 症状 | 根源 |
|---|---|
| 新东西挤掉旧东西 | 紧上限的本意是逼策展，实际效果是驱逐——模型宁可 `remove` 一条旧的也不合并 |
| 记不下结构 | 一个客户的联系人、约定、历史决定要拆成三四条互不相干的 `§` 条目 |
| 矛盾看不出、修不掉 | ADR-0222 明写「共享档分叉那一半没修完」，只做到了写入者前缀 |
| 没有历史 | 任何成员一次误清没有回退（ADR-0222 代价段） |
| 手改无审计 | 桌面改的只留 `updated_at`，连谁改的都不记 |

用户的方向是 Karpathy 的 **LLM wiki** 模式（[gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)）：
LLM 维护一个持久、互链的 markdown 页面集合，坐在人和原始材料之间；新材料进来不是被索引等待检索，
而是被**读进去、整合进既有页面**——更新实体页、修订综合页、标出与旧结论矛盾的地方。三种操作：
ingest（新材料 → 改 10 来页）、query（读页作答，好答案回填成页）、lint（定期体检：矛盾、过期、
孤儿页、缺链）。与 RAG 的差别一句话：RAG 每次从碎片重新发现，wiki 里知识累积。

本仓的地基恰好齐了：每团队一容器一卷的 `/work`（ADR-0199/0232）、容器里的
`read_file`/`write_file`/`bash`、镜像里的 ripgrep 13（ADR-0253 真机验过）、桌面「文件」页能浏览
搜索 `/work`（ADR-0251/0253）、Git 三把刀（#1105）。要新写的是**结构**，不是基础设施。

### 0.1 设计对话里定下的四件事（stanyan 选定）

1. **wiki 替换两档**，不叠加、不并存。每只 agent 的「手感」变成 wiki 里 `agents/<agentId>.md` 一页
   ——全员可读，但只注入给它自己。模型只学一套「写哪一页」的规则。
2. **落点是 `/work/wiki/` 里的 markdown 文件**，不是 Supabase 表：就是 Karpathy 那个形状，人在
   「文件」页直接看、能 git、能 rg。
3. **agent 自己维护，工具强制结构**（方案 A）：新 `wiki` 工具负责机械不变量（页头盖章、index 从
   页头**生成**、log 追加、写入过 `scanThreat`），ingest 是 agent 在自己 turn 里顺手做，零额外模型
   调用。旁路图书管理员（方案 B）写进「推翻它的前提」。
4. 六条风险各配对策（§9），其中两条被明确接受为本期范围：journal 表（持久性）与桌面手改帧
   （人能改）。

## 1. 整体形状

### 1.1 目录

容器里 `/work/wiki/`（`WIKI_DIR = "wiki"`，相对 `WORKDIR`）：

```
SCHEMA.md            约定：页面类型、命名、页头、什么时候记、怎么查、整理步骤。初始化时生成；人和 agent 都可改
index.md             索引。工具从各页页头生成，禁止手写——手写的索引会漂（memoryStore.ts 头注的同一条理由）
log.md               追加式操作日志：## [时间] write|remove|edit|migrate|restore|seed|check | 路径 | 谁 | 一句话
team.md              pinned，团队口径。从 SHARED 迁入；不可删
agents/<agentId>.md  每只 agent 一页，从 OWN 迁入。只注入给它自己；只有它自己（或人）能写
<目录>/<slug>.md     其余页：实体（客户/产品/供应商/人）、概念（口径/定义）、来源摘要、综合。目录一级、自由命名
```

- 路径判据 `isWikiPagePath`：`^(?:[a-z0-9][a-z0-9-]{0,63}/)?[a-z0-9][a-z0-9-]{0,63}\.md$`——一层目录、
  小写 kebab（同 ADR-0204 的桶名纪律）；标题可中文，住页头。`..`、绝对路径、第二层目录一律拒。
- 保留：`index.md` / `log.md` 工具专有（`write`/`remove` 都拒）；`SCHEMA.md` / `team.md` 可写不可删；
  `agents/<id>.md` 只有 `agentId === id` 的那只（或桌面上的人）能写。
- **没有 `raw/`**：团队的不可变来源已经存在——会话事件日志（append-only）和 `/work` 里的文件。页头
  `sources` 写「会话 id#seq」或 `/work` 路径，不复制原文。
- `/work/wiki/.tmp/` 是原子写入的中转目录（§2.4），索引与 `check` 都忽略它。
- `clone_repo` 的 dest 不许落在 `wiki/` 下（gitTools 那一层多一条校验；`normalizeWorkPath` 之后判
  `dest === "wiki" || dest.startsWith("wiki/")`）——否则一个仓库被 clone 进 wiki 目录，索引器会对着
  `.git` 发呆。

### 1.2 页头（frontmatter）

```
---
title: 销量口径
summary: 一句话，索引里就这一行
pinned: false
updated_by: 运营
updated_at: 2026-09-09T06:12:03Z
sources: [s-9f2a#118, /work/docs/2026-Q3.xlsx]
---
正文（markdown，[[customers/acme]] 这样互链，Obsidian 兼容；[[路径|别名]] 也认）
```

- 模型给 `title`（≤ 80 字、不含换行）、`summary`（≤ 140 字、单行）、`pinned`（可选）、`sources`（可选，
  字符串数组）、正文。**`updated_by` / `updated_at` 由工具盖章，不信模型**（同 ADR-0222 决策 4「由写入路径拼」）。
- 解析器是本仓自己的严格子集（`key: value` 一行一对，`sources` 是 YAML flow list），不引 YAML 库
  （引依赖 = Tech stack 改动）。**读宽写严**：读的时候缺 `title` 退回 slug、缺 `summary` 记空串并
  由 `check` 标出、未知键忽略；写的时候页头整个由工具构造，不可能有未知键。
- 页头里的 `title` / `updated_by` 进提示词时过 `promptSafe`（ADR-0226 的结构闸：它们会拼进
  `- [[路径]] 标题 — 摘要` 与块头这类结构）。

### 1.3 索引（生成物）

```
# 索引
<!-- 由 wiki 工具生成，别手改；改页头的 title / summary 索引就会跟着变 -->

## 常驻
- [[team]] 团队口径 — 所有智能体都该知道的口径与分工

## agents
- [[agents/admin]] 管理员 — 管理员的工作习惯

## customers
- [[customers/acme]] Acme — 华东最大客户，月结 60 天
```

组的顺序：常驻 → agents → 其余目录按字母 → 无目录的页归「未分目录」；组内按路径排。
`SCHEMA.md`、`index.md`、`log.md`、`.tmp/` 不进索引。同一份纯函数 `renderIndex(pages)` 三处用：
工具写完页重生成、`check` 重生成、桌面 tab 解析（`parseIndex` 是它的逆）。

### 1.4 日志（追加）

一行一条：`## [2026-09-09 14:02] write | customers/acme | 运营 | 补月结条款`。
`kind ∈ write | remove | edit(桌面) | migrate | restore | seed | check`。`check` 那行带机械体检的
计数摘要。**超过 100 KB 就滚动**：`mv log.md log-<YYYYMMDD-HHMMSS>.md` 后新开（滚出去的不进索引、
不参与 nudge）。追加走 `world.exec("cat >> wiki/log.md", { stdin })`——`ExecOptions.stdin` 已有。

## 2. `wiki` 工具

落点 `services/runtime/src/wikiTool.ts`（同 `workspaceMemoryTool.ts` 的位置与纪律）。纯逻辑全部在
`src/shared/wiki.ts`（三端共用：runtime 工具 / 桌面 tab / 将来手机端）。工具**只依赖 ExecutionWorld
与注入的接口**，不 import fs / supabase / docker（硬规则）。

### 2.1 五个 action

| action | 参数 | 做什么 | 备注 |
|---|---|---|---|
| `read` | `paths: string[]` | 回每页全文（页头 + 正文），单页超过 12 000 字截断并说明 | `parallelSafe: true` |
| `search` | `query: string` | 容器里 `rg --json -n -i --max-count 3 -- <query> /work/wiki`，回「路径 + 行号 + 片段」 | `parallelSafe: true`；解析复用 `src/shared/files.ts` 的 `parseRgJson` / `classifyRgError`（ADR-0253），rc 单独带回 |
| `write` | `path, title, summary, content, pinned?, sources?` | 整页替换（新建或覆盖）。校验 → `scanThreat` → 盖章 → 原子落盘 → 重生成 index → 追加 log → journal | 成功回「已写 <路径>（N 字）」，**不回显正文**（ADR-0222 决策 7 沿用 memory 工具的理由：回显诱导模型再改一轮） |
| `remove` | `path` | 删页 → 重生成 index → 追加 log → journal(content=null) | 保留页拒绝 |
| `check` | — | 机械体检（§7.1），顺手重生成 index、补记漂移的 journal，追加 `check` 行 | 回一份报告 |

`requiresApproval: false`——它是记忆写入，不是沙箱里的任意写（同 `memory` 工具）。围栏：所有路径先过
`isWikiPagePath`，再拼 `wiki/` 前缀交给 `world.fs` / `world.exec`；DockerWorld 的 `fenceInContainer`
是第二道（礼貌报错，真边界是容器）。

### 2.2 两个预算，写入时校验

- **常驻预算 `WIKI_PINNED_BUDGET = 2200`**：所有 `pinned: true` 页的正文字符数之和（`charCount`，
  与 memoryStore 同一把尺子）。写入会让总和超预算 → 拒绝，报错里列出当前常驻页与各自字数
  （「先取消别的 pin 或精简」）。这个数 = 今天 SHARED 的上限，**最重要的事实仍然零检索失败**（§9 风险 1）。
- **自己那页 `WIKI_OWN_BUDGET = 1100`**：`agents/<自己>.md` 正文上限 = 今天 OWN 的上限。
- 其余页**无上限**——这正是换成 wiki 的理由。单页过大只影响 `read` 的截断。

预算沿用 ADR-0116「超限**且没变小**才拒」：一页已经超预算时，让它变小的写入照样放行。

### 2.3 写入路径的不变量（由工具保证，不靠模型）

1. `scanThreat` 跑在正文 + `title` + `summary` 上（`src/shared/threatPatterns.ts`），命中拒写。
2. `updated_by` = 这只 agent **此刻**的名字（`agentName: () => string` 现取，同 ADR-0222 决策 4），
   `updated_at` = 工具时钟（注入的 `now`）。
3. `agents/<id>.md` 的所有权：`agentId !== id` 的写入拒绝——别人的手感别人写不了，与「只注入给它自己」
   一致。桌面上的人不受此限（§8）。
4. `pinned` 谁都能点，预算是唯一的闸（§13 代价）。`team.md` **恒为常驻**——对它 `pinned: false` 无效，
   否则「团队级口径写 team（常驻）」这句提示词会在某一次写入之后悄悄变成假话。
5. 名字进页头前过 `promptSafe`（折叠空白 + 替身转义）。

### 2.4 原子性与互斥

- 页面落盘：`world.fs.write("wiki/.tmp/<rand>.md")` → `world.exec("mv -f -- .tmp/<rand>.md <path>")`。
  索引同样先写 `.tmp` 再 `mv`。读者永远看不到半截文件。
- 重生成 index 要读全部页头：一条脚本 `find /work/wiki -name '*.md' … | xargs … sed -n '/^---$/,/^---$/p'`
  按 NUL 分记录、TAB 分字段打印（**`String.raw`**，同 `workFiles.ts` 那条教训：模板串里的 `\0` 是
  一个真 NUL 字节，execve 到那儿就截断，且单测不看脚本字节全绿；`tests/runtime/wikiScripts.test.ts`
  钉住「脚本里除换行外不许有裸控制字符」）。
- 每次 `write` 是 5 次容器往返（写 tmp / mv+扫页头 / 写 index tmp / mv index+追加 log / journal 不进容器），
  约 250 ms。
- **互斥两层**：进程内 `withMemoryFileLock(wikiLockKey(workspaceId))`（daemon 级，`Map` 是模块级的，
  所以工具路径与 §8 的桌面帧路径**同一把锁**）；工具走的是过容器锁那份 `world`（ADR-0232 已经把
  同团队各会话碰容器的 turn 串行化）。桌面帧不在任何 turn 里，只拿进程内锁——它改的是 wiki 目录，
  不是容器的工作状态，与一只正在跑 bash 的 agent 并行没有冲突面。
- 多 daemon 不在前提里（同 ADR-0222 决策 5），写进「推翻它的前提」。

### 2.5 错误处理

- 记忆副作用**永不阻塞回复**：`check`/`write` 抛错回给模型的是人话；连续失败 3 次回终态（同 memory 工具）。
- journal 写失败只 `console.warn`，不让 `write` 失败——文件已经落了盘，那才是事实；`check` 负责补记（§6）。
- `search` 时 rg 不在（rc 127）走 `classifyRgError` 说「搜索工具不在」，不说「没有匹配」（ADR-0253）。

## 3. 注入：`workspace_wiki_loaded`

### 3.1 事件

```ts
interface WorkspaceWikiLoadedEvent extends SessionEventBase {
  type: "workspace_wiki_loaded";
  agentId: string;
  agentName: string;
  index: string;                                  // index.md 原文（未截断；截断在投影）
  pinned: { path: string; title: string; body: string }[];
  own: string | null;                             // agents/<agentId>.md 的正文；没有这页 = null
  nudge: string | null;                           // §7.2；只有管理员那只非 null
}
```

落的时机与判据**逐字沿用 ADR-0222 决策 2**：`runJob` 里 `briefIfNeeded` 之后、`engineFor` 之前；
**缺席或内容变了才落**（与本会话该 agent 最近一条逐字段比对），**投影最新一条胜出**（`deriveMessages`
记下 `renderWorkspaceWikiPrompt(event)` 覆盖上一条，主循环跑完拼到 system 尾部；**不许 `+=`**）。
wiki 是多写者可变状态，一条会话里一只 agent 会有多条快照，理由同 0222。

旧 `workspace_memory_loaded` 留在 schema，投影照旧（旧日志永远可重放），**不再落**。

新事件类型的检查清单（AGENTS.md 索引里那十一处）逐处表态：`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、
`persistencePolicy`（模型可见 = 必须落）、`deriveMessages`（最新一条胜出）、`deriveSections`、
`toThreadMessages.isAuditEvent`（不上时间线）、`deriveUsage`、`contextEstimate.pendingAfter`
（云会话页不读圆环：显式 `case` 只 `break`，同 0222 的表态）、`PRIVACY_VERDICTS: strip`（团队的 wiki
是那个团队的私事）、`OTHER_AGENT_VERDICTS: drop`（别人的快照是它的上下文）、`persistencePolicy.test`
的 `DURABLE` 数组、`Timeline.tsx` 的 `EventRow`；另外 `modelContextScan.boundedContextEvents` 多捞一类
（压缩幸存，全部捞、投影只认最后一条）。

### 3.2 投影（system 尾部）

`renderWorkspaceWikiPrompt(e)`，顺序固定：

1. 一段约定摘要（≈ 400 字，是 SCHEMA.md 的浓缩，静态）：有 wiki、用 `wiki` 工具；记什么 / 不记什么
   （沿用 0222 那句「优先记能减少同事再次纠正你的事；不记任务进度、一周内会过期的东西」）；怎么记
   （一个实体/概念一页，先 `search` 有没有页，有就改那页别另开；`[[路径]]` 互链；`sources` 写来源；团队级
   口径写 `team`，自己的手感写 `agents/<你>`）；怎么查（涉及客户、口径、分工、历史决定先看索引，有对应页就
   `read`）；机制（被问到时照实说：每次轮到你发言前注入索引 + 常驻页 + 你自己那页，其余页要你自己 read；
   成员可在团队设置页看和改）。
2. `[索引]`：index 原文，超过 `WIKI_INDEX_INJECT_LIMIT = 4000` 字时在行边界截断并加一句
   「索引还有 N 行，用 wiki search 或 read index.md 看全部」。
3. `[常驻页]`：每页 `### <title>（<path>）` + 正文。
4. `[你的页 agents/<id>]`：正文；`own === null` 时一句「你还没有自己那页，用 wiki write agents/<id> 建」。
5. `[nudge]`（非 null 时一行）。

注入前对 pinned / own 的正文再跑一次 `scanThreat`——bash 能绕开工具改文件，命中的那页**注入一行警告
不注入正文**，并在 `check` 报告里点名（§9 风险外的那个洞）。

### 3.3 快照怎么读、什么时候不读容器

一条脚本一次 exec 打出：`index.md`、所有页头 `pinned: true` 的页（路径 + 正文）、`agents/<id>.md`、
`log.md` 最后 50 行（给 nudge 算）。NUL/TAB 纪律同 §2.4。解析是 `src/shared/wiki.ts` 的 `parseSnapshotDump`。
用**裸的 `opts.world`**（不过容器锁）——只读，不该为它排队。

**只聊天的 turn 不该把停着的容器叫起来**（ADR-0232「第一次碰容器才拿」的精神）：daemon 内按
workspaceId 缓存上一份快照，规则一条——**容器停着 = 卷没变**（所有写者都在容器里跑：工具、桌面帧、
bash；旁路 clone 容器不碰 `wiki/`，§1.1 那条校验保证）。所以：
- 容器在跑（`sandbox.isRunning(workspaceId)`，`docker inspect` 的 `State.Running`）→ 现读（一次 exec，
  几十毫秒）；
- 容器停着且有缓存 → 用缓存；
- 容器停着且无缓存（daemon 刚起）→ 现读一次（会把容器叫起来，接受）。

缓存在**任何一条碰过容器的 turn 收口时作废**（`heldRelease !== null` 就作废——bash 改没改 wiki 探不出来，
宁可多读一次），桌面帧写完也作废。

## 4. SCHEMA.md（初始化生成，中文）

内容分五段，全文是 `src/shared/wiki.ts` 里的常量 `DEFAULT_SCHEMA`：
① 页面类型与命名（实体页 / 概念页 / 来源摘要 / 综合页；一层目录小写 kebab；标题中文）
② 页头字段与谁盖章
③ 什么时候记、记哪一页（先 search、一个事实住一页、team 与 agents 的分工、常驻预算的含义）
④ 怎么答（先看索引、引用页路径、好答案回填成页）
⑤ 整理步骤（语义 lint，人一句「整理 wiki」让管理员跑）：先 `check` 拿机械报告 → 处理断链与孤儿 →
   逐页看 `stale?` 标记决定更新还是删除 → 找矛盾（同一实体两页说法不同、team 里两条口径打架）→ 合并
   重复页 → 把答过的好问题回填成页 → 再 `check` 一次收口。

人和 agent 都可改（`write SCHEMA.md`，`title` 固定「约定」）；改了只影响读它的人，提示词里那段浓缩不跟着变
（§13 代价：两份会漂，浓缩里只放不会变的机制句）。

## 5. 初始化、迁移、恢复（`ensureWiki`）

每次起 turn 前（快照之前）、以及桌面帧写入之前，跑一次状态探测（一次 exec：`test -d /work/wiki`）：

| 状态 | 动作 | log |
|---|---|---|
| `present` | 什么都不做 | — |
| `absent` 且 journal 有行 | 从 journal 各路径最新版本物化文件 → 生成 index | `restore` |
| `absent` 且 journal 为空、`workspace_memories` 有行 | SHARED 的每条 `§` 条目变 `team.md` 里的一个 bullet（**保留 `[名字]` 前缀**，那是 0222 攒下的署名事实）；每只 agent 的 OWN 变 `agents/<id>.md` 的 bullet 列表；`SCHEMA.md` 生成；journal 记 `migrate` | `migrate` |
| `absent` 且两边都空 | 生成 `SCHEMA.md` + 空的 `team.md`（pinned，正文一句「还没有口径，用 wiki write 写第一条」）+ index + log；journal 记 `seed` | `seed` |

- `workspace_memories` **表不删、行不动**；runtime 只保留读路（`createSupabaseWorkspaceMemory.read`），
  写路与工具删掉。删表的 migration 留到所有团队都迁过之后（没法知道那一天，写进代价段）。
- 迁移只跑一次：`present` 之后永远不再看 `workspace_memories`。
- `ensureWiki` 失败（容器起不来、Supabase 抖）只 warn，本 turn 不落快照（同 0222 决策 5「读失败不阻塞 turn」）。

## 6. journal 表（对策：持久性 + 历史）

migration `supabase/migrations/0034_workspace_wiki_journal.sql`（幂等，手动执行一次，同 0021 起的约定）：

```sql
create table if not exists public.workspace_wiki_journal (
  seq          bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  path         text not null,
  content      text,                         -- null = 该页被删
  kind         text not null,                -- write | remove | edit | migrate | restore | seed | external
  author_kind  text not null,                -- agent | member | system | external
  author_id    text not null default '',     -- agent_id 或 uid；system/external 为空串
  author_label text not null default '',     -- 写入那一刻的名字（快照，改名不回写，同 ADR-0256）
  created_at   timestamptz not null default now()
);
create index if not exists wwj_ws_path_seq on public.workspace_wiki_journal (workspace_id, path, seq desc);
alter table public.workspace_wiki_journal enable row level security;
-- 成员可读；authenticated 没有 insert / update / delete 策略——写方只有 runtime（service key）
create policy wwj_select_member on public.workspace_wiki_journal for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
```

- **单向：文件是事实，journal 是备份 + 历史**。不做双向同步，不做对账（ADR-0207 那套的复杂度是设计对话里
  明确否掉的）。恢复只发生在 `wiki/` 不存在时（§5）。
- 接口 `WikiJournal { append(entry): Promise<void>; heads(workspaceId): Promise<Map<path, {content: string | null; seq: number}>> }`，
  Supabase 实现只在 daemon 装配，测试用内存版。`heads` 第一版是「按 seq 倒序全拉、首见即头」——行数
  = 写入次数，一个团队几千行量级，够用；量级变了见「推翻它的前提」。
- 客户端不给 insert（同 ADR-0256 的理由：给了就是让任何成员替 agent 伪造一次写入）、不给 delete
  （「读过」与「没发生」不许变成同一件事）。桌面的人改走 §8 的帧，仍由 runtime 落 journal。
- 漂移：bash 绕开工具改的页，`check` 比对文件内容与 `heads`，不一致的补一行 `kind = external`。

## 7. lint：机械的归代码，语义的归模型

### 7.1 `check`（机械）

规则表（每条一个可单测的纯函数，输入是「全部页的 {path, frontmatter, body}」+ journal heads + now）：

| 规则 | 判据 | 处置 |
|---|---|---|
| 断链 | `[[x]]` 指向不存在的页 | 报 |
| 孤儿 | 没有任何入链，且不是 team / agents/* / pinned / SCHEMA | 报 |
| 页头缺字段 | 缺 title / summary / updated_at | 报 |
| 常驻超预算 | pinned 正文之和 > 2200 | 报（写入时本来就拦，这里抓 bash 绕开的） |
| 自己那页超预算 | `agents/*.md` > 1100 | 报 |
| 可能过期 | `updated_at` 早于 60 天且不 pinned | 报 `stale?`（不删，只标） |
| 可疑指令 | `scanThreat` 命中 | 报，注入侧同步生效（§3.2） |
| 非 md 内容 | `wiki/` 下有目录/文件不符合 `isWikiPagePath` | 报 |
| journal 漂移 | 文件内容 ≠ heads | **补记** `external` |
| 索引漂移 | index.md ≠ `renderIndex(pages)` | **重生成** |

报告是一段人话（每条规则一节，空的不出），末尾追加 `check` 那行 log（带计数）。

### 7.2 nudge（谁来触发整理）

`nudgeFrom(logTail, now)`（纯函数，log.md 最后 50 行 → 字符串或 null）：自上一条 `check` 起
`write|remove|edit` ≥ 20 条，或距上一条 `check`（没有的话距第一条 `write`）≥ 14 天 → 一句
「wiki 自上次整理以来写入了 N 次 / 已 D 天没整理；有空档时跑 wiki check 并按 SCHEMA.md 的整理步骤处理」。

- **只注入给管理员那只**（`agentId === ADMIN_AGENT_ID`）——它是天然的图书管理员；给每只都注入等于
  让一个正在干活的 agent 分心去整理。
- 桌面设置页顶部画同一句（同一份纯函数，§8）。
- 零额外模型调用；要不要整理是人（或管理员在空档时）的决定。

## 8. 桌面：设置页「记忆」tab + `wiki_write` 帧（协议 16 → 17）

### 8.1 tab

`WorkspaceMemoryTab` 改写成 `WorkspaceWikiTab`（导航项 id 不变、label 仍是「记忆」——用户认这个词；
hint 改成「团队的 wiki：口径、客户、分工」，**只从已在手的 `ws` 推**，同 ADR-0264）。

- 读：走**现成的 `files` / `files_result` 帧**（ADR-0251/0253 那条 `readWork` 路，不建容器）：
  `wiki/index.md` → `parseIndex` → 分组行（title — summary）；`wiki/log.md` → `nudgeFrom` → 顶部一句。
  「读不到」与「一页都没有」分家（同 ADR-0264 决策 8 的三态：`loading` / `undefined` / `[]`）。
- 点一行 → 推入页：`readWork(wiki/<path>)` 读全文，正文按 markdown 渲染（渲染层现成的 Streamdown），
  「编辑」→ 表单（title / summary / pinned 开关 / 正文 textarea）→ `wiki_write`。「新建页」= 同一表单多一格路径。
  「删除」→ `useConfirm()`（ADR-0265）→ `wiki_write{op:"remove"}`。
- 不做：页面历史视图（journal 里有，界面不画，§13）、上传附件、Obsidian 式图谱。

### 8.2 帧

控制房（同 `config` / `archive` / `files`：属于团队，不以「开着一条会话」为前提，ADR-0234）：

```ts
// CsUp
| { t: "wiki_write"; workspaceId: string; op: "write"; path: string; title: string; summary: string; pinned: boolean; body: string }
| { t: "wiki_write"; workspaceId: string; op: "remove"; path: string }
// CsDown
| { t: "wiki_write_result"; workspaceId: string; path: string; ok: boolean; message?: string }
```

- 在籍成员即可（判据同 `files`：`hostUids()` 复核）；会话房里收到一律 `denied not_authorized`（同 `config`）。
- 服务端走**与工具同一条写入路径**（同一个 `wikiService.write`）：校验、`scanThreat`、盖章
  （`updated_by` = 成员的 label，`author_kind = member`，log 的 kind = `edit`）、原子落盘、重生成 index、
  journal。人改的和 agent 改的过同一道门；`agents/<id>.md` 的所有权对人不设限（人替 agent 整理笔记是正当的）。
- 限速：新 `WIKI_BUCKET`（与 `FILES_BUCKET` 同形，判据相同——每帧一次 docker exec）。
- `CS_PROTOCOL_VERSION` 16 → 17（加帧也进位，ADR-0233 的纪律）。runtime 要重新部署（#791），桌面要发版。

### 8.3 `wikiService`

工具与帧共用的本体：`services/runtime/src/wikiService.ts`，`createWikiService({ workspaceId, fs, exec, journal,
memories, now, isRunning })`，方法 `ensure / snapshot / read / search / write / remove / check`。工具和帧各是
一层薄壳。`fs`/`exec` 抽成 `WikiFs` 接口，两个实现：容器版（脚本）与内存版（测试）——脚本的**字节**另有
断言（§11）。

## 9. 风险 → 对策对照

| # | 风险（设计对话里的评价） | 对策 | 落点 |
|---|---|---|---|
| 1 | 召回不再由构造保证：模型得自己决定读哪页，便宜型号最可能跳过 | pinned 页全文每 turn 注入、总预算 2200 = 今天 SHARED；自己那页每 turn 注入、1100 = 今天 OWN；索引每行带 summary；提示词写明「涉及客户/口径/分工先查索引」 | §2.2、§3.2 |
| 2 | 持久性退步：VPS 卷没有备份 | journal 追加表：每次写入后追加一行；卷丢了从 heads 物化回来；顺带白拿版本历史与「误清有回退」 | §6、§5 |
| 3 | 人不能直接手改 | `wiki_write` 帧 + tab 里的编辑表单；服务端同一条写入路径 | §8 |
| 4 | 每 turn 多几次往返 | 对策 1 让常见事实零往返；`read` 收数组；`search` 回路径 + 片段；两把读刀 `parallelSafe` | §2.1 |
| 5 | 长草 | `check` 机械体检 + `SCHEMA.md` 的语义整理步骤 + nudge（≥ 20 次写入或 ≥ 14 天，只给管理员） | §7 |
| 6 | ADR-0222 落地四天就推翻 | 存量两档自动迁入、表暂留、0222 标 superseded 指向新 ADR | §5、§12 |
| — | bash 绕开写入闸改页（注入面） | 注入前再扫一次，命中注入警告行不注入正文；`check` 点名 | §3.2 |
| — | 只聊天的 turn 也要碰容器 | 「容器停着 = 卷没变」的快照缓存 | §3.3 |

## 10. 拆与留

拆：`services/runtime/src/workspaceMemoryTool.ts`、`createWorkspaceMemoryTool` 在工具表里的那一格、
`loadMemoryIfChanged`、`WorkspaceMemoryTab` 的两档编辑与 `workspaceMemoryView.ts`、
`workspaceManager.saveMemory` / `supabaseWorkspacesApi.saveMemoryRow` / `memoryDocs`、
`loadWorkspaceMemories` 那条 IPC。

留：`src/shared/workspaceMemory.ts` 里迁移要用的 `SHARED_MEMORY_AGENT_ID` 与 `parseEntries` 一族；
`services/runtime/src/workspaceMemory.ts` 的 `read`（迁移专用，`write` 删）；`workspace_memory_loaded`
类型与 `renderWorkspaceMemoryPrompt`（重放）；`workspace_memories` 表。

本机四档记忆（USER / MEMORY / PROJECT / TOPIC，ADR-0116/0204/0207/0211）**一字不动**——它们的落点、
判据、同步都是本机的事，云会话从来不接它们（ADR-0222 决策 7 的「永不同台」原样成立）。

## 11. 测试面

### 门禁里跑得到

- `tests/shared/wiki.test.ts`：页头解析/序列化往返、路径判据表、`renderIndex` 分组与排除、`parseIndex`
  是其逆、链接抽取（含别名）、`check` 每条规则一例、投影截断与顺序、`nudgeFrom` 三种边界、迁移映射
  （`§` 条目 → bullet，前缀保留）、`parseSnapshotDump` 按字节（含 NUL/TAB、含被截断的尾记录）、log 行
  格式/解析/滚动阈值。
- `tests/runtime/wikiService.test.ts`（内存 `WikiFs` + 内存 journal）：seed / migrate / restore 三条初始化路；
  预算「超限且没变小才拒」；保留页与所有权；`scanThreat`；index 重生成；log 追加；journal 写失败只 warn；
  `check` 补记 external 与重生成 index；并发写同一团队串行。
- `tests/runtime/wikiScripts.test.ts`：三段脚本的字节里除换行外没有裸控制字符（`String.raw` 保鲜期）。
- `tests/runtime/wikiTool.test.ts`：参数宽容边界（复用 `toOpList` 的教训：形状差一点要说清哪儿差）、
  五个 action 的错误文案、连续失败 3 次终态、`parallelSafe` 只贴在两把读刀上。
- `tests/runtime/sessionService.test.ts` 增：快照事件「缺席或变了才落」、缓存只在容器停着时用且 turn 碰过
  容器就作废、nudge 只给管理员、`ensureWiki` 失败不阻塞 turn。
- `tests/session/*`：`deriveMessages` 最新一条胜出、`agentView` drop、`modelContextScan` 幸存、
  `persistencePolicy` durable、`PRIVACY_VERDICTS` strip、`contextEstimate` 显式 break、`timelineLists` 两份名单一致。
- `tests/runtime/frameHandler.test.ts` 增：`wiki_write` 控制房在籍闸、限速、回执；会话房 denied。
- `tests/renderer/WorkspaceWikiTab.test.tsx`：loading / 读不到 / 空 / 有页三态、编辑表单发帧、删除走 `useConfirm`。
- `tests/runtime/gitTools.test.ts` 增：dest 落在 `wiki/` 下拒绝。

### 门禁里跑不到，必须真机

1. 在生产 Supabase 跑 0034；2. 部署 runtime（#791，协议 17）；3. 桌面构建；然后：
① 旧团队第一次起 turn → `wiki/` 出现，`team.md` 里是原 SHARED 的条目、`agents/<id>.md` 是原 OWN，log 有 `migrate`；
② agent 被问客户约定 → 看见索引后 `read` 对应页；③ agent `write` 新页 → 文件页里看得到、index 更新、
journal 多一行；④ `pinned` 超预算被拒的文案；⑤ 桌面改一页 → agent 下一 turn 快照变了；
⑥ 容器 idle 停掉后只聊天 → 不叫起容器（`docker ps` 看）；⑦ `check` 报告与 nudge 出现；
⑧ 删掉卷（或换 VPS）后第一次起 turn → 从 journal 恢复。

## 12. 切片与交付顺序（一个 PR，四组任务按序）

1. 纯层 `src/shared/wiki.ts` + `wikiService` + `wikiTool` + 事件/投影/十一处表态 + sessionService 接线
   （快照、`ensureWiki`、缓存）。
2. journal 表（0034）+ Supabase 实现 + 迁移路 + 拆云侧 `memory` 工具与桌面直连路。
3. `wiki_write` 帧 + 协议 17 + `WorkspaceWikiTab`。
4. ADR-02xx（推翻 0222）+ CONTEXT.md 三条术语（团队 wiki / `workspace_wiki_loaded` / journal）+
   AGENTS.md 索引换掉 0222 那条 + ADR-0222 头部加「已被推翻」指针。

合并后立刻：跑 0034、部署 runtime、按 §11 真机清单验；桌面等下一次 `npm run release`。

## 13. 已知代价与天花板（接受）

- **索引 4000 字截断**：几十页之后索引会被截，模型只能靠 `search` 找长尾——那是检索层的活，见「推翻它的前提」。
- **`pinned` 谁都能点**：一只 agent 把自己关心的页 pin 满 2200 字，别人就 pin 不了。没有审批，预算是唯一的闸。
- **bash 绕开写入闸**：`scanThreat` 与所有权在工具路径上；bash 改的页要到 `check` 或注入那一刻才被抓。
- **journal 是备份不是事实**：写失败只 warn；两次 `check` 之间的写入若恰好 journal 失败又丢卷，那一页就丢。
- **`heads` 全拉**：行数 = 写入次数；量级上来要换成 `distinct on` RPC。
- **只聊天的 turn 在 daemon 刚起、容器停着时会叫起容器一次**（缓存空）。
- **SCHEMA.md 与提示词里那段浓缩是两份**：改 SCHEMA 不改浓缩；浓缩里只放机制句，不放会变的约定。
- **页面历史不画**：journal 有，界面没有。
- **桌面 tab 依赖 runtime 活着**：VPS 挂了 tab 说「读不到」（与文件页同命）；journal 有内容但 tab 不从它读
  ——读一处不读两处，同一份内容两个来源迟早给两个答案。
- **手机端不接**。
- **`workspace_memories` 表暂留**，删表 migration 没有触发日。
- **每次 `write` 5 次容器往返**（≈ 250 ms）。
- **真机一次都没跑过**：与 ADR-0222 同一条——前置是 0034 + 部署 + 发版。

## 14. 推翻它的前提

- **若真机上出现「记了但没读到」成规模**（对策 1 不够）：先把索引每行的 summary 加长、或把「最近改过的
  页」也注入；再不够就是方案 B（旁路图书管理员按 turn 摘要注入相关页）。
- **若一个团队的 wiki 超过几百页**：索引截断成为瓶颈，该上检索层（qmd / 向量），不是调 4000 这个数。
- **若 runtime 变成多实例**：进程内锁不够，要用 journal 的 `seq` 做 CAS（同 ADR-0222 决策 5 的推翻前提）。
- **若人手改的量大**：表单不够，要真编辑器 + 页面历史视图（journal 已经存着）。
- **若 agent 需要真正私有的笔记**（别的 agent 不许读）：文件在共用卷上做不到，那一页要搬回 DB。
- **若「谁 pin 了什么」成为争端**：pin 要过审批或只许管理员，预算改按人分。
- **若长草得快**：nudge 不够，方案 B 的旁路 lint 定时跑。

## 15. 参考

- Karpathy, *llm-wiki*（gist）：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- ADR-0222（被推翻的两档记忆）、ADR-0060（记忆文件是投影，事件是事实）、ADR-0204（桶名纪律）、
  ADR-0232（容器锁）、ADR-0251/0253（文件页与 rg）、ADR-0256（客户端不给 insert 的理由）、
  ADR-0264（hint 只从 `ws` 推）、ADR-0265（`useConfirm`）
