# 任务会话云端日志（本机 ↔ 云端 ↔ 手机接着聊）设计——四个子项目里的 ①底座

- 日期：2026-09-10
- Task issue：#1223
- 状态：spec 待维护者过目；ADR 编号**合并时认领**（项目 ADR-0074 的规矩）
- 需求原话（维护者）：「用户在家在自己的电脑上进行了一些会话，出门的时候电脑已经睡眠了，用户可以在手机上继续自己电脑上的那个会话（即使电脑已经睡眠了）。另一个场景：用户在外面，家里电脑没有开机，用手机开启了一个会话，回家之后关上手机，可以在家里的电脑继续这一段会话。……任务会话可以使用语音聊天，就和团队里的 Agent 一样，但任务里面是一对一的，没有群聊。任务里的语音就是一个 otto 本机的助手，可以帮用户做任何他想做的事情，也要记住用户之前的所有记忆。语音音色可以在设置里调。」
- 维护者拍板的三条（2026-09-10 会话内）：① **电脑睡着时手机上的 Otto = 聊 + 记忆 + 搜索/出图，不碰电脑文件，没有云端沙箱**；要动电脑的活记下来、回到电脑再做；② **登录后全部任务会话自动上云**（日志同步对所有登录用户开，云端替你跑 turn 只给订阅用户，同 ADR-0233 云端不走自带 key）；③ 方向取 A：**云端日志为准、本机 sqlite 是副本、「笔」租约决定谁跑、runtime 只在没人握笔时兜底**（B「runtime 为准桌面变显示器」与 C「手机自己跑 LoopEngine」被否，理由见 §8）。

## 0. 这不是一份 spec 能装下的东西：四个子项目

| # | 子项目 | 交付 | 依赖 |
|---|---|---|---|
| ① | **任务会话云端日志（底座）——本 spec** | 两张表 + RPC + 笔；桌面复制器；`executor_changed` 事件；Default 路径每台机器自己算；附件进 Storage | 无 |
| ② | 云端兜底执行器 | VPS runtime 多一条「个人车道」：没人握笔时替用户跑 turn；工具表 = ask_user / todo_write / memory / web_search / web_extract / generate_image；记忆从 `memory_docs` 拍快照；账 on-behalf-of 该 uid | ① |
| ③ | 手机任务会话客户端 | 手机「会话」tab 多一栏任务会话：直连 Supabase 读日志 + realtime、发话、建会话、正在回复指示 | ①（读/写）、②（才有人在电脑睡着时答） |
| ④ | 一对一语音 + 音色 | 桌面复用团队语音栈换挂载点；手机 STT/TTS 要 native 模块（告别 Expo Go）；音色落账号、两端设置页 | ①③ |

①做完的可验形态：**同一账号两个 `OTTO_PROFILE` 桌面实例互相接着聊**（`docs/dev-two-accounts.md` 那套），手机与云端一个字都还没碰。②③④各自开 spec，引用本文件 §3.9 的契约。

## 1. 已验前提

本条的前提全是**读代码验出来的**，没有打过接口；线上要验的列在 §5「手验清单」。

| 事实 | 出处 |
|---|---|
| 本机事件日志 = 账号抽屉里一份 sqlite（`accounts/<hash>/sessions.db`），`seq` 在 `append()` 事务内 `MAX(seq)+1` 分配，事件信封没有任何来源/设备字段（只有 v2 预留的 `sandboxId`，无人写） | `src/session/store.ts:168-181`、`src/session/events.ts:10-21` |
| `LoopEngine` 只依赖五方法的 `EventLog` 口；runtime 的 `sessionService` 只调 `store.append` / `store.load` | `src/session/eventLog.ts`、`services/runtime/src/sessionService.ts` 全文 grep |
| engine 已有 `runLoggedTurn(opening)`：对**已落盘**的 `user_message` 起 turn，不重追加 | `src/loop/engine.ts:684` |
| turn 中途落进日志的 `user_message` 会被增量采样读到（`unseenUserTail`），这是后台任务回注走的路 | `src/loop/engine.ts:288, 896`；ADR-0205 |
| `turn_ended.outcome = "interrupted"` 已存在，语义就是「resume 时发现上一轮没收口、合成一条收口」 | `src/session/events.ts:423-435` |
| 云会话（团队）从帧到 sqlite 到容器全按 `workspaceId` 键；`workspace_sessions.workspace_id` 非空外键；没有任何个人会话的云端表 | `services/runtime/src/daemon.ts:319-326`、`supabase/migrations/0015_workspaces.sql:42` |
| 手机 App 是电脑的加密投影：中继一个 storage API 都不调，对端不在就丢帧；`mobile/` 里没有 cs 帧、没有音频、没有 native 模块 | `services/edge/src/relay.ts:5-11`、`services/edge/src/worker.ts:196-203`、`mobile/package.json` |
| 手机持有与桌面同一个 Supabase 项目的 JWT，已直连 Supabase 做好友/私信（含 realtime） | `mobile/src/supabase.ts`、`mobile/src/friendsApi.ts:190` |
| 记忆四档已按账号同步到 `memory_docs`（`(uid,key)` 主键、own-row RLS、后写胜），云端 runtime 一行都不读它 | `supabase/migrations/0019_memory_docs.sql`、`services/` grep 零命中 |
| 任务会话 = `session_created.workspaceKind === "default"`；文件夹是 `<内置 Default>/<sessionId>`，**文件夹名就是 sessionId** | `src/main/taskWorkspace.ts:20-35`、`src/shared/defaultWorkspace.ts:18-31`、ADR-0206 |
| 桌面在线心跳：`profiles.last_seen_at` 每 30 s 一次（好友服务） | `src/main/friends.ts:95,453` |
| 桌面已有随机 16 字节的 `deviceId`（远程配对身份） | `src/main/remoteIdentity.ts:69` |
| 附件内容寻址 `sha256:<hex>`、字节在日志外的 `AttachmentStore`；Storage bucket own-folder 策略有先例 | `src/session/events.ts:111-116`、`supabase/migrations/0014_session_packages.sql` |
| `web_search` / `web_extract` 用的是仓库内置 anysearch key（`ANYSEARCH_API_KEY` 可覆盖），不是用户的 key | `src/main/agent.ts:121, 737-738` |

## 2. 边界

做（①）：
- 任务会话（`workspaceKind: "default"`、无 `spawnedBy`）的**整份日志**在云端有一份账号级副本，桌面持续双向复制。
- 「同一时刻谁在跑」由**笔**（租约）决定；追加走 CAS，两台设备写不撞。
- 新事件 `executor_changed`：换执行器这件事写进日志，提示词从它推导。
- Default 文件夹路径由每台机器自己算；云端建的会话能在任何一台 Mac 上落地。
- 图片附件进 Storage，按需回取。
- 桌面主进程：复制器、turn 准入接笔、冲突处理、设置页一行状态。

不做（①，明写）：
- runtime 不动（②）；手机不动（③）；语音一个字不碰（④）。
- 任务文件夹里的**文件**不同步，只同步日志（§7 第 7 条）。
- 项目会话（用户自己的 git 仓 / 自定义默认文件夹）不上云。
- 子智能体会话（`spawnedBy`）不上云。
- 对面设备的 token 流式；日志保留策略；三路合并。

## 3. 架构

```
桌面 A（醒着）                          Supabase                          runtime（②）           手机（③）
──────────────                        ─────────                         ────────────           ─────────
sessions.db ◀── 复制器 ──┐        task_sessions（笔/last_seq/title）   没人握笔 + 人话没答     select + realtime
  ▲ onAppend      推/拉  ├──RPC──▶ task_session_events（append-only） ◀── 拿笔、跑、追加 ──▶   task_append(user_message)
  │               笔     │        storage: task-attachments            memory_docs 拍快照       「正在回复」= pen_holder
LoopEngine ──runLoggedTurn┘        realtime: UPDATE task_sessions
```

一句话：**云端那份是事实，每台设备的 sqlite 是它的前缀副本；谁握笔谁写 turn；人话不要笔。**

### 3.1 表

**`task_sessions`**（一行一条任务会话，账号级）

| 列 | 说明 |
|---|---|
| `id text pk` | 沿用桌面 `s-YYYYMMDDhhmmss-8hex`。手机建会话也铸这个形状（`newSessionId` 从 `src/main/agent.ts` 搬到 `src/shared/sessionId.ts`）：Default 子目录名就是它 |
| `uid uuid not null references auth.users on delete cascade` | |
| `title text not null default ''`、`title_rank smallint not null default 0` | 投影 renamed(3) > autotitled(2) > 首行(1)；RPC 追加时按事件类型更新，只在 `rank >= title_rank` 时写，低优先级盖不掉高的 |
| `archived boolean not null default false` | `session_archived` / `session_unarchived` 翻它 |
| `last_seq integer not null default -1` | CAS 的基准 |
| `pen_holder text null`、`pen_until timestamptz null` | 笔：谁在跑 turn、到期时间 |
| `created_at`、`updated_at timestamptz` | 手机列表按 `updated_at` 排 |

RLS 四条 own-row（照抄 0019）。**realtime 只订这张表的 UPDATE**：`last_seq` 变了 = 有新事件，客户端再去 select 尾巴。不订事件表——`tool_result` 单条能到 1 MB，`postgres_changes` 的 payload 上限会把它静默丢掉（§7 第 11 条：上限具体多大没验，设计不依赖那个答案）。

**`task_session_events`**

| 列 | 说明 |
|---|---|
| `session_id text references task_sessions(id) on delete cascade`、`seq integer` | `primary key (session_id, seq)` |
| `uid uuid not null` | 冗余一份，RLS select 不用 join |
| `ts bigint`、`type text` | 信封列，同桌面 sqlite |
| `payload jsonb` | 整条事件原样——与桌面 `payload` 列**同一份 JSON**，两端 `JSON.parse` 出来逐字节相等 |

RLS **只有 select own**。没有 insert / update / delete 策略：写只走 RPC，append-only 在 DB 层成立（同本机的 `events_no_update` / `events_no_delete` 触发器）。

### 3.2 RPC（`security definer`）

调用方两种：JWT（桌面 / 手机）——`p_uid` 必须等于 `auth.uid()`；service key（runtime）——`auth.role() = 'service_role'` 时信显式 `p_uid`。

1. **`task_append(p_uid, p_session_id, p_expected_seq, p_holder, p_events jsonb) → integer`**（回最后一条 seq）
   - CAS：`p_expected_seq = last_seq + 1` 才写，否则 `raise exception 'seq_conflict'`。`p_events` 是数组（1..N 条），同一事务、同一 CAS——交互时一条一发，回填/收口时成批。
   - `p_expected_seq = 0` 且行不存在 = 建会话：同一事务插 `task_sessions` 行，第 0 条必须是 `session_created`。
   - **谁能追加什么由笔决定**：每条事件按 `PEN_VERDICTS`（§3.8）分两类。`human` 类不看笔；`executor` 类要求 `pen_holder = p_holder and pen_until > now()`，否则 `raise exception 'pen_required'`。手机从不握笔，天然只发得出人话；桌面跑 turn 时握笔，什么都能落；**runtime 同一条规矩，不因为拿着 service key 就绕过**。
   - 顺手投影：`last_seq`、`updated_at`、`title`/`title_rank`、`archived`。
   - 上限：单条 payload 2 MB；`user_message.content` 64 KiB（同 `CS_MAX_TEXT_BYTES`）。
2. **`task_pen_acquire(p_uid, p_session_id, p_holder, p_ttl_s) → (ok boolean, holder text, until timestamptz)`**：`pen_holder is null or pen_until < now() or pen_holder = p_holder` 才写入；同 holder 再调 = 续期；否则回当前持有人。
3. **`task_pen_release(p_uid, p_session_id, p_holder)`**：只有持有人能放（`pen_holder = p_holder`）。

拉尾巴不要 RPC：`select … from task_session_events where session_id = ? and seq > ? order by seq limit 500`，RLS 管。删除也不要：`delete from task_sessions where id = ?`，own-row 策略 + 级联。

### 3.3 笔（pen）的语义

- **只在需要写 executor 类事件时握**：turn 准入时拿 → 每 `PEN_RENEW_MS = 10_000` 续 → **收口后的小模型帮手（自动标题 / 主题 / 建议 / 记忆 nudge）跑完**才放——放笔挂在帮手链的 `finally` 上，没接帮手链的装配（测试 / 裸装配）在 `turn_ended` 落盘后立即放。`PEN_TTL_S = 30`。holder：`desktop:<deviceId>` / `cloud` / `phone:<deviceId>`（手机永远拿不到 executor 事件的资格，写 holder 只是为了日志可读）。
- **两个拿笔时刻**，都靠「同 holder 再调 = 续期」幂等：
  1. **准入**（要不要起 turn）：`handleSendMessage` 里、落完人话之后。
  2. **推送**（能不能写）：pusher 推一批含 executor 类事件的批次之前，先 acquire/续期。离线建的会话、离线跑完的 turn，回网后就是在这一刻拿笔推上去的。
- 拿不到 = 对面正在跑。桌面显示「云端正在回复」，等 realtime 看到 `pen_holder` 变空；手机反过来同理。人话照样先落（不要笔），正在跑的那一 turn 会在增量采样里读到它（ADR-0205 那条路）；云端碰不到文件这件事由 `executor_changed` 的提示词块兜着（§3.5）。
- 过期 = 持有人死了（电脑睡了 / runtime 崩了）。新持有人拿到后**先看日志尾**：上一 turn 没 `turn_ended` → 补一条 `turn_ended{outcome:"interrupted"}` 收口（同 ADR-0220 重启补跑），再按 `lastUnanswered` 判最后那条人话答过没、没答就跑。
- **`interrupted` 算「没答」，`aborted` 算「答过」**：前者是系统把它打断的（睡眠 / 崩溃），后者是人按了停止。`lastUnanswered` 的判据（§3.8）钉这一条。
- 为什么不「电脑常握笔」：常握 = 手机永远等到过期（30 s 起步）才轮到云端，且电脑醒着但没在跑也不该独占。「桌面优先」由 ② runtime 那侧的宽限期实现：`profiles.last_seen_at` 90 s 内新鲜（桌面 app 活着）就先等 10 s 让桌面拿，桌面看到手机的人话会立刻拿（§3.6）。

### 3.4 事件：`executor_changed`

```ts
interface ExecutorChangedEvent extends SessionEventBase {
  type: "executor_changed";
  executor: "desktop" | "cloud";
  /** 桌面：这台设备的人话名（同 remote 的 deviceLabel）；云端缺席 */
  label?: string;
  /** 模型可见面是 deriveMessages 从它投影出来的 system 尾块；旧桌面重放跳过它只少一行时间线 */
  ignorable: true;
}
```

- **谁落**：拿到笔的那一方，且仅当 `currentExecutor(events) !== 自己` 时落一条，位置在拿笔之后、起 turn 之前。`currentExecutor` = 最后一条 `executor_changed`，一条都没有 = `"desktop"`（存量日志全是桌面写的）。云端建的会话因此天然在 seq 1 落 `{executor:"cloud"}`——`session_created` **一个字段不加**。
- 新事件类型的 **11 处清单**逐处表态：`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、`persistencePolicy`（durable）、`deriveMessages`（§3.5）、`deriveSections`（跳过）、`toThreadMessages.isAuditEvent`（**false**，要画）、`deriveUsage`（无）、`contextEstimate.pendingAfter`（不计）、`agentView.OTHER_AGENT_VERDICTS`（`keep`，它不会出现在团队会话里，穷举表要它表态）、`PRIVACY_VERDICTS`（**`strip`**：这是设备事实，不是这段对话）、`Timeline.tsx` 的 `EventRow`（一行分隔）、`tests/renderer/timelineLists.test.ts` 那条对表断言会抓漏。外加本 spec 新增的第 12 处：`PEN_VERDICTS`（`executor`）。

### 3.5 模型可见面（`deriveMessages`）

system 消息**末尾**追加一段（同 `renderVoiceCallPrompt` 的位置：追在最后，prefix cache 只从这儿失效）。日志里一条 `executor_changed` 都没有 = 一字不加，**旧日志投影逐字节不变**。

- `currentExecutor === "cloud"`：
  > 你现在在云端替用户接着这条会话（用户在手机上）。电脑不在线——你碰不到它的文件、终端和连接器，能用的只有当前工具表里那几把。要动电脑的活，用 `todo_write` 记下来并明说「回到电脑再做」，不要假装做了。回复像发消息：短、先说结论。
- `currentExecutor === "desktop"` 且日志里出现过 `cloud`：
  > 你回到了电脑上，全部工具可用；云端那段记下的待办现在能做了。
- 桌面 → 桌面且 `label` 变了（换了一台 Mac）：上句末尾多一句「这是另一台电脑，任务文件夹里此前的文件不在这台机器上。」

`systemPromptText` 那行「当前工程文件夹：…」照旧打日志里那份（`workspace` 字段本来可选，缺席就不打）；云端块已经说了「碰不到电脑文件」，不另改。`PACKAGE_NUDGE`（打包为项目）照旧只跟 `workspaceKind` 走——云端没有那把刀，块里那句「能用的只有工具表里那几把」盖住它。

### 3.6 桌面主进程

**模块**：`src/main/taskSessionSync.ts`（IO 编排，同 `memorySync` 形状）+ `src/shared/taskSync.ts`（纯逻辑，§3.8）+ `src/main/supabaseTaskSessionsApi.ts`（Supabase 调用，同 `supabaseMemoryDocsApi`）+ `src/main/attachmentFetch.ts`（按需回取）。随账号抽屉装配；登出停、不清本地。

**哪些会话**：`session_created.workspaceKind === "default"` 且无 `spawnedBy`。判据从日志读，不看设置。

**推（本地 → 云）**
- `EventStore` 加一个可选观察者 `onAppend(event)`（构造参数）。engine 与 `index.ts` 直接 append 的都从 `append()` 一个门出，挂这一处就全覆盖；runtime 也 new 这个类，可选参数不影响它。
- 观察者只做「这条会话脏了」标记。真正推的是按**持久化游标**干活的 pusher：`task-sync.json`（accountData 下）记每条会话 `{ pushedUpTo, detached? }`；脏了就 `store.load(afterSeq: pushedUpTo)` 按序推，一条会话同一时刻只有一个 in-flight；批次里有 executor 类事件就先 acquire/续期笔。退避重试；`seq_conflict` 进冲突流程；`pen_required`（笔被别人握着）等笔空再推。
- 开机回填：未归档任务会话先推、归档的排后面、一条一条来。老会话一次性上云是有意的代价。
- 带附件引用的事件（`user_message.attachments`、工具出图的 `tool_result.images`）**先 PUT 字节再推事件**（bucket `task-attachments`，对象名 `<uid>/<hex>`，内容寻址 = 去重 + 幂等）；PUT 失败卡住这条会话的队列重试，永不推出一条悬空引用。

**拉（云 → 本地）**
- 触发：realtime `task_sessions` UPDATE；登录恢复；`powerMonitor` `resume`；窗口聚焦；**60 s 一次的 sweep**（一条 `select … where uid = me and updated_at > 上次`，不是每会话一条）。realtime 通道的健康度没人看着（#913 那一族），sweep 是兜底不是主路。
- 云端 `last_seq` > 本地末条 → select 尾巴（500 一片）→ 按序 `store.append`，**断言本地分到的 seq 与云端相等**，不等 = 本地多出了东西 → 冲突流程。拉进来的事件 `muted`（观察者跳过），游标直接推到该 seq。
- 拉到 `executor_changed{cloud → desktop}` 的切换、以及每次拉的同一批触发点，顺带 `memorySync.pullNow()`——②的云端记忆工具写的是 `memory_docs`，不拉就要等下次登录。
- 会话在云端有、本地没有（手机 / 另一台电脑建的）：从 seq 0 整份拉进 sessions.db，侧栏自然出现（列表读的就是本地库）。

**turn 准入（笔接进 `handleSendMessage`）**
1. 照旧先落 `user_message`（human 类，免笔）→ 推。
2. `task_pen_acquire`。拿到 → `currentExecutor !== "desktop"` 就先落 `executor_changed{desktop,label}` → 照旧跑 turn（checkpoint 保存、`runningSessions`、工作区互斥全部不变），每 10 s 续，收口帮手跑完放。
3. 被别人握着 → **不起本地 turn**：`sessionRuntime` 多一态 `waitingFor: "cloud" | "desktop"`（按 holder 前缀判；运行指示条写「云端正在回复」/「另一台电脑正在回复」），笔一空先按 `lastUnanswered` 看这条答过没，没答才 `runLoggedTurn(opening)`——`agent.ts` 补一个「对已落盘的那条起 turn」入口（engine 已有）。
4. 网络错 ≠ 被占：**照跑**（桌面 app 离线必须能用，同 memorySync「off 也开会话」），这条会话标 `offlineRun`，回网后的冲突是预期内的。
5. turn 中途推送被拒 `pen_required`（睡了 30 s 以上再醒、笔已过期）：先试重拿；拿到（没人接手过）继续；拿不到 → `stopTurn`，本地多出的尾巴进冲突流程。

**手机的话由电脑跑**：拉下来一条 human `user_message` 且 `lastUnanswered` 指着它 → 桌面**立刻**拿笔、`runLoggedTurn`。会话不在内存就先走既有 resume（含 `mcpHub.ready()`）。多条连发只起一个 turn，剩下的由增量采样吃掉。

**睡眠 / 唤醒**（`powerMonitor`，今天主进程没接它）：
- `suspend`：正在跑的 turn `stopTurn` 并以 `turn_ended{outcome:"interrupted"}` 收口（不是 `aborted`——人没按停止），尽力推出去、放笔。于是手机接手时看到的是干净的尾巴，且那条人话按「没答」处理、云端会接着答。
- `resume`：**先 sweep 再做任何事**；本地正在等笔的会话重新判。

**冲突：分叉或重放，云端赢，本机不丢**
- 判据：同一 seq 两边 payload 不同（`seq_conflict` 之后先比对——游标陈旧导致的重推会撞出「已经在了」，比对相同就只推游标）。找到第一处不同 F。
- **本地多出的尾巴 `[F..末]` 全是 human 类**（改名 / 归档 / 换型号 / 人话，没有 turn 痕迹）→ **重放**：`purge(原 id)` → 从云端整份拉回 → 把那几条按原顺序作为**新事件**重新 append（新 seq）。一次改名就是一次改名，不需要分叉。
- **尾巴里有 executor 类事件**（离线跑过 turn）→ **分叉**：新铸 sessionId，把本地 `[0..F-1] + [F..末]` **复制**成一条独立会话（`session_created.forkedFrom = {sessionId, seq: F-1}`，重编号走 `retargetForImport` 那套；**不是 `store.fork` 的引用式分叉**——引用式会让接下来的 `purge(原 id)` 被拒）→ `purge(原 id)`（日志层 purge，不走用户「删除」那条会杀检查点 / worktree 的路）→ 从云端整份拉回原 id。侧栏多一条「〈标题〉（本机未同步的分支）」。
- 为什么云端赢：云端那截是握着笔写的，或是人亲口说的，其他设备都已经看过它；本机那截是离线盲写的。分叉保住两边，不做三路合并。

**删 / 归档**
- 归档是 human 类事件，正常同步，别的设备列表跟着收起。
- 删除：本机 `purge` + `delete from task_sessions`（级联事件；Storage 里的附件不删——内容寻址、可能被别的会话引用，①不做引用计数）。**别的设备永远不因为云端行消失而删本地**（一个 bug 就是全设备丢数据）：sweep 发现行没了 → `task-sync.json` 标 `detached`、停止同步、照样可读；之后若在那台继续聊 → 清 `detached`，从 seq 0 整份重推 = 重新建行，无损。

**Default 路径：每台机器自己算**
- 今天 `session_created.workspace` 是建会话那台 Mac 的绝对路径，resume 缺了就拒（`index.ts:2681-2683`）。新规则只对 `workspaceKind === "default"` 生效：**装配时**若日志那个目录在本机存在就用它，否则 `defaultWorkspaceFor(documents, sessionId)` = `<内置 Default>/<sessionId>` 并 mkdir。自定义默认文件夹的会话本来就不是 `default` 种（判据钉在 builtin 上），不受影响。
- 云端建的会话：`session_created { workspaceKind: "default" }`，**没有 `workspace`**（runtime 不知道任何 Mac 路径）——resume 对 `default` 种放宽「必须有 workspace」。

**附件回取**：`attachmentStore.read(id)` 未命中 → 从 Storage 取回落本地缓存。四处读字节的闭包（`index.ts:3405 / 3562 / 4037 / 4284`）改经 `attachmentFetch`。取不到不炸：时间线画占位「附件在另一台设备上」，喂模型时丢掉那个 image part、留一句文字说明。

### 3.7 渲染层（①最小）

- 时间线：`executor_changed` 一行分隔（「在云端继续 · 08:12」/「回到电脑」/「换到另一台电脑」）。
- 运行指示条：`waitingFor` 一档「云端正在回复」/「另一台电脑正在回复」（`agentPhase.ts` 六档之外的第七档，审批仍最优先）。
- 设置 → 账号：一行「任务会话云同步：已同步 / 离线 / 关（原因）」，同记忆同步那行的做法。表没建时这里写原因，不弹窗。
- 分叉出来的会话标题带「（本机未同步的分支）」，其余零改动——侧栏本来就读本地库。

### 3.8 `src/shared/taskSync.ts`（纯函数，三端共用一份，同 `wire.ts` 的纪律）

- 常量：`PEN_TTL_S = 30`、`PEN_RENEW_MS = 10_000`、`PULL_PAGE = 500`、`TASK_TEXT_MAX_BYTES = 64 * 1024`、`TASK_EVENT_MAX_BYTES = 2 * 1024 * 1024`。
- `PEN_VERDICTS: Record<SessionEvent["type"], "human" | "executor">`——**穷举 Record**，新事件类型不表态 tsc 直接红（同 `PRIVACY_VERDICTS`）。`human`：`session_created`（仅 seq 0）、`user_message`、`session_renamed`、`session_archived`、`session_unarchived`、`session_topic_set`、`model_changed`、`image_model_changed`、`memory_user_edit`、`branch_checked_out`、`session_shared`、`share_grant_note`；其余全部 `executor`。RPC 里的白名单是从它生成后抄进 SQL 的，`tests/shared/taskSync.test.ts` 有一条读 migration 文件对表。
- `holderId(kind, deviceId)`、`currentExecutor(events)`、`lastUnanswered(events)`（最后一条 human `user_message`，其后没有 `turn_ended`，或有但 `outcome === "interrupted"` → 它；`aborted` / `completed` / `error` 算答过）。
- `divergence(local, cloud)` → `"none" | { at, kind: "human_only" | "has_executor" }`。
- `sliceBatches(events, maxBytes)`、`attachmentRefsOf(event)`。
- `newSessionId()`（从 `agent.ts` 搬来）、`defaultWorkspaceFor(documents, sessionId)`。

### 3.9 对 ② ③ 的契约（免得三份 spec 各自发明）

- 表 / RPC / 常量 / `PEN_VERDICTS` 一律以 §3.1–3.3、§3.8 为准，改动要回来改这里。
- **② runtime**：service key 调同一批 RPC，**同样受笔约束**；触发 = realtime（订 `task_sessions` UPDATE，全体 uid）+ 30 s sweep（`lastUnanswered` 非空 且 笔空/过期）；宽限 = `profiles.last_seen_at` 90 s 内新鲜就等 10 s；拿到笔先补 `interrupted` 收口再落 `executor_changed{cloud}`；记忆快照走 `src/shared/memorySnapshot.ts`（行 → `MemoryLoadedEvent` 形状，两档、无项目档），桌面 `readTiers` 也要改走它（文件 → 行 → 同一个函数）；`memory` 工具 = `ConfigCapability` 三方法套在 `memory_docs` 上（`list(relDir)` = 前缀查 key）；型号：`model_changed` 那款网关供着就用，不供退网关第一款，实际用了哪款记在 `assistant_message.model`，**不落新事件**；账 on-behalf-of 该 uid；没订阅 = blocked，措辞照 ADR-0233 分开说。
- **③ 手机**：`task_sessions` select + realtime UPDATE；事件 select；发话 = `task_append(user_message, holder: phone:<deviceId>)`；建会话 = `task_append(expected_seq 0, [session_created{workspaceKind:"default"}, user_message])`；「对面在打字」= `pen_holder != null`；「没人会答」= 笔空 + 电脑心跳陈旧 + 没订阅 → 「电脑不在线；云端接手要订阅」。附件上传同 §3.6 的对象名规则。

## 4. 钱与安全

- 钱：①本身不花模型钱。Supabase 存储随日志长（§7 第 1 条）。
- 数据边界：整份日志上云——`request_envelope`（渲染后的 system 提示词快照）、`memory_loaded`（记忆全文）都在里面。它们是用户**自己的**数据、own-row RLS，与 `memory_docs` 同一条线；`PRIVACY_VERDICTS` 是分享给**别人**时的闸，不适用于自己的副本。
- 写路径只有 RPC：客户端写不出违反 append-only 的东西；`executor` 类事件必须握笔，手机拿不到写 turn 的资格；runtime 不因 service key 绕过（SQL 里不按角色分支放行，只按角色决定信不信 `p_uid`）。
- 附件对象名内容寻址，own-folder 策略；不做引用计数、不删。

## 5. 测试

门禁内（`tests/` 镜像 `src/`）：
- `tests/shared/taskSync.test.ts`：游标算术、`divergence` 三态、`sliceBatches`、`PEN_VERDICTS` 穷举 + 与 migration SQL 白名单对表、`currentExecutor`、`lastUnanswered`（含 `interrupted` vs `aborted`）、`defaultWorkspaceFor`。
- `tests/main/taskSessionSync.test.ts`：假 api + 真 `EventStore`（临时文件）——推序、批次含 executor 事件先拿笔、muted 拉不回推、human-only 冲突重放、含 executor 冲突分叉 + purge + 重拉、离线跑完回网对账、`pen_required` 重拿 / 中止、云端行没了 → detached 不删本地、附件先传后推。
- `tests/session/store.onAppend.test.ts`：每次 append 都触发；fork / purge 不触发；runtime 那条不传观察者的构造照旧。
- `tests/session/deriveMessages.executor.test.ts`：无事件逐字节不变；cloud / desktop / 换电脑三段措辞。
- `tests/main/taskWorkspace.test.ts`：default 种缺 `workspace` 或目录不存在时的派生。
- `tests/renderer/`：时间线分隔行、运行指示条第七档、设置页那行。
- 新事件类型清单：`timelineLists` 对表 + 各穷举 Record 由 tsc 抓。

门禁外（SQL 跑不到 Postgres）——**手验清单**，对 Cloud 真库、同一账号两个 `OTTO_PROFILE` 实例：
1. A 新建任务会话、聊两轮 → B 侧栏出现、内容一致（含 `memory_loaded`、`request_envelope`）。
2. B 打字 → B 拿到笔跑；同时 A 打字 → A 显示「对面正在回复」（桌面对桌面的 `waitingFor` 文案写「另一台电脑」）；B 收口后 A 那条被 `lastUnanswered` 判为未答 → A 起 turn。
3. A 断网（关 Wi-Fi）聊一轮 → 回网 → 无人动过时正常推上；若期间 B 也聊了 → A 那截分叉成「（本机未同步的分支）」，原会话与 B 一致。
4. A 只改名 / 归档（断网）→ 回网 → 重放，不分叉。
5. A 合上盖子 5 分钟再开 → 笔过期、`interrupted` 收口、sweep 拉齐。
6. 带图的人话 → B 侧时间线能画图、B 起 turn 时模型拿得到图。
7. 表没建（回滚 migration）→ 设置页那行写原因，会话本地照常。
8. 一台删除 → 另一台 `detached` 仍可读，续聊后重新出现在第一台。

e2e（Playwright 双实例）可选，不进门禁。

## 6. 部署顺序（合并后，本班做）

1. Cloud 真库手跑 `supabase/migrations/0036_task_sessions.sql`（两张表 + RLS + 三条 RPC + bucket `task-attachments` 三条策略）。编号**合并前 re-fetch 再定**（0035 是此刻的末号）。
2. 发桌面。表不在时 RPC 404 → 复制器 `off` + 设置页一行原因，会话本地照常——失败方向是「不同步」不是「不能用」。
3. runtime / edge 本 spec 不动，`npm run deploy:check` 不受影响。

## 7. 已知代价

1. 日志两份；Supabase 存储随工具输出长（bash 单条到 1 MB），①没有保留策略。
2. 开机回填一次性上传存量任务会话，一条一条来，可能几十 MB。
3. 对面设备没有 token 流式，只有「正在回复」。
4. 离线分歧 = 分叉出一条兄弟会话，永不合并。
5. `memory_loaded` 仍是起点快照，换执行器不刷新（两条 `memory_loaded` 会在投影里叠两遍，且「日志里那份就是真相」不该为此破）。
6. `checkpoint_created` / `workspace_restored` / `residue_*` 会复制到对它们没意义的机器——消费方要优雅失败（「这台机器上没有这个检查点」）。
7. **任务文件夹里的文件不同步，只同步日志**。维护者的两个场景不受影响（云端无 fs；回到同一台电脑文件都在）；Mac A → Mac B 拿到空文件夹，提示词多一句说明。
8. 一台删除，其他设备留一份 `detached` 副本（有意的）。
9. 桌面在线判据借的是好友那条 30 s 心跳；它没跑时云端每次多等 10 s，不是失败。
10. 子智能体会话不上云；另一台机器上的 `session_search` 看不到它们。
11. realtime `postgres_changes` 大 payload 会不会静默丢**没真验过**——设计上只订小行，不依赖那个答案。
12. 收口帮手跑完才放笔：手机在电脑刚答完那几秒里发的话要多等帮手那一两秒。
13. 冲突分叉时若原会话有子智能体会话 → 冻结（`frozen: "has_children_conflict"`）不 purge，那条会话停止同步直到人来处理。
14. 附件「拉到即取」：拉到那一刻下载失败进 `missingAttachments`，下次 sweep 重试，期间那张图在本机画占位。
15. `service_role` 有 BYPASSRLS：append-only 与笔约束对 runtime 是「只走 `_as` 包装」的约定，不是 DB 强制。
16. held 时 skill / 图片消息要等对面答完再发一次。
17. `state()` 是瞬态、`frozen` 是持久：渲染层的那一行看不到「为什么停了」的持久原因（下一次成功 sweep 会把它刷回 idle）。
18. `acquirePen` 没有超时：悬住的 socket 会让准入卡住到 undici 放弃。
19. compact 期间放笔检查会跳过、等下一 turn 收口；F3 放笔正确性依赖收口帮手链是真异步。
20. `answerLogged` 的 held 分支不排空 `pendingBg`（延迟不丢）。
21. 0036 未在真库执行前，桌面状态行写「云端还没有任务会话表」（有意的失败方向）。
22. **任务会话的「回到这一步」分支只在本机**（终审 C2）：引用式分叉（`store.fork` 的零拷贝）不上云，
    它在别的设备上不存在，也不因这条会话同步而出现。要它跨设备就得先把还原改成复制式。
23. **`tool_result` 里含 NUL 字节的会话会冻结**（终审 I4 的直接后果）：`\u0000` 进 jsonb 触发 22P05，
    这一批再发一次结果一样，所以判成终态 `forbidden` 而不是每 30 s 重试。根治（推之前把 NUL 剥掉
    / 转义）另开 issue——那要改的是「日志里已经有什么」，不是这条同步链路。

## 8. 否决的候选

- **B. runtime 为准、桌面变显示器 + 远程工具执行器**：桌面离线就没有任务会话；每次本机工具调用绕 VPS + 中继（256 KiB 帧上限直接卡死大输出）；worktree / 检查点 / MCP / 子智能体 / 后台任务全要重做成远程能力；所有本机工具输出过 VPS。
- **C. 手机自己跑 LoopEngine**：iOS 后台 30 秒杀 JS，长 turn 中途断成半截日志；「电脑睡了、手机锁屏、Otto 还在想」这个场景直接不成立；两套 engine 运行时要与 schema 同步。
- 事件信封加 `device` 列：换执行器由 `executor_changed` 带内说，笔是瞬态的；加列要改桌面 sqlite schema 且旧日志无此列。
- 电脑常握笔：见 §3.3。
- realtime 订事件表：payload 上限静默丢，见 §3.1。
- 三路合并 / 云端不赢：本地分叉已经零丢失，合并规则没有真实需求。
- 删除级联到其他设备：一个 bug 就是全设备丢数据。
- 换执行器重拍 `memory_loaded`：见 §7 第 5 条。
- 手机走中继经 runtime 读日志（像 cs 帧）：runtime 挂了手机连历史都看不到；直连 Supabase 是用户自己的数据 + RLS，少一整层。
- 同步时过 `PRIVACY_VERDICTS` 挑着传：副本不逐字节相等就没法用「本地是云端前缀」这一条不变量做对账，且云端执行器要的正是模型可见的那批。

## 9. 实施偏差（写 plan 时定的，合并时以此为准）

以下 20 条是实现期间对本 spec 正文的偏离，以及复审过程中新增的裁定，均已落地（对应 commit 见
issue #1223 的 progress 记录）。spec 正文本身不回改，读到与本节冲突之处以本节为准。

### A. 与 spec 正文不同的六处

1. **附件「拉到即取」而非读时回取**（对应 §3.6「附件回取」）：puller 追加事件后立刻下载引用的图片
   进本地 `AttachmentStore`，失败进 `missingAttachments` 下次 sweep 重试；§3.6 提到的那几处同步读
   附件字节的闭包（`attachmentStore.read`：分享 / 发布 / 代读员 / data-URL）一个字不动，没有改经
   `attachmentFetch`。
2. **睡眠打断用 `engine.abortTurn("interrupted")`**（对应 §3.6「睡眠 / 唤醒」），`turn_ended.outcome`
   写 `interrupted`；`lastUnanswered` 把它算「没答」、`aborted` 算「答过」。
3. **建行那一批（`expected_seq = 0`）由 RPC 顺手把笔发给创建者**（30 s），不是创建者另外再
   acquire 一次。
4. **分叉出来的兄弟会话不写 `forkedFrom`**（对应 §3.6「冲突」里 `session_created.forkedFrom` 的
   说法）：`store.purge` 会因为引用式分支拒绝抹掉原 id；身份改靠标题后缀「（本机未同步的分支）」。
5. **多一条 push 通道 `taskSessionReplaced`**：purge + 重拉之后渲染层整份重载，spec 正文未提及。
6. **realtime 同时订 INSERT 与 UPDATE**（对应 §3.1「realtime 只订这张表的 UPDATE」）：INSERT 也订
   了，用于另一台设备建会话时的即时感知。

### B. 复审后新增的裁定

7. **有子智能体会话的会话不 purge**：冲突时 `store.purge` 会级联删子会话（从没同步过）；改成冻结
   （`frozen: "has_children_conflict"`）、本地全留、状态里说清，其他设备照旧在云端那份上继续。
8. **持久化的终态标志 `frozen?: string`**（`task-sync.json`）：`forbidden`（RPC 拒收，含超限事件）
   / `has_children_conflict` / `needs_upgrade` / `purge_rejected`（有引用式分支）。冻结的会话
   touched/push/pull 一律跳过、不清；只有 `needs_upgrade` 在每次开机 backfill 时解冻再试。
9. **先验再换**：`replaceWithCloud` 之前用 `shouldPersist` 逐条验云端日志，验不过 = `needs_upgrade`
   冻结、不 purge；拉取时撞到本版本不认识的事件类型（`store.append` 的 `assertNever`）停在那一条、
   保住前缀、冻结 `needs_upgrade`（旧桌面对新版本写的会话提示升级，而不是半截日志）。
10. flush 按轮快照、封顶三轮；出错把同批余下的会话放回；封顶后 dirty 非空 `scheduleRetry`；
    `forkCopy` 末尾 `scheduleFlush`；backfill 也对 `pushedUpTo < 本地末条` 的会话标脏；建行发的笔也
    续期（`granted + startRenew`）；笔丢了清 `granted`。
11. `sliceBatches` 按 UTF-8 字节切批（不是 UTF-16 单元）。
12. 四个 SQLSTATE 常量 `TASK_SQLSTATE` 落 `src/shared/taskSync.ts`，api 与 migration 对表断言。
13. 0036 SQL：`p_events` NULL 守卫、pen RPC 校验 holder、建行竞态 `unique_violation → P0010`、标题
    `btrim`。
14. **复制器的 uid 同步取自 `AccountManager`**（`friends.currentUid()` 在 `onChange` 那一刻还是
    null，照它判 `start()` 永远 no-op）。
15. `taskSync.deleted()` 只对有游标条目的会话打云端 `DELETE`。
16. **turn 准入**：同步的 `admitting` Set 把「判 running」与「add running」之间那次
    `await acquirePen` 盖住（`handleSendMessage` / `answerLogged` / `compact` 三处）；渲染层那
    ~100 ms 窗口再按回车得到既有「还在跑」错误而不是排队。
17. **笔的放法**：try 之前抛错先放笔；`executor_changed` 的 append 在 try 里；收口帮手排空后**只在
    没有下一轮在跑/准入时**放（后台回注紧接着起下一轮）。
18. **held（笔被别人握着）时带 skill 或图片的消息拒收**并说清（`skill_invoked` / `image_described`
    是 executor 类事件，没有笔落不了）；纯文本照落。`answerLogged` 那条路补检查点 +
    `pickAutoModel`，不做图片代读（另一台设备落的带图人话在没有视觉的型号上直接跑）。
19. 后台回注排空 `drainPendingBg` 由两个调用方在各自 `finally` 之后调；held 分支也排空；
    `handleBackgroundDone` 的 queue-up 判据加 `admitting`。
20. 合盖时被打断的会话记进 `interruptedBySuspend`，唤醒后 `pullNow().finally` 之后逐个接着答。

### C. 终审一轮的裁定（合并前最后一轮，均已落地）

21. **推送方临时借的笔推完即放**（C1）：`pushSession` 里两条路会让推送方握上笔——`needsPen && !holdsPen`
    那次 `acquirePen`，以及 `expected === 0` 建行成功后 RPC 发下来那支。三处 `releasePen` 调用点全在
    `index.ts` 的 `driveTurn` 里，只服务「turn 的笔」，这两支没人放：一次 `backfill()` + `flushNow()`
    之后每条任务会话都被本机永久握笔、各起一个 10 s 续期定时器（N 条会话 = N/10 RPC/s，永远），
    第二台电脑永远看到「另一台电脑正在回复」。改成 try/finally，`!isRunning(id)` 时放；turn 在跑时
    不放（那支是 turn 的）。准入那条路会自己再拿一次——多一次 RPC 换「没在跑就不占笔」。
22. **引用式分叉不上云**（C2）：「回到这一步」走 `store.fork()`（零拷贝），分支自己的第一条原始行是
    `session_created{forkedFrom, seq = endSeq+1}`，而 `store.load()` 扁平化后前缀是父会话的 `0..endSeq`
    ——推上去的流里于是有**两条** `session_created`（seq 0 与 endSeq+1），0036 的
    `session_created only at seq 0` 判 P0012 → `freeze(id, "forbidden")`，这条会话永久冻结。
    判据放进 `isTask()`（`store.forkOrigin(id) !== null` → 不是任务会话），touched / backfill /
    deleted 一律跳过。**否决的两条**：改 migration 放行 `seq>0` 的 `session_created{forkedFrom}`
    （拉到另一台机器后 `forkOrigin` 认出 forkedFrom、`load()` 再前缀一遍父会话 = 事件重复 seq 撞车）；
    把任务会话的还原改成复制式（改既有功能的存储语义，不在这一轮）。代价见 §7 第 22 条。
    同一条里给测试的假 RPC 补齐了 0036 `_task_append` 里本来没有的三条（`session_created` 只许在
    seq 0 / 单条事件与 `user_message` 正文的字节上限 / 行 uid 与调用方不同）——假货比真 RPC 宽松的
    地方，正是本机全绿而真库把整条会话冻死的地方。
23. **`executor_changed` 的第一条也要落**（I1）：`driveTurn` 那道门是 `last !== null`，没人写第一条，
    于是 Mac B 接手 Mac A 的会话时 `deriveMessages` 永远给不出「这是另一台电脑，任务文件夹里此前的
    文件不在这台机器上」（§3.5 / §7 第 7 条）。`ExecutorChangedEvent` 加可选 `freshWorkspace?: true`
    （这台机器恢复时发现日志里那个任务文件夹本机没有、于是新建了一个；`first.workspace` 缺席不算
    ——云端建的会话没有「此前的文件」可言）；触发条件加第二支：`last === null && fresh`。
    「该不该落、带不带 fresh」抽成纯函数 `executorChangeFor()` 放 `src/shared/taskSync.ts`。
    投影侧 `changedMachine` 多认 `freshWorkspace` 这一档；`isAuditEvent` / `PRIVACY_VERDICTS` /
    `agentView` / `persistencePolicy` 都不动（同一个事件类型）。
24. **`frozen` 是一种状态 kind，不是一次性的 error**（I2）：`freeze()` 原来只 `setState({kind:"error"})`
    一次，下一轮 `flush()`/`pullNow()` 开头那句 `syncing` 就把它盖掉，收尾再写「任务会话已与账号
    同步」；而 `taskSyncText` 对 error 一律写「会自动重试」——`freeze` 恰恰不 `scheduleRetry`。
    `TaskSyncState` 加 `{kind:"frozen", count, message, lastSyncedAt}`；发布 / 读取前过一层
    `visible()`：idle/syncing 上叠冻结（持久事实压瞬态），error 与 off 照发。`frozenDetail` 跟着
    落盘，重启后那行仍说得出原因。`needs_upgrade` 的文案改成「升级 Mr Otto 后会自动恢复」——它是
    唯一会被 backfill 解冻的一条；其余三条不许出现「重试」。状态行 frozen 走 warn 色。
25. **`SessionSummary.workspaceKind` + 渲染层单一谓词 `isTaskSummary`**（I3，这是 §3.6/§3.7 的修正）：
    `sessionGroups.taskSessions()` 只按路径判，于是云端建的会话（日志里没有 `workspace`）掉进
    「史前会话」、另一台 Mac 建的（本机不存在的绝对路径）在项目栏长出一个外星路径组——两种都是
    这次同步认领来的任务会话。`SessionSummary` 从第 0 条 `session_created` 投影 `workspaceKind`
    （同 `spawnedFrom` 的写法），`isTaskSummary(s, builtin)` = 不是子会话 且（`workspaceKind ===
    "default"` 或 路径是 Default）；`taskSessions` / `archivedTaskSessions` / App.tsx 里五处按路径
    排除任务会话的地方全换成它，「史前会话」的判据跟着收窄成「路径与 workspaceKind 两半都没有」。
26. **未映射的 SQLSTATE 不再永久 30 s 重试**（I4）：`codeOf` 的 default 把一切非网络错误映成
    `other` → `fail()` → 每 30 s 重试、会话永远脏着。`22*`（数据异常，含 22P05 = NUL 字节进 jsonb）
    与 `23*`（完整性约束）改判 `forbidden`（走既有 freeze 终态，message 带原 SQLSTATE 与原文）；
    `PGRST301`（JWT 过期，下次调用 supabase-js 自己会刷）判 `network`（瞬态）。`guarded()` 里那段
    网络正则与 `codeOf` 的合成一个 `isNetworkMessage(msg)`。
27. **`onReplaced` 排在 human_only 重放之后**（minor）：渲染层收到 replaced 就 `resume()` 重读日志，
    先发的话它读到的是还没重放那几条人为动作的版本。
