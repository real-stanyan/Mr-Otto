# ADR-0280：agent 的语音由 helper 自己的音频引擎播——不被 VPIO 压低，还是回声参考

- 状态：已采纳（2026-09-09）
- Issue：#1201（承 #1184 / ADR-0277）

## 背景

ADR-0277 给 helper 的 inputNode 开了系统回声消除（VPIO）。真机第一次跑，维护者十分钟里说了四次
「你说什么 / 听不清」——不是断，是**小**：macOS 的 VPIO 一开就把别的 app 的音频压低（ducking），
`voiceProcessingOtherAudioDuckingConfiguration` 的 `duckingLevel: .min` 是最低档不是零，而 agent 的
语音正是 Electron 这个「别的 app」放的（Web Audio，ADR-0271 / #1170）。下午没开 AEC 时同一台机器
「能听到」，两次之间只差这一样。

## 决策

### 1. TTS 字节交给 helper，用同一个 AVAudioEngine 的 AVAudioPlayerNode 播

主进程把渲染层递来的字节落成临时文件（`tmpdir/mrotto-speech/<id>.audio`——一段几百 KB，走 stdin 的
NDJSON 要 base64 且一行读完才解析），`play{id, path}` 命令递给 helper；helper 用 `Playback`（挂在
识别那同一个 engine 上的 AVAudioPlayerNode）播，播完发 `played{id}`、播不了发 `playError{id, message}`，
主进程收到回执就删文件。走同一个 VPIO 单元出去的声音**不被压**，还成了回声消除的远端参考信号
——比「扬声器放什么它就猜什么」的系统级消除更准。

### 2. 只在回声消除开着时走这条路

渲染层 `VoicePlayer` 的 `createAudio` 每段起播时现判：`mic.aec === true` → `helperAudio`；否则
Web Audio 照旧（非 mac / 没 helper / 开不了 AEC 的机器一个字不变）。`PlayerAudio` 的形状不动
（play / pause / onended / onerror），helper 那条路的 `play()` 在拿到 id 那一刻算起播、`onended`
等回执；`onerror` 多带一个可选的原因（helper 有原文，Web Audio 没有）。

### 3. 引擎的起停：听或播任一在进行就跑着

helper 原来只在开麦时起 engine、关麦就停。现在播也挂在它上面：关麦时正在放就不停（播完那一刻
再停）；没在听时来了 `play` 就起引擎——这时没开 voice processing，也就没有 ducking 的问题，走普通
输出。不让引擎常驻：跑着的引擎占着麦克风设备，关麦之后菜单栏那个橙点还亮着是撒谎。

### 4. 格式：每段按文件的 processingFormat 重连一次 player

AVAudioPlayerNode 的输出格式要与文件一致（mp3 的采样率不定），格式变了就 `disconnectNodeOutput`
再 `connect`；stop 之后迟到的完成回调用 generation 认账（`node.stop()` 会把已排的完成回调触发）。

## 否掉的候选

- **把 ducking 关成零**：API 没有这一档；`enableAdvancedDucking: false` + `.min` 已经是最低。
- **Electron 那边放大音量补偿**：压多少不知道、还随系统版本变，补偿是在猜。
- **关掉 AEC 退回半双工**：ADR-0277 的全部收益（常开麦、插嘴）都没了。

## 代价与已知未做

- 每段一次临时文件读写（几百 KB，SSD 上不可感）。
- 播放走了 helper，helper 崩了这段就丢（`playError` 回来，播放器跳到下一段——同合成失败的处理）。
- 关麦时正在放的那段播完才停引擎，橙点多亮几秒。
- 真机一次没跑过（探针只验了 helper 单独能把 mp3 放出声）。

## 推翻前提

- 真机上 helper 播的声音有问题（爆音 / 格式解不开）：`createAudio` 那一处改回 `defaultCreateAudio`，
  其余不动；ducking 的问题回到桌面上另想。
