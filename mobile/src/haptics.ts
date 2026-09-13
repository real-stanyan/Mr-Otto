// 触感只在四处（spec §3.3）：批准 / 拒绝落定、发送、通话接通 / 挂断、抽屉吸附。多了就没人注意了。
// 这里只放已经有消费方的两处；通话跟 M7、抽屉跟 M2 一起进来。
// 失败一律吞掉：没有触感马达的设备（模拟器、部分安卓）不该因为这个抛错。
import * as Haptics from "expo-haptics";

/** 批准 / 拒绝发出去了 */
export function hapticDecided(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** 一条话发出去了 */
export function hapticSent(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}
