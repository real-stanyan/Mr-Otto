# 智能体回电改成真正的来电：CallKit + VoIP 推送 —— 设计

- 日期：2026-09-29
- Task issue：#1428
- 关系：推翻 ADR-0331（#1411）里「不用 CallKit、走时效性通知 + App 内来电页」那一段；修订 ADR-0320
  「锁屏 = 这台停听、通话还在」——只在系统来电进行中时不停听。

## 维护者已拍板（2026-09-29）

1. 「我希望无论如何，来电时手机上也要震动」：走 CallKit + PushKit 的 VoIP 推送，系统来电界面、持续响铃震动。
2. **不上中国大陆 App Store**（Apple 不许大陆区的 App 用 CallKit）：只做 CallKit 这一套，现在的通知来电整条拆掉，
   不留按地区切换。
3. **锁着屏直接通话**：锁屏在系统来电界面点接听，不用解锁、不用开 App，接起来就能说；挂断走系统按钮。

## 0. 已验前提

1. **普通通知无法保证在手机上响**。真机诊断（#1428 正文）：往手机发了系统默认提示音与 `ringtone.caf` 两条
   测试推送，APNs 都回 200，手机都没响没震，Mac 上弹出并响了——这台 Mac 开着 iPhone 镜像，iOS 把锁屏时的
   通知路由到了正在用的设备（同 Apple Watch）。载荷、铃声文件（27 秒 PCM、在包根目录、与源文件逐字节相同）、
   权限（`allowSound: true`）都核过没问题。App 管不了 iOS 把一条通知送到哪台设备。
2. **现在的链路**（读代码核过）：`call_user` → `callRinger.call`（开着这条聊天不打、同一对 10 分钟一次、没设备不打）
   → 落 `call_ring{ringing}`、45 秒计时 → `apns.ts` 发 `apns-push-type: alert` 的时效性通知，载荷 `{aps, ring: RingPush}`
   → 手机：前台 `setNotificationHandler` / 点通知 / 冷启动三处都进 `ringStore.enqueue` → `IncomingCall` 全屏页 →
   接听 `answerRing`：导航重置到 `Chat{answerRing}`，`ChatScreen` 在房间 ready 时 `callAgent` → `setVoiceCall` 帧 →
   runtime `ringer.answer` 记接通、`greetNewcomers` 落开场白（ADR-0332）。拒接只在本机撤掉，服务端到点记 missed。
3. **Expo 模块能挂 AppDelegate 生命周期**：`expo-modules-core` 有 `ExpoAppDelegateSubscriber`，模块在
   `expo-module.config.json` 里声明 `appDelegateSubscribers`（expo-notifications 就是这么挂的）。所以 PushKit 的
   注册可以放在 `didFinishLaunching` 里，**不用再去改 AppDelegate**——那个文件已经被 `withSceneLifecycle`
   插件按正则改过一次（ADR-0329），再叠一层改动最容易互相踩。
4. **原生模块的写法**照 `mobile/modules/otto-speech/`：`expo-module.config.json` + `index.ts`
   （`requireOptionalNativeModule`，Expo Go 里是 null）+ `ios/*.podspec`（`static_framework`，依赖 `ExpoModulesCore`）+
   `ios/*.swift`（`Module` 子类，专用串行队列，`sendEvent` 发事件）。autolinking 自动发现，不用登记。
5. **otto-speech 自己开关音频会话**：`Recognizer.swift` 起引擎前 `setCategory(.playAndRecord, mode: .default,
   options: [.defaultToSpeaker, .allowBluetoothA2DP])` + `setActive(true)`，听与放都停了 `setActive(false)`；
   还把 `AVAudioSession.interruptionNotification` 当成打断（停听、不自动恢复）。CallKit 通话里会话由系统激活
   （`provider(_:didActivate:)`），App 不该自己 `setActive`。
6. **后台会断房间、停听**：`voiceStore.ts:242-246` 在 AppState 变 background 时 `session.leave()`，
   `cloudClient.ts:74-78` 暂停会话房（runtime 的「开着这条聊天就不打」靠它，ADR-0331）。App 现在没有
   `UIBackgroundModes`。
7. **APNs 的 `.p8` 令牌鉴权对 VoIP 推送同样有效**，推送类型 `voip`、topic 是 `<bundle>.voip`（Apple 文档）。
   VoIP 令牌由 `PKPushRegistry` 给，与 `getDevicePushTokenAsync` 那个普通令牌不是同一个。
8. **iOS 13 起的硬规定**：App 收到每一条 VoIP 推送，都必须在 `didReceiveIncomingPushWith` 返回之前调用
   `CXProvider.reportNewIncomingCall`，否则系统会杀掉 App，屡犯就不再投递 VoIP 推送。所以 runtime 只在真的
   要响铃时才发 VoIP 推送，手机收到了一律报来电（过期的也报，报完立刻结束）。

## 1. 服务端

### 1.1 令牌分两种

- migration `0047_push_devices_kind.sql`：`push_devices` 加 `kind text not null default 'alert'`，
  `check (kind in ('alert', 'voip'))`。存量行都是普通令牌，默认值恰好对。
- `register_push_device` 加第三个参数 `p_kind text default 'alert'`（校验只收那两个值，其余 `raise`）；
  Postgres 的重载按签名区分，所以先 `drop function register_push_device(text, text)` 再建三参版，
  `grant execute ... to authenticated`、`revoke ... from public` 同 0046。token 校验逐字沿用 0046（十六进制、
  16–256）。upsert 时把 `kind` 一起写。
- `unregister_push_device` 不动（按 token 删，与种类无关）。
- **跑生产库要维护者在会话里明说**（同 0046）。

### 1.2 推送改成 VoIP

- `pushDevices.list` 只取 `kind = 'voip'` 的行。普通令牌留在表里，服务端不再给它们发（旧装的包收不到来电，
  开发阶段只有一台手机，重装即可）。
- `apns.ts`：
  - 载荷 `ringVoipPayload(ring)` = `{ ring }`，不带 `aps`（VoIP 推送不展示，展示由 CallKit 做）。
  - 头 `ringHeaders`：`apns-push-type: voip`、`apns-topic: <bundleId>.voip`、`apns-priority: 10`、
    `apns-expiration: 0`（过期的 VoIP 推送没有意义：晚到的会被报成一通立刻结束的来电，白白打扰一下）。
    不再带 `apns-collapse-id`（VoIP 推送不支持合并）。
  - 环境探测（先按记下的 `apns_env`，没记过先生产后沙盒）、令牌作废处理逐字不变。
- `callRinger` 其余一字不变：打不打、冷却、45 秒未接、接通判定、开场白、`resume` / `missAll`。

## 2. 手机：原生模块 `mobile/modules/otto-call/`

Swift，照 otto-speech 的形状；podspec 多链 `PushKit`、`CallKit`。

### 2.1 注册（AppDelegate 订阅者）

- `OttoCallAppDelegate: ExpoAppDelegateSubscriber` 在 `didFinishLaunching` 里建 `PKPushRegistry`
  （`desiredPushTypes = [.voIP]`），同一时刻建好 `CXProvider`（单例 `CallCenter`）。App 被 VoIP 推送从后台叫起来时，
  这一步必须早于推送回调——放在模块的 JS 初始化里就来不及。
- 拿到 / 换了 VoIP 令牌：存在 `CallCenter` 里，并发 `onToken` 事件；JS 可以随时 `getVoipToken()` 取。

### 2.2 来电

- `didReceiveIncomingPushWith`：在原生层解析载荷里的 `ring`（只要 `ringId`、`agentName`、`expiresTs`），**同步**
  `reportNewIncomingCall`：
  - `CXCallUpdate`：`remoteHandle` = `.generic`（值为 agentId）、`localizedCallerName` = 智能体名、
    `hasVideo = false`、不支持保持 / 分组 / DTMF。
  - 一通来电一个新 `UUID`，`CallCenter` 记 `ringId ↔ UUID` 与完整载荷 JSON。
  - 解析失败或已过 `expiresTs`：照样报（§0.8），报完立刻 `reportCall(with:endedAt:reason: .failed/.unanswered)`。
  - 然后把完整载荷发给 JS（`onIncoming`）。JS 还没起来时先攒在 `CallCenter` 里，JS 起来后 `takePending()` 取走。
- `CXProviderConfiguration`：`localizedName` 用默认（App 名）、`ringtoneSound = "ringtone.caf"`（已由
  expo-notifications 插件打进包根目录，§4）、`supportsVideo = false`、`maximumCallsPerCallGroup = 1`、
  `supportedHandleTypes = [.generic]`、`includesCallsInRecents = false`（通话记录在聊天里已经有了，不往「电话」App
  的最近通话里塞）、`iconTemplateImageData` 用 App 图标的单色版（没有就不设）。
- 本机到点结束：`CallCenter` 按 `expiresTs` 设计时器，还在响就 `reportCall(... reason: .unanswered)` 并发 `onEnded{reason:"missed"}`。

### 2.3 动作（CXProviderDelegate → JS 事件）

- **接听** `CXAnswerCallAction`：`configureAudioSession()`（只 `setCategory(.playAndRecord, mode: .voiceChat,
  options: [.allowBluetoothA2DP])`，不 `setActive`），`action.fulfill()`，发 `onAnswer{ringId}`。
- **挂断 / 拒接** `CXEndCallAction`：`fulfill`，发 `onEnd{ringId, answered: Bool}`。
- **静音** `CXSetMutedCallAction`：`fulfill`，发 `onMute{ringId, muted}`。
- **音频交接**：`didActivate audioSession` 发 `onAudio{active: true}`；`didDeactivate` 发 `onAudio{active: false}`；
  `providerDidReset` 结束所有来电、发 `onEnd`。
- JS 调原生：`endCall(ringId)`（App 里挂断 → `CXEndCallAction` 经 `CXCallController`）、
  `setMuted(ringId, muted)`（App 里静音同步到系统界面）。来电在 `fulfill` 接听那一刻就算接通，系统界面从那一刻计时，
  不另报「已连接」。

### 2.4 otto-speech 让出音频会话

- otto-speech 加一个开关 `setSessionManagedExternally(Bool)`，由 JS 在系统来电开始 / 结束时调（两个原生模块互不
  import，状态只在 JS 里有一份）。**判据**：开着时 Recognizer 不 `setActive(true/false)`、不改 category，其余照旧。
- 系统来电进行中收到 `interruptionNotification` 不当成打断（CallKit 激活 / 去激活会话本身就会触发它）。
- 麦克风要等 `onAudio{active: true}` 之后才开：CallKit 接听的这一路，JS 在音频激活之前不 `join` 麦克风。

## 3. 手机：JS 接线

- `mobile/src/call/callKit.ts`（新）：订阅 otto-call 的事件，接到现有 ringStore 的动作上：
  - `onIncoming` → `ringFromPayload` → `ringStore` 记下这通（不再画 `IncomingCall`），并照旧 `prefetchOpening`
    （ADR-0332，过期的不预合成）。
  - `onAnswer` → `answerRing(ring)`：导航重置到 `Chat{answerRing}`，与现在同一条路（后台时 React 照样渲染、
    ChatScreen 照样挂载、照样开房间）。标记「这是系统来电接起的」，让语音层等 `onAudio{active}` 再开麦。
  - `onEnd{answered:false}` → `declineRing`（同现在：只在本机撤，服务端 45 秒后记 missed）；
    `onEnd{answered:true}` → 挂断现在这通语音通话（`setVoiceCall([])`，与 App 里点挂断同一个动作）。
  - `onMute` → 语音层的静音（关麦）。
  - App 里挂断 / 通话被别处结束（名单清空）→ `endCall`。
  - 系统来电开始 → `setSessionManagedExternally(true)`；结束 → `false`。
- **后台不断**：系统来电进行中（从接听到结束）时，`voiceStore` 的「切后台就 `leave`」与 `cloudClient` 的
  「切后台就暂停会话房」都不做；来电结束之后，如果此刻在后台，补做一次。判据是 `callKit.ts` 导出的
  `inSystemCall()`，两处各读一次，不各记一份状态。
- **注册令牌**：`pushRegistration.ts` 改成取 `getVoipToken()`（和 `onToken`），`register_push_device(p_token,
  p_bundle, p_kind: 'voip')`。不再向 iOS 要通知权限（CallKit 不需要），不再取普通推送令牌。退出登录照旧注销。
- **拆掉**：`IncomingCall.tsx` 及其挂载点、`ringStore` 里的 `setNotificationHandler` / 点通知 /
  `getLastNotificationResponseAsync` 三处入口、App 内来电振动。`ringStore` 的队列、`answerRing` /
  `declineRing` / `settleAnswer` / 20 秒「没接通」提示留着，由 `callKit.ts` 驱动。
- **App 开着时来电**：同样是 CallKit 的界面（iOS 在前台时画成顶部横幅式来电），前后台一套，不会两处都响。

## 4. 构建配置

- `app.json`：`ios.infoPlist.UIBackgroundModes = ["voip", "audio"]`。
- 铃声文件继续由 `["expo-notifications", {sounds: [...]}]` 打进包根目录（CallKit 的 `ringtoneSound` 从主 bundle 取）；
  expo-notifications 本身还在依赖里，只是不再用于来电。时效性通知的 entitlement 留着不删（删了要重新配描述文件，
  与这次无关）。
- **要重新打原生包**：新原生模块 + 新后台模式。`CI=1 npx expo prebuild --clean --platform ios` 后装到真机
  （步骤同 #1417 那一次）。

## 5. 不做的

- 大陆区兜底（拍板 2）。
- 视频、呼叫保持、多方通话。
- 未接来电的系统通知（聊天里的通话记录已经是未接的记录，ADR-0331）。
- 把拒接告诉服务端（同现在：到点记 missed）。
- 桌面端：没有来电。

## 6. 测试

- `tests/runtime/apns.test.ts`：VoIP 头（type / topic / priority / expiration、没有 collapse-id）、载荷只有 `ring`。
- `tests/runtime/pushDevices.test.ts`：只取 `kind='voip'`；`tests/runtime/callRinger.test.ts` 照旧全绿（行为不变）。
- `tests/docs/pushDevicesMigration.test.ts`：0047 的约束（kind 两值、三参 RPC、授权与撤销、token 校验与 0046 一致）；
  `migrationRegexBounds` 照常覆盖。
- JS 接线的纯判据抽成 `src/shared/callKitBridge.ts`（事件 → 动作的映射、`inSystemCall` 的状态机、过期判断），进 vitest。
- 原生部分与「锁屏接听直接通话」只能真机验：锁屏来电响铃震动（开着 Mac 的 iPhone 镜像）、锁屏接听说话、
  系统界面挂断 / 静音、App 开着时来电、拒接后 45 秒记未接、没接到点自己结束、接听后解锁进 App 看到通话中。

## 7. 上线

1. 维护者同意后跑 0047。
2. 部署 runtime（#791）。**部署之后旧包收不到来电**，直到装上新包。
3. prebuild + 真机装新包，App 启动时注册 VoIP 令牌。

## 8. 决策记录

ADR（编号合并时定）：「智能体回电走 CallKit + VoIP 推送，推翻 ADR-0331 的通知来电；系统来电进行中不停听，修订
ADR-0320」。写清：为什么普通通知不够（§0.1 的诊断）、不上大陆区是前提、iOS 的「每条 VoIP 推送必须报来电」
规定怎么约束服务端、音频会话交给 CallKit 之后 otto-speech 让出的那一段。
