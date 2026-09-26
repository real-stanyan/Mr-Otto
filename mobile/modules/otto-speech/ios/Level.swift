import Foundation

// 能量门（#1184）：一块音频的 RMS → 「人在说话吗」+ 给界面画声浪的 0..1。
//
// 门槛不写死：不同麦克风、不同房间的底噪差几十 dB，一个固定数要么在安静房间里被键盘声
// 触发，要么在吵的房间里永远听不见人。底噪自适应——样本比底噪低就快速跟下去，比底噪高就
// 慢慢抬（安静样本抬得快、说话样本抬得很慢：一个人连说十几秒不该把自己的声音变成底噪，
// 但持续十几秒的噪音——空调、马路——该被吸收成底噪）。另有一条绝对下限：比底噪高但本身
// 极轻的声音（键盘、呼吸）不算说话。
//
// 纯逻辑：时间与样本都由调用方递进来，Tests 里造数列就能跑。
struct LevelGate {
  /// 比底噪高这么多 dB 算说话
  let riseDb: Double
  /// 绝对门槛（dBFS）：再比底噪高，低于它也不算
  let minDb: Double
  /// 安静样本抬底噪的速度（每样本）
  let quietAlpha: Double
  /// 说话样本抬底噪的速度（每样本）
  let activeAlpha: Double
  private(set) var floorDb: Double? = nil

  init(riseDb: Double = 9, minDb: Double = -55, quietAlpha: Double = 0.05, activeAlpha: Double = 0.004) {
    self.riseDb = riseDb
    self.minDb = minDb
    self.quietAlpha = quietAlpha
    self.activeAlpha = activeAlpha
  }

  /// 一块音频。回 (界面用的 0..1, 有人在说话)
  mutating func feed(rms: Float, now: Double) -> (level: Double, active: Bool) {
    // 全零那一块（设备刚起）钳到 -90：不让一块数字静音把底噪钉在 -120
    let db = max(20 * log10(max(Double(rms), 1e-6)), -90)
    let floor = floorDb ?? db
    let active = db > minDb && db > floor + riseDb
    if db < floor {
      floorDb = floor + (db - floor) * 0.5
    } else {
      floorDb = floor + (db - floor) * (active ? activeAlpha : quietAlpha)
    }
    let level = min(1, max(0, (db + 60) / 50))
    return (level, active)
  }
}
