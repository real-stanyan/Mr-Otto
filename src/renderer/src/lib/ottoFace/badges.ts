// 角标图案。与角色无关——十五个状态共用这一套。
//
// 存在的理由是 40px：花名册是一墙小头像，那个尺寸下「眯眼」和「平视」根本分不出来，
// 光靠脸不够。脸负责近看，角标负责扫一眼——与现有 orb 同一个思路。
// `A` 是强调色占位，实际取值由状态表给（蓝=在干活 / 琥珀=要你 / 绿=成了 / 红=崩了 /
// 青=语音 / 灰=静默）。

export type BadgeName =
  | "dots3" | "bubble" | "glass" | "gear" | "bars"
  | "wave" | "coil" | "bang" | "check" | "cross"
  | "hourglass" | "snow" | "zzz";

/** `gear` / `bars` 有动画，图案在 compose 里现算，所以不在这张表里 */
export const BADGES: Readonly<Record<Exclude<BadgeName, "gear" | "bars">, readonly string[]>> = {
  dots3: ["", "", "", "AA.AA.AA", "AA.AA.AA"],
  bubble: [".AAAAAA.", "A......A", "A......A", ".AAAAAA.", "..A.....", ".A......"],
  glass: [".AAAA...", "A....A..", "A....A..", "A....A..", ".AAAA...", "...AA...", "....AA..", ".....AA."],
  wave: ["....AA..", "..AA....", ".AA.....", ".AA.....", "..AA....", "....AA.."],
  coil: [".AAAAA.", "A.....A", "A.AAA.A", "A.A.A.A", "A.A...A", "A.AAAAA", "A......"],
  bang: [".AAAA.", ".AAAA.", ".AAAA.", ".AAAA.", "......", ".AAAA.", ".AAAA."],
  check: [".......A", "......AA", "A....AA.", "AA..AA..", ".AAAA...", "..AA...."],
  cross: ["AA....AA", ".AA..AA.", "..AAAA..", "...AA...", "..AAAA..", ".AA..AA.", "AA....AA"],
  hourglass: ["AAAAAA", ".AAAA.", "..AA..", "..AA..", ".AAAA.", "AAAAAA"],
  snow: ["A..A..A", ".A.A.A.", "..AAA..", "AAAAAAA", "..AAA..", ".A.A.A.", "A..A..A"],
  zzz: [".....AAA", "......A.", ".....A..", ".....AAA", "AAAA....", "..A.....", ".A......", "AAAA...."],
};

/** 齿轮两帧交替 = 旋转。像素画里真做旋转会把硬边磨掉，所以只换帧不转角度 */
export const GEAR_FRAMES: readonly (readonly string[])[] = [
  [".A.AA.A.", ".AAAAAA.", "AAA..AAA", "AA....AA", "AA....AA", "AAA..AAA", ".AAAAAA.", ".A.AA.A."],
  ["..AAAA..", ".AAAAAA.", "AAA..AAA", "AA....AA", "AA....AA", "AAA..AAA", ".AAAAAA.", "..AAAA.."],
];
