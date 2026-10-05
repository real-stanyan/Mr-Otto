# ADR-0374 应用的房间建在 Supabase 上：写只走 RPC、进局跑房主那一版、邀请卡复用应用卡信封不进位协议

- 日期：2026-10-05 · Issue：#1675 · Spec：docs/superpowers/specs/2026-10-05-otto-app-rooms-design.md · Plan：docs/superpowers/plans/2026-10-05-otto-app-rooms.md

## 背景
维护者要「能和好友互动的应用和游戏」（回合制、共享数据、一次性挑战、实时四类都要）。Otto 应用（#1591）的 app_data 按人隔离，分享 = 复制副本，桥上没有往好友那边写的口子。

## 决定
1. 房间（一局 / 一本共享的账）建在 Supabase：表 + RLS + Realtime 私有 broadcast，不经 runtime 中继（中继 DO 钉在欧洲，悉尼往返 ~350 ms）。
2. 写只走 security definer RPC：比较后再写（if_rev）、人数 ≤ 8、好友判据、ping 限速要在一个事务里判。
3. 一局钉住房主建局时的版本；成员读得到的只有那一版（app_versions 与 otto-apps 桶各一条按成员放行的策略）。
4. 邀请卡 = 应用卡信封多一格 room；加入走 RPC 直连——cs 协议严格相等握手，加帧就要 runtime 与所有手机同时换版。
5. 叫人推送照 friendPush：runtime 订 app_room_pings 的 INSERT；推送开关复用「朋友」那一档。
6. 第一版只人和人；智能体不进房间。
7. **实时频道不走 postgres_changes。** Supabase Realtime 不对 DELETE 事件套 RLS，任何登录用户订阅表变更都会收到别人房间的 room id、key 和谁与谁同房。改为 DB 触发器调 `realtime.send(..., private=true)`，往只读主题 `room-sys:<id>` 发三种事件：`change` / `members` / `closed`。成员互发的应用消息 `msg` 走 `room:<id>`，只在房间未关时可写。客户端**只信** `room-sys` 来的系统事件（`room:` 上谁都能发，伪造不了系统事件）。publication 里只留 `app_room_pings`，给 runtime 用 service role 订。
8. **授权在加入频道时判一次。** Realtime 的频道授权在 join 时评估：退房或关房要等客户端重新 join 或刷新 token 才生效，不是逐条消息判。这是 Realtime 的模型，不是我们能改的；写入侧不依赖它——写永远走 RPC，RPC 每次都核成员与房间状态，所以被踢出的人最多多收一阵子读通知，写不进去。
9. **房主的代码，访客的数据。** 进局的访客跑的是房主钉住的那一版代码，这份代码拿到的是**访客自己那份应用副本**的个人 `otto.storage`。这条信任边由我们接受：代码是房主的智能体写的、`build_app` 的静态检查照样管着它（扩展名白名单、没有外网、threatPatterns），访客点「加入」就是同意跑这一局。
10. **`room.open` 对只被邀请的人先加入。** `room.open(id)` 遇到调用人只是 invited，先 join 再进。应用里点「打开」与邀请卡上点「加入」视为同一个同意，不再多弹一道。
11. **回前台后房主端重订。** 真从后台回来才重订（不是每次 active 抖动）。先等旧频道真正移除，再订新的——realtime-js 按 topic 复用还在 leaving 的频道，不等就会订回一条半死的；重订后把 `list("")` 的结果当 `room.change` 事件重放一遍，补上断线期间漏的通知。失败按指数退避、有封顶。

## 推翻它的前提
见 spec §9：Supabase Realtime 在悉尼撑不住实时对战 / 要智能体进房 / cs 协议改成最低兼容版本。另：Realtime 改成逐消息授权或给 DELETE 套上 RLS（则第 7 条的触发器 + 私有 broadcast 可以退回 postgres_changes，省一层）。
