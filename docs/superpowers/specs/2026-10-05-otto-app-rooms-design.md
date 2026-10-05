# Otto 应用的「房间」——和好友一起玩 / 一起记 —— 设计

- 日期：2026-10-05
- Task issue：#1675（来源：#1661 端到端测试）
- 维护者原话：「做一些更复杂的应用，做一些可以和好友互动的应用和游戏」；选「先补平台能力再测」。
- 关系：Otto 应用框架（#1591，`docs/superpowers/specs/2026-10-05-otto-apps-design.md`，§7 预告过「多人共用一个应用 → app_data 的隔离要重想」）、
  应用分享（#1648，`src/shared/appCard.ts` / `services/runtime/src/appShare.ts`）、朋友私聊推送（#1442，`friendPush.ts`）、好友档位（ADR-0355 一带）。
- 范围：**Supabase（migration + RLS + RPC）+ 手机宿主 + 桥 + 应用专员提示词 + runtime 一个推送订阅**。桌面不在本期。

## 0. 维护者已拍板（2026-10-05，会话里）

1. 四类互动都要：**回合制对战、共享数据（AA 账本 / 清单）、一次性挑战（默契测试 / 出题）、实时对战**。
2. 加入方式：**邀请卡自动装**——应用里点「邀请好友」→ 私聊里一张卡 → 对方点开，没有这个应用就自动添加副本，直接进同一局。
3. 版本：**进局跑房主那一版**——一局钉住房主建局时的应用版本，成员在这一局里跑的是那一版的文件；成员自己副本的版本不动。
4. 智能体：**第一版只人和人**——房间里只有人；智能体只负责做应用。轮到谁 / 有人记了一笔，发普通推送。
5. 走法：**方案 A**——房间直接建在 Supabase 上（表 + RLS + Realtime），不经过 runtime 中继。
6. 其余细节维护者交给实现方按已有线索判断（「你根据已有线索判断下」）——下文 §3–§6 的取舍都写了理由，推翻前提见 §9。

## 1. 已验前提（2026-10-05，只读核过）

- `app_data` 按 `(app_id, uid)` 隔离，RLS `uid = auth.uid()`；`apps` / `app_versions` / `otto-apps` 桶都只给本人读（0063）。
- 分享 = 复制：`acceptAppShare` 核私信（发给你、发的人对得上、还是好友、源应用这一版还在）→ 复制文件 + 建一行 apps，`createdByAgent = share:<源 appId>`。
  **所以副本知道自己的源**——「同一个应用的一家子」现成可认。
- 手机 → runtime 的 `app_accept` 帧（cs 协议 29）。**cs 协议是严格相等握手**（`frameHandler.ts`：`v !== CS_PROTOCOL_VERSION` 即拒）：加帧 = 进位 = runtime 与所有手机必须同时换版。
  本设计因此**不加帧**（见 §4.1）。
- `decodeAppCard` 只读 `env.card` 里认识的格，不拒信封上多出来的键——在信封上加 `room` 一格，老手机 / 老 runtime 仍把它当普通应用卡。
- Supabase Realtime 手机端已在用（`tasks` / `agent_activity` 的 postgres_changes、好友在线的 presence）；runtime 用 service key 订 `messages` 的 INSERT 推送朋友私信（`friendPush.ts`）——
  房间提醒照这个形状。
- 推送开关 / 免打扰都在 `notifier`（runtime）。
- 最新 migration 0066。

## 2. 它是什么

**房间 = 一个应用的一局 / 一本共享的账**。房主在自己的应用里开一间，邀好友进来；房间里有一份成员共读写的键值数据（持久）和一条成员间的即时消息通道（不进我们的表；`realtime.send` / 客户端 broadcast 在 `realtime.messages` 里会留一个保留期，不是「完全不落地」）。
应用自己决定什么进房间：五子棋把棋盘放进房间，自己的战绩留在个人 `storage`；AA 账本整本放进房间。

四类互动在房间上的样子：

| 类型 | 用房间的哪一半 | 例 |
|---|---|---|
| 回合制 | 共享数据 + `ifRev` 防抢写 + `ping` 叫对方 | 五子棋：`board` 一键，落子 `set(board, …, {ifRev})`，然后 `ping("轮到你了")` |
| 共享数据 | 共享数据 + `change` 事件 | AA 账本：每笔一个键 `e:<时间戳>`，谁记谁写，大家实时看到 |
| 一次性挑战 | 共享数据（各写各的键） | 默契测试：出题人写 `q`，答题人写 `a:<uid>`，双方看比分 |
| 实时对战 | 即时消息（broadcast）+ 结束时写一份结果 | 抢答：题目 / 抢答信号走 `send`，比分最后 `set` |

## 3. 数据模型与权限（migration 0067，号码合并时认领）

```
app_rooms         id uuid pk · host_uid → auth.users · host_app_id → apps (on delete cascade)
                  · host_version int（建局时钉死）· title text（1–40）· closed bool default false
                  · created_at / updated_at
app_room_members  room_id → app_rooms (cascade) · uid → auth.users · status 'invited'|'joined'|'left'
                  · invited_by uuid · joined_at · pk (room_id, uid)
app_room_data     room_id → app_rooms (cascade) · key text (1–200) · value jsonb（≤ 64 KB）· rev bigint
                  · updated_by uuid · updated_at · pk (room_id, key)
app_room_pings    id bigserial · room_id · from_uid · text（1–80）· created_at
```

- **成员判据**一个函数：`is_room_member(room uuid) → bool`，只看 `status = 'joined'`、只问当前登录的人（`auth.uid()`，不带 uid 参数，所以拿它探不了别人在哪间房）；**房间关了照样算成员、照样能读**，关房后的写由各 RPC 自己拦（「这一局已经结束了」）。security definer、`stable`，各条 RLS 都调它，判据只有一处。broadcast 那一侧同形：`room_topic_readable(topic text)` / `room_topic_writable(topic text)`（见下）。
- **读**：`app_rooms` / `app_room_members` 成员与被邀的人能读；`app_room_data` 只有 joined 成员能读。
- **写只走 RPC**（表本身对 authenticated 只开 select）。每个 RPC 自己核一遍，security definer：
  - `app_room_create(app_id, title) → room`：`apps.owner_uid = auth.uid()`；版本取那个应用的 `current_version`；房主自动 joined。每人同时开着的房间 ≤ 50。
  - `app_room_invite(room, uid)`：调用人是房主；对方是 accepted 好友（`friendships`）；房间人数（invited + joined）≤ 8；已在就幂等。
  - `app_room_join(room)`：调用人是 invited（或 left 后被再邀）；→ joined。
  - `app_room_leave(room)`：成员 → left；房主离开 = 关房（`closed = true`，数据留着只读）。
  - `app_room_set(room, key, value, if_rev bigint default null) → {ok, rev} | {ok:false, rev, value}`：成员才能写；`if_rev` 给了且对不上 → 不写，回现值（回合制两个人同时落子，后到的被拒，不互相覆盖）；`rev` 每次 +1。
    单房间键数 ≤ 500、单值 ≤ 64 KB（超了抛错，应用拿到的是 reject）。
  - `app_room_remove(room, key)`：同 set 的成员判据。
  - `app_room_ping(room, text)`：成员才能发；同一人同一房间 10 秒一条、每小时 60 条（超了静默丢弃并回 false，不抛——提醒丢一条不该让游戏报错）。
- **跑房主那一版**：`app_versions` 加一条 select 策略——`exists 房间 r where r.host_app_id = app_id and r.host_version = version and is_room_member(r.id)`；
  `otto-apps` 桶加对应的 select 策略（路径 `<host_uid>/<host_app_id>/<host_version>/…`）。**只放钉住的那一版**，房主别的版本、别的应用仍读不到。
- **两条私有 broadcast 频道**（`realtime.messages` 上两条策略，都要 `extension = 'broadcast'`）：
  - `room:<id>`：成员互发的即时消息（应用自己的 `msg`）。joined 成员可读可写；**房间关了就不能再写**（`room_topic_writable` 判 `closed`）。
  - `room-sys:<id>`：系统事件（`change` / `members` / `closed`），**只有触发器能发**。成员只读、客户端写不了，所以没人能伪造 `change`（假的 `rev` / `by` 会搅乱别人的 if_rev 状态）、`members` 或 `closed`。关了的房间仍可读。
  - 判据是两个函数，都不带 uid、用 `auth.uid()`：`room_topic_readable(topic)`（`room:` 或 `room-sys:` + 合法 uuid、且是 joined 成员）、`room_topic_writable(topic)`（只认 `room:`、是 joined 成员、房间没关）。
  - 这些消息不进我们的表，但 `realtime.send` 会在 `realtime.messages` 里留一个保留期的行，不是「不落库」。
- **变更推送走触发器 + 私有 broadcast，不走 postgres_changes**：`app_room_data` / `app_room_members` **不**进 `supabase_realtime` publication——postgres_changes 的 DELETE 事件不过 RLS，任何登录用户订阅这两张表都会收到别人房间的 `(room_id, key)` / `(room_id, uid)`。
  改为两个 `AFTER INSERT OR UPDATE OR DELETE` 行触发器（security definer）调 `realtime.send(payload, event, 'room-sys:' || room_id, true)` 往私有频道 `room-sys:<id>` 发（不是成员能写的 `room:<id>`）：
  `app_room_data` → 事件 `change`，载荷 `{key, value, rev, by}`（删除时 `{key, removed: true}`）；`app_room_members` → 事件 `members`，载荷 `{uid, status}`（删除时 status 为 null）。
  另有一个 `AFTER UPDATE` 触发器挂在 `app_rooms` 上：`closed` 由 false 变 true 时发事件 `closed`，载荷 `{closed: true}`。
  投递由上面 `realtime.messages` 的 select 策略把关，只有 joined 成员收得到。触发器里发送失败吞掉（不回滚写入）——漏一条通知，应用回前台时重读对齐即可。
  只有 `app_room_pings` 留在 publication（runtime 用 service role 订；客户端没有它的 select 策略）。
- **频道授权在加入（join）时评估**：Realtime 在客户端 join 频道时判一次，退房 / 关房要等客户端重新 join 或刷新 token 才生效，不是逐条消息判；写入不靠它，写永远走 RPC 并由 RPC 核成员与房间状态。
- 个人 `app_data` 不动。

**为什么写只走 RPC**：比较后再写（`if_rev`）、人数上限、好友判据、限速都要在一个事务里判；拆成「RLS + 客户端先读后写」就是竞态。

## 4. 邀请与加入

### 4.1 邀请卡（不进位协议）

信封沿用应用卡（`otto.app-card` v1），**在信封上多一格** `room: { id, title }`：

```json
{ "otto": "otto.app-card", "v": 1, "card": { …同分享卡… }, "room": { "id": "<uuid>", "title": "五子棋 · 第 3 局" } }
```

- 老手机：当普通应用卡显示、点「添加」照样复制——只是进不了局，不坏。老 runtime：`acceptAppShare` 不读 `room`，复制照常。
- 新手机：气泡画成「邀请你一起玩「五子棋」」+「加入」。
- 发卡的是房主的手机：`app_room_invite` 成功后往私聊写这条信封（同 #1648 发应用卡那条路，`sendToFriend`）。私聊一写，`friendPush` 自然推给对方。

### 4.2 点「加入」

1. 已有这个应用的副本（`createdByAgent = share:<host_app_id>`）或自己就是房主那个应用 → 跳过复制；否则走现有 `app_accept`（runtime 复制一份，`already` 也算成功）。
2. 手机直连 `app_room_join(room)`（RLS 判是否被邀）。
3. 打开 `MiniAppScreen`，`route.params = { appId: 我的副本, roomId }`——**房间模式**（§5.2）。

复制失败（已不是好友 / 房主删了应用）→ 卡上一行原因，不进局。被邀但没点的，房主那边成员列表显示「已邀请」。

## 5. 桥与宿主

### 5.1 `window.otto.room`（新能力 `room`，清单里要声明）

```
otto.room.current()                    → 当前房间 {id, title, hostUid, version, me:{uid,name}, members:[{uid,name,status}]} | null
otto.room.create({title})              → 建一间并进去（宿主重载进房间模式）
otto.room.invite()                     → 宿主弹好友选择（同分享那个选人框）→ 发邀请卡 → 回被邀的 uid 列表
otto.room.rooms()                      → 我在的、属于这个应用一家子的房间 [{id,title,hostUid,closed,updatedAt}]
otto.room.open(id)                     → 宿主重载进那一间
otto.room.leave()                      → 离开（房主 = 关房）
otto.room.get(key) / list(prefix)      → 值 / [{key,value,rev,by}]
otto.room.set(key, value, {ifRev?})    → {ok:true, rev} | {ok:false, rev, value}（不抛：冲突是正常分支）
otto.room.remove(key)
otto.room.send(msg)                    → 即时消息（JSON ≤ 4 KB，每秒 ≤ 20 条，超了 reject）
otto.room.ping(text)                   → 推给其他成员（限速见 §3；被限速回 false）
otto.on(event, cb) / otto.off(event, cb)
   "room.change"  {key, value, rev, by}   别人（也含自己别的设备）改了一个键
   "room.message" {from, msg}             即时消息
   "room.members" {members}               有人加入 / 离开
```

- `APP_BRIDGE_JS` 加事件管线：宿主 `injectJavaScript("window.__ottoEvent(name, payload)")`，桥里按名字分发给 `otto.on` 注册的回调。
- 不在房间里（`current()` 为 null）时调 get/set/send/ping → reject「还没进房间」。
- 能力白名单：`APP_CAPABILITIES` 加 `room`；`capabilityOf` 把 `room.*` 归 `room`；`bridgeDenied` 不变。

### 5.2 宿主（`MiniAppScreen` 房间模式）

- 有 `roomId`：读房间 → 用 **`host_uid / host_app_id / host_version`** 拉清单与文件（`ensureAppFiles(hostUid, hostAppId, hostVersion, files)`，RLS 已放行）→ 以那一版的入口页载入。
  个人 `storage.*` 仍落在**我自己那份应用**（`appId` = 我的副本）的 `app_data` 下——战绩不跟着房间走。
- 订阅：订两条私有 broadcast 频道，按事件名分发——`room-sys:<id>` 上的 `change` → `room.change`、`members` → `room.members`、`closed` → 宿主切成只读；`room:<id>` 上的 `msg`（应用自己发的即时消息）→ `room.message`。**宿主只信 `room-sys:` 上的系统事件**；应用发的 `msg` 一律当应用数据，不当系统事件处理。不用 postgres_changes（见 §3：DELETE 事件绕过 RLS）。
  离开页面就退订。回到前台重订并补一次 `list("")`，让应用自己对齐（断线期间的变更不逐条补发）。
- 顶栏在房间模式下显示房间名 +「邀请」；不在房间时保持原样（分享 / 改一下）。
- 推送点开：带 `roomId` 的深链进房间模式。

### 5.3 jsdom 试开与静态检查（runtime `build_app`）

- jsdom 试开的假桥补 `otto.room` 与 `otto.on`（`current()` 回 null，其余回空成功）——没这一步，用了 `room` 的应用在打包时就会「报错」被拒。
- 静态检查不变（`room.send` 不是外网，规则只拦 fetch / XHR / WebSocket 等）。

## 6. 推送（runtime）

- `roomPush.ts`：service key 订 `app_room_pings` 的 INSERT → 推给该房间**其他 joined 成员**：标题「<发的人>·<应用名>」，正文 = `text`，深链带 `roomId`。
  推不推交 `notifier`（开关 / 免打扰照旧）。形状同 `friendPush.ts`，同样的已知代价：realtime 断线期间的不补推。
- 不对 `app_room_data` 的每次写都推——太吵；要不要叫人由应用决定（`ping`）。

## 7. 应用专员那一侧

- `tierPrompt` 的 appsLine 加一句房间：「要和好友一起玩 / 一起记的，清单声明 `room`，用 `otto.room`（create / invite / get / set(ifRev) / send / ping，`otto.on('room.change'|'room.message')`）；
  个人的东西仍放 `otto.storage`；回合制落子用 ifRev 防抢写，落完 ping 对方」。完整 API 写进 `build_app` 的工具说明（专员写应用之前就看得到；沙箱里的 `/work/.otto/appcheck/` 要第一次 build_app 才生成，不适合放文档）。
- 管理员那段：「和好友一起玩 / 一起记」的需求是应用域的活，照常派；不再说「做不了」。

## 8. 测试

- **SQL 层**：`supabase/checks/0067_app_rooms.check.sql`——两个测试 uid 模拟：非成员读不到数据、被邀未加入写不进、`if_rev` 冲突回现值、第 9 人邀不进、非好友邀不进、限速、关房后只读、只放钉住那一版的 `app_versions` / 桶对象。
- **纯逻辑**（vitest）：`src/shared/appRoom.ts`（信封编解码含 `room`、`room.*` 的参数校验与限额、`capabilityOf`）、`appBridge` 事件分发、`MiniAppScreen` 房间模式的接线测试（同 `tests/mobile/miniAppWiring.test.ts`）、`roomPush` 的行解析与收件人计算、build_app 假桥对用了 `room` 的应用试开不报错。
- **端到端**（#1661 的驱动 + 验收台扩成两个账号）：dev qq 号（2819d0bb…，`mr-otto-dev`）与主号（32c6716a…，`mr-otto`）——两号已是 accepted 好友（2026-10-05 查过；herz 号不是）。
  让管理员做五子棋 / AA 账本 / 默契测试 / 抢答四个应用，验收台开两个页面各代表一个人、真连 Supabase，验同步、冲突、即时消息、ping 推送落表。

## 9. 推翻它的前提

- Supabase Realtime 在悉尼 ↔ 项目所在区的延迟撑不住实时对战（broadcast 往返 > 300 ms）→ 实时那半改走 edge 上新开的、落在 OC 区的 DO 房间。
- 维护者要智能体进房（当对手 / 裁判 / 读 AA 账本）→ 成员表加 `agent:<id>` 一类成员，runtime 以 service role 代它读写，另开一期。
- cs 协议改成「最低兼容版本」而不是严格相等 → 邀请可以改走 runtime 帧，一次核完复制 + 入局。

## 10. 分期

| 期 | 内容 | 上线方式 |
|---|---|---|
| **1** | migration 0067（表 / RLS / RPC / Realtime 策略 / 版本与桶的读放行）+ 桥 `otto.room` + 宿主房间模式 + 邀请卡 + build_app 假桥 + 专员提示词 | migration（维护者点头）→ runtime 部署 → OTA |
| **2** | `room.ping` 推送（`app_room_pings` + `roomPush.ts`）+ 推送深链进房间 | runtime 部署 → OTA |
| **3** | 端到端：四个样板应用两账号验收（#1661 续） | — |

第 1 期不带推送也能玩（双方都开着应用时实时同步）；第 2 期让回合制「轮到你了」能叫醒对方。
