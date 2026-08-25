import Foundation

// 桥协议 —— 一行一条 JSON（NDJSON），与 MrOttoIsland 同款。
// 主进程发 Request，helper 回同 id 的 Response。纯数据 + 纯函数放这个文件，
// 好让 Tests 能在没有 Simulator、没有辅助功能授权的机器上跑。

struct Request: Decodable {
  let id: Int
  let type: String
  /// windowRect 用：这次截图的像素尺寸。给了就能在无障碍树里按宽高比认出
  /// 哪个元素是设备屏（它是唯一一个和截图同比例的大块）
  var shotWidth: Double?
  var shotHeight: Double?
  var x: Double?
  var y: Double?
  var x2: Double?
  var y2: Double?
  var duration: Double?
  var text: String?
  var button: String?
}

struct Rect: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Element: Encodable {
  let role: String
  let label: String
  let value: String?
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Response: Encodable {
  let id: Int
  let ok: Bool
  var error: String?
  /// probe
  var trusted: Bool?
  var simulatorRunning: Bool?
  var pid: Int?
  /// windowRect
  var rect: Rect?
  /// 这个矩形是哪来的："screen" = 无障碍树里那块设备屏（准）；
  /// "window" = 只拿到了窗口外框（没授权时的退路，调用方要自己等比内切）
  var rectSource: String?
  /// describe
  var elements: [Element]?
}

/// 硬件按钮 → Simulator.app 的菜单快捷键。
/// 这张表是这个 helper 的全部「按钮」实现：模拟器没有可发的硬件事件，
/// 能按的只有 AppKit 那一层的组合键。
/// 键码是 macOS 的 virtual keycode（kVK_ANSI_H = 4, kVK_ANSI_L = 37, kVK_ANSI_Z = 6）。
struct KeyCombo: Equatable {
  let keyCode: UInt16
  /// 用字符串记修饰键，Tests 里比对不用拖 CGEventFlags 进来
  let modifiers: Set<String>
}

func comboFor(button: String) -> KeyCombo? {
  switch button {
  case "home": return KeyCombo(keyCode: 4, modifiers: ["command", "shift"])
  case "lock": return KeyCombo(keyCode: 37, modifiers: ["command"])
  case "siri": return KeyCombo(keyCode: 4, modifiers: ["command", "shift", "option"])
  case "shake": return KeyCombo(keyCode: 6, modifiers: ["command", "control"])
  default: return nil
  }
}

/// 划动插值：把起止两点切成 steps 段。CGEvent 没有「划」这个动作，
/// 只能按住 → 一串 drag → 松开，中间点不够密的话 iOS 侧识别不出手势
func interpolate(
  from: (x: Double, y: Double), to: (x: Double, y: Double), steps: Int
) -> [(x: Double, y: Double)] {
  guard steps > 0 else { return [to] }
  return (1...steps).map { i in
    let t = Double(i) / Double(steps)
    return (x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
  }
}


/// 等比内切：把 shot 的宽高比塞进 box 里居中。
/// windowRect 只拿到窗口外框时的退路——Simulator 的窗口比设备屏略大一圈，
/// 直接拿外框当屏会让点击整体偏移
func fitCentered(
  shot: (width: Double, height: Double), box: Rect
) -> Rect {
  guard shot.width > 0, shot.height > 0 else { return box }
  let scale = min(box.width / shot.width, box.height / shot.height)
  let w = shot.width * scale
  let h = shot.height * scale
  return Rect(
    x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h)
}
