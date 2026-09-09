import AVFoundation
import Foundation

// helper 侧播放（#1201）：agent 的 TTS 字节由主进程落成临时文件，helper 用**同一个** AVAudioEngine 的
// AVAudioPlayerNode 播。为什么不让 Electron 自己放：inputNode 开着 voice processing 时 macOS 会把
// 别的 app 的音频压低（ducking，`duckingLevel: .min` 只是最低档不是零），真机上就是「听不清」；
// 走同一个 VPIO 单元出去的声音不被压，还是回声消除的远端参考信号。
//
// 一次只播一段（渲染层的队列本来就串行）；每段换文件格式就重连一次 player（AVAudioPlayerNode 的
// 输出格式要与文件的 processingFormat 一致，mp3 的采样率不定）。stop 之后迟到的完成回调用
// generation 认账（stop 会让已排的完成回调触发）。所有状态在主线程上动。
final class Playback {
  private let engine: AVAudioEngine
  private let node = AVAudioPlayerNode()
  private var attached = false
  private var connectedFormat: AVAudioFormat?
  private var generation = 0
  private var currentId: String?
  private let emit: (Event) -> Void

  init(engine: AVAudioEngine, emit: @escaping (Event) -> Void) {
    self.engine = engine
    self.emit = emit
  }

  var isPlaying: Bool { currentId != nil }

  /// `ensureRunning`：节点接好之后再起引擎——一个节点都没有的 engine 起不来
  /// （`inputNode != nullptr || outputNode != nullptr` 那条断言，探针撞过）
  func play(id: String, path: String, ensureRunning: () throws -> Void) {
    stop()
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    } catch {
      emit(Event(type: "playError", message: "音频解不开：\(error.localizedDescription)", id: id))
      return
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
      emit(Event(type: "playError", message: "音频引擎起不来：\(error.localizedDescription)", id: id))
      return
    }
    generation += 1
    let gen = generation
    currentId = id
    node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.generation == gen else { return }
        self.currentId = nil
        self.emit(Event(type: "played", id: id))
      }
    }
    node.play()
  }

  /// 停手上这段（不发 played：停是调用方自己要的，它知道）
  func stop() {
    guard currentId != nil else { return }
    generation += 1
    currentId = nil
    node.stop()
  }
}
