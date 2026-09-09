# ADR-0273：群语音里人说话走 macOS 本机识别——常开麦、半双工、说完停顿自动发出

- 状态：已采纳（2026-09-09）
- Issue：#1176（承 #1163 / ADR-0271、#1174 / ADR-0272）
- 维护者拍板：引擎 = macOS 原生本机识别（否掉云端 ASR 走 edge）；收音 = 常开麦（否掉按住说话）

## 背景

ADR-0272 让拉进通话的 agent 先开口之后，维护者真机第二次用：对着它**说话** → 没有任何反应。
原话：「我在群语音中说话，不知道是系统根本识别不到我的声音还是什么，Agent 没有回话」。
不是识别不到，是**压根没有麦克风输入**——ADR-0271 明确没做 STT，只能打字、agent 用语音回。
对一个叫「语音通话」的东西，这是接通之后最大的一道墙：人的心智模型是打电话，不是打字机。

## 决策

### 1. 引擎：macOS 原生本机识别，一个 Swift helper，不过网关

`native/MrOttoSpeech/`：`SFSpeechRecognizer` + `AVAudioEngine`，与 MrOttoIsland / MrOttoSimInput
同一个形态（主进程 spawn，stdin/stdout NDJSON）。on-device（zh-CN / en-US 这台机器实测
`supportsOnDeviceRecognition = true`）、免费、实时出字、录音不出机器。**不像 TTS 那样走 edge**：
TTS 要官方 key（只能在 Worker secret 里），识别不要——把录音分片上传网关调 Whisper 一类的
ASR 是延迟高、按分钟计费、还要加一种 `model_route.kind` + 迁移 + 部署的路，而 app 本来只有
macOS。代价是**手机端将来要另做一份**（它没有 SFSpeechRecognizer 的 Node 桥可言）。

### 2. 常开麦 + 半双工，说完停顿 1.5 秒自动发出

进通话就开麦（`joinVoiceCall` 顺手 `speechStart`），通话栏一颗麦克风钮可手动关。断句在 helper
的 `Endpointer`：识别器连续模式下不会自己说「这句完了」（`isFinal` 只在 `endAudio` 之后来），
所以「转写文本 1.5 秒没再变过」= 一句说完 → `final` → 渲染层当成我在群里说的一句发出去
（`cloudSay(text, [], [])`：不 @，走 ADR-0270 的派活——通话里按职责挑一只接）。每句收口之后
**换一个新的识别 request**：连续模式下 request 会把音频一直攒着、转写只增不清；没人说话时
每 50 秒也换一次，理由相同。

**半双工**：agent 在说、或队列里还排着要说的段 → `speechPause`（helper 不再喂音频、当场收口
手上那半句），队列空 → `speechResume`。不闭麦的话扬声器里它自己的话会被麦克风录回去、当成
人说的再发出去——一个自激的回路。判据看 `queued` 不只看 `speaking`：段与段之间 `speaking`
会闪一下 null（预取好的下一段紧接着起播），只看它会在每两段之间开一次麦、再关一次。
引擎不停：停/起引擎要几百毫秒，而 agent 每说一段就来一回。

### 3. 事件不是请求-响应；崩溃要说出口

识别结果是 helper 自己冒出来的（partial / final / status / paused / resumed / listening / error），
没有哪条命令在等它，所以 `speechBridge` 的 `send` 只回「写没写进管子」，一切走 `onSpeechEvent`。
helper 懒起（第一次开麦才 spawn：没开过麦的 app 不该多一个占着麦克风设备的子进程），崩了
补一条 `error` + `listening:false`——不补的话通话栏会一直画着「开麦」而没人在听（#913
「失败无声」那一族）；超过 3 次不再起。渲染层关着麦时 helper 迟到的事件一律不动状态。

### 4. 权限：两道，各自说清去哪儿勾

麦克风 + 语音识别两道 TCC 授权按顺序问；任何一道没过，helper 发 `status`，渲染层据它说人话
（系统设置 → 隐私与安全性 → 哪一格 → 勾上 Mr Otto（开发时是 Electron / MrOttoSpeech））。
**helper 自己当 TCC 的责任进程**（#1180 订正）。TCC 把授权归到责任进程，而责任进程是沿进程树
一路归到**最顶上的 GUI app**：打包后由 Finder 起是 Mr Otto.app，dev 从终端起就是那个终端
（cmux / iTerm / Terminal，谁都不带 NSSpeechRecognitionUsageDescription）——真机上 helper 就这么被 TCC
杀掉（EXC_CRASH，崩溃报告 `responsibleProc = cmux`）。第一版押的「归到爹（Electron.app），给它补
plist」因此是错的：它不是顶上那个。修法是 helper 启动时 `responsibility_spawnattrs_setdisclaim(1)` +
`POSIX_SPAWN_SETEXEC` 原地 exec 自己一遍（Chromium 给 helper 进程用的同一私有接口），TCC 从此读
它用 `-sectcreate __TEXT,__info_plist` 嵌在二进制里的 Info.plist，弹窗写的是 MrOttoSpeech。真机验过：
`setdisclaim rc=0` → 4 秒内 speech / mic 都 authorized。（第一次 60 秒探测没等到授权回调、误判成
「弹不出框」，实际是框没人点。）接口没了就原样往下跑，那时授权归爹、打包态有 `extendInfo` 兜着。
打包时 `afterPack.cjs` 把 release 二进制拷进 Resources 并 ad-hoc 签，同另外两个 helper。

## 否掉的候选

- **云端 ASR 走 edge**：跨端可共用、但延迟高、按分钟计费、要动网关与迁移；app 只有 macOS。
- **按住说话**：最可控、零误收，但不像打电话；维护者要的是微信群语音那种形态。
- **Chromium 的 Web Speech API**：Electron 没带 Google 的语音 key，`webkitSpeechRecognition`
  起不来。
- **本地 whisper.cpp**：要带模型文件、要编原生库，包体与首启成本都不成比例。

## 代价与已知未做

- **只有 macOS**；手机端要另做一份。识别语言先钉 zh-CN（`SPEECH_LOCALE`），没有设置项。
- 半双工靠「不喂音频」不靠回声消除：agent 说话时人插不进嘴（要等它说完），且 `pause` 那一刻
  手上的半句会被当成一句发出去。
- 断句阈值 1.5 秒是拍的：说一句话中间停顿超过它会被切成两句。
- on-device 识别的语言资产是系统的（「听写」语言包）；没装的机器退回 Apple 服务端识别
  （`requiresOnDeviceRecognition = false`，1 分钟上限，helper 撞上就重开 request 并报一句
  「识别中断…正在重试」）。
- 识别出来的话进日志与打字的一模一样（一条 `user_message` / `chat_message`），**不标「这是
  说的」**——追溯不出这句是不是识别错了。
- 真机一次没跑过（合并后在 dev 里验：开麦 → 授权 → 说一句 → 派活 → 回话读出来 → 期间闭麦）。

## 推翻前提

- 要跨端：把 `speechBridge` 的事件契约原样保留，helper 换成一条「录音分片 → edge → ASR」的
  路；渲染层与 store 一个字不动（它们只认 `SpeechEvent`）。
- 半双工不够（人要能插嘴）：换成回声消除（AVAudioEngine 的 voice-processing IO），`pause` /
  `resume` 两条命令留着不发即可。
