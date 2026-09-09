import Foundation

// 桥协议 —— 一行一条 JSON（NDJSON），与 MrOttoSimInput 同款。
// 主进程发 Command，helper 主动吐 Event（**不是请求-响应**：识别结果是自己冒出来的，
// 没有哪一条命令在等它）。纯数据 + 纯函数放这个文件，Tests 在没麦克风的机器上也能跑。

struct Command: Decodable {
  /// start / stop / pause / resume / status
  let type: String
  /// start：识别语言（BCP-47，如 zh-CN）
  var locale: String?
  /// start：安静多久算一句说完（毫秒）
  var silenceMs: Double?
}

struct Event: Encodable {
  /// status / listening / paused / resumed / partial / final / error
  let type: String
  /// partial / final
  var text: String?
  /// error
  var message: String?
  /// status：语音识别授权（authorized / denied / restricted / notDetermined）
  var speech: String?
  /// status：麦克风授权（同上四档）
  var mic: String?
  /// status：这个语言在这台机器上能不能本机识别
  var onDevice: Bool?
  var locale: String?
  /// listening：开/关
  var on: Bool?
}

/// 断句。识别器在连续模式下不会自己说「这句完了」——isFinal 只在 endAudio 之后来——
/// 所以「说完停顿自动发出」靠这里：转写文本在 silenceMs 内没再变过 = 一句说完。
/// 时间由调用方递进来（毫秒），Tests 才能不等真时间。
struct Endpointer {
  let silenceMs: Double
  private(set) var text: String = ""
  private var changedAt: Double = 0

  init(silenceMs: Double) { self.silenceMs = silenceMs }

  /// 新的转写快照到了。变了记时间并回 true（调用方发 partial）；没变回 false。
  /// 首尾空白不算变：识别器偶尔只在末尾多吐一个空格
  mutating func feed(_ snapshot: String, now: Double) -> Bool {
    let t = snapshot.trimmingCharacters(in: .whitespacesAndNewlines)
    if t == text { return false }
    text = t
    changedAt = now
    return true
  }

  /// 定时检查：有字、且从上次变化起安静够久 → 这一句收口并清空
  mutating func tick(now: Double) -> String? {
    guard !text.isEmpty, now - changedAt >= silenceMs else { return nil }
    return flush()
  }

  /// 强制收口（pause / 识别器自己报 isFinal）：有字回字并清空，没字回 nil
  mutating func flush() -> String? {
    guard !text.isEmpty else { return nil }
    let out = text
    text = ""
    return out
  }
}
