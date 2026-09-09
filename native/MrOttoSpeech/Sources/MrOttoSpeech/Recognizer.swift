import AVFoundation
import Foundation
import Speech

// 识别会话：AVAudioEngine 的输入 tap 喂 SFSpeechAudioBufferRecognitionRequest，
// 结果交给 Endpointer 断句。**所有状态都在主线程上动**（识别回调与音频 tap 各在自己的
// 线程上，一律 hop 到 main）。
//
// 每句收口之后**重开一个 request**：连续模式下 request 会把音频一直攒着（内存跟着长），
// 且转写文本只增不清；换新 request = 清空转写、丢掉旧音频。没人说话时每 50 秒也换一次，
// 理由相同。generation 计数让旧 task 的迟到回调认不了新账。
//
// 半双工：pause 时不再往 request 喂音频、当场收口手上那半句（人被打断了，那半句仍然是
// 他说的）；resume 重开 request。引擎不停：停/起引擎要几百毫秒，agent 每说一段就来一回。

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
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var endpointer = Endpointer(silenceMs: 1500)
  private var timer: Timer?
  private var running = false
  private var paused = false
  private var generation = 0
  private var requestStartedAt: Double = 0
  private var locale = "zh-CN"

  /// 没人说话时多久换一次 request（毫秒）：攒着的音频有上限
  private let idleRestartMs: Double = 50_000

  init(emit: @escaping (Event) -> Void) { self.emit = emit }

  func status() -> Event {
    Event(
      type: "status",
      speech: speechAuthName(SFSpeechRecognizer.authorizationStatus()),
      mic: micAuthName(AVCaptureDevice.authorizationStatus(for: .audio)),
      onDevice: recognizer?.supportsOnDeviceRecognition,
      locale: locale)
  }

  func start(locale: String, silenceMs: Double) {
    if running {
      emit(Event(type: "listening", on: true))
      return
    }
    self.locale = locale
    endpointer = Endpointer(silenceMs: silenceMs)
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
      emit(Event(type: "error", message: "这台机器不支持识别「\(locale)」"))
      return
    }
    recognizer = r
    // 两道授权按顺序问：先语音识别再麦克风；任何一道没过都把 status 发出去，
    // 渲染层据它说人话（去哪儿勾）
    SFSpeechRecognizer.requestAuthorization { [weak self] s in
      DispatchQueue.main.async {
        guard let self else { return }
        guard s == .authorized else {
          self.emit(self.status())
          self.emit(Event(type: "error", message: "没有「语音识别」权限"))
          return
        }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          DispatchQueue.main.async {
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

  private func beginAudio() {
    guard !running else { return }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      emit(Event(type: "error", message: "没有可用的麦克风"))
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      // 音频线程。paused / request 是主线程改的，这里只读——最坏多喂一两块，无害
      guard let self, !self.paused, let req = self.request else { return }
      req.append(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      emit(Event(type: "error", message: "麦克风打不开：\(error.localizedDescription)"))
      return
    }
    running = true
    paused = false
    emit(Event(type: "listening", on: true))
    newRequest()
    let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)
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
    if #available(macOS 13, *) { req.addsPunctuation = true }
    request = req
    requestStartedAt = nowMs()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(gen: gen, result: result, error: error) }
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
      // 识别器自己断了（服务端模式的 1 分钟上限、内部错误…）：手上那半句先收口，
      // 稍后重开——不把一次抖动翻成「识别坏了」。cancel 自己引起的错误走不到这里
      // （generation 已经前进）
      if let text = endpointer.flush() { emit(Event(type: "final", text: text)) }
      emit(Event(type: "error", message: "识别中断：\(error.localizedDescription)，正在重试"))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        guard let self, self.generation == gen else { return }
        self.newRequest()
      }
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
    guard running else { return }
    running = false
    paused = false
    timer?.invalidate()
    timer = nil
    generation += 1
    task?.cancel()
    request?.endAudio()
    task = nil
    request = nil
    endpointer = Endpointer(silenceMs: endpointer.silenceMs)  // 通话结束，手上那半句作废
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    emit(Event(type: "listening", on: false))
  }
}
