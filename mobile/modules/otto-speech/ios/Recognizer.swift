import AVFoundation
import Foundation
import Speech

// 识别会话（#1356 A4，ADR-0320）：桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Recognizer.swift 的 iOS 版。
// 逐段对应桌面那份（理由写在那份的头注与 ADR-0273 / 0277 / 0280：AVAudioEngine 的输入 tap 喂识别 request、
// 每句收口换新 request、没人说话 50 秒换一次、能量门喂断句、半双工 pause/resume 不停引擎、回声消除开得了
// 就不半双工、放音挂在同一个引擎上）。iOS 多出来的六处：
// ① 起引擎之前配 AVAudioSession（playAndRecord、默认走扬声器、允许蓝牙 A2DP 放音）并激活；听与放都停了
//    再交还（notifyOthersOnDeactivation：别的 app 的音乐接着放）；
// ② 来电 / Siri 打断、耳机插拔（引擎配置变了）会让引擎停下而不回调：当成一次中断说出口——停听、手上那段
//    放音报 playError（不报的话 JS 那边的放音队列会一直等一个永远不来的 played）。「配置变了」按引擎此刻
//    停没停判，不按时间判：系统是先停引擎再发这条通知的（AVAudioEngine.h）；我们自己在起引擎之前开回声
//    消除也会引出一条，它 hop 到 speechQueue 时起引擎那一步已经做完——引擎还在跑 = 就是那一条，不算。
//    原来按「起来之后 1 秒内的不算」判，会把起来之后真停掉的那一次也吞掉（显示在听、什么都识别不到、
//    一个字不说）。不自动重起（维护者裁定），要人再点一下麦克风；
// ③ 回声消除的 ducking 配置是 iOS 17 起才有的 API；
// ④ 放音收 expo-file-system 给的 file:// URI（Playback.swift）；
// ⑤ 起完引擎再报一次 status：aec 要开完回声消除才知道（桌面那份只在开引擎之前报，第一次开麦时 aec 还是 nil）。
// ⑥ 开麦时引擎若已经因为放音在跑（第一次开麦要等授权），先把手上那段当放完收掉、停引擎，再开回声消除。
// **所有状态都在 speechQueue 上动**（OttoSpeechModule.swift；不用主线程的理由写在那里：iOS 的主线程是
// 界面线程，而 setActive 是同步阻塞的）。命令本来就在它上面跑；音频 tap、识别回调、两道授权回调、两条通知
// 各在系统挑的线程上，一律 hop 过去；定时器也挂在它上面。

private func speechAuthName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "notDetermined"
  }
}

private func micAuthName(_ s: AVAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "notDetermined"
  }
}

private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

final class Recognizer {
  private let emit: (Event) -> Void
  private let engine = AVAudioEngine()
  /// 放音（与识别共用 engine：不被回声消除压低，还是回声参考，ADR-0280）
  private lazy var playback = Playback(engine: engine) { [weak self] e in
    self?.emit(e)
    if e.type == "played" || e.type == "playError" { self?.deactivateIfIdle() }
  }
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var endpointer = Endpointer()
  private var gate = LevelGate()
  private var timer: DispatchSourceTimer?
  private var running = false
  private var paused = false
  /// 开麦的号（终审 Important 2）：开麦要等两道授权（第一次会弹窗），等的时候来了 stop（切后台 / 离开 /
  /// 挂断），授权回来时不该再开——JS 那边早当它关了，不会再发 stop，麦就开着没人管（橙点亮着、识别在跑）。
  /// start 与 stop 各推一格，授权回调只认自己那一格
  private var startToken = 0
  private var generation = 0
  private var requestStartedAt: Double = 0
  private var locale = "zh-CN"
  /// 上下文词表（start 给的），每个 request 都带
  private var hints: [String] = []
  /// 回声消除开没开；nil = 还没开过麦
  private var aec: Bool? = nil
  private var lastLevelEmitAt: Double = 0
  /// level 事件的节流（毫秒）：音频块几十块一秒，界面画声浪 10 帧一秒够了
  private let levelEveryMs: Double = 100
  /// 没人说话时多久换一次 request（毫秒）：攒着的音频有上限
  private let idleRestartMs: Double = 50_000
  private var observers: [NSObjectProtocol] = []

  init(emit: @escaping (Event) -> Void) {
    self.emit = emit
    let center = NotificationCenter.default
    // queue: nil = 在发通知的那条线程上同步跑（引擎那条是它内部的队列）：只读 userInfo，然后 hop 到 speechQueue
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
      speechQueue.async { self?.interrupted("被系统打断了（来电 / Siri），点一下麦克风再开") }
    })
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      speechQueue.async {
        // 按引擎此刻停没停判（头注 ②）：还在跑 = 起引擎之前开回声消除引出的那一条
        guard let self, !self.engine.isRunning else { return }
        self.interrupted("声音设备变了（耳机 / 蓝牙），点一下麦克风再开")
      }
    })
  }

  func status() -> Event {
    Event(
      type: "status",
      speech: speechAuthName(SFSpeechRecognizer.authorizationStatus()),
      mic: micAuthName(AVCaptureDevice.authorizationStatus(for: .audio)),
      onDevice: recognizer?.supportsOnDeviceRecognition,
      locale: locale,
      aec: aec)
  }

  func emitStatus() {
    emit(status())
  }

  func start(locale: String, hints: [String]) {
    if running {
      emit(Event(type: "listening", on: true))
      return
    }
    startToken += 1
    let token = startToken
    self.locale = locale
    self.hints = hints
    endpointer = Endpointer()
    gate = LevelGate()
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
      emit(Event(type: "error", message: "这台设备不支持识别「\(locale)」"))
      return
    }
    recognizer = r
    // 两道授权按顺序问：先语音识别再麦克风；任何一道没过都把 status 发出去，JS 据它说人话（去哪儿打开）。
    // 两个回调都在系统挑的线程上来，hop 回 speechQueue；这次 start 等的时候被 stop（或新的 start）顶掉了，
    // 就什么都不说、不开麦（startToken）
    SFSpeechRecognizer.requestAuthorization { [weak self] s in
      speechQueue.async {
        guard let self, token == self.startToken else { return }
        guard s == .authorized else {
          self.emit(self.status())
          self.emit(Event(type: "error", message: "没有「语音识别」权限"))
          return
        }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          speechQueue.async {
            guard token == self.startToken else { return }
            guard ok else {
              self.emit(self.status())
              self.emit(Event(type: "error", message: "没有「麦克风」权限"))
              return
            }
            self.emit(self.status())
            self.beginAudio()
          }
        }
      }
    }
  }

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    try session.setActive(true)
  }

  /// 听与放都停了：停引擎、把音频交还给系统（别的 app 的音乐接着放）
  private func deactivateIfIdle() {
    guard !running, !playback.isPlaying else { return }
    if engine.isRunning { engine.stop() }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func ensureEngine() throws {
    guard !engine.isRunning else { return }
    engine.prepare()
    try engine.start()
  }

  private func ensurePlaybackEngine() throws {
    guard !engine.isRunning else { return }
    try activateSession()
    try ensureEngine()
  }

  private func beginAudio() {
    guard !running else { return }
    // 正在放它的话（开麦要等两道授权，它已经开口了）：先把手上那段收掉、停引擎——回声消除只能在停着的引擎上开，
    // 在跑着的引擎上开会抛（退回半双工）或者引发一次「配置变了」，把刚开的麦又关掉
    // 放在激活会话之前：cut() 报的 played 会走 deactivateIfIdle()，把会话交还系统；先收再激活，顺序才对
    if engine.isRunning {
      playback.cut()
      engine.stop()
    }
    do {
      try activateSession()
    } catch {
      emit(Event(type: "error", message: "麦克风打不开：\(error.localizedDescription)"))
      return
    }
    let input = engine.inputNode
    // 系统回声消除（ADR-0277）。开不了不算错——status.aec=false，JS 退回半双工，界面上不说；但真机上
    // 要查「为什么没开成」，留一行系统日志
    do {
      if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
      aec = true
    } catch {
      NSLog("[OttoSpeech] voice processing unavailable: %@", String(describing: error))
      aec = false
    }
    if aec == true, #available(iOS 17.0, *) {
      input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      emit(Event(type: "error", message: "没有可用的麦克风"))
      deactivateIfIdle()
      return
    }
    // 开着回声消除时输出格式可能是多声道，识别器吃不下：只取第 0 声道折成 mono（桌面同一条）
    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false) else {
      emit(Event(type: "error", message: "麦克风格式不支持（\(format.sampleRate) Hz）"))
      deactivateIfIdle()
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      // 音频线程。paused / request 是 speechQueue 上改的，这里只读——最坏多喂一两块，无害
      guard let self, let src = buffer.floatChannelData else { return }
      let n = Int(buffer.frameLength)
      guard n > 0 else { return }
      // 能量：第 0 声道的 RMS。paused 时也算——声浪照画，只是不喂识别器
      var sum: Float = 0
      for i in 0..<n { sum += src[0][i] * src[0][i] }
      let rms = (sum / Float(n)).squareRoot()
      speechQueue.async { self.onLevel(rms: rms) }
      guard !self.paused, let req = self.request else { return }
      if buffer.format.channelCount > 1, let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) {
        out.frameLength = buffer.frameLength
        memcpy(out.floatChannelData![0], src[0], n * MemoryLayout<Float>.size)
        req.append(out)
      } else {
        req.append(buffer)
      }
    }
    do {
      try ensureEngine()
    } catch {
      input.removeTap(onBus: 0)
      emit(Event(type: "error", message: "麦克风打不开：\(error.localizedDescription)"))
      deactivateIfIdle()
      return
    }
    running = true
    paused = false
    emit(Event(type: "listening", on: true))
    // 头注 ⑤：aec 这时才知道
    emit(status())
    newRequest()
    // 100ms 一跳：断句的粒度——completeMs 700 之上再加的等待不该超过一跳。挂在 speechQueue 上，tick 与
    // 别的状态改动排在同一条队列里
    let t = DispatchSource.makeTimerSource(queue: speechQueue)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(10))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    timer = t
  }

  /// 换一个新的识别 request（旧 task 作废：generation 前进，迟到的回调认不了账）
  private func newRequest() {
    guard running, !paused, let recognizer else { return }
    generation += 1
    let gen = generation
    task?.cancel()
    request?.endAudio()
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    req.addsPunctuation = true
    if !hints.isEmpty { req.contextualStrings = hints }
    request = req
    requestStartedAt = nowMs()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      speechQueue.async { self?.handle(gen: gen, result: result, error: error) }
    }
  }

  private func handle(gen: Int, result: SFSpeechRecognitionResult?, error: Error?) {
    guard gen == generation, running, !paused else { return }
    if let result {
      if endpointer.feed(result.bestTranscription.formattedString, now: nowMs()) {
        emit(Event(type: "partial", text: endpointer.text))
      }
      if result.isFinal {
        if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
        newRequest()
      }
      return
    }
    if let error {
      // 识别器自己断了（服务端模式的 1 分钟上限、内部错误…）：手上那半句先收口，稍后重开——
      // 不把一次抖动翻成「识别坏了」。cancel 自己引起的错误走不到这里（generation 已经前进）
      if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
      emit(Event(type: "error", message: "识别中断：\(error.localizedDescription)，正在重试"))
      speechQueue.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        guard let self, self.generation == gen else { return }
        self.newRequest()
      }
    }
  }

  /// 一块音频的能量到了（speechQueue 上）：过门 → 喂断句 → 节流着发给界面
  private func onLevel(rms: Float) {
    guard running else { return }
    let now = nowMs()
    let r = gate.feed(rms: rms, now: now)
    if !paused { endpointer.feedLevel(active: r.active, now: now) }
    if now - lastLevelEmitAt >= levelEveryMs {
      lastLevelEmitAt = now
      emit(Event(type: "level", value: (r.level * 100).rounded() / 100, active: r.active))
    }
  }

  private func tick() {
    guard running, !paused else { return }
    let now = nowMs()
    if let text = endpointer.tick(now: now) {
      emit(Event(type: "final", text: text))
      newRequest()
      return
    }
    if endpointer.text.isEmpty, now - requestStartedAt > idleRestartMs {
      newRequest()
    }
  }

  func pause() {
    guard running, !paused else { return }
    paused = true
    generation += 1
    task?.cancel()
    request?.endAudio()
    task = nil
    request = nil
    if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
    emit(Event(type: "paused"))
  }

  func resume() {
    guard running, paused else { return }
    paused = false
    newRequest()
    emit(Event(type: "resumed"))
  }

  func stop() {
    // 先推一格：还在等授权的那次 start 作废。它不算开过，所以不报 listening 关——JS 早当它关了，多报一条
    // 只会落进「关了之后迟到的事件」那道缝里
    startToken += 1
    guard running else { return }
    running = false
    paused = false
    timer?.cancel()
    timer = nil
    generation += 1
    task?.cancel()
    request?.endAudio()
    task = nil
    request = nil
    endpointer = Endpointer()  // 手上那半句作废（离开 / 挂断）
    engine.inputNode.removeTap(onBus: 0)
    emit(Event(type: "listening", on: false))
    // 正在放它的话就先不停引擎（放音也挂在它上面），放完那一刻再停
    deactivateIfIdle()
  }

  /// 放一段。起不来抛 PlaybackFailure，交给 play 那条命令去拒 promise（不发 playError，见 Playback.swift）
  func play(id: String, uri: String) throws {
    do {
      try playback.play(id: id, uri: uri) { try self.ensurePlaybackEngine() }
    } catch {
      // 原来走 playError 那条路时顺手做的收尾：会话可能激活了一半、引擎停着——没人在用就交还
      deactivateIfIdle()
      throw error
    }
  }

  func stopPlay() {
    playback.stop()
    deactivateIfIdle()
  }

  /// 系统把声音拿走了（头注 ②）：手上那段放音报 playError；在听的话先说一句为什么、再停听
  private func interrupted(_ message: String) {
    playback.interrupt(message: message)
    guard running else {
      deactivateIfIdle()
      return
    }
    emit(Event(type: "error", message: message))
    stop()
  }

  /// 模块被销毁（JS 那侧重载）：停听、停放、退订通知
  func shutdown() {
    stop()
    stopPlay()
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
  }
}
