# 好友系统设计（Friend System）

日期：2026-08-18
状态：已与 stanyan 对齐（会话内逐节确认）

## 目标

真人用户（Supabase 账号）之间互加好友，一期交付全部三块能力：

1. **关系链**：邮箱精确搜索用户、发好友请求、接受/拒绝、好友列表、删好友
2. **在线状态**：好友列表显示在线/离线
3. **好友聊天（DM）**：好友之间一对一实时消息

不分期，一个 PR 全量交付。

## 方案选型

**Supabase 直连**（已确认）：复用现有账号体系（`src/main/account.ts` 的 supabase client 与登录态），表 + RLS 保安全，Realtime 做在线状态与消息推送，零自建服务器。

否决项：自建后端（部署运维过重）、纯轮询（在线状态/消息延迟差）。

## 数据模型（Supabase）

Migration SQL 入库 `supabase/migrations/0001_friends.sql`，由 stanyan 在 Supabase SQL editor 跑一次（或授权 supabase MCP 后由 agent 执行）。

### profiles

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | = auth.users.id |
| email | text unique | 搜索键 |
| name | text | 显示名 |
| avatar_url | text | 头像 |
| updated_at | timestamptz | |

- auth.users 的 insert/update 触发器自动同步（SECURITY DEFINER 函数）
- RLS：authenticated 可 select（支撑邮箱精确搜索）；仅本人可 update

### friendships

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| requester | uuid FK profiles | 发起方 |
| addressee | uuid FK profiles | 被请求方 |
| status | text | `pending` \| `accepted` |
| created_at / updated_at | timestamptz | |

- 无序对唯一索引 `(least(requester,addressee), greatest(requester,addressee))` 防双向重复
- RLS：仅当事双方可 select；requester 可 insert（强制 status=pending 且 requester=auth.uid()）；addressee 可 update（仅 pending→accepted）；双方均可 delete（拒绝=删行，删好友=删行）
- 自加好友被 check 约束拒绝（requester <> addressee）

### messages

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint identity PK | |
| sender | uuid FK profiles | |
| recipient | uuid FK profiles | |
| body | text | |
| created_at | timestamptz | |

- RLS：仅收发双方可 select；insert 要求 sender=auth.uid() 且存在双方 accepted 的 friendship（policy 子查询）
- 加入 Realtime publication（`supabase_realtime`）

### 在线状态

不建表。Supabase Realtime **Presence** channel（如 `online-users`），客户端登录后 track 自己的 user_id，订阅端聚合出在线集合。

## 主进程：`src/main/friends.ts`（FriendsManager）

- 与 AccountManager 共用同一个 supabase client 实例（同一登录态、同一 authStorage）
- 照 account.ts 的 `SupabaseLike` 注入模式扩一个 `FriendsSupabaseLike` 最小接口（`from().select/insert/update/delete`、`channel()`、`removeChannel()`），单测注入假实现，不实例化真 client、不发网络请求
- 登录后：订阅 friendships / messages 的 postgres_changes（按自己 uid 过滤）+ 加入 presence channel；登出：全部退订

### ShellBridge 新增（`src/shared/shellBridge.ts`）

请求/响应：

- `searchUserByEmail(email)` → `FriendProfile | null`（精确匹配）
- `sendFriendRequest(userId)` / `respondFriendRequest(friendshipId, accept: boolean)` / `removeFriend(friendshipId)`
- `listFriends()` → `{ friends, incomingRequests, outgoingRequests }`（一次拉全）
- `sendDirectMessage(friendId, body)` / `listMessages(friendId, before?)`（分页拉历史）

订阅（main 推）：

- `onFriendsChanged(snapshot)` — 关系链任何变化推全量快照（量小，快照比增量简单）
- `onPresenceChanged(onlineUserIds: string[])`
- `onDirectMessage(message)`

类型层新增 `FriendProfile` / `FriendshipEntry` / `DirectMessage` / `FriendsSnapshot`，只走可序列化纯数据，token/session 永不过 IPC（沿用既有安全硬约束）。

## 渲染层

- **侧边栏常驻「好友」区**（已确认，非叠加面板入口）：好友列表 + 在线圆点 + 待处理请求角标；「添加好友」邮箱输入 → 搜索结果 → 发请求；收到的请求就地 接受/拒绝
- **DM 聊天面板**：点好友 → 右侧半屏叠加面板（复用 Protocol/Git Graph 的交互模式与互斥收口，agent 会话不失焦，可展开全屏）；消息列表 + 输入框，Realtime 即时到达
- `store.ts` 加 friends slice（快照、在线集合、当前打开的 DM、未读计数）；与 `protocolOpen`/`gitGraphOpen` 同套互斥逻辑加 `friendChatOpen`
- 样式 Tailwind + shadcn/ui（既有约定）

## 错误处理

- 未登录：好友区显示「登录后可用」占位，所有 bridge 方法返回明确错误
- 网络/RLS 拒绝：bridge 方法返回 `{ ok: false, message }` 形态，UI toast/内联提示，不崩
- Realtime 断线：supabase-js 自动重连；重连后主进程重拉快照推一次 `onFriendsChanged`
- 重复请求/已是好友：唯一索引冲突映射成可读错误（「已发过请求」）

## 测试（vitest，`tests/` 镜像 `src/`）

- FriendsManager 全逻辑走假 `FriendsSupabaseLike`：请求/接受/拒绝/删除的状态流转、快照映射、presence 聚合、登出清理
- 纯函数单测：无序对规整、snapshot 分组（friends/incoming/outgoing）、错误映射
- 渲染层：store slice 的 reducer 级测试
- RLS 无法离线测：migration SQL 内注释写明每条 policy 意图，人工在 Supabase 后台验证一次
- 门禁 `npm test` 全绿才收工

## 交付物清单

1. `supabase/migrations/0001_friends.sql`
2. `src/main/friends.ts` + `src/main/index.ts` 接线（IPC handler + 生命周期）
3. `src/shared/shellBridge.ts` 类型与频道扩充 + preload 桥接
4. 渲染层：侧边栏好友区组件、DM 面板组件、store slice
5. `tests/` 对应测试
6. `docs/adr/`：新 ADR 记录「好友系统走 Supabase 直连」架构决策
