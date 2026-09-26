# ADR-0320：手机端语音通话——自写 Expo 原生模块照搬 MrOttoSpeech，编排进 shared

- 日期：2026-09-26
- 状态：已采纳
- 关联：#1356（A4）；spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §5.7 / §10 第 57–72 条 / §11 第 6–8 条；ADR-0271（团队语音通话）/ 0273（本机识别 helper）/ 0277（回声消除与插嘴）/ 0280（放音走 helper 的引擎）/ 0288（通话折成卡）/ 0306（断线时语音怎么收口）/ 0293（手机端依赖跟消费方一起进）

## 背景

手机「智能体」单栏的电话模式（spec §5.7）：输入框空着时那颗圆钮变「开电话」，通话中输入框换成电话那一格（脸 / 声浪 / 计时 / 转文字 / 静音 / 挂断），挂断折成一张卡。服务端那一半早就在（`call` 帧、`voice_call_changed`、`say{voice:true}`、edge `/llm/v1/speech`，ADR-0271 / 0288），手机缺三样：人说话那一半（识别）、它说话那一半（放音）、把两者串起来的编排。Expo Go 不带语音识别——识别一定要一个原生模块，也就一定要开发版。

## 决定

1. **识别与放音写成一个 Expo 本地模块**（`mobile/modules/otto-speech/`，Swift 5.9），照搬桌面 `native/MrOttoSpeech`（维护者 2026-09-26 在三条路里选的这条）：SFSpeechRecognizer + AVAudioEngine、每句收口换新 request、断句 Endpointer、能量门 LevelGate、VPIO 回声消除（开得了就不半双工、人能插嘴）、放音挂在同一个引擎的播放节点上。桌面在真机上踩过的坑（自激回声 #1176、ducking #1201、边想边说被切碎 #1196）一次带过来。iOS 多出来的五件事写在 `Recognizer.swift` 头注：配 AVAudioSession、来电 / 耳机插拔打断要说出口（不然放音队列等一个永远不来的 played）、ducking 配置是 iOS 17 的 API、放音收 file:// URI、起完引擎再报一次 status（aec 要开完回声消除才知道——桌面那份只在开引擎之前报，第一次开麦时 aec 还是 nil，另开 issue）。
2. **纯逻辑那两份 Swift 逐字抄、用断言对拍**（`Level.swift` 整份、`Endpointer.swift` 从「一句是不是像说完了」那段注释起到末尾，`tests/mobile/ottoSpeech.test.ts`），事件字段表、JS 声明的函数与 Swift 注册的函数、Info.plist 的两句授权说明也对拍。不共用源文件：CocoaPods 的本地 pod 收不到 pod 目录外的源文件，而改桌面 helper 的文件结构要重编它、重编要人重新点一次 TCC 授权。
3. **放音不引 expo-audio**（spec §5.7 原文写的是它）：两个库各自配 AVAudioSession，只能半双工、听筒 / 扬声器路由要自己兜；放音走识别那个引擎是 ADR-0280 已经在桌面验过的形状。一段 TTS 字节先落成缓存目录里的文件（expo-file-system），放完 / 放不了 / 停掉就删。
4. **编排进 shared**（`src/shared/voiceSession.ts`，进 vitest）：加入 / 离开、谁的回复读出来（通话名单里那几只、加入之后落下来的）、半双工与插嘴、一句说完发出去、云端断线的收口（gone 停麦但通话保留、ready 回来把麦开回来、人碰过麦克风就不自动开、denied 整段收掉）——语义逐条照桌面 store 的语音那一段。为此桌面渲染层的四份纯逻辑（voiceFeed / voiceMic / voicePlayer 的队列 / helperAudio）与主进程的三份（speechEventOf / ttsRoute / ttsClient）挪进 shared，桌面改 import、行为不变。**桌面 store 还没改用 voiceSession**：它多一扇「扣住 / 合并」的窗（#1281 的决策模型断句，走主进程 IPC），源码里还钉着 utteranceHoldWiring 那几条断言；两份编排并存是已知代价，另开 issue。
5. **锁屏 / 切后台 = 这台停听**（维护者 2026-09-26）：停麦停放音，通话本身还在（日志事实）；回到这一页，那一格写「通话还开着」+「接着听」。不开后台音频模式。离开聊天页同样只是停听（与桌面离开云会话同一条）。
6. **Expo Go 里没有电话**：`requireOptionalNativeModule` 回 null，电话钮不画，其余照常——开发版（`npx expo run:ios`）才有。
7. **声音按 agent_id 派生**（桌面同一份 `agentVoiceId`），挑声音另开一片（维护者 2026-09-26）。

## 否决

- **社区库 expo-speech-recognition + expo-audio**：决定 3 的理由；且识别、断句、回声消除、放音四件事分在两个库里，桌面那套判据（断句两条时钟、能量门、插嘴门槛）要么抄不过去、要么在 JS 里重写一遍。
- **A4 只做「听」、识别另开一片**：电话模式里没有麦克风，半个电话。
- **服务端识别**（录音上传 edge 转写）：Expo Go 里跑得动，但要新开一条带计费的网关路由、一家新的数据处理方，人说的每一句都出门；本机识别免费、不出门（ADR-0273 同一条）。
- **手机端的编排只写在 RN 那一侧**：手机端不进 vitest，而这一层是整条链上最容易出安静错的（断线、迟到的事件、半双工的开关）。

## 已知代价

1. 通话只在开发版里有；开发版要本机 Xcode + CocoaPods 构建（第一次十几分钟），真机要维护者的签名。
2. Swift 不进门禁：编译与行为只在模拟器 / 真机上验（xcodebuild 一次 + 开发版冒烟）。
3. 两份编排并存（决定 4），另开 issue 收成一份。
4. 名册上看不出哪条聊天的通话还开着（通话状态不在清单表里，要 runtime 投影一列）。
5. 模拟器上回声消除多半开不了 → 半双工；插嘴只能在真机上验。
6. 来电 / 耳机插拔之后要人自己再点一下麦克风（不自动恢复）。
7. 真机一次没跑过；登录后的流程（真打一通电话）agent 验不了。
