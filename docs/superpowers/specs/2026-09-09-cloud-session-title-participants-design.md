# 云会话的名字与最近参与的人（#1213）

> 团队侧栏那一列会话全是「新会话」，而且看不出最近谁在里面说过话。
> 两条独立的病，共用一个挂载点和一张表。

## 病根

真机形态：团队「mandy's bubble tea」侧栏五条会话全叫「新会话」。

**① 标题从来没有被写过。** `services/runtime/src/daemon.ts:731` 建云会话时
`title: ""` 写死，此后**没有任何一处更新它**。本机那条路有 `session_autotitled`
（`src/main/index.ts:1146`，搭便宜模型的合并调用），云端一条都没有。所以侧栏那五行是
`displaySessionTitle` 的兜底在说话（#925），不是命名失败——**命名这件事在云端压根不存在**。

**② 「最近谁在这条会话里说过话」今天没有任何数据源。** 权威日志在 VPS 上，桌面够不着
（要先开一条那个团队的会话房才读得到 backlog），而侧栏那行必须在**一条会话都没开**的
时候就画得出来。这与 #1064 点名角标是同一个形状，结论也同一条：只能是 runtime 往
Supabase 写一份**日志的投影**。

## 维护者拍板的三条

1. 会话由**模型**自动命名，**话题漂了就重命名**（不是一条会话只命名一次）。
2. 会话行右边画「最近有过对话的那个 5 小时窗里，有哪些**人类成员**参与过」，
   **叠罗汉头像封顶 3 个**。
3. 窗口是**固定窗**（不重叠的桶，`floor(ts / 5h)`）：当前窗没人说话，就一直保留
   **最后一个有对话的窗**的名单。一旦有过对话，这一格永远不会变空。

第 3 条化简掉了一个维度：既然永远显示「最近一个有对话的窗」，就不需要存历史窗口，
也不需要定时器让它到点过期——**只有一个当前值**。

## 总形状

两件事共用：

- **一个挂载点**：runtime 的 `say()` 落盘之后。
- **一张表**：`workspace_sessions`（标题用已有的 `title` 列，参与者加两列）。

于是：**协议不进位**（两样都走 Supabase 直查，一个帧都不加）、**不新增事件类型**
（标题用已有的 `session_autotitled`，那十一处穷举表一处都不用碰）。

---

## 切片 1 · 标题

### 挂在人类发言落盘之后，不挂在 turn 收口上

群聊里人可以只跟人说话（`resolveTargets` 解出空名单 → 只落一条 `chat_message`，
一个 turn 都不起）。挂在 `outcome === "completed"` 上的话，那种会话**永远不会被命名**。
本机那条路挂 turn 是对的（本机会话必然有 agent 应答），云端不是。

### 档位

`n` = 这条会话累计的人类发言条数（从日志推导，判据同切片 2 的「人类发言」三条）：

| n | 做什么 | 花不花钱 |
|---|---|---|
| `1` | **首行兜底**：这句话首行截 40 字，直接写 `workspace_sessions.title` | 不打网关 |
| `2`，之后每 5 条（`n >= 2 && (n - 2) % 5 === 0`） | **模型命名/重判** | 一次最便宜那款 |

首行兜底不是「凑合」，它是**与本机同一条口径**：本机 `store.ts:617` 的标题投影就是
「手动改名 > `session_autotitled` > 第一条 `user_message` 首行」。云端 `title` 是
Supabase 一列、没有这个投影，所以要显式写一次。它同时是模型那条路的**降级出口**——
网关挂了、所有者没订阅、解析不出，侧栏也不至于停在「新会话」。

第一次模型命名排在 `n === 2` 而不是 `n === 1`：只有一句「你能听到吗」时，模型也只能
起一个烂名字，而 `n === 2` 时通常已经有一问一答。

### 重判把当前标题一起给模型

这是「话题漂了就重命名」不至于让侧栏那行字天天乱变的**全部原因**：模型收到
「当前标题 + 最近 8 句」，回 `KEEP` 或一个新标题。多数轮回 `KEEP`，那一行就不动。
如果不给当前标题、每次都让它重起一个名字，同一段对话会因为措辞抖动被反复改名，
而「人找不到刚才那条会话」是比「名字略旧」贵得多的代价。

### 落地

新模块 `services/runtime/src/sessionTitler.ts`，形状**逐处抄 `dispatch.ts`**：
纯提示词 + 解析 + 一次网关调用，**不碰 store、不知道 `sessionService` 存在**。
谁来调、调完怎么落盘都在 `sessionService` 那一侧。

- 上下文**复用 `dispatchContext`**（已导出、已测、已过 `promptSafe`/`promptSafeBody`）。
  不另写一份取上下文的逻辑：那会是同一个判据的第二份实现。
- 身份头同 `autoModel` / `dispatch`：`x-runtime-secret` + `x-otto-on-behalf-of` +
  workspace/session 头，**照常落 `usage_event`，不做暗扣**（ADR-0237 那条纪律）。
- 输出解析：`KEEP`（大小写不敏感、允许前后空白）→ 不改；其余取首行、去引号、
  截 14 字 → 新标题；空串 / 只有标点 → 当作没判出来。
- **认不出来一律 `null`**，不是「默认保持」也不是「默认重起」——`null` 的调用方语义
  就是「这次没成功，什么都不做」，与 `parseDifficulty` / `dispatchVerdictFor` 同一条。

失败一律回落「今天的行为」：网关非 2xx、超时、所有者没订阅、解析不出 → 不落事件、
不写库，标题保持现状。

### 载体

已有的 `session_autotitled` 事件（最后一条胜出，同本机 `store.ts:502`）+ 同步写
`workspace_sessions.title`。日志是事实，那一列是投影——写库失败不重试，下一次命名
或下一次 daemon 重启会把它补上。

**唯一要动的是 `hiddenFromCloudTimeline`（加第 ⑧ 条）**：「会话被自动命名了」人不能
据此行动，是机器的内务，按 ADR-0235 / ADR-0260 的判据在群聊时间线上藏起来。
`hiddenFromCloudTimeline` **不在**新事件类型那份检查清单里（它是云会话时间线的投影
判据，不是穷举 `Record`），而清单上那十一处**已经**全部认识 `session_autotitled`
——本机那条路早就在落它，一格都不用加。

---

## 切片 2 · 参与者

### 存哪：`workspace_sessions` 加两列，不新建表

migration `0035_cloud_session_participants.sql`（原为 0034，与另一条 lane 撞号后改号）：

```sql
participants        jsonb  not null default '[]'::jsonb   -- uid 数组
participants_window bigint not null default 0             -- floor(ts / 5h)
```

**加列不是新表**，三条理由任一单独成立：

- 这份东西**只有一个当前值**（第 3 条拍板已经化简掉了历史维度），新表会凭空长出一个
  没有消费方的历史维度；
- `listCloudSessions` 已经在查这张表，加两格 `select` 是**零额外往返**；
- RLS 也已经有（`wss_select_member`，在籍即可读），新表要另写一遍。

与 #1064 的 `workspace_mentions` 为什么是新表不矛盾：那份是**一人一行的收件箱**
（主键 `(uid, session_id, seq)`、要按人查、要标已读），这份是会话的一格属性。

写方只有 runtime（service key，绕过 RLS）。**不给 authenticated 的 update**：
给了就是让任何在籍成员伪造「某某参与过」。

### 判据是日志的纯投影

新模块 `src/shared/sessionParticipants.ts`：

```ts
export const PARTICIPANT_WINDOW_MS = 5 * 60 * 60 * 1000;
export function windowIndexOf(ts: number): number;
/** 最后一个有过人类发言的窗，以及那个窗里说过话的人。一条人类发言都没有 → null */
export function lastActiveWindowParticipants(
  events: readonly SessionEvent[]
): { window: number; uids: string[] } | null;
```

倒着扫：找最后一条人类发言 → 算它的窗 `w` → 继续往前收集所有落在 `w` 里的人类
`fromUid` → 遇到 `windowIndexOf(ts) < w` 就停。**有界**（一个 5 小时窗里的消息数），
不扫全量日志。`uids` 去重、按**首次出现**顺序（叠罗汉的画序稳定，不会因为谁又说了
一句就整排跳动）。

放 `src/shared/` 而不是 `services/runtime/`：窗口长度这个常量桌面那侧写 `title`
文案时要用（「最近 5 小时」），而同一个数在两处各写一遍必然分家。runtime 直接 import
`src/shared/`（先例：`workFiles` 直接 import `src/shared/files.ts` 的 `parseRgJson`）。

### 「人类发言」三条

- `chat_message` 且 `fromUid !== "system"`
- `user_message` 且 `fromUid` 在场 且 `relay === undefined` 且 `greeting === undefined`
- agent 的话走 `assistant_message`，**压根没有 `fromUid`**，天然不进

排除 `relay` / `greeting` 是要紧的、也是这条判据里唯一不显然的一处：那两种开场白的
`fromUid` 是**点火的那个人**（ADR-0223 §4.2 / #1174），不排除的话一条接力链会在几小时
之后、在他早就离开的窗里，替他重新「参与」一次。判据与 `hiddenFromCloudTimeline`
第 ①⑦ 条逐字相同——同一件事（「这条 `user_message` 是不是真的有人打出来的」）。

`dispatch: "auto"` 的那条**照常算**：那就是人自己打出来的话，只是收件人由分类器挑
（#1153）。

### 谁写、什么时候写

runtime 在 `say()` 落盘之后算一遍整份、`update` 那两列。

并发（两个人同时说话，来自不同 cid，不在同一条串行链上）只造成**短暂**不一致：
每次写的都是「从日志重算的完整集合」而不是增量，所以乱序落地的后果是某一格暂时少
一个 uid，下一条发言就修正了。daemon 重启从日志重建——**库是投影不是事实**
（同 `archived` 那一列的待遇，#822）。

写库失败只打日志不抛：这一格挂了不该让一句话发不出去。

---

## 切片 3 · 桌面

### 数据

`CloudSessionRow`（`supabaseWorkspacesApi.ts`）/ `CloudSessionListRow`（`shellBridge`）/
`CloudSessionRowView`（`workspaceView.ts`）各加一格 `participantUids: string[]`；
`listCloudSessions` 的 `select` 多两格；解析时**形状不对一律回 `[]`**
（复用 `normalizeStringArray` 同款纪律）。

**一个帧都不加，协议不进位。**

### 刷新

三条路，各管各的：

1. **开着这条会话时收到 `session_autotitled`** → `refreshCloudSessions(workspaceId)`。
   逐字抄旁边 `session_archived` 那条已有的写法（`store.ts:3033`）：判据是日志里那条
   事件，不是「我刚点了什么」。这个事件很稀疏，一次往返不心疼。
2. **开着这条会话时收到人类发言** → 把 `fromUid` **并进**侧栏那行的
   `participantUids`（本地 patch，不打网络）。**只并不删**：窗口边界不在渲染层判，
   下次拉取修正。方向是安全的——最坏是多显示一个刚说过话的人，而反过来
   （少显示一个正在说话的人）才是撒谎。
3. **没开着的会话** → **窗口重新聚焦时重拉一次**。复用 #1064 立下的那条纪律：
   会看到它的那一刻必然是人回到这扇窗前，`focus` 就是那个信号。
   **不做定时轮询、不动 realtime publication**——把 `workspace_sessions` 加进
   publication 会让每一次 `updated_at` 变动推给每个成员，而这一格没有那么急。

监听挂在 `WorkspacesSidebarSection` 已有的那个 effect 上（`ids` 依赖那条）：作用域
天然就是「这一栏在屏幕上」，而看不见的时候本来也不需要刷新。

---

## 切片 4 · UI

`WorkspacesSidebarSection` 的会话行：

```
[标题 flex-1 truncate] [头像堆] [未读角标]
```

- 16px 圆头像，向左重叠 `-ml-1`，每枚 `ring-1 ring-sidebar` 分层；
- 封顶 3 枚，多出来的第 4 格画 `+N`（`N = 总数 - 3`）；
- 头像取 `ws.members` 里那个 uid 的 `avatarUrl`，空串画首字母——同 #971 气泡旁那枚
  的画法，渲染层不必再判 null；
- 名字走已有的 `labelOf(ws, uid)`；**退了群的 uid 照样画**（`labelOf` 回 uid 前 8 位）
  ——「他当时在场」是已经发生的事实，不因为他后来退群而没发生；
- 全名单进 `title`（那一行本来就有 `title`，追一段「最近 5 小时：A、B、C」）；
- **不给入场动效**：它是挂着的状态记号不是一次事件（同 ADR-0255 / #1064 那枚角标）。

一条都没有（`participantUids` 空）→ 整个头像堆不画，行退回改动前的样子。

宽度：侧栏 16rem，会话行可用约 230px。三枚头像 + `+N` 约 56px，标题 `truncate` 让位。
**几何不写成断言**（同 ADR-0236 第 1 条），保鲜期在紧挨类名那段注释里。

---

## 测试

| 断言 | 钉住什么 |
|---|---|
| `lastActiveWindowParticipants`：窗口边界、只留最后一个有对话的窗、去重与首现顺序、空日志回 `null` | 投影本身 |
| 同上：`relay` / `greeting` / `fromUid === "system"` 不算参与 | 唯一不显然的那条判据 |
| `sessionTitler`：`KEEP` / 新标题 / 认不出 → `null` / 网关非 2xx → `null` / 超长截断 | 「判不出来一律回落」 |
| 档位：`n===1` 走兜底不打网关、`n===2` 与每 5 条打一次、其余不打 | 花钱的那条判据 |
| `hiddenFromCloudTimeline("session_autotitled") === true` | 第 ⑧ 条 |
| 侧栏那一行**真渲染一遍**（头像堆出现/封顶/`+N`/空名单不画） | 同 #1068 的纪律：纯逻辑钉不到「有没有被画出来」 |

## 已知代价

1. 固定窗按 epoch 切，边界落在 UTC 00/05/10/15/20（悉尼 11:00/16:00/21:00/02:00/07:00），
   跟谁的作息都不对齐。因为总是显示「最近一个有对话的窗」，相位基本无感——但
   一条会话可能在 10:59 和 11:01 各有一个人说话，画出来只有后者。
2. 重判每 5 条人类发言一次，忙的群里是常态开销（每次约 $0.00005，算所有者的额度）。
3. 参与者只在桌面**回到前台**时刷新，一直开着不动的窗口里那排头像会陈旧。
4. 只做桌面——手机端还没有云会话客户端。
5. **要跑 migration 0035 + 重新部署 runtime 才生效**（#791）。
6. 首行兜底写的是**发言原文**首行，可能很难看（比如一句「在吗」）；模型那一跑
   （`n === 2`）会覆盖它，但两句之间那段时间侧栏上就是那句话。

## 明确不做

- **手动重命名**：维护者选的是「话题漂了就重命名」这一档，没要手改。
  `session_renamed` 压过 `session_autotitled` 的规矩已经在本机那条路上了，
  将来要加是纯增量。
- **agent 头像不画**：要的是「人类成员」。混着画会让「谁在场」这个问题多一个含义。
- **参与者历史窗口不留**：只存当前那一份（第 3 条拍板化简掉的那个维度）。
- **realtime 不接**：focus 刷新已经覆盖「会看到它的那一刻」。
- **不给替身**：参与者为空时不退回「显示创建者」——「没人说过话」和「某人说过话」
  是两件事，用创建者顶上就是编一个没发生的参与。
