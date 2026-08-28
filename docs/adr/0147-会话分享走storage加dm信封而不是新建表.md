# ADR-0147：会话分享走 Storage + DM 信封，而不是新建一张表

- 状态：已接受（**补记**——决策与实现随 issue #611 / PR #613、#614、#615 已合并进 main，当时漏了 ADR，本文按已落地的代码补写）
- 日期：2026-08-28
- 关联：issue #611（需求与本决策）、#612（被否的平行方案）、#616（这两条 lane 撞车的协议缺口）、#617（本方案的隐私闸漏项）
- 相关 ADR：0009（附件/快照本机引用）、0055（好友在场）、0114（好友直连 Supabase，不经中继）

## 背景

需求：桌面端输入框 `@好友`，把当前会话的完整快照发过去；好友确认后在自己机器上 fork 继续跑，`@` 后面那句话随包过去，交代这个 fork 去干什么。

同一个需求被两条 lane 各做了一遍（详见 #616）。本 ADR 记录**活下来的那一套**，并把被否的那套的理由一并留档——否则下一班只看得见代码，看不见「为什么不是另一种」。

## 决策

### 1. 载体 = Supabase Storage，DM 只发信封

`messages.body` 有 `check (length(body) between 1 and 4000)`，装不下事件日志（单条工具输出常几十万字符）。三条候选：

| 候选 | 否决理由 |
|---|---|
| 塞进 DM 正文 | 4000 字符上限，直接不可能 |
| 新建 `session_shares` 表，payload jsonb | 附件二进制要 base64 进数据库行，体积 +33%；附件字节本就不该进数据库；PostgREST body 上限逼出一个「会话过大不可分享」的硬天花板 |
| **Storage bucket + DM 发路径**（选中） | 容量够；附件按字节原样走；RLS 钉「只有 accepted 好友能下载」；DM 那条只带 `{pkg_id, 留言}`，正文长度限制不再是约束 |

路径约定 `session-packages/{sender_uid}/{pkg_id}/...`，第一段位是发送方 uid，RLS 直接拿它判「这是谁发的、我跟 ta 是不是好友」（`supabase/migrations/0014_session_packages.sql`）。

### 2. 包的形状 = manifest.json + events.jsonl + 附件字节，不是一个大 JSON

`src/shared/sessionPackageCodec.ts`。分三份存的理由：附件是二进制，进 JSON 得 base64（+33%）；事件是文本且天然逐行一条（与 `trajectoryExport` 的 jsonl 同源）；manifest 小，接收方先拉它就能决定要不要下整包。

### 3. 隐私闸 = 全量事件 + 黑名单剥离，不是白名单保留

这是与 #612 分叉最深的一处。#612 的路线是「只保留投影所需的最小事件集」（白名单），本方案是「全量事件流，剥掉必剥的那几类」（黑名单，`PRIVACY_STRIP_TYPES`）：`request_envelope`（烤着发送方的 system prompt 全文，含记忆快照）、`memory_loaded` / `memory_user_edit` / `memory_nudge`（发送方个人记忆原文）、`checkpoint_created` / `workspace_restored`（指向发送方本机快照库的死引用）、`branch_checked_out`（发送方的 git 分支记录）。另有 `rewriteWorkspace()` 剥 `session_created` 上的 `workspace` / `workspaceKind` / `forkedFrom`——围栏来源必须是接收方。

为什么黑名单赢：这是「交给另一个人继续跑」，不是「拿出去分析」。fork 的价值在上下文完整，白名单每漏一类事件就是接收端投影失真一次，而漏了什么**不会报错**——只会安静地少一段历史。黑名单的失败模式反过来：漏剥一类 = 泄露一次，泄露看得见、可单测钉死、可事后补（#617 就是这么被抓出来的）。用**能被测试抓住的失败模式**换不能被测试抓住的那种。

代价明说：包体积等于全量日志；将来若要收窄，#612 那份「哪些模型不可见事件其实是 `deriveMessages` 的依赖」（`turn_ended` 的空跑判定、`skill_released` 的台账、`context_compacted` / `micro_compacted` 的压缩投影、`tool_execution_started` 的悬空自愈）的分析可以捡回来——存档在分支 `salvage/612-session-shares-approach`（commit 0bd42e1，不合并）。

### 4. 接收 = 复制式重放，不走 `store.fork`

`forkedFrom` 是同库语义（父会话在本地库里），跨机器父根本不存在。接收端剥掉发送方的 seq/sessionId，逐条 append 进新会话——等价于 `tests/session/fork.test.ts` 验过的复制式 fork。

### 5. `@` 让位给好友，路径 mention 迁到 `#`

`@` 原本被路径高亮占着。冲突处理是让位而不是并存：`@` = 人，`#` = 路径，与外部惯例同向（`src/renderer/src/aui/ottoDirectives.ts`）。代价是存量输入习惯要改。

## 后果

- 接受：跨机 fork 丢工作区文件状态、丢 checkpoint（死链）；接收方在自己的工作区跑，`project_instructions` / 记忆按他自己的环境重生成。
- 接受：包体积 = 全量日志（见上）。
- 接受：`@` 语义迁移打断存量习惯。
- 遗留：隐私闸漏了 `project_instructions`（本机绝对路径 + 指令文件全文），见 #617。
- 凭据（API key / MCP 凭据）的临时授权不在本期，第二期在此之上叠加，不推翻本期的包形状 / 传输 / 接收装配。
