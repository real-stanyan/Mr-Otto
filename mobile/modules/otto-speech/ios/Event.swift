import Foundation

// 事件（#1356 A4，ADR-0320）：与桌面 native/MrOttoSpeech/Sources/MrOttoSpeech/Protocol.swift 的 Event
// 同名同字段（tests/mobile/ottoSpeech.test.ts 对拍字段表）——桌面那边编码成一行 JSON，这里交给 Expo 的
// sendEvent 当字典；JS 那侧用同一个 speechEventOf 验。缺席的字段不放进字典（等于桌面 JSON 里没有那个键）。
struct Event {
  /// status / listening / paused / resumed / partial / final / level / played / playError / error
  let type: String
  var text: String?
  var message: String?
  /// status：语音识别授权（authorized / denied / restricted / notDetermined）
  var speech: String?
  /// status：麦克风授权（同上四档）
  var mic: String?
  /// status：这个语言在这台设备上能不能本机识别
  var onDevice: Bool?
  var locale: String?
  /// status：系统回声消除开没开（nil = 还没开过麦）
  var aec: Bool?
  /// listening：开 / 关
  var on: Bool?
  /// level：麦克风此刻的能量（0..1）
  var value: Double?
  /// level：能量门判「有人在说话」
  var active: Bool?
  /// played / playError：哪一段
  var id: String?

  var dictionary: [String: Any?] {
    var d: [String: Any?] = ["type": type]
    if let text { d["text"] = text }
    if let message { d["message"] = message }
    if let speech { d["speech"] = speech }
    if let mic { d["mic"] = mic }
    if let onDevice { d["onDevice"] = onDevice }
    if let locale { d["locale"] = locale }
    if let aec { d["aec"] = aec }
    if let on { d["on"] = on }
    if let value { d["value"] = value }
    if let active { d["active"] = active }
    if let id { d["id"] = id }
    return d
  }
}
