# 和好友的智能体聊天 + 它替我给它主人带话 —— 设计

- 日期：2026-10-05
- Task issue：#1655
- 维护者原话：「可以和好友的智能体聊天，并且如果有需要好友的智能体会帮我和主人带话」
- 截图：手机「雨姐 [继爸]」那一页 = 朋友的管理员给我打电话的外联会话（#1441 / ADR-0337），只有来电记录，底栏写
  「这是 Mingxuan Zhang 的智能体给你打电话的地方」，不能打字。
- 关系：外联会话（ADR-0337，spec `2026-10-03-agent-calls-friend-design.md` §13「二期重判」）、好友档位（ADR-0350）、
  车道桥只说话不掀审批（ADR-0358）、跨主场档位口径（ADR-0368 `collabAuthPrompt`）、管理员唯一入口（ADR-0367）、
  定时汇报找管理员私聊（ADR-0366）、`message_friend` 的闸（ADR-0362）。

## 0. 维护者已拍板（2026-10-05，会话里四问）

1. **落点**：就在外联页打字（不跳回好友私聊页）。
2. **带话双向，都经管理员**：朋友的话 → 管理员判断要带 → 写进主人与管理员的私聊并推送；主人在那里回 →
   管理员把答复写回外联页并推给朋友。
3. **权限**：按好友档位口径（ADR-0368），只说不动手。
4. **入口**：一期只在已存在的外联页里聊；不加「主动开一条」的入口、不加回拨（spec §13 另一半仍留着）。
5. 第二段设计里确认：外联会话放开 wiki 快照（与公开车道一致）。

## 1. 已验前提（2026-10-05，只读核过）

- 外联会话 = 打电话那一方主人主场里的 `chat_kind='outreach'` 云会话，名单恒为「一只智能体 + 一位好友（客人）」，
  每对一条永久复用（`services/runtime/src/outreachSession.ts` `ensureOutreachSession`）。
- 好友在外联里说话被 **runtime 挡**：`sessionService.ts` `say` 里 `isOutreach` 分支，不在通话里或不是那位好友一律
  `SayRejectedError("这通电话已经结束了。")`。客户端另有一层：`src/shared/mobileChat.ts` `outreachComposer` 把输入栏换成说明条。
- 外联里工具面恒空（`tools()` 里 `if (isOutreach) return []`）；不注入 wiki（`loadWikiIfChanged` 首行）；不接力
  （`relayAfterTurn`）；不推送（`pushReply` 与 `alertTargetFor` 都对 outreach 返回）。
- 能打外联电话的只有管理员（ADR-0367 决定 4，`callFriendTool && adminOnly && !supervisedTurn()`）。
- 外联只在好友档位为「全部开放」时可打（`src/shared/friendTier.ts` `allowsOutreach(t) = t === "full"`）。
- 主人那侧的管理员私聊：`daemon.ts` `findDmSession(home, [ADMIN_AGENT_ID])` + `routineRooms.room(home, sid)`
  （定时汇报 `runDndReport` 就是这样开房的）。
- 落开场白 + 起一轮的现成写法：`reportOutreach` / `runReport`（`greeting` 字段 + `coordinator.enqueue`）；
  受监督判据集中在 `openingTraits`（`outreach_report` / `pair_call_summary` / `dnd_report` 都在里面）。
- 推送静音的 greeting 表：`src/shared/replyNotify.ts` `SILENT_GREETINGS`。
- 手机路由已有 `{ kind: "outreach"; workspaceId; sessionId }`（`mobile/src/nav/types.ts`）。

## 2. 链路

### 2.1 朋友在外联页打字

- `say` 闸改成：外联里只认那位好友（`peerUid`，从外联 fold / 名单取，不再要求有一通在进行），且**此刻好友档位仍是
  「全部开放」**（`opts.peerTier(peerUid)`；查不出来按不放行）。主人在外联里仍不能说。
- 每对每小时上限 `OUTREACH_CHAT_PER_HOUR_MAX = 30`（runtime 内存窗口，同 ADR-0358 的桥；花的是主人额度）。超了拒，
  回「这会儿说得太多了，过一会儿再来」。
- 通话中的 `say`（语音转写）路径不变；通话中的那一句仍受原闸（进行中那通的好友）。
- 重启补跑：今天外联里「此刻没在通话」= 补跑的开场白全部落收口不跑（ADR-0337 终审 M1）。改成只丢**落在一通电话之内**的那些
  （`outreachLiveAt(seed, seq)`）；打字聊的照常补跑。
- 那一轮是客人点起的：沿用 ADR-0325 第 7 条（每一刀要主人批）——但外联里只有 `relay_to_owner` 一把刀，且它豁免（见 2.2）。

### 2.2 带话给主人：`relay_to_owner(text)`

- 只在外联会话里挂、只给 L0（管理员）；不在通话里也在（通话中朋友也可能要带话）。
- **客人点起的轮里不掀审批**：只对自己主人说话、不动任何人的东西（同 ADR-0358 决定 2 的论证）。
- 每对每小时上限 `RELAY_TO_OWNER_PER_HOUR_MAX = 5`。
- 落地：经 `outreachHub.relay(...)` → daemon 找主人主场的管理员私聊（`findDmSession`）→ 开房 → 新方法
  `relayFromFriend({ text, peerUid, peerName, outreachSessionId })`：落 `greeting: "friend_relay"` 开场白
  （`fromUid` = 主人、点管理员，正文 = `friendRelayText`：谁、原话摘要、怎么回）并起一轮，让管理员对主人说一句
  「X 让我带话：…」。**这一轮受监督**（正文是外人的话；进 `openingTraits.report`）。回复走现成 `pushReply`
  （管理员私聊是 dm → 推给主人）。`friend_relay` **不进** `SILENT_GREETINGS`。
- 外联会话里**不另落记号**：管理员调完刀会对朋友说「已经转告 X」，那句就是朋友看得到的回执；工具调用与回执本就在日志里。
- 找不到主场 / 管理员私聊 / 额度不够：工具回失败文本给模型（「没带到：…」），模型据实告诉朋友。

### 2.3 主人回话：`reply_to_friend(friend, text)`

- 挂在主人主场里、L0、**与 `message_friend` 同闸**：主人本人亲口点起、非监督轮（`ownerSpoke`）。
  `friend` 按名字解析（复用 `resolveFriend`），只能是**已有外联会话**且档位仍「全部开放」的好友；没有就回「TA 还没有和
  你的智能体聊过，用 message_friend 发私聊」。
- 落地：经 `outreachHub.replyToFriend(...)` → `ensureSession`（复用那条外联会话）→ 开房 → 新方法
  `ownerReply({ text, ownerUid })`：落 `greeting: "owner_reply"` 开场白（`fromUid` = 主人、点管理员）并起一轮，管理员把
  主人的话转给朋友。`owner_reply` 开场白在手机外联页不画（greeting 一族照旧藏），朋友看到的是管理员转述的那句。
- 这一轮不受监督（是主人亲口的话），但外联里工具面本就只有 `relay_to_owner`。
- 外联 `say` 闸放行这条开场白：它不走 `say`，走 `ownerReply` 直接 append（同 `reportOutreach`），不受客户端帧的闸。

### 2.4 推送

- `pushReply` 不再对 outreach 一刀切：外联里**只推给那位好友**，且只推「不在通话中」的回复（通话里本人正在听）。
- `alertTargetFor`：`chat === "outreach"` 时对好友本人返回 `{ kind: "cloud", chat: "outreach", ... }`，主人仍 null。
- 手机：推送点开路由到 `{ kind: "outreach", workspaceId, sessionId }`；核 `notifyStore` / 推送点击处理认 `"outreach"`，
  不认就补。静音键 `muteKeyFor` 对 outreach 要给一个键（按 sessionId）。

## 3. 管理员在外联里看到什么

- **档位口径**：外联只在「全部开放」存在，brief 里加 `collabAuthPrompt("full", 朋友名)` + 新段 `outreachChatPrompt`：
  「你在替主人接待 X。事实直接答；要主人拍板的事（花钱、承诺时间、替主人答应什么）用 relay_to_owner 带话，别替主人答应。
  主人的回话会以开场白的形式回到这里，转述给 X」。提示词只在工具真挂着时提它（#1206）。
- **记忆**：`loadWikiIfChanged` 去掉外联那一行——与公开车道一致；外联里 `nudge` 恒为假。副作用：通话里那只也带着记忆。依据：外联存在 = 主人给了这位
  朋友「全部开放」。**引言要换只读版**：`WIKI_PROMPT_INTRO` 点名 `wiki_read` / `wiki` 两把刀，外联里都没挂（#1206）——`renderWikiPrompt`
  多一个 `readOnly` 选项，deriveMessages 在外联里传真：引言换成「下面是主人的团队 wiki（只读）」、不写「用 wiki write 建」那句。
- **工具面**：外联里只挂 `relay_to_owner`。

## 4. 事件 / 协议

- `user_message.greeting` 多两个取值：`friend_relay`、`owner_reply`（字符串字段，旧日志不含即可照放）。
- **不加新事件类型**：带话的痕迹就是工具调用 + tool_result + 开场白，全在现成事件里。否决新建 `outreach_relay` 事件：要登记进
  七张穷举表（KNOWN_EVENT_TYPES / PRIVACY_VERDICTS / PEN_VERDICTS / cloudTimeline / persistencePolicy / deriveMessages / contextEstimate），
  只为画一条灰注，不值；也否决给 `outreach` 事件加 phase 值（`outreachFold` 按 started/ended 折通话状态）。
- 不动协议版本（`say` 帧已存在；老客户端只是没有输入框）、不动 schema。

## 5. 手机端

- `outreachComposer`：好友侧返回输入框（`{ kind: "input" }` 或现有输入栏的那一种），主人侧照旧说明条。被 runtime 拒时
  显示拒绝文案（档位被调低 / 超上限）。
- 气泡：两种开场白按现有 greeting 惯例藏（`friend_relay` 在主人的管理员私聊里、`owner_reply` 在外联里），看到的是管理员说的那句。
- 空页文案：好友侧「可以在这里和 X 说话，它打来的电话也记在这里」。
- 推送点击 → 外联页。

## 6. 测试（tests/ 镜像 src/）

- runtime `sessionService`：
  - 外联里好友不在通话中 `say` 放行（档位 full）；档位 < full 拒；主人 `say` 拒；第 31 句拒。
  - `relay_to_owner` 只在外联 + L0 挂；客人点起的轮里不掀审批；第 6 次拒；调 hub。
  - `relayFromFriend` 落 `friend_relay` 开场白、起管理员一轮、那一轮受监督、回复推给主人。
  - `reply_to_friend` 只在主人亲口非监督轮挂（同 `message_friend` 夹具）；`ownerReply` 落 `owner_reply` 起一轮、回复推给好友、
    不推主人。
  - 旧外联日志（无新 greeting / 事件）照放。
- runtime `outreachHub`：relay / replyToFriend 的找房、档位、找不到主场 / 管理员私聊 / 外联会话的失败文本。
- shared：`outreachComposer`、`replyNotify`（`friend_relay` 不静音）、新提示词片段。
- 门禁 `npm test`（含 `mobile/` tsc）。

## 7. 部署

runtime → 手机热更新。无 migration。老手机：外联页仍只读，推送点开若不认 outreach 落到默认页（不崩）。

## 8. 不做 / 之后

- 从好友资料页主动开一条和对方管理员的聊天、外联页回拨电话（spec §13 另一半）。
- 主人在外联页里直接打字（主人仍只读；要回话走管理员私聊）。
- 跨主场「主人 ↔ 朋友的管理员」以外的转达（专员不出主场，ADR-0368 决定 1 不变）。
- 窗口计数重启清零（同 ADR-0358 的已知代价）。
