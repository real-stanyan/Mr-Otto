import Foundation

// 桥协议 —— 一行一条 JSON（NDJSON），与 MrOttoSimInput 同款。
// 主进程发 Command，helper 主动吐 Event（**不是请求-响应**：识别结果是自己冒出来的，
// 没有哪一条命令在等它）。纯数据 + 纯函数放这个文件，Tests 在没麦克风的机器上也能跑。

struct Command: Decodable {
  /// start / stop / pause / resume / status
  let type: String
  /// start：识别语言（BCP-47，如 zh-CN）
  var locale: String?
  /// start：转写多久没变就一定收口（毫秒）——能量断句之上的天花板
  var silenceMs: Double?
  /// start：像说完了的一句，人停嘴之后等多久收口（毫秒）
  var completeMs: Double?
  /// start：没说完的一句（逗号 / 没标点收尾），人停嘴之后等多久收口（毫秒）
  var midMs: Double?
}

struct Event: Encodable {
  /// status / listening / paused / resumed / partial / final / level / error
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
  /// status：系统回声消除开没开（开着 = 扬声器里 agent 的话不会被录回去，麦可以常开；
  /// nil = 还没开过麦）
  var aec: Bool?
  /// listening：开/关
  var on: Bool?
  /// level：麦克风此刻的能量（0..1，给界面画声浪）
  var value: Double?
  /// level：能量门判「有人在说话」
  var active: Bool?
}

/// 一句是不是像说完了：句末标点 = 说完；逗号 / 顿号 / 冒号收尾 = 没说完；没标点时很短的
/// 才算闭合的短答（「在吗」「好的」），长句没标点按没说完——识别器给句末标点是常态，
/// 没给往往是它还没定稿。判错的代价不对称：把没说完当说完是把人的话切成两半，
/// 把说完当没说完只是多等 0.8 秒（同 dryrun 的 endpointing 那条纪律）
func utteranceLooksFinished(_ text: String) -> Bool {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let last = t.last else { return false }
  if "。！？!?.…".contains(last) { return true }
  if "，、,;；:：".contains(last) { return false }
  return t.count <= 4
}

/// 断句。识别器在连续模式下不会自己说「这句完了」——isFinal 只在 endAudio 之后来——
/// 所以「说完停顿自动发出」靠这里。两条时钟（#1184）：
/// - **能量**：`feedLevel` 报人在不在说话；停嘴之后安静够久（像说完了 completeMs、没说完
///   midMs）且转写稳住 stableMs → 收口。识别器在人停嘴之后还会再变几百毫秒（重打分），
///   只看文本等于在识别器滞后之上再加一层等待；
/// - **文本**：转写 silenceMs 没变 = 一定收口。这是天花板不是主路：背景一直响（能量永远
///   「活着」）时不能永远不收口。没收到过能量样本时只剩这条（旧行为）。
/// 时间由调用方递进来（毫秒），Tests 才能不等真时间。
struct Endpointer {
  let silenceMs: Double
  let completeMs: Double
  let midMs: Double
  let stableMs: Double
  private(set) var text: String = ""
  private var changedAt: Double = 0
  /// 能量门上一次从「说话」翻成「安静」的时刻；nil = 此刻在说话（或还没收到过能量）
  private var quietSince: Double? = nil
  private var sawLevel = false

  init(silenceMs: Double = 1500, completeMs: Double = 700, midMs: Double = 1500, stableMs: Double = 250) {
    self.silenceMs = silenceMs
    self.completeMs = completeMs
    self.midMs = midMs
    self.stableMs = stableMs
  }

  /// 新的转写快照到了。变了记时间并回 true（调用方发 partial）；没变回 false。
  /// 首尾空白不算变：识别器偶尔只在末尾多吐一个空格
  mutating func feed(_ snapshot: String, now: Double) -> Bool {
    let t = snapshot.trimmingCharacters(in: .whitespacesAndNewlines)
    if t == text { return false }
    text = t
    changedAt = now
    return true
  }

  /// 能量门的一个样本：人此刻在不在说话
  mutating func feedLevel(active: Bool, now: Double) {
    sawLevel = true
    if active {
      quietSince = nil
    } else if quietSince == nil {
      quietSince = now
    }
  }

  /// 定时检查：有字、且（文本静默到天花板，或人停嘴够久且转写稳住）→ 这一句收口并清空
  mutating func tick(now: Double) -> String? {
    guard !text.isEmpty else { return nil }
    if now - changedAt >= silenceMs { return flush() }
    guard sawLevel, let quiet = quietSince else { return nil }
    let need = utteranceLooksFinished(text) ? completeMs : midMs
    guard now - quiet >= need, now - changedAt >= stableMs else { return nil }
    return flush()
  }

  /// 强制收口（pause / 识别器自己报 isFinal）：有字回字并清空，没字回 nil。
  /// 安静的时钟一并清：下一句从它自己的样本起算
  mutating func flush() -> String? {
    guard !text.isEmpty else { return nil }
    let out = text
    text = ""
    quietSince = nil
    return out
  }
}
