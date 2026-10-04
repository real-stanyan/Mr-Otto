# ADR-0361：智能体替主人给好友发私聊——`message_friend` 与 `call_friend` 同闸同档位，以主人名义落 `messages` 表、正文带「代发」前缀

日期：2026-10-04 · issue #1549 · 维护者原话：「智能体不能传达消息只靠打电话」（截图：主人在主场对管理员说「发消息给他」，
它答「消息我发不了，手上只有打电话这一个口子。要么我再拨一通把三条念完」）

## 背景

ADR-0337（#1441）给了智能体一把 `call_friend`：主人说「去问问小红」，它给小红打电话、聊完回来汇报。但「转达三句话」
这种事根本不需要实时通话——好友没接（截图里就是「响到超时」）就只剩「你手机上发一句最快」。0054 的档位文案
（`outreachTierProblem`）那时就写着「智能体不能直接给 X **打电话或发消息**」，发消息这一半一直没做。

朋友私聊本身早就是一张 `messages` 表（0001）：手机直接写、runtime 用 service key 订 INSERT 推送给对方（#1442 的
`friendPush`）。缺的只是一条「智能体以主人名义写一行」的路。

## 决定

1. **一把新刀 `message_friend(friend, text)`，是 `call_friend` 的姊妹，不是新的子系统。** 同一个 `outreachHub`
   多一个 `message` 分支：同一份 `friendsOf`（只认 accepted）、同一个 `resolveFriend`（重名 / 查无此人回去问主人）、
   同一道档位闸（生效档必须是「全部开放」，拒的文案就是 0054 那句）。之后不响铃、不建外联会话、不查设备与额度，
   直接 `sendDm(主人, 好友, 正文)`——daemon 用 service key 往 `messages` 表 insert 一行，`sender` 是主人。
   否决了另开一张 `agent_messages` 表 / 新 `chat_kind`：对收信人来说这就是一条私聊消息，走别的表就要在每个客户端
   再画一种气泡，而 0001 那张表 + friendPush 的推送 + 已读回执全是现成的。
2. **正文带纯文本前缀「[<智能体> 代发] 」**，不是 JSON 信封。这条是以主人名义写的，不标就是让智能体冒充本人；
   做成信封（像名片那样）老客户端会看到一坨 JSON，而转达消息必须对任何版本的客户端都可读。代价：主人自己的
   私聊页里这条也带着前缀——这是对的，他也该看得出哪条是自己敲的、哪条是智能体替他发的。
3. **亮刀条件与 `call_friend` 逐字相同**：只在主场（`approveAll`）、不在外联会话、不在私密车道；只有主人本人
   亲口点起的那一轮能发（`ownerSpoke`），受监督的轮（客人点起 / 汇报轮）干脆不亮；服务重启后的补跑轮拒并让它
   先问主人（这条消息上一次可能已经发出去了）。理由同 ADR-0337 第 ②条：以主人名义对外的动作，凭据只能是主人本人
   这一轮的原话，不能是接力棒、招呼或别人的话。
4. **每（主场，智能体，好友）每小时 20 条**，进程内滑动窗（复用 laneBridge 的窗口函数）。重启清零的代价是多发
   几条、不是漏发，所以不落库。超限回「让他自己发」。
5. **推送不另推**：写进 `messages` 之后 friendPush 订的那条 INSERT 照旧把它推给对方，标题是主人的称呼、正文带前缀。
6. **工具表里 `message_friend` 紧挨着 `call_friend`**，描述里把分工说清：要实时一问一答才打电话，转达一句话就
   发消息。不改系统提示词——`call_friend` 也没有提示词那一句，两把刀靠描述自荐。

## 没做 / 之后

- 不给群聊 / 车道里的智能体发私聊的能力（车道里主人与朋友本来就在同一页，智能体直接说话就行，ADR-0353）。
- 不做「对方回了告诉智能体」：回话落在私聊里，主人自己看得见；智能体要知道得主人转述（同 `call_friend` 的
  「回不回你看不到」）。要闭环得给智能体订 messages，那是另一个决定。
- 不做带媒体的代发。

## 影响的文件

`src/shared/outreach.ts`（刀名 / 上限 / `agentDmBody` / `friendMessageSentText`）、`services/runtime/src/messageFriendTool.ts`、
`outreachHub.ts` 的 `message` + `sendDm` 依赖、`sessionService.ts` 的 `opts.friendMessage` 与装配、`daemon.ts` 两处接线；
测试 `tests/shared/friendMessage.test.ts`、`tests/runtime/messageFriendTool.test.ts`、`outreachHub.message.test.ts`、
`sessionService.friendMessage.test.ts`。不动 schema、不动协议版本，部署只需 runtime。
