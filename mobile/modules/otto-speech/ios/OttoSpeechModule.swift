import ExpoModulesCore

// 手机端语音通话的原生一半（#1356 A4，ADR-0320）：识别 + 断句 + 回声消除 + 放音，照搬桌面
// native/MrOttoSpeech（ADR-0273 / 0277 / 0280）。桌面那边是一个吃 stdin 的子进程，这里是 Expo 模块：
// 命令是 AsyncFunction（一律在 speechQueue 上跑），事件一律走 onSpeech（不是请求-响应：识别结果是自己
// 冒出来的，没有哪一条命令在等它）。

/// 这个模块的命令、回调、定时器、通知一律在这一条私有串行队列上跑：Recognizer / Playback 的状态只在
/// 它上面动；串行，start / stop / play 按到达的顺序一条条做（#1356 A4 终审）。
/// **不用主线程**：iOS 的主线程就是界面线程，而配 AVAudioSession、`setActive`（AVAudioSession.h：激活
/// 是同步阻塞的，别放在阻塞会出问题的线程上）、开回声消除、起引擎，加起来常有几百毫秒，换路由 / 蓝牙能到
/// 几秒——放在主线程上，开电话那一刻、没开麦时每放一段，界面都要停一下（点不动，原生驱动的动画也停）。
/// 桌面那份在主线程上跑没事，是因为那个主线程是 helper 自己进程的，不是谁的界面。
/// 事件从这条队列上发出去没问题：sendEvent 自己排进 JS 线程（expo-modules-core 的 runtime.schedule）。
let speechQueue = DispatchQueue(label: "mrotto.speech", qos: .userInitiated)

/// 拒一条命令的 promise，JS 那边 Error.message 就是 `text` 原话。expo 把拒绝交给 JS 时 message 取的是
/// debugDescription（默认是「类名: 原因 (at Swift 源文件:行)」），这里改成只有原话。
/// `@unchecked Sendable` 是 Exception 那一格要子类重述的（expo 自己的异常类也这么写）；唯一的存储是一个 let
final class SpeechRejection: Exception, @unchecked Sendable {
  private let text: String

  init(_ text: String) {
    self.text = text
    super.init()
  }

  override var reason: String { text }
  override var debugDescription: String { text }
}

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
    }.runOnQueue(speechQueue)

    AsyncFunction("stop") {
      self.recognizer.stop()
    }.runOnQueue(speechQueue)

    AsyncFunction("pause") {
      self.recognizer.pause()
    }.runOnQueue(speechQueue)

    AsyncFunction("resume") {
      self.recognizer.resume()
    }.runOnQueue(speechQueue)

    AsyncFunction("status") {
      self.recognizer.emitStatus()
    }.runOnQueue(speechQueue)

    // 起不来（解不开 / 引擎起不来）时拒 promise，不发 playError（Playback.swift 的 PlaybackFailure）。
    // 自己拿 promise 拒，不是直接从这里抛：直接抛的话 expo 会给 JS 那边的 message 包一层（「Calling the
    // 'play' function has failed」+ 类名 + Swift 源文件行号），而这句话要原样落到界面上
    AsyncFunction("play") { (id: String, uri: String, promise: Promise) in
      do {
        try self.recognizer.play(id: id, uri: uri)
        promise.resolve()
      } catch {
        promise.reject(SpeechRejection(error.localizedDescription))
      }
    }.runOnQueue(speechQueue)

    AsyncFunction("stopPlay") {
      self.recognizer.stopPlay()
    }.runOnQueue(speechQueue)

    OnDestroy {
      // recognizerInstance 是在 speechQueue 上懒建的：读它也在队列上，排在还没做完的命令后面
      speechQueue.async { self.recognizerInstance?.shutdown() }
    }
  }
}
