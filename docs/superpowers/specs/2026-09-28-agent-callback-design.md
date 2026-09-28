# 智能体办完事打电话回给你 —— 设计

- 日期：2026-09-28
- Task issue：#1411
- 关系：打给智能体、挂断后它照样干活，这两件已经有了（ADR-0320 手机语音通话，ADR-0271 / 0272 通话与「拉进来的先开口」）。这一版补反方向：智能体让你的手机响。手机端推送这一层以前没有（ADR-0256 已知代价：「只做桌面（手机没有推送凭据那一层）」），这一版从零搭。

维护者原话：「语音通话：用户可以打电话给智能体交代任务，智能体把事儿办完了，也可以选择打电话回给用户」。

## 维护者已拍板（2026-09-28）

1. **手机怎么响：通知加 App 内来电页**，不用 CallKit。锁屏时是一条会响铃的通知，点开进全屏来电页；App 开着时直接弹来电页。跟微信国内版一样。否决 CallKit 的理由：要 VoIP 推送 + 后台音频，得推翻 ADR-0320「锁屏就停听」，原生工作量大几倍；中国大陆 App Store 不允许用 CallKit。
2. **什么时候打：智能体自己判断。** 你说过「办完打给我」就一定打；没说时，事情办了很久、你中途挂了或离开了、或者需要你拍板，它也可以打。硬限制：同一只 10 分钟内最多打一次；你正开着这条聊天或在通话里时不打。
3. **推送走 runtime 直发 APNs**。否决的两条：edge 代发（APNs 只收 HTTP/2，Worker 往外能不能走 HTTP/2 没把握，还多一跳）；Expo 推送服务（通知内容过第三方，还要配 EAS）。

## 0. 已验前提

1. 仓里没有任何推送代码：没有 expo-notifications、没有 APNs 发送方、没有设备令牌表。0011 的 `devices.push_token` 一直没人读写，那张表是给已删掉的远程配对用的，这里不复用。
2. 开发者团队 HV982TTRNP 有 Apple Distribution 证书，是付费账号，能开推送。Bundle ID `com.stanyan.mrotto.mobile`。
3. Expo SDK 57 带的 expo-notifications 版本是 `~57.0.14`，还没装。
4. 云会话线上帧里的事件只做浅校验（`src/shared/remote/cloudSession.ts` 的 `isSessionEvent` 只看 type / seq / sessionId / ts）。**加一种新事件类型不用升协议版本**，旧客户端照收，认不出的类型各端时间线本来就不画。
5. 手机起呼走现成的 `call` 帧：`voiceStore.startCall(sessionId, agentIds)` → runtime 的 `setVoiceCall(byUid, label, participants)`。新拉进通话的那只由 `greetNewcomers` 落一条带 `greeting` 的开场白，让它先开口。带 `greeting` 的开场白时间线不画（`cloudTimeline.ts` 的 `hiddenFromCloudTimeline`，不分 greeting 种类）。
6. runtime 知道谁连着哪条会话：daemon 的 `roomRosters`（每个会话房一份 cid 集合），加上 frameHandler 的 `cids`（cid → 验过的 uid）。
7. runtime 每一轮都知道是谁叫起来的（sessionService 的 `currentInitiator`）。
8. runtime 的配置是「缺必需项就启动失败」（`services/runtime/src/config.ts` 的 `resolveConfig`）。
9. 聊天页从外面打开要一个导航引用；手机端目前没有 `createNavigationContainerRef`。

## 1. 推送

### 1.1 设备令牌表（`supabase/migrations/0045_push_devices.sql`）

```sql
create table if not exists public.push_devices (
  token      text primary key,         -- APNs 设备令牌（十六进制）
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   text not null default 'ios',
  bundle_id  text not null,
  apns_env   text,                      -- 'production' / 'sandbox'；null = 还没发成功过
  updated_at timestamptz not null default now()
);
alter table public.push_devices enable row level security;
create policy pd_select_self on public.push_devices for select to authenticated using (user_id = auth.uid());
-- 不给 insert / update / delete 策略：客户端只走下面两个 RPC
```

- `register_push_device(p_token text, p_bundle text)`，security definer：先删掉这个令牌挂在**别人**名下的那一行，再按令牌 upsert 到 `auth.uid()` 名下（新插入的行 `apns_env` 为空；同一个人重复登记不清它——同一个令牌的环境不会变）。同一台手机换了账号，令牌就归新账号。不这么做的话，上一个账号的来电会响在这台手机上，锁屏上还会显示对方那句话。
- `unregister_push_device(p_token text)`，security definer：只删 `auth.uid()` 名下的这一行。
- runtime 用 service key 读写：按 `user_id` 取令牌、回写 `apns_env`、删掉失效的令牌。

### 1.2 手机注册

- 装 expo-notifications（`~57.0.14`），app.json 挂它的配置插件：`sounds` 带上铃声文件（§3.4）；`aps-environment` 由插件加进 entitlements。另在 `ios.entitlements` 加 `com.apple.developer.usernotifications.time-sensitive: true`。
- 登录之后第一次回到前台时申请通知权限（iOS 系统弹窗），拿 `getDevicePushTokenAsync()` 的原生令牌，调 `register_push_device`。之后每次回前台再注册一次：令牌可能变，RPC 是幂等的。
- 退出登录前先调 `unregister_push_device`。断网调不通也照样退出。
- 用户拒绝了通知权限 = 没有令牌 = 这个人收不到回电（§2.2 的第 4 条会接住）。

### 1.3 runtime 发推送（`services/runtime/src/apns.ts`）

- **配置**：三个环境变量 `APNS_KEY_FILE`（.p8 文件在 VPS 上的路径）、`APNS_KEY_ID`、`APNS_TEAM_ID`，外加 `APNS_BUNDLE_ID`（缺省 `com.stanyan.mrotto.mobile`）。前三个要么全有、要么全无。全无 = 推送关着，回电工具不出现（§2.1）；只有一部分 = 配错了，启动失败（同 `resolveConfig` 的纪律）。
- **鉴权**：token-based（JWT，ES256，header 带 `kid`，claims 是 `iss`=Team ID 与 `iat`），用 `node:crypto` 签。每 50 分钟换一次：APNs 要求不超过 1 小时，也不要频繁换。
- **连接**：`node:http2`，生产 `api.push.apple.com`、沙盒 `api.sandbox.push.apple.com`，每个主机一条长连接，断了重连。
- **请求**：`POST /3/device/<token>`，头 `apns-topic`=Bundle ID、`apns-push-type: alert`、`apns-priority: 10`、`apns-expiration`=响铃过期时刻、`apns-collapse-id`=ringId。
- **载荷**：
  ```json
  { "aps": { "alert": { "title": "运维 来电", "body": "<它要说的那句话>" },
             "sound": "ringtone.caf", "interruption-level": "time-sensitive",
             "thread-id": "<sessionId>" },
    "ring": { "ringId": "…", "workspaceId": "…", "sessionId": "…", "agentId": "…", "agentName": "…", "reason": "…",
              "chat": "dm | group | team | guest", "expiresTs": 1234567890 } }
  ```
  名字与那句话也带上：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照。
  `chat` 让手机知道开哪一种聊天页：主场私聊 → `dm`；主场群，被叫的是群主 → `group`；主场群，被叫的是客人 → `guest`；团队 → `team`。
- **环境**：
  - 从 Xcode 装的包走沙盒，TestFlight / App Store 走生产，手机自己判断不了是哪种。所以按令牌那一行的 `apns_env` 发。
  - 还没记录时先试生产，回 `400 BadDeviceToken` 再试沙盒；发成功了把环境回写到那一行。
  - 两边都 `BadDeviceToken`，或者回 `410 Unregistered`，就删掉这个令牌。
- 纯逻辑（JWT 的形状、选环境、判失效）与 IO（http2）分开，前者进 vitest。

## 2. 回电工具与一次响铃

### 2.1 工具 `call_user`

- **谁有**：推送开着时，每条云会话的每只智能体都有，不过审批门。唯一例外是客人点起的那一轮：按 #1393，那一轮的每一把工具都要群主批。推送关着时，这个工具不出现：不能让模型许诺一通打不出去的电话。
- **参数**：`reason`，一句话，显示在锁屏上。折叠空白、去换行，超过 60 字就截断。
- **说明文字**（给模型看的）：
  - 什么时候打：用户说过「办完打给我」一定打；事情办了很久、用户已经不在（挂了电话、离开了聊天），或者需要他拍板时可以打；别为小事打。
  - reason 写一句对方在锁屏上能看懂的话。
  - 接通后你会先开口，把事情说清楚。
- **打给谁**：叫起这一轮的那个人（`currentInitiator`）。这一轮不是人叫起来的（接力、系统补跑的 `system`），就不打，工具回一句「这一轮不是人叫起来的，没人可打」。

### 2.2 什么时候不打

以下几种情况，工具直接回一句话让它在聊天里说，日志里不落事件：

1. 对方正开着这条聊天：这条会话房里有对方的连接。daemon 给 sessionService 注入 `isWatching(uid)`，frameHandler 为此加一个 `uidOf(cid)`。
2. ~~这条会话正在通话~~ 并进第 1 条（计划阶段的补全，见 §9）
3. 同一只打给同一个人，10 分钟内已经打过。从日志折叠，重启不清零。
4. 对方一台能收推送的设备都没有。

### 2.3 一次响铃的生命周期

新事件类型 `call_ring`（`ignorable: true`，模型看不见）：

```ts
interface CallRingEvent extends SessionEventBase {
  type: "call_ring";
  ringId: string;
  phase: "ringing" | "answered" | "missed";
  fromAgentId: string;   // 不叫 agentId：带 agentId 的事件会被 openTurns / foldActivity 当成这只的「动静」
  toUid: string;
  reason: string;        // 三个 phase 都带，时间线画卡不用回头找
  expiresTs: number;     // ringing 起算 45 秒
  ignorable: true;
}
```

- **打出去**：工具过了 §2.2 → 落 `ringing` → 给对方每一台设备发推送（最多等 5 秒）。
  - 一台都没送到：当场落 `missed`，工具回「没打通（推送没送到）」。
  - 送到了：工具回「已经打过去了。他接起来你会先开口；45 秒没接就算未接，他回来会在聊天里看到」。
- **接听**：对方在手机上点「接听」→ 打开这条聊天 → 发现成的 `call` 帧，把这一只拉进通话。`setVoiceCall` 里，如果新拉进来的这只正在给这个 uid 响铃，就算接听：
  - 落 `answered`，撤掉定时器；
  - 它的开场白换成回电版（新的 `greeting: "callback"`）：`[系统] 「运维」打给 Stan 的电话接通了。运维：你打这个电话是为了：<reason>。先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。`（名字过 `promptSafe`，同 `voiceCallGreetingText`）。
  - 过了响铃时限 30 秒内接起来的照样算（`RING_ANSWER_GRACE_MS`）；它本来就在一场没人挂断的通话里时，名单没变也认接听。
- **未接**：45 秒到了还在响 → 落 `missed`。
- **重启**：装配时把日志里还停在 `ringing` 的折出来。已过期的补一条 `missed`；没过期的重新挂定时器。
- **归档**：还在响的一律落 `missed`。

### 2.4 提示词

云会话 system 提示词里通话那一段加一句：「挂断之后事情办完了，或者要他拍板，可以用 `call_user` 回电。」改的是 `src/session/deriveMessages.ts`，**要重新部署 runtime 才生效**（#791）。只在推送开着时说：`voice_call_changed` 带 `callback: true` 才说。

## 3. 手机

### 3.1 收到回电

- **App 在前台**：`setNotificationHandler` 对带 `ring` 的通知不弹横幅、照样响铃（`shouldPlaySound: true`），并弹出全屏来电页。
- **App 在后台或锁屏**：系统通知带 30 秒铃声。点开时：
  - 还没过期 → 进全屏来电页；
  - 已过期 → 直接打开那条聊天（照微信，点未接来电的通知不自动回拨）。
- **冷启动**：用 `getLastNotificationResponseAsync()` 接住。
- **导航**：从聊天页之外打开聊天，要在根上加一个 `createNavigationContainerRef`。

### 3.2 全屏来电页（`mobile/src/call/IncomingCall.tsx`）

- 内容：它的脸（`waiting`，唯一左右摆的那一档，「等你」）、名字、那句话、两颗按钮「接听」「挂断」。
- 手机震动（`Vibration.vibrate(pattern, true)`），直到接听、挂断或过期。
- **接听**：关掉来电页和那条通知 → 导航到那条聊天，带 `answerRing: { ringId, agentId }` → 房间 ready 后 `startCall(sessionId, [agentId])`。
- **挂断**：只关掉来电页、停掉响铃。服务端到点记未接，不另发「拒接」。
- 同一时刻只弹一张：第二通按到达顺序排在后面。

### 3.3 聊天记录里的来电卡

- `mobileChat.chatRows` 新增一种行 `ring`：居中一张小卡，写「📞 运维 打来电话」、那句话，以及状态（正在响 / 已接通 / 未接）。
- 一次响铃只画一张卡，卡在 `ringing` 那条的位置；状态取这个 ringId 最后一条事件。
- 手机的 `chatRows` 也用 `hiddenFromCloudTimeline` 判「藏不藏」，所以要在调它**之前**先认出 `call_ring`，否则卡会被桌面那条规则一起藏掉。
- 桌面这一版不画：`hiddenFromCloudTimeline` 把 `call_ring` 藏起来，等 #1403 桌面微信式布局合了再接。

### 3.4 铃声

- 自己合成，不用别人的音频，没有授权问题：一段两音交替的铃声，总长不超过 30 秒（APNs 的上限）。
- 用脚本生成 WAV，再用 `afconvert` 转成 `.caf`，放进 `mobile/assets/sounds/ringtone.caf`，由 expo-notifications 插件的 `sounds` 打进包里。
- 生成脚本 `scripts/make-ringtone.mjs` 一并提交，产物可复现。

## 4. 事件登记

新事件类型要在所有穷举表里表态（AGENTS.md 那份「十一处」清单）：

- events.ts：联合类型与 `KNOWN_EVENT_TYPES_MAP`；
- `persistencePolicy`（落盘）与 `tests/session/persistencePolicy.test.ts` 的 `DURABLE` 名单；
- `deriveMessages`（不进模型视野）；
- `toThreadMessages.isAuditEvent`（本机时间线不画）与 `Timeline.tsx` 的 `EventRow`（两份名单一致那条测试会查）；
- `contextEstimate.pendingAfter`、`deriveUsage`；
- `agentView.OTHER_AGENT_VERDICTS`（keep：没有 agentId，那张表轮不到它）；
- `sessionPackage.PRIVACY_VERDICTS`（strip：它带着别人的 uid 与一句私人的话）；
- `cloudTimeline.hiddenFromCloudTimeline`（桌面藏）。

`user_message.greeting` 的联合类型加 `"callback"`。

## 5. 部署顺序

1. 在生产库跑 0045（要维护者点头）。
2. 维护者建 APNs 密钥：Apple Developer → Certificates, Identifiers & Profiles → Keys → +，勾 Apple Push Notifications service (APNs)，下载 .p8（只能下载一次），记下 Key ID。然后把 .p8 放到 VPS，路径写进 runtime 的环境变量文件，三个变量一起加。
3. 部署 runtime（`npm run deploy:check` 核指纹，日志里看「推送开着」那一行）。
4. 打手机包装到真机。App ID 要带 Push Notifications 和 Time Sensitive Notifications 两项能力，Xcode 自动签名会补上。

任何一步没做都不出错：0045 没跑时手机注册失败只记日志；密钥没配时回电工具不出现；手机没更新时收不到推送、也不会注册令牌。

## 6. 测试

- `src/shared/…`：`call_ring` 的折叠（重启恢复：过期补 missed、没过期重新挂定时器、归档全 missed）、来电卡的行、回电开场白的文字、`chat` 字段怎么定。
- `services/runtime/src/apns.ts`：JWT 能用公钥验过、请求头与载荷、选环境与失效令牌的判定（注入假的 http2）。
- `services/runtime/src/…`：`call_user` 的四种不打、打出去落 `ringing`、送不到落 `missed`、45 秒到点落 `missed`、`setVoiceCall` 认出接听并换成回电开场白、非回电的拉人照旧用普通开场白、客人那一轮要群主批。
- `services/runtime/src/config.ts`：三个变量全无 = 关，只有一部分 = 启动失败。
- migration：读 0045 的 SQL，断言没有写策略、两个 RPC 是 security definer 且只动那个令牌。
- `tests/runtime/daemon…Wiring.test.ts`：读 daemon 源码，断言 `isWatching` 与 APNs 客户端接上了。
- 手机：通知 → 来电页 → 接听 → 进通话，在真机上走一遍（推送只在真机上能收）。

## 7. 切片

1. shared：`call_ring` 事件与登记、折叠、回电开场白、来电卡的行。
2. 0045 + 测试。
3. runtime：`apns.ts` + 配置 + 测试。
4. runtime：`call_user` + 响铃生命周期 + `setVoiceCall` 认接听 + daemon 接线（`isWatching`、APNs 客户端、令牌表读写）+ 提示词。
5. 手机：expo-notifications + 注册 / 注销 + 铃声 + 全屏来电页 + 导航 + 来电卡。
6. ADR + AGENTS.md。
7. 部署：0045 → 密钥 → runtime → 真机。

## 8. 已知代价与推翻前提

- **锁屏时只是一条会响的通知，不是整屏来电**。接听要点开通知、解锁、再点一次「接听」。要整屏来电就得上 CallKit（维护者已否决，理由见上）。
- **挂断 = 未接**，不单独记「拒接」。
- **冷却按会话在内存里记**，重启清零；同一只在两条会话里可以各打一次。
- **只有手机会响**，桌面不响也不画卡（等 #1403）。
- **reason 会显示在锁屏上**。要隐藏预览，走 iOS 自己的「显示预览」设置。
- **前台接听后铃声停不停，要真机验**。iOS 删掉那条通知是否会停掉它的声音，这一点没把握；停不掉的话改成 App 内自己放。
- **切后台就断开会话房**：切出去再回来要重连一次。
- **推翻前提**：如果 time-sensitive 通知在真机上被专注模式挡掉，或者铃声只响一声，就退一步：通知只负责叫醒 App，响铃交给 App 内来电页。

## 9. 计划阶段的补全（2026-09-28）

1. **§2.2 第 2 条「正在通话不打」并进第 1 条**。锁屏 = 这台停听、通话还在（ADR-0320），通话名单非空不等于人在通话里——照 spec 字面，挂了电话锁屏（最常见的回电场景）会因为那场没人挂断的通话永远打不出去。人真在通话里时他必然连着这条会话，第 1 条已经挡住。接听时通话本来就开着：名单没变也认接听（Task 5）。
2. **手机切后台主动断开会话房**（Task 8）。iOS 挂起的 socket 在服务端看来还连着（中继自己应答心跳，runtime 看不见），`isWatching` 会恒真，同样是回电永远打不出去。
3. **接听宽限 30 秒**：人在第 44 秒点了接听，落到服务端时已记未接，仍算接通（`RING_ANSWER_GRACE_MS`）。
4. **冷却从日志折叠**，不只是内存：比 spec 更严（重启不清零），状态少一份。
5. **通话块那一句只在推送开着时说**：`voice_call_changed` 加可选字段 `callback?: true`，runtime 推送开着时带上。spec §2.1 自己的理由（推送关着时工具不出现，不能让模型许诺一通打不出去的电话）同样适用于提示词。
6. **`agentView.OTHER_AGENT_VERDICTS` 写 `keep` 不写 `drop`**：`call_ring` 没有 agentId，早退路径一律放行，那张表根本轮不到它；写 `drop` 是一句不成立的话（同 voice_call_changed / chat_roster_changed 的写法）。模型不可见由 deriveMessages 保证。
7. **回电开场白加「运维：」点名**（同 `voiceCallGreetingText`）：群里每只都读得到这一条，「你打这个电话是为了」得说清是对谁说。
8. **`register_push_device` 重复登记不清 `apns_env`**：同一个令牌的环境不会变，只有新插入的行是空。
9. **推送里的 `ring` 多带 `agentName` 与 `reason`**：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照。
10. **聊天里的来电卡用电话图标代替 📞**：仓里一律用 `Icon`。
11. **接听 / 点开过期来电都把导航重置成「首页 → 那条聊天」**：手机只有一份「当前聊天」store，聊天页叠聊天页会让下面那一页在返回时对着一份已关掉的 store。
