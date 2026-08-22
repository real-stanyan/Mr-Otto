# 长短期记忆（对标 hermes-agent）— 设计

日期：2026-08-22
参考：https://github.com/NousResearch/hermes-agent（`agent/memory_manager.py`、`tools/memory_tool.py`、`agent/context_compressor.py`、`docs/micro-compaction.md`、`tools/session_search_tool.py`）

## 目标

给 Otto 加四样东西，全部照 hermes 的行为，只在撞 Hard rules 的地方改写法：

1. 长期记忆：`memory` 工具 + `MEMORY.md` / `USER.md`
2. 跨会话回忆：FTS5 索引 + `session_search` 工具
3. 自动压缩 + 压缩前记忆上下文
4. 微压缩（设置开关，默认关）

四块拆四个 Task issue、四个 PR，按上面顺序串行。

## 与 Hard rules 的两处对齐（前提，各自一条 ADR）

- **append-only**：hermes 微压缩"把 transcript 里几条换成一条 summary marker"是改历史。Otto 改为追加 `micro_compacted` 事件，投影层用摘要替代它覆盖的那段。日志不动。
- **事件日志是唯一事实**：`MEMORY.md` / `USER.md` 是跨会话可变状态。定为**投影/缓存**：`memory` 工具的 tool_call/tool_result 事件 + 用户在 UI 的编辑事件是事实；session 开头追加 `memory_loaded` 快照事件。文件丢了可从全部会话的事件重放出来。

## 决策（已确认）

| 问题 | 决定 |
|---|---|
| 顺序 | 记忆工具 → FTS 搜索 → 自动压缩 → 微压缩 |
| 写入审批 | 不过审批门（同 hermes 默认 `write_approval: false`） |
| nudge | 每 10 个 user turn fork 内置子智能体后台审查（照抄） |
| 文件作用域 | 全局一份 `~/.config/mr-otto/memories/`，不分 workspace |
| 会话内 UI | assistant-ui elements：memory-chips / retrieval-chunks / document-reference |

---

## 一、长期记忆

### 文件

- `~/.config/mr-otto/memories/MEMORY.md`：agent 笔记，上限 **2200 字符**
- `~/.config/mr-otto/memories/USER.md`：用户画像，上限 **1375 字符**
- 条目分隔符 `\n§\n`，条目可多行。按字符不按 token（字符数与模型无关）。
- 读写经 `ExecutionWorld` 新增 `readConfigFile(rel) / writeConfigFile(rel, text)`（配置目录作用域，不受 workspace 围栏约束）。工具不 import fs。严格 UTF-8 解码，BOM 容忍。

### 工具 `memory`

Schema：
- `target`（必填）：`memory | user`
- `action`：`add | replace | remove`
- `content`（别名 `new_text`）
- `old_text`：replace/remove 用，短且唯一的子串
- `operations[]`：原子批量，每项 `{action, target, content?, old_text?}`；字符上限只在批量结果上校验，一次调用可先腾地再加

行为（逐条照 hermes）：
- 超限 = 报错，**不自动淘汰**，错误文案告诉模型当前占用与上限，让它自己合并
- 一个 turn 内失败 3 次后返回终态结果（不再报错），"记忆副作用永不阻塞回复"
- 精确重复拒绝；加载时 `dedupe` 保序去重
- 漂移守卫：replace/remove 前校验磁盘内容能 round-trip 到当前解析结果，否则拒写
- 文件存在但读不了 = 拒写，绝不清空
- 成功响应是终态一句话，**不回显**条目（回显会诱导模型"再找点东西改"）
- **无 read action**：记忆只注入不读

### 事件（`src/session/events.ts`）

- `memory_loaded { memory: string; user: string; renderedAt: number }`：session 第 2 条（`session_created` 之后）。resume 不重读文件——日志里那条就是模型当时看到的。
- `memory_user_edit { target; before; after }`：用户在设置页 / memory-chips 的 `onForget` 改文件时落（不进模型上下文；它是"文件可从日志重建"的凭据）。
- `memory_nudge { turnCount }`：每 10 个 `user_message` 落一条，触发后台审查。

### 注入（`deriveMessages`）

`memory_loaded` 渲成两块，追加在 system 消息**末尾**（volatile tail，前缀缓存只从这里往下失效）：

```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
<条目，§ 分隔>
══════════════════════════════════════════════
USER (about the user) [12% — 160/1,375 chars]
…
```

空文件不渲块。整个 session 字节不变；中途写盘下个 session 才可见。

### 安全

- 写入 + 渲染两处跑 threat-pattern 扫描（移植 hermes `tools/threat_patterns.py` 的 strict 规则表）。中毒条目渲染为 `[BLOCKED: …]`，磁盘原样保留让用户看见并删除。
- `contextEstimate` 把 memory 块算进 system 估算（两边共用 `systemPromptText` 出口的既有约束）。

### 系统提示词

`systemPromptText` 追加（中文，压到 4 句）：

> 你有跨会话的长期记忆（上面的 MEMORY/USER 块），用 memory 工具维护。记：用户偏好、环境细节、工具怪癖、稳定约定——优先记能减少用户再次纠正你的事。不记：任务进度、PR/issue 号、commit、"修了 X"、一周内会过期的任何东西——这些用 session_search 查。写陈述句不写祈使句（「用户偏好简短回复」✓，「总是简短回复」✗——祈使句下次会被当指令）；流程和步骤归 skill 不归记忆。

### nudge 子智能体

每 10 个 `user_message` 落 `memory_nudge` → fork 内置子智能体 `memory-reviewer`（ADR-0051 机制，定义住代码里）：输入 = 父会话 COMPACT_COMPRESSION 投影 + 当前记忆快照；它自己决定调不调 `memory` 工具；结果不回父上下文。子会话工具白名单只有 `memory`（ADR-0054）。

### UI

- 工具结果行：`memory-chips`，chips = 本轮 added/updated（着色）+ existing（灰），`onForget(id)` → ShellBridge `memory.remove(target, entry)` → 写文件 + 落 `memory_user_edit`
- 设置页新卡「记忆」：两个文件的文本框、占用条、清空按钮（走同一条 ShellBridge 通道）

### 测试

- `tests/tools/memory.test.ts`：假 world；上限、批量、3 次失败终态、漂移守卫、读失败拒写、去重、不回显
- `tests/session/deriveMessages.memory.test.ts`：渲染、空文件不渲、BLOCKED 替换、字节稳定
- `tests/architecture.test.ts`：`src/tools/memory.ts` 不 import fs
- `tests/main/memoryReviewer.test.ts`：10 turn 触发一次、子会话白名单

### ADR

0059：记忆文件是投影，记忆工具事件是事实。

---

## 二、FTS5 + `session_search`

### 索引（`src/session/store.ts`）

- `events_fts` FTS5 虚表：`content=events`，列 `session_id, type, text`，`tokenize='trigram'`（中文不需分词）
- `AFTER INSERT` 触发器同步（事件表禁 update/delete，所以只需 insert 路径）
- 只索引 `user_message / assistant_message / tool_result` 的文本字段
- 启动时表缺失 → 一次性回填；schema 版本号记在 `PRAGMA user_version`

### 工具 `session_search`

四种形态由参数推断，**零 LLM 调用**：

| 形态 | 参数 | 返回 |
|---|---|---|
| DISCOVERY | `query` | BM25 前 300 行 → 按 session 去重 → 第一名 ±5 条 + 首尾各 3 条，其余紧凑 |
| SCROLL | `session_id + around_event_id + window` | 该事件前后 window 条 |
| READ | `session_id` | 整段（COMPACT_COMPRESSION 投影，不吐全量工具输出） |
| BROWSE | 无参 | 最近 20 个 session：id、分区标题（ADR-0034）、时间、turn 数 |

排除：`spawnedBy` 子会话（它们是父任务的内部，不是"过去的对话"，ADR-0047）；当前 session。

### 提示词

`systemPromptText` 加一句：「过去做过什么、进度到哪、当时怎么决定的——用 session_search 查历史会话，别存进记忆。」

### UI

- DISCOVERY → `retrieval-chunks`：`query`、chunks `{id: eventId, source: 分区标题, locator: "MM-DD HH:mm · #序号", text, score: BM25 归一化}`，`searching` 在工具运行中为 true
- READ → `document-reference`：`title` = 会话标题，`pages` = turn 数，`anchors` = 命中 turn，`onJump` 打开该会话（复用子会话回看那条 ShellBridge 通道）
- SCROLL/BROWSE 用既有 tool 行

### 测试

- `tests/session/store.fts.test.ts`：内存 sqlite，trigger 同步、回填、中文命中
- `tests/tools/sessionSearch.test.ts`：四形态推断、子会话排除、去重、窗口边界

### ADR

0060：跨会话回忆靠搜索，不靠注入。

---

## 三、自动压缩 + 压缩前记忆上下文

### 触发

每 turn 发请求前：`contextEstimate ≥ contextWindow × 阈值` → 先 `engine.compact()` 再发。阈值：`contextWindow ≥ 512K` 用 0.50，否则 0.75（hermes 的 small-ctx floor）。`contextWindow` 来自 `modelCatalog`；未知模型不自动触发。

`context_compacted` 事件加 `trigger?: "auto" | "manual"`；旧事件无此字段 = manual（向后兼容）。

设置页：总开关（默认开）+ 阈值滑块（0.3–0.9）。

### 压缩前记忆上下文

`compact()` 的摘要 prompt 追加：

```
MEMORY CONTEXT（已在长期记忆里的事实，摘要里不要重复）:
<memory_loaded 快照正文，脱敏 + 头 4000 / 尾 1500 字符截断>
```

脱敏移植 hermes `redact_sensitive_text(force=True, redact_url_credentials=True)`：API key、token、bearer、URL 用户名密码。

### ADR

0061：自动压缩，推翻 ADR-0003「只手动触发」——手动触发实际没人记得按，上下文爆掉比一次摘要贵。

### 测试

- `tests/loop/engine.autoCompact.test.ts`：阈值两档、关闭、未知模型、trigger 字段
- `tests/session/redact.test.ts`：脱敏规则

---

## 四、微压缩（默认关）

### 事件

`micro_compacted { summary: string; coversUpTo: number; model: string; usage?: TokenUsage }`。`coversUpTo` = 被吸收的最后一个事件下标。

### 流程

每 turn 收口后（设置开启时）：
1. 找最老的未吸收 exchange：上一条 `micro_compacted.coversUpTo` 之后第一个 `user_message` 到下一个 `user_message` 之前
2. 保护区不动：system + 第一个 exchange；尾部 `DEFAULT_COMPRESSION.keepRecentTurns` 个 turn 不动
3. 该 exchange 的 assistant/tool 事件 + 当前 running summary → 便宜模型（复用 `sectionClassifier` 那路 adapter）→ 新 summary
4. 落 `micro_compacted`；summary 估算超 2000 token 时先让模型 defrag 一次再落
5. **`user_message` 永不吸收**：投影里原文保留，只用 summary 替代 assistant/tool 部分

### 投影

`deriveMessages` 遇最新 `micro_compacted`：`coversUpTo` 之前的非保护区事件 → 一条 assistant 消息 `[对话摘要]\n<summary>` + 原文 user_message 按序穿插。只认最新一条（旧的被新摘要包含）。

### 设置

开关默认关。说明文案：「每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。」

### ADR

0062：append-only 下的微压缩 = 追加事件 + 投影替换。

### 测试

- `tests/session/deriveMessages.micro.test.ts`：保护区、user 永不吸收、只认最新、与 context_compacted 共存
- `tests/loop/engine.micro.test.ts`：exchange 定位、defrag 阈值、关时不跑

---

## 不做

- provider 插件接口（MVP 边界：不做插件系统；内置文件记忆够用）
- 记忆写入审批
- 外部记忆服务（mem0/honcho 等）
