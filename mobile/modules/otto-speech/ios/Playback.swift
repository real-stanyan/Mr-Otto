import AVFoundation
import Foundation

// 放音（#1356 A4，ADR-0320）：桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Playback.swift 的 iOS 版——
// agent 的 TTS 字节由 JS 落成缓存目录里的一个文件，这里用识别那**同一个** AVAudioEngine 的 AVAudioPlayerNode
// 放：不被回声消除压低，还是回声消除的远端参考信号（ADR-0280）。
// 与桌面的差别两处：路径收 expo-file-system 给的 file:// URI；多一个 interrupt——系统把声音拿走（来电 /
// 耳机拔了）时节点停了、完成回调不会来，手上那段要报 playError，不然 JS 那边的放音队列会一直等下去。
// 一次只放一段（JS 那边的队列本来就串行）；每段换格式就重连一次节点（mp3 的采样率不定）。stop 之后迟到的
// 完成回调用 generation 认账。所有状态在主线程上动。
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

  /// `ensureRunning`：节点接好之后再起引擎——一个节点都没有的 engine 起不来（桌面探针撞过）
  func play(id: String, uri: String, ensureRunning: () throws -> Void) {
    stop()
    let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
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

  /// 停手上这段（不发 played：停是 JS 自己要的，它知道）
  func stop() {
    guard currentId != nil else { return }
    generation += 1
    currentId = nil
    node.stop()
  }

  /// 系统把声音拿走了：节点已经停了、完成回调不会来——手上那段报 playError
  func interrupt(message: String) {
    guard let id = currentId else { return }
    generation += 1
    currentId = nil
    node.stop()
    emit(Event(type: "playError", message: message, id: id))
  }

  /// 麦克风要开回声消除（得先停引擎）时手上那段放不完了：当它放完了报 played，JS 的放音队列接着往下走
  /// （这一段不补读）。不报 playError：这不是出错，界面上不该冒一行红字
  func cut() {
    guard let id = currentId else { return }
    generation += 1
    currentId = nil
    node.stop()
    emit(Event(type: "played", id: id))
  }
}
