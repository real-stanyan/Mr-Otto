# 手机端智能体聊天本地缓存：先画存着的，连上再以服务器为准 —— 设计

- 日期：2026-09-29
- Task issue：#1426
- 维护者原话：「现在加载 agent 会话有点慢，可以做本地保存加快加载速度」

## 维护者已拍板（2026-09-29）

1. 做「本地缓存，先画后补」：点进去先画本机存着的，同时照常连接；服务器那份到了以服务器为准。
2. **不做**提前连接（手指按下列表那一行就开始握手）。
3. 连接中照旧不能发送（发送钮等 ready）；不做「连接中先发、连上补发」。
4. 范围：和智能体的聊天——私聊、主场群聊、团队群（都走 `mobile/src/cloud/chatStore.ts`）。朋友私聊
   （`friendsStore`，另一套数据）不动。

## 0. 已验前提

1. **慢的是握手，不是历史大小**。VPS 上真机截图那条群（`e968b0ce`）一共 4 条事件。打开一条聊天是：
   `openChat` 把 `events: []`、`state: "connecting"` 放进 store → `cloudClient.join` 连中继、hello 验籍、
   welcome、backlog → backlog 最后一片（`done: true`）送完才翻成 `ready`。这一整段里 `chatCentre`
   因为 `eventCount === 0` 画转圈（`cloudEmptyState` → `skeleton`）。
2. **日志只增不改**（Hard rule），每条事件在一条会话里有唯一 `seq`，同一 seq 的内容永远相同。所以
   本机存下来的事件不会「过时」，只会「不全」。`insertCloudEvent` 按 seq 二分插、同 seq 去重，
   先放缓存、再收服务器的，顺序无所谓。
3. **`ready` 之前 store 只收到 backlog 的事件**：客户端把 ready 之前到的直播事件攒在 `liveBuffer` 里，
   最后一片 backlog 时一起按 seq 排好转发（`cloudSessionClient.ts`），随后才推 `state: "ready"`。
   所以第一次翻成 ready 的那一刻，服务器这一轮要给的历史已经全部进了 store。
4. **聊天走尾巴模式**：`welcome.chat` 在场时 backlog 只下发最后 `BACKLOG_TAIL_DEFAULT = 200` 条，
   更早的靠 `loadOlder`（`beforeSeq` = 客户端记的 `oldestSeq`）。团队会话（`chat` 缺席）一次下发全量。
5. **本机持久化用 `expo-sqlite/kv-store`**，App 已经在用（supabase 的 session、外观、已读游标
   `seenStore`）。已读游标按账号分键（`otto.wx.seen.<uid>`，ADR-0187 本机数据跟着账号走），写盘攒一下再写。
6. 语音那一层（`voiceSession`）只在 `ready` 之后才动：拨号、接回电、加入通话都等 ready，
   `startCall` 在发帧前按 `chatEvents` 的尾巴记 `sinceSeq`。缓存里的事件在 ready 之前放进 store，
   不经 `activity.event`（与今天 `openChat` 直接放 `events: []` 同一个位置），不会被当成新事件念出来。

## 1. 缓存的内容与边界

- 键：`otto.chatCache.<uid>.<sessionId>`；索引：`otto.chatCache.<uid>.index`（`[{ sessionId, ts }]`，
  ts = 上次写入时刻）。
- 值：`{ v: 1, events: SessionEvent[] }`，JSON。事件原样存，不做字段裁剪——哪些事件画得出来是
  渲染那一层的判据（`chatRows` / `hiddenFromCloudTimeline`），缓存层不复制第二份。
- 上限（`src/shared/chatCache.ts` 的常量）：
  - 每条聊天最多 `CHAT_CACHE_MAX_EVENTS = 200` 条（= 服务器第一页的大小，多存没有意义：连上之后
    比那一屏更早的会被扔掉，见 §3）；
  - 每条聊天序列化后最多 `CHAT_CACHE_MAX_BYTES = 300 * 1024` 字节：工具结果可能很大，超了从最旧的
    开始丢，直到不超；丢到只剩最新一条仍然超，这条聊天就不存（存一条巨大的事件不如不存）；
  - 最多 `CHAT_CACHE_MAX_CHATS = 30` 条聊天，超出按索引里的 ts 从最久没写的删。
- 流式碎片（`streaming`）不存：它不是事件，是一帧的预览。
- 读出来的东西**不信**：版本不对、不是数组、事件缺 `seq`（非数字）或 `sessionId` 不等于这条，
  整份当没有（回 null，按没有缓存打开）。

## 2. 什么时候写、什么时候删

- 写：这条聊天 `events` 变了之后攒 1 秒写一次；`closeChat` 时把手上那份立刻写一次。只写对账之后
  （`provisional` 为假）的状态——对账之前 store 里是「缓存 + 半截 backlog」，写回去没有新信息，
  还可能把缓存里本该在对账时扔掉的那截再存一遍。没连上就离开的，不写。
- 写的时候先按 §1 截断，再更新索引、按上限淘汰。
- 删这一条：打开之后 `state` 变成 `denied`（没权限 / 会话没了），清掉这条缓存。`gone`（连接断了）不删。
- 删全部：`supabase.auth.onAuthStateChange` 收到 `SIGNED_OUT` 时，清掉**那个账号**的全部缓存与索引
  （消息是私人内容，同一台手机下一个登录的人不该在磁盘上留着它；已读游标不清是因为它不含内容）。
- 写 / 删失败一律吞掉：缓存只是加速，失败的后果是下次照旧转圈。

## 3. 打开与对账

`openChat(workspaceId, sessionId, …)`：

1. 读缓存（本地 sqlite，毫秒级），拿到就把 `events` 设成缓存那份，**同时记下这些是缓存来的**
   （`provisional: true` 这一格在 store 的 session 上，另记一个 `serverMin: number | null`，初值 null）。
   读缓存与 join 之间照旧查 `gen`（人已经离开这一页就不接着连）。
2. 照常 `cloudClient.join`。
3. 在 `provisional` 为真期间，每条经 `onEvent` 进来的事件更新 `serverMin = min(serverMin, e.seq)`。
4. **第一次翻成 `ready`** 时对账（`reconcileCachedEvents(events, serverMin)`，纯函数）：
   - `serverMin === null`（服务器一条都没给）：缓存来的全部扔掉——服务器说这条会话没东西，就以它为准；
   - 否则扔掉 `seq < serverMin` 的（那只可能是缓存来的）。服务器那一屏是从 `serverMin` 连续到
     末尾的，扔掉更早的就不会留下「缓存到 150、服务器从 300 开始」的断档；更早的历史照旧由
     `loadOlder` 向服务器要。
   - 然后 `provisional = false`，之后的重连（`gone → connecting → ready`）不再对账。
5. 团队群一次下发全量，`serverMin` 就是日志第一条，对账什么都不扔（缓存那些全被去重掉）。

画面上：打开瞬间有内容；连上时新消息补进来；若缓存比服务器那屏更长，顶上多出的那一截会在连上时
消失——列表是倒着的、人停在底部，看不到那一截的变化。

## 4. 代码落点

- `src/shared/chatCache.ts`（纯，进 vitest）：常量、`trimForCache`、`serializeChatCache` /
  `parseChatCache`、`reconcileCachedEvents`、`touchCacheIndex`（更新 ts、按上限算出要淘汰的
  sessionId）、索引的 parse / serialize。
- `mobile/src/cloud/chatCache.ts`（IO）：`loadChatCache(uid, sessionId)`、`scheduleChatCacheSave(uid, sessionId, events)`
  （1 秒攒一次）、`flushChatCacheSave()`、`removeChatCache(uid, sessionId)`、`clearChatCaches(uid)`，外加
  `SIGNED_OUT` 接线。kv-store 没有「列出前缀」，所以清全部靠索引。
- `mobile/src/cloud/chatStore.ts`：`openChat` 读缓存 + `provisional` / `serverMin`；`onEvent` 记 serverMin
  并在 ready 之后排写；`onStatus` 第一次 ready 对账、denied 删；`closeChat` 立刻写。`ChatSession` 多
  `provisional: boolean`。

## 5. 不做的

- 提前连接（维护者拍板 2）。
- 连接中发送（拍板 3）。
- 朋友私聊的缓存（拍板 4）。
- 聊天列表的缓存：列表那一格的最后一句、时间来自 `workspace_sessions` 的投影，不在这条线上。

## 6. 测试

- `tests/shared/chatCache.test.ts`：截断（条数、字节、单条超上限不存、留最新的）；parse 拒绝坏数据（版本、
  非数组、seq 非数字、sessionId 不符）；对账（serverMin 为 null 全扔、扔 `seq < serverMin`、团队全量不扔、
  重复 seq 已被 insert 去重的前提下结果有序）；索引（touch 更新 ts、超 30 条淘汰最久的、同一条重复
  touch 不重复）。
- 手机接线：`npx tsc --noEmit -p mobile`。效果（点进去不转圈）真机看。

## 7. 上线

只改手机 JS，服务端一行不动。开发版重启 Metro 即生效。

## 8. 决策记录

ADR（编号合并时定）：「手机本机缓存云会话事件，只作首屏占位、连上以服务器为准」——事件日志仍是
唯一事实源；缓存是它的一段前缀副本，第一次 ready 时按 serverMin 对账；按账号分键、退出即清。
