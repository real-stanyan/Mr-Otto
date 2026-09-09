# ADR-0281：团队记忆换成 LLM wiki——文件是事实、工具强制结构、journal 单向备份

- 原为 ADR-0267，合并前改过 0279，再撞号改到 0281（每次都是与 main 上已落地的 ADR 撞号，按 ADR-0074 改号；0279 现属 #998「弹窗溢出兜底」）
- 状态：已采纳
- 日期：2026-09-09
- 关联：issue #1140；spec `docs/superpowers/specs/2026-09-09-team-llm-wiki-design.md`；计划 `docs/superpowers/plans/2026-09-09-team-llm-wiki.md`；
  **推翻 ADR-0222**（两档 workspace_memories）；沿用 ADR-0222 决策 2（缺席或变了才落、投影最新一条胜出）/ 决策 4（结构由写入路径保证）/
  ADR-0060（文件是投影、事件是事实）/ ADR-0232（容器锁）/ ADR-0251/0253（files 帧与 rg）/ ADR-0256（客户端不给 insert 的理由）；
  Karpathy *llm-wiki*（https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f）

## 背景

ADR-0222 落地四天的形状（spec §0 那张表）：紧上限逼出的是驱逐不是策展、`§` 条目记不下结构、矛盾看不出修不掉、没有历史、手改无审计。
用户的方向是 Karpathy 的 LLM wiki：LLM 维护一组互链 markdown 页面，ingest / query / lint 三种操作，知识累积而不是每次从碎片重新发现。

## 决策

1. **wiki 替换两档，不叠加**（设计对话 stanyan 选定）。SHARED → `team.md`（常驻），OWN → `agents/<agentId>.md`（全员可读、只注入给它自己、只有它自己或人能写）。模型只学一套「写哪一页」。
2. **落点是 `/work/wiki/` 的 markdown 文件**，不是 Supabase 表：人在「文件」页直接看、能 git、能 rg；`index.md` 由工具从页头**生成**（手写的索引会漂，memoryStore.ts 那条理由），`log.md` 追加。
3. **agent 自己维护，工具强制结构**：`wiki_read`（parallelSafe）+ `wiki`（write / remove / check），不过审批门；页头盖章、`scanThreat`、所有权、预算都在写入路径上，不靠模型自觉（ADR-0222 决策 4 的纪律）。**`Tool.parallelSafe` 是整把刀的属性，不是按 action 的**——spec §2.1 原案是一把工具五个 action（read/search/write/remove/check），只读的 read/search 要挂上这条属性就必须拆成独立的第二把刀 `wiki_read`（`parallelSafe: true`），写的三个 action 留在 `wiki`；这是对 spec §2.1 的一处偏离，理由已经在 plan 的 Global Constraints 里立过。
4. **注入是新事件 `workspace_wiki_loaded`**：索引 + 常驻页 + 自己那页 + （只给管理员的）nudge；缺席或变了才落、投影最新一条胜出（ADR-0222 决策 2 逐字）。事件里的正文是已经过 `scanThreat` 的版本——事件里的内容就是注入的内容。
5. **两个预算**：常驻页合计 2200（= 今天 SHARED）、自己那页 1100（= 今天 OWN）——最重要的事实仍然零检索失败；其余页无上限。「超限且没变小才拒」沿用 ADR-0116。**正文字数只有一把尺子** `bodyCharCount`（剥掉序列化补的尾换行），写入闸 / 常驻预算 / 体检三处共用——复审抓到 `beforeChars`（已落盘文本反读）比 `chars`（调用方原始 body）多算 1（序列化恒给 body 补一个收尾换行），同一页原样重写会被这 1 字之差误判成「变小」而放行，让「超限且没变小才拒」退化成「没变大才拒」。
6. **journal 追加表单向备份**（0034）：文件是事实，journal 是备份 + 历史；恢复只发生在 `wiki/` 不存在时。客户端只读不写（同 ADR-0256）。
7. **容器停着 = 卷没变**：快照缓存按这条规则用——只聊天的 turn 不把停着的容器叫起来；任何碰过容器的 turn 收口时作废缓存。**Git 三把刀**（`execInWorkspace` / `execInSidecar` / `clone`）**在 sessionService 里先过 `gateContainer()`**——判据与 bash 一致，"碰过容器"由构造保证（`heldRelease` 非 null），不靠第二个标志位；漏了这一步的后果是静默的：一只 agent 跑 `clone_repo` 这一轮收口时缓存不会作废，容器空闲超时后的下一轮会拿着 clone 之前的 index/pinned/own 服务而不报错、不提示。代价是长 clone 排在工作区锁后面（同工作区别的会话要等它跑完才能碰容器）。
8. **人改走 `wiki_write` 帧（协议 18）**，服务端与工具同一条写入路径；不直连 Supabase。
9. **迁移一次**：`wiki/` 不存在且 journal 为空时把 `workspace_memories` 两档迁成页（保留 `[名字]` 前缀）；表不删、行不动。

## 否决的备选

| 备选 | 为什么否 |
|---|---|
| wiki 叠在两档之上 | 三个落点、判据最难写清（设计对话） |
| Supabase 表一页一行 | 搜索 / 读写都要专门工具、没有 grep、不是文件就不能 git（设计对话） |
| 表是事实源、卷里物化一份（双向同步） | ADR-0207 那套复杂度；单向备份够用（设计对话 / spec §6） |
| 旁路图书管理员每 turn 做 ingest | 每 turn 多一次模型调用算 owner 额度、署名是非参与者、多一套队列；留作升级路（spec §14） |
| 纯提示词 + 现有文件工具 | ask 模式团队每次写都要人批、index 靠模型手维护会漂、没有 scanThreat（spec §0.1） |
| 一把工具五个 action | `Tool.parallelSafe` 是整把刀的属性，只读的两个 action 拆成第二把刀 |

## 顺手修的

- `DockerWorld.exec()` 原来不转发 `ExecOptions.stdin`（`LocalWorld` 转、`DockerWorld.fs.write` 自己也 `attachStdin`）——`wikiFs.appendLog` 走 `cat >> "$f"` 期待从 stdin 读日志行，接上 DockerWorld 之后读到的是立即 EOF、静默写 0 字节（exit code 仍是 0，不报错）。已改成 `execOpts?.stdin !== undefined` 时把 `attachStdin: true` 一并递给 `runExec`，`tests/world/dockerWorld.test.ts` 钉住。
- 索引：`- [[路径]] 标题 — 摘要` 用「 — 」（em dash）分隔标题与摘要，标题本身若含「 — 」会让 `renderIndex`/`parseIndex` 的往返出现歧义——手改页面的标题不保证用的是哪种破折号。修法是在 `indexGroups` 生成索引条目前，把标题里的「 — 」折成「 – 」（en dash）；结构承诺不能只对走过写入闸校验的标题成立，宽读进来的（迁移、bash 改的、旧数据）都要过这一刀。

## 代价与天花板

- **索引 4000 字截断**：几十页之后索引会被截，模型只能靠 `search` 找长尾——那是检索层的活，见「推翻它的前提」。
- **`pinned` 谁都能点**：一只 agent 把自己关心的页 pin 满 2200 字，别人就 pin 不了。没有审批，预算是唯一的闸。
- **bash 绕开写入闸**：`scanThreat` 与所有权在工具路径上；bash 改的页要到 `check` 或注入那一刻才被抓。
- **journal 是备份不是事实**：写失败只 warn；两次 `check` 之间的写入若恰好 journal 失败又丢卷，那一页就丢。
- **`heads` 全拉**：行数 = 写入次数；量级上来要换成 `distinct on` RPC。
- **只聊天的 turn 在 daemon 进程首次仍会 `ensure()` 容器一次**（缓存空）：daemon 每个工作区第一次被碰到时，即使这一轮只是聊天，也会叫起一次容器去探快照；之后靠决策 7「容器停着 = 卷没变」的缓存规则不再重复。
- **SCHEMA.md 与提示词里那段浓缩是两份**：改 SCHEMA 不改浓缩；浓缩里只放机制句，不放会变的约定。
- **页面历史不画**：journal 有，界面没有。
- **桌面 tab 依赖 runtime 活着**：VPS 挂了 tab 说「读不到」（与文件页同命）；journal 有内容但 tab 不从它读
  ——读一处不读两处，同一份内容两个来源迟早给两个答案。
- **手机端不接**。
- **`workspace_memories` 表暂留**，删表 migration 没有触发日。
- **每次 `write` 5 次容器往返**（≈ 250 ms）。
- **`snapshot()` 不持锁**——`isRunning()` 期间并发写入作废缓存后，这次读到的旧值仍可能被 `snapshotCache.set` 记回去，直到下一次写入或容器在跑时的现读；只在容器 idle 后可观察，接受。
- **真机一次都没跑过**：与 ADR-0222 同一条——前置是 0034 + 部署 + 发版。**migration 0034 已于 2026-09-09 在生产 Supabase 上执行**（controller 手动跑的）：跑的是 `workspace_wiki_journal` 这张表的定义，表名才是认的凭据，文件从 0033 改到 0034 是合并前的撞号改号（决策 6），不影响已经跑过的那一次。**runtime 也已于同日从本分支先行部署**（协议 17 上线）——这一步只上了服务端，此刻已装的桌面协议号仍是旧的，连不上云会话；要等桌面下一次 `npm run release` 才补齐。两者都是已知、有意的窗口期，不是事故；spec §11 的真机验收清单仍然一条都没有真正跑过。

## 推翻它的前提

- **若真机上出现「记了但没读到」成规模**（对策 1 不够）：先把索引每行的 summary 加长、或把「最近改过的
  页」也注入；再不够就是方案 B（旁路图书管理员按 turn 摘要注入相关页）。
- **若一个团队的 wiki 超过几百页**：索引截断成为瓶颈，该上检索层（qmd / 向量），不是调 4000 这个数。
- **若 runtime 变成多实例**：进程内锁不够，要用 journal 的 `seq` 做 CAS（同 ADR-0222 决策 5 的推翻前提）。
- **若人手改的量大**：表单不够，要真编辑器 + 页面历史视图（journal 已经存着）。
- **若 agent 需要真正私有的笔记**（别的 agent 不许读）：文件在共用卷上做不到，那一页要搬回 DB。
- **若「谁 pin 了什么」成为争端**：pin 要过审批或只许管理员，预算改按人分。
- **若长草得快**：nudge 不够，方案 B 的旁路 lint 定时跑。
