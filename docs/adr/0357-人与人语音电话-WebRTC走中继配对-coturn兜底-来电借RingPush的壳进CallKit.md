# ADR-0357：人与人在私聊里打语音电话——WebRTC 走中继 host↔guest 配对、自建 coturn 兜底、来电借 RingPush 的壳进 CallKit

日期：2026-10-04 · issue #1534（#1532 的二期）· 维护者拍板：「按你推荐的来」（WebRTC + 自建 coturn；信令走现有链路；来电复用 CallKit / APNs；是好友就能打）。协议 26 → 27。

## 背景

今天的「电话」全是人 ↔ 智能体：手机本地识别成文字 → 智能体 → TTS 合成放音（ADR-0320 / 0331）。两台手机之间**没有任何音频通道**。
维护者要的是私聊页上「给本人打电话」真的能打。只读核过的前提：中继按 channel 分房、只配 host↔guest 两种角色（好友代理那套，ADR-0151）、
载荷帧按 cid 寻址（ADR-0130）；来电那一条路（VoIP 推送 → PushKit → CallKit → JS 的 answer / end / mute / audio 事件）已经为智能体回电搭好
（ADR-0331，#1428），原生那一侧只读 `payload["ring"]` 的几格。

## 决定

1. **媒体走 WebRTC（react-native-webrtc）P2P，自建 coturn 做 TURN 兜底。** 否决了按分钟计费的第三方（LiveKit / Agora）——语音一通一两百 kbps，
   和 runtime 同一台机器上的 coturn 足够；也否决了把音频塞进中继的 WebSocket（中继是 Durable Object、单帧 256 KiB、不是媒体服务器）。
   `deploy/coturn/turnserver.conf.example` 是装法；runtime 多两个可选 env `TURN_URLS` / `TURN_SECRET`（要么全有要么全无，同 APNS 的纪律）。
   没配 = 只给公共 STUN，打得通但不保证。
2. **TURN 凭据是时限票**（coturn 的 `use-auth-secret`：用户名 `<过期秒>:<uid>`、密码 = base64(HMAC-SHA1)），runtime 在 `human_call` 帖上签：
   打的人在回执里拿、接的人在来电推送里拿（`RingPush.ice`）。两张票不同；活两小时；手机拿不到长期密码。
3. **信令走现有中继**：打的人以 host 连 `hc:<callId>`、接的人以 guest 连；帧是 `shared/humanCall.ts` 的 `HcFrame`（offer / answer / ice / hangup / ready），
   base64url 一层，按 cid 寻址。**offer 等对端说 ready 才发**：接的人要先连上房、开麦、建好 PeerConnection——offer 先到会撞上还没建好的那一端。
   runtime 不碰信令也不碰媒体，只做两件事：核对是好友、推来电。
4. **来电借 RingPush 的壳进 CallKit**：`chat = "human"`、`sessionId = callId`、`agentId = 打的人`、`agentName = 打的人的名字`。
   `CallCenter.swift` 一个字不改就能响（它只读 ringId / agentName / expiresTs）；JS 那一侧 `ringTarget` 认出 `human` 去开通话页而不是聊天页；
   `muteKeyFor("human")` 回 null（不是一条聊天，没有免打扰那一格）。否决了给原生加第二种推送负载：多一种负载 = 多一条要出原生包才能改的路。
5. **协议 27**：控制房多一对 `human_call` / `human_call_result`。`human_call` 不带 workspaceId、不过在籍那道闸（它不关于任何团队）；
   限速走 `call` 那一档；细判在 daemon（是好友、对方有能收推送的设备、推送没开就说打不了）。`deps.humanCall` 可选：smoke / 老测试不接它。
6. **是好友就能打**（同外联「好友关系本身就是同意」，ADR-0337 第 3 条）：仅聊天档也行——这是人，不是智能体。
7. **通话期间 otto-speech 让出音频会话**（`setSessionManagedExternally(true)`，与 CallKit 进行中同一个口），WebRTC 自己管 AVAudioSession；
   一通上限 1 小时（防止忘了挂的两台手机把 TURN 流量跑一夜）；响 45 秒没接算未接（与回电同一个数）。
8. **状态机是纯函数**（`reduceHumanCall`：ringing → connecting → live → ended，第一个结局胜出），通话页只画它。

## 否决的

- 第三方音视频 SDK：计费 + 又一套账号；对语音通话的需求过重。
- 音频经中继 / runtime 中转：中继不是媒体服务器；runtime 多一条实时音频路径就要为它加带宽与监控。
- 打的人那一侧也走 CallKit（去电界面）：otto-call 只有来电那一半；去电用 App 内的页就够，少一次原生改动。
- 未接 / 拒接写进 `messages`（私聊里留一条「未接来电」）：要 runtime 替人写 messages 或加列；一期先不留痕，另开 issue。

## 代价与已知未做

- **要出原生包**（react-native-webrtc）；协议 27 硬切，部署顺序 coturn（可选）→ runtime → 手机。
- **没有 TURN 时对称 NAT 后面的两台手机打不通**；配了 TURN 流量走 runtime 那台机器的带宽。
- **接的人的 WebRTC 在 CallKit `didActivate` 之前就开麦**：一期没等 `audio` 事件；真机上若接起来头一秒没声音，把 openMedia 挂到 audio=active 之后。
- **私聊里不留「未接来电」那一行**；打的人不在页面上时没有去电界面（锁屏后靠 CallKit 那一侧的音频会话，打的人这一侧没有）。
- **一次只有一通**：第二通来了把上一通收掉；忙线那一帧（`hangup busy`）只在对端还连着中继时发得出去。
- 真机一次没跑过（Windows 上没有模拟器）；`iceConnectionState` 到 `connected` 才算接通，没做媒体统计 / 回声消除以外的音频调优。
