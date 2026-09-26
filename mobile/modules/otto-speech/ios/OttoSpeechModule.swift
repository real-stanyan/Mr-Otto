import ExpoModulesCore

// 手机端语音通话的原生一半（#1356 A4，ADR-0320）：识别 + 断句 + 回声消除 + 放音，照搬桌面
// native/MrOttoSpeech（ADR-0273 / 0277 / 0280）。桌面那边是一个吃 stdin 的子进程，这里是 Expo 模块：
// 命令是 AsyncFunction（一律在主线程上跑——Recognizer 的状态只在主线程上动），事件一律走 onSpeech
// （不是请求-响应：识别结果是自己冒出来的，没有哪一条命令在等它）。
public class OttoSpeechModule: Module {
  private var recognizerInstance: Recognizer?
  /// 第一次用到才建（没开过电话的 app 不该多一个 AVAudioEngine 和两条通知订阅）
  private var recognizer: Recognizer {
    if let r = recognizerInstance { return r }
    let r = Recognizer { [weak self] event in
      self?.sendEvent("onSpeech", event.dictionary)
    }
    recognizerInstance = r
    return r
  }

  public func definition() -> ModuleDefinition {
    Name("OttoSpeech")

    Events("onSpeech")

    AsyncFunction("start") { (locale: String, hints: [String]) in
      self.recognizer.start(locale: locale, hints: hints)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.recognizer.stop()
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      self.recognizer.pause()
    }.runOnQueue(.main)

    AsyncFunction("resume") {
      self.recognizer.resume()
    }.runOnQueue(.main)

    AsyncFunction("status") {
      self.recognizer.emitStatus()
    }.runOnQueue(.main)

    AsyncFunction("play") { (id: String, uri: String) in
      self.recognizer.play(id: id, uri: uri)
    }.runOnQueue(.main)

    AsyncFunction("stopPlay") {
      self.recognizer.stopPlay()
    }.runOnQueue(.main)

    OnDestroy {
      guard let recognizer = self.recognizerInstance else { return }
      DispatchQueue.main.async { recognizer.shutdown() }
    }
  }
}
