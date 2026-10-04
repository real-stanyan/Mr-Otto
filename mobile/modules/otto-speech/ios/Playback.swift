import AVFoundation
import Foundation

// 放音（#1356 A4，ADR-0320）：桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Playback.swift 的 iOS 版——
// agent 的 TTS 字节由 JS 落成缓存目录里的一个文件，这里用识别那**同一个** AVAudioEngine 的 AVAudioPlayerNode
// 放：不被回声消除压低，还是回声消除的远端参考信号（ADR-0280）。
// 与桌面的差别四处：路径收 expo-file-system 给的 file:// URI；多一个 interrupt——系统把声音拿走（来电 /
// 耳机拔了）时节点停了、完成回调不会来，手上那段要报 playError，不然 JS 那边的放音队列会一直等下去；
// 多一对 suspend / resume——开麦要先停引擎再开回声消除时，手上那段停下记着、重起之后从头再放（Recognizer 头注 ⑥，
// #1514）；多一个 cut——放不完了（系统来电里引擎被停 / 重起没成），当放完收掉；起不来（解不开 /
// 引擎起不来）是抛出去，不发 playError（见 PlaybackFailure）。
// 一次只放一段（JS 那边的队列本来就串行）；每段换格式就重连一次节点（mp3 的采样率不定）。stop 之后迟到的
// 完成回调用 generation 认账。所有状态在 speechQueue 上动（不用主线程的理由见 OttoSpeechModule.swift）；
// 完成回调在系统的线程上来，hop 过去。

/// 一段放不起来（音频解不开 / 引擎起不来），原话给人看（终审 Minor 5）。**抛出去、不发 playError**：
/// play 这条命令那时还没回，JS 还没登记这一段；这时发出去的 playError 能不能赶在登记之后到，全靠
/// expo 回 promise 比发事件优先——赶不上那一段就永远等不到回执（放音队列卡住，半双工时麦一直闭着）。
/// 抛出去 = 这条命令的 promise 被拒（OttoSpeechModule 的 play），JS 当场知道这段放不了
struct PlaybackFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

final class Playback {
  private let engine: AVAudioEngine
  private let node = AVAudioPlayerNode()
  private var attached = false
  private var connectedFormat: AVAudioFormat?
  private var generation = 0
  private var currentId: String?
  /// 手上这段的文件：开麦要停引擎开回声消除时（suspend / resume）从头再排一次要用它
  private var currentFile: AVAudioFile?
  private let emit: (Event) -> Void

  init(engine: AVAudioEngine, emit: @escaping (Event) -> Void) {
    self.engine = engine
    self.emit = emit
  }

  var isPlaying: Bool { currentId != nil }

  /// `ensureRunning`：节点接好之后再起引擎——一个节点都没有的 engine 起不来（桌面探针撞过）。
  /// 起不来就抛 PlaybackFailure（见它的注释）；起来了之后的结局（放完 / 被打断）照旧走事件
  func play(id: String, uri: String, ensureRunning: () throws -> Void) throws {
    stop()
    let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      throw PlaybackFailure(message: "音频解不开：\(error.localizedDescription)")
    }
    if !attached {
      engine.attach(node)
      attached = true
    }
    let format = file.processingFormat
    if connectedFormat == nil || connectedFormat! != format {
      if connectedFormat != nil { engine.disconnectNodeOutput(node) }
      engine.connect(node, to: engine.mainMixerNode, format: format)
      connectedFormat = format
    }
    do {
      try ensureRunning()
    } catch {
      throw PlaybackFailure(message: "音频引擎起不来：\(error.localizedDescription)")
    }
    currentId = id
    currentFile = file
    schedule(id: id, file: file)
  }

  private func schedule(id: String, file: AVAudioFile) {
    generation += 1
    let gen = generation
    node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      speechQueue.async {
        guard let self, self.generation == gen else { return }
        self.currentId = nil
        self.currentFile = nil
        self.emit(Event(type: "played", id: id))
      }
    }
    node.play()
  }

  /// 停手上这段（不发 played：停是 JS 自己要的，它知道）
  func stop() {
    guard currentId != nil else { return }
    generation += 1
    currentId = nil
    currentFile = nil
    node.stop()
  }

  /// 开麦要先停引擎再开回声消除（Recognizer 头注 ⑥）：手上这段先停下、**记着**，不发任何事件——
  /// 引擎带着回声消除重起之后 resume() 从头再放。回 true = 有一段停着等 resume；调用方没能把引擎重起来的话
  /// 改调 cut()，这一段当放完收掉。suspend 与 resume / cut 在 speechQueue 的同一拍里做完，中间没有别的命令插进来。
  /// 原来这里直接 cut()：系统来电接通时开场白往往赶在开麦之前（开麦要等两道授权回调），整句被当放完收掉，
  /// 人听到的是「接起来一开始没声音」（#1514）
  func suspend() -> Bool {
    guard currentId != nil, currentFile != nil else { return false }
    generation += 1 // 停节点时那段的完成回调会来，作废它
    node.stop()
    return true
  }

  /// suspend 停下的那段从头再放（引擎已经重起）
  func resume() {
    guard let id = currentId, let file = currentFile else { return }
    schedule(id: id, file: file)
  }

  /// 系统把声音拿走了：节点已经停了、完成回调不会来——手上那段报 playError
  func interrupt(message: String) {
    guard let id = currentId else { return }
    generation += 1
    currentId = nil
    currentFile = nil
    node.stop()
    emit(Event(type: "playError", message: message, id: id))
  }

  /// 手上那段放不完了（系统来电里引擎被停 / suspend 之后引擎没能重起）：当它放完了报 played，JS 的放音队列
  /// 接着往下走（这一段不补读）。不报 playError：这不是出错，界面上不该冒一行红字
  func cut() {
    guard let id = currentId else { return }
    generation += 1
    currentId = nil
    currentFile = nil
    node.stop()
    emit(Event(type: "played", id: id))
  }
}
