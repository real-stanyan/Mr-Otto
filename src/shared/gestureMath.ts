// gestureMath —— 手势那层的两条公式（动量投影 / 越界阻尼），桌面 `renderer/src/lib/spring.ts`
// 与手机底部抽屉共用一份（#1356 A1，spec §2 不抄第二份）；从 spring.ts 原样挪过来，
// 那边 re-export，nav-stack 的 import 不变。

/** 动量投影：以这个速度松手，滚到停下来还会再走多远。
    用的是 Apple 在 *Designing Fluid Interfaces* 示例里那条**指数衰减**式，不是
    课本上的 v²/(2a)——落点要跟系统滚动的手感一致，这两条给出的距离差得远。
    `decelerationRate` 0.998 = 常规滚动，0.99 = 更快停下。

    为什么要它：甩一下之后该去哪，判据是「速度衰减完落在哪」，不是「松手那一刻
    离谁近」。少了这一步，轻轻一甩会原地弹回去，手感立刻变成「它没听见」。 */
export function projectMomentum(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 越界阻尼：拉过头之后越拉越跟不动。硬停读作「卡住了」，渐进阻力读作
    「还在听你的，只是到头了」。`dimension` 是这一维的尺寸（把阻力标定到控件大小）*/
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
