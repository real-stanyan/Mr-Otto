# 任务会话：记忆按主题分桶、会话按主题分组、Default 按会话分格、记忆跟账号走

日期：2026-09-02 ｜ issue：#846 ｜ 关联：ADR-0116（三档记忆）、ADR-0135（Default 工作区标记）、ADR-0187（账号抽屉）、#559（内置 Default）

## 1. 背景与病根

任务栏里的会话都跑在内置 Default 工作区（`Documents/Mr Otto/Default`）。用户要的是 Claude.ai 那种体验：casual 聊天，记忆自动落进 Hobbies / Work / Project 这类主题桶，换电脑登同一个号记忆还在。

三个病根，各自独立：

1. **任务会话没有领域记忆**。Default 不是 git 仓，`resolveProjectRoot` 回 `null`，任务会话只有 USER + MEMORY 两档。MEMORY 的定义是「本机环境」（#589 收紧过），USER 是「关于用户本人」——「用户在改一台 WRX」「用户在做 X 公司的 Y 项目」这类领域事实没有档位可住，要么挤进 USER 互相驱逐，要么不记。
2. **Default 平铺**。所有任务共写一个目录：同名文件互相覆盖、coworkLog 一本账全混、Files 面板越来越长。第十个任务就乱，不是「到后面」。
3. **记忆在本机**。`~/.mr-otto/accounts/<sha256(uid) 前16位>/memories/` 按账号分抽屉，但零云同步。换电脑登同一个号，记忆是空的。

Claude.ai 的「文件夹」不是磁盘目录，是**记忆按主题分桶** + **会话按主题分组**两件事叠在一起的观感。本设计把它拆开做。

## 2. 主题桶的数据模型（第一段）

### 落点与格式

- `memories/topics/<slug>.md`，一桶一文件，相对 `accountConfig`（ADR-0187 的账号抽屉）。
- 条目格式沿用 `§` 分隔：`parseEntries` / `formatEntries` / `applyOps` / `withMemoryFileLock`（按路径）原样复用。

### slug

- ASCII kebab：`^[a-z][a-z0-9-]{0,23}$`。
- 种子四个：`work` / `hobbies` / `life` / `learning`。显示名映射在 `src/shared/memoryStore.ts`：工作 / 爱好 / 生活 / 学习。
- 模型新建的桶，显示名 = slug；用户在设置页可改显示名，落 `memories/topics/<slug>.label`（一行文本；不做中心索引，目录自描述，同 ADR-0116 的 `root.txt` 理由）。

### 与三档的关系

- 加第四个 `MemoryTarget`：`"topic"`，工具调用时 `topic` 参数必填。
- MEMORY / USER / PROJECT 的语义**不动**。`tierRuleText` 追加一句：领域事实（工作内容、爱好、生活安排、在学什么）写 TOPIC，并指明桶；USER 收窄为身份与偏好（名字、语言、回复风格、怎么被称呼）；MEMORY 照旧只装本机环境。判据：「这条事实属于用户生活的哪一块」答得上来就是 TOPIC。
- `isMemoryTarget` 扩到四值；`memoryRelPath(target, projectDir, topic)` 加第三参，`topic` 缺失或 slug 非法时抛（同「project 档缺 projectDir 就抛」的纪律——绝不悄悄落到别的档）。

### 新建桶的闸

- 工具描述与 system 尾部都注入**桶索引**：每桶一行 `slug（显示名）· N 条`。
- `topic` 不在索引里 → 工具报错：「没有这个桶。先看索引，确认没有相近的桶再带 `create_topic: true` 重发」。带了 `create_topic: true` 才真建。目的：防「work」「工作」双桶。
- 桶数封顶 **8**，满了新建报错，逼合并。

### 预算与注入

- 每桶 **700** 字，`MEMORY_LIMITS.topic = 700`。合计上限 5600 字（约 1.5k token）。
- **整份注入**，不做相关性检索——和现有 `memory_loaded` 一个纪律：会话开始快照、投影可从日志推导。不可配置（ADR-0116：紧上限是为了逼出策展）。
- 上限触顶的升级路径是检索层（hermes 的 `prefetch(query)` 那种），不在本轮。

### 事件

- `memory_loaded` 加可选 `topics?: { slug: string; label: string; content: string }[]`。缺席 = 旧日志，投影逐字节不变（测试钉住）。不新开事件类型：旧版本读新日志时 `assertReplayable` 拒的是未知类型，已知类型上的多余字段它认得（ADR-0116 同款理由）。
- `memory_user_edit.target` 扩到含 `"topic"`，加可选 `topic?: string`（同 `projectRoot` 的角色：三档之后 `target` 不再唯一标识一份文件）。
- `renderMemoryBlocks` 每桶渲一块 `TOPIC:<label> (<slug>)`，标题带占用百分比，同现有三块。

### 被否的路

- **注入索引 + 按需读**：模型多一次往返，且违背「记忆只注入不读」（memory 工具没有 read action 是刻意的）。
- **把 MEMORY.md 拆成桶**：MEMORY 的环境事实与领域事实是两回事，混了又回到互相驱逐。
- **模型自由建桶不设闸**：Claude.ai 的做法，但会长出「work」「工作」「Work」三个桶。
- **完全固定桶名**：用户的生活不按预设四格切。

## 3. 会话贴主题 + 侧栏分组（第二段）

### 分类时机

- 搭 `turnAnnotator` 的合并调用，加「任务四：主题」——同一次往返多要一个 `sessionTopic` 键。只在会话还没主题时问（同 `session_autotitled` 的「一次会话最多一条」）。
- 素材同标题那份（第一条用户消息前 2000 字）。候选 = 当前桶索引。**只从索引里选，不许在这一步新建桶**：新建桶是记忆写入的动作，不是分类的动作。选不出返回 null，会话留在「未分类」。
- 触发条件：只对 `workspaceKind: "default"` 的主会话（非子会话、非 SideChat）跑。项目会话的分组轴是项目本身，再贴主题是两套分组打架。

### 事件

- `session_topic_assigned { topic, model, usage? }`：模型产出、日志推不出 → 必须落盘；给人看的 → 投影丢弃，不喂回模型（`section_classified` / `session_autotitled` 同款纪律）。
- `session_topic_set { topic: string | null }`：用户手动归类，`null` = 手动归到未分类。
- 优先级：`session_topic_set` 最后一条 > `session_topic_assigned` 最后一条 > 无。手动改过之后自动分类不再触发。
- 两条都是 UI 不可见事件（`threadGroups.isInvisible` 加名单）。

### 侧栏

- `SessionSummary` 加 `topic?: string`（slug），`store.sessions()` 从两条事件按上面优先级推导。
- 任务栏内按 `topic` 分组：组头 = 显示名（种子桶查映射，其余读 `.label` 或用 slug），未分类沉底。桶被删了的会话回未分类（slug 找不到文件就当未分类，不抛）。
- 组的折叠状态记 localStorage（注意 #758：localStorage 还没按账号分家，这里先照现状记，等 #758 一起改）。
- 会话「更多」菜单加「归到…」，列桶索引 + 「未分类」。

### 被否的路

- **写记忆时顺手给会话贴主题**：一个会话可能一条记忆都不写，就永远没分组。
- **第一条消息发出前让用户选主题**：新手零决策是 #559 的底线。
- **按会话标题名的关键词匹配**：不需要模型，但「改装车」不会命中「hobbies」。

## 4. Default 磁盘按会话分格（第三段）

- 会话工作区 = `<内置 Default>/<sessionId 前 8 位>/`。惰性 mkdir（同今天 Default 本身的惰性——只在真被用作会话工作区那一刻）。
- `session_created.workspace` 落的就是这个子目录。于是 Files 面板、coworkLog、`package_project` 的「files 必须解析在 workspace 内」、`trustedWorkspaceForWrite` 白名单（改成前缀匹配 Default 根）——全部沿现有 workspace 语义工作，不用改。
- `workspaceKind: "default"` 的判定改成「workspace 的父目录 = 内置 Default」（`isDefaultWorkspace` 抽成纯函数，测试钉住新旧两种形状：旧日志里 workspace 直接等于 Default 根的会话照旧算 default）。
- 用户在设置页选了自定义默认工作文件夹时（`defaultWorkspace !== null`），**不分格**：那是用户自己的文件夹，往里塞哈希子目录是越界。分格只针对内置 Default。
- 归档会话：子目录**不动**。用户产物不因归档消失，打包（`package_project`）才搬走。设置页「工作区」栏加一行「清理空的任务文件夹」，只删空目录。
- `projectRoot` 对这些子目录照旧回 `null`（Default 不是 git 仓）——任务会话的领域记忆走主题桶，不走 PROJECT 档，这是第一段的前提。

### 被否的路

- **按标题命名子目录**：标题在第一轮回复后才有，且会改名，日志里的路径会变成历史。
- **归档即删子目录**：用户在 Finder 里找得到自己的产出是 #559 照顾新手的理由。
- **任务不要工作区、产物进附件库**：推翻「会话永远有工作区」，bash 没有 cwd，留给 v2 容器化再看。
- **临时目录 + 归档删**：比分格干净，但新手在 Finder 找不到没打包的产物。

## 5. 设置页、迁移、测试（第四段）

- `MemorySettings` 加「主题」分区：桶列表（显示名 + 占用）、改显示名、编辑条目、删桶。编辑与删除走 `applyUserEdit` 落 `memory_user_edit`（删桶 = `after` 为空串 + 删文件与 `.label`）。
- 无迁移：旧 MEMORY / USER / PROJECT 一字不动，旧日志投影逐字节不变。
- 测试（镜像 `src/` 结构）：
  - `tests/shared/memoryStore.topics.test.ts`：slug 校验、`memoryRelPath("topic")`、桶数上限、索引渲染、`applyOps` 对 topic 的上限。
  - `tests/session/deriveMessages.topics.test.ts`：没有 `topics` 字段的 `memory_loaded` 投影逐字节不变；有的话多渲几块。
  - `tests/main/sessionTopic.test.ts`：`parseSessionTopic` 形状烂返回 null、只认索引里的 slug、手动覆盖自动、优先级。
  - `tests/main/workspaceSettingsStore.test.ts`：子目录路径生成、`isDefaultWorkspace` 新旧两种形状、自定义默认文件夹不分格。
  - `tests/tools/memory.test.ts`：`create_topic` 闸、不在索引里报错、8 桶满报错。

## 6. 云同步：记忆跟账号走（第五段）

### 表

```sql
create table memory_docs (
  uid uuid not null references auth.users(id) on delete cascade,
  key text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  primary key (uid, key)
);
alter table memory_docs enable row level security;
-- 只允本人读写
```

- `key` = `memoryRelPath` 的相对路径：`memories/USER.md`、`memories/MEMORY.md`、`memories/topics/work.md`、`memories/topics/work.label`、`memories/projects/<hash16>/MEMORY.md`、`.../root.txt`。
- migration `supabase/migrations/0017_memory_docs.sql`。

### 本地是缓存

- 登录恢复后拉全量：`updated_at` 新的一方胜（本地文件 mtime 对云端 `updated_at`）；云端有、本地没有 → 写本地；本地有、云端没有 → 推上去。
- 每次本地写完推一次，防抖合并（同 `pxEscrowSync` 的模式：多个触发源汇成一次上传，内容指纹没变不打网络）。
- 离线：只读写本地，回线补推。断网不影响会话开始（「先落盘再喂模型」的节奏不变）。
- 登出：本地抽屉留着（ADR-0187 的账号抽屉本来就按 uid 隔离），不清。

### 唯一口子

- 所有记忆读写已经走 `memoryRelPath` + `withMemoryFileLock`，同步层挂在 `accountConfig` 那层的 `writeFile` 后面（`src/main/memorySync.ts`），工具与设置页零改动。
- 新增写路径必须走这个口子，否则云端漏一份——`tests/architecture.test.ts` 加断言：`src/tools/memory.ts` / `src/main/memoryEdit.ts` 之外不许写 `memories/` 前缀的路径。

### 已知天花板（写进 ADR）

- 冲突「后写胜」是有损的：两台机同时改同一桶，晚的覆盖早的。接受——记忆是策展文本不是账本，真丢了 `memory_user_edit` 里有 `before`。
- 项目档的 key 含路径哈希（`projectMemoryDir(root)`），换机器路径不同 → 项目记忆**实际不跨机**。本轮不解；解法是 key 换成 remote URL 哈希，那是 ADR-0116 第一条「作用域键」的重审，另开 issue。
- 手机端可读同一张表（friendsApi 直连 Supabase 的先例），本轮不做手机端 UI。

## 7. 实施顺序

五段可以分 PR，但顺序有依赖：

1. 第一段（主题桶）——其余都依赖它的 slug / 索引。
2. 第二段（会话贴主题）——依赖桶索引。
3. 第三段（Default 分格）——独立，可并行。
4. 第四段（设置页 + 测试）——跟第一、二段走。
5. 第五段（云同步）——独立于二、三，依赖第一段的路径形状。

ADR：主题桶 + 会话分组一份（推进 ADR-0116：领域事实的第四档 + 为什么不拆 MEMORY）、Default 分格一份（推进 ADR-0135：`workspaceKind` 判定变了）、云同步一份（推翻 ADR-0116 隐含的「记忆在本机」）。编号在合并时认领（ADR-0074）。
