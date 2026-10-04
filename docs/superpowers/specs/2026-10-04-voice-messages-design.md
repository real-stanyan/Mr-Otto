# 微信式语音消息（#1492）

日期：2026-10-04 · Task：#1492 · 依赖：#1491 P2/P3（PR #1497 / #1498，协议 24、`chat-media` 通道）· demo：`.demo/voice-messages.html`

> **2026-10-04 更新：** 私聊那一半已由另一条 lane 先合（PR #1506，ADR-0351；录音在 PR #1507 等原生发版）。维护者裁定**以 main 为准**：数据口径（≤5MB、无 1 秒下限、转写可缺席）、迁移 0055、手机 `AudioBubble`（expo-video 放音）都以 ADR-0351 为准，本稿「数据 / 共享」「迁移」「手机端 · 原生」「语音条」几节对应部分作废。本稿仍有效的部分：桌面私聊显示「[语音] 转写」（本分支已做）、群聊 / 智能体聊天发语音条（协议 25，待做）、G1 手势 + 转文字先改再发（待 #1507 合后在其上做）。

## 目标

手机端朋友私聊、群聊、智能体私聊都能发语音条（同微信）。接收方点了播放，长按可以「转文字」。智能体只拿到发送方手机识别出来的转写文字，看了以后回复。

## 已拍板（维护者 2026-10-04 会话）

1. **转写在发送方手机做**：按住时 SFSpeechRecognizer 本来就在边说边出字，松手时把音频和这份转写一起发出去。接收方「转文字」直接展开这份现成的转写，本机不再识别。智能体只收文字。
2. **这次只做手机**：桌面收到语音只显示「[语音] 转写」，不放音也不录。播放和录音留给 #1491 P5。
3. **听写保留**：按住录音，松手发语音条。手指拖到「转文字」再松手 = 只发文字，即今天的听写。
4. **智能体私聊也发语音条**，跟群聊、朋友私聊用同一个输入栏，行为一致。
5. **数据方案 A**：都用 `kind:"audio"` 这一种媒体，转写走各通道已有的正文。私聊放 `media.transcript`、body 写「[语音]」。云会话的 `say.text` 就是转写。
6. **UI = demo 的 A + G1 + 先改再发**：
   - **A 经典语音条**：宽度随时长变，显示 `N″`，未读带红点。长按弹菜单「转文字 / 删除」，转写画在气泡下面。
   - **G1 手势（微信 8）**：按住后左下是「✕ 取消」，右下是「文 转文字」，留在原处松手就发出。
   - **先改再发**：拖到「转文字」松手后弹出编辑框，有「取消 / 发送原语音 / 发送」三个按钮。

## 规则

- 时长不足 1 秒：提示「说话时间太短」，不发。50 秒起显示「还可以说 N 秒」，60 秒自动按发送处理。
- 同一时间只放一条。连着的几条别人发的未读语音，放完一条自动接下一条。离开页面就停。
- 未读红点只记在本机（AsyncStorage，按消息 id），不同步到服务器。
- 通话中按住说话：照今天的 `dictationUsable` 处理，录音也不可用。
- 识别不出文字：私聊 `transcript` 不写。云会话的 text 写「[语音，未识别出文字]」，免得智能体对着空占位乱回。接收方「转文字」显示「没识别出文字」。
- @ 的口径不变：转写当普通文字走现有的 mention 解析，和今天的听写一样。不 @ 谁的话，谁的活谁接（ADR-0270）。

## 数据

### 共享（`src/shared/chatMedia.ts`）

- `ChatMediaItem.kind` 加 `"audio"`，MIME 只收 `audio/mp4`（AAC m4a，单声道，约 32kbps，60s ≈ 240KB），扩展名 `m4a`。
  - 字段：`durationMs`（1000..60000 的整数）；`transcript?`（≤2000 字，**只在私聊用**）。
  - `width`/`height` 写 0，不带 `poster`。
- 一条消息只有这一段语音，不与图片 / 视频混发。`parseChatMedia` 与 `parseChatMediaRefs` 都要断言这一点。
- `MEDIA_PLACEHOLDER.audio = "[语音]"`。
- 字节上限 `AUDIO_MAX_BYTES = 2MB`：留足余量，按码率估算远到不了。
- `ChatMediaRef`（云会话引用）加 audio 分支：`{kind:"audio", sha256, mediaType, bytes, durationMs}`，没有 `transcript`，因为转写在 text 里。
- **向后兼容**：老客户端的 `parseItem` 遇到 audio 会把整份 media 丢掉，退回去显示 body「[语音]」，这条退路是数据构造本身保证的。

### 迁移 0054

`dm-media`、`chat-media` 两个 bucket 的 `allowed_mime_types` 加 `audio/mp4`。`messages` 表不动，`messages_media_shape` 只校验数组长度。生产库由维护者执行，执行方法见 Management API 那套。

### 云会话协议 25（`src/shared/remote/cloudSession.ts`）

- `CS_PROTOCOL_VERSION` 从 24 升到 25：握手要求精确相等，加一种枚举值也要升（ADR-0233）。
- `say.media` 接受 audio 引用，约束是只能有一个。
- runtime 的 `chatMediaIntake` 对 audio 这样处理：
  1. 自己拼路径：`chatMediaPath(ws, session, sha256, "audio/mp4")`；
  2. 下载回来，核对 sha256 和字节数（≤2MB）；
  3. **不进 `AttachmentStore`**：那里只收图片，音频进了 `attachments` 会被当成图片喂给模型。
- 事件：`ChatMessageEvent` 和 `UserMessageEvent` 都加可选字段 `voiceNote?: { sha256, bytes, durationMs }`，跟 `videos` 并列。
  - 旧日志里没有这个字段，照样能重放，满足 SessionEvent 向后兼容这条硬规则。
  - `deriveMessages` **不读** `voiceNote`，模型只看到 content（转写）。智能体侧和投影都不用改。
- 云时间线投影到手机和桌面的那一行，带上 `voiceNote`。
- 协议变更走一个项目 ADR：形状 + 为什么不进附件库 + 部署顺序。

## 手机端

### 原生 `otto-speech`（`runtimeVersion` 1 → 2，出 TestFlight）

- `start()` 加一个参数 `record: boolean`。为 true 时，在现有 tap（`Recognizer.swift`）里把单声道 buffer 顺手写进 `AVAudioFile(forWriting:)`，格式 AAC m4a，写到 caches 目录；`pause` 不影响录音。
- `stop()` 返回 `{ uri, durationMs, bytes }`。取消时删文件。
- 播放复用 `Playback.play(id, uri)`，前提是 m4a 能被 AVAudioFile 打开，实现时第一步先验这一点。
- **旧原生包 + 新 JS**：JS 先探测 `record` 能力，没有就把「按住」退回今天的听写行为，松手直接发文字。

### 输入栏（`mobile/src/chat/WxComposer.tsx` 的 `HoldButton` + 浮层）

- G1 手势：按下开始，手指位置判定为发送 / 取消 / 转文字三个区之一，浮层照 demo 画。
  - 系统把手指抢走（`onResponderTerminate`）一律算取消。
  - 现有的「上抬 60pt 取消」删掉，由左下的取消目标代替。
- 「转文字」松手后弹编辑框，三个按钮：
  - **发送**：把编辑后的文字走 `sendText`；
  - **发送原语音**：用未编辑的转写发语音条；
  - **取消**：丢弃。
- `voiceStore`：`startDictation` / `stopDictation` 改成返回 `{ text, audio? }`。播放走 `vm-<id>` 前缀的支路，同一时间只放一条。`helperAudioEvent` 不能再吞掉这条支路的 `played` 事件。

### 语音条（`mobile/src/media/AudioBubble.tsx`，`MediaBubble` 遇到 audio 分派过来）

- 宽度 `64 + 150·√(min(d,60)/60)` pt。`N″` 用等宽数字。
- 播放中，那组声波图标轮流闪；`prefers-reduced-motion` 下只改不透明度。
- 长按弹菜单：在现有气泡长按菜单原有的项之外，加一项「转文字 / 隐藏文字」。
- 转写画在气泡下面，入场 220ms ease-out（scale .96 → 1）。
- 发送中的 pending 变体，失败时可以重发，复用 P1 的 `runPending`。
- 播放流程：签名 URL → `expo-file-system` 下载到 caches（以 path 为键，下过就不再下）→ `OttoSpeech.play`。

### 发送

- **朋友私聊**：`sendMediaToFriend` 加上 audio。路径 `dmMediaPath`（`<sender>/<recipient>/<uuid>.m4a`），body 写「[语音]」，`media` 为 `[{kind:"audio", durationMs, transcript}]`。
- **群聊 / 智能体私聊**：
  1. `prepareMedia` 算 sha256，上传到 `chat-media`；
  2. 调 `sendText(transcript || "[语音，未识别出文字]", mentions, memberMentions, [audioRef])`；
  3. 那一行带 `voiceNote` 时把文字藏起来改画语音条，「转文字」展开的就是这行的 content。

## 桌面

- `FriendChatView`：用 `parseDmMedia` 认出 audio 后，显示「[语音] 」+ transcript；没有转写时只显示「[语音]」。
- `CloudSessionPage` 的 `ChatMessageRow` / `UserMessageRow`：带 `voiceNote` 的行，在 content 前加一个小号「[语音]」标签。

## 切片（每片一个 PR）

1. **共享 + 迁移 + 桌面显示**：`chatMedia.ts` 的 audio 分支与解析器测试，迁移 0054，桌面两处显示。不碰协议。
2. **原生录音**：`otto-speech` 的 record，`runtimeVersion` 升到 2，出 TestFlight。
3. **手机输入栏 + 语音条 + 私聊发送**：G1 浮层、编辑框、`AudioBubble`、播放支路、红点、旧原生包降级。
4. **协议 25 + runtime + 群聊发送**：`voiceNote` 事件字段、intake 的 audio 分支、手机云会话的发送与画法、桌面标签，外加 ADR。

## 部署顺序与风险

- 迁移 0054 要先于切片 3/4 的任何发送生效：不然上传会被 bucket 拒，客户端会显示发送失败，可以重发。
- **协议 25 会再断一次所有已装的客户端**：runtime 部署、手机热更新、桌面发版必须同一拍（同 ADR-0348 的注意事项）。
- **runtimeVersion 2 的坑**：原生包升到 rv2 后，还停在 rv1 的手机收不到新的热更新。协议 25 上线时，它们会一直连不上，直到装上新包。所以顺序是：
  1. 先发 TestFlight rv2，等常用设备都升上去；
  2. 再部署协议 25。
- 切片 3 的私聊部分不依赖协议，rv2 包到手就能用。

## 测试

- vitest：
  - `parseChatMedia` / `parseDmMedia` / `parseChatMediaRefs` 的 audio 正反例：混发、超时长、超字节、带 poster、transcript 超长；
  - 协议 25 编解码；
  - intake 的 audio 分支（sha 不符、超大、不进附件库）；
  - `deriveMessages` 对带 `voiceNote` 的事件，投影出来的只有 content；
  - 旧日志（没有 `voiceNote`）重放不变。
- 手机端纯逻辑：G1 区域判定、1 秒 / 60 秒边界、连播挑下一条，抽成纯函数测。
- 真机冒烟：
  - 模拟器录不了真麦克风，录音和播放只能在 TestFlight 包上验；
  - 私聊两台设备互发；
  - 群聊里说「Otto ……」，看智能体按转写回复；
  - 桌面看到「[语音] 转写」。

## 不做

桌面放音和录音（P5）；服务端 STT；已读状态跨设备同步；听筒 / 扬声器切换；转发语音；语音进模型（音频模态）。
