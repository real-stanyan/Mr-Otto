// specs —— 由 scripts/extract-face-sprite.mjs 从原图提取。
//
// 方框眼镜 —— 镜框是脸的一部分，不动；只抹镜片内腔，眼睛在框里换。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 头高 46 格，与花名册其余角色对齐（见 characters/index.ts）。

import { deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SPECS: FaceCharacter = {
  id: "specs",
  name: "方框眼镜",
  w: 55,
  h: 48,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    ".......................................................",
    "................####################...................",
    "................####################...................",
    "................####################...................",
    "..............##########dd##############...............",
    ".............###########dd##############...............",
    "...........#####dddddddd##################.............",
    "..........######dddddddd##################.............",
    ".......#######dddddddddddd##########dddd#####..........",
    ".......#######dddddddddddd##########dddd#####..........",
    ".......#####ddddddddoooooooooo########oooo###..........",
    ".......#####ddddddddoooooooooo########oooo###..........",
    "......###dddddddddooooooooooooooooooooooooo###.........",
    ".....####dddddddddooooooooooooooooooooooooo###.........",
    ".....####dddddddddooooooooooooooooooooooooo###.........",
    ".....####dddddddddooooooooooooooooooooooooo###.........",
    ".....###ddddddddddooooooooooooooooooooooooooo###.......",
    ".....###ddddddddddooooooooooooooooooooooooooo###.......",
    ".....###ddddddddddooooooooooooooooooooooooooo###.......",
    ".....###ddddddddddooooooooooooooooooooooooooo###.......",
    ".....###ddddddoooooooo########oooooooooo####o###.......",
    ".....###ddddddoooooooo########oooooooooo####o###.......",
    ".....###ddddddoooooooooooooooooooooooooooooooo##.......",
    ".....###ddddddoooooooooooooooooooooooooooooooo##.......",
    ".....#######ddooooo###############ooo##############....",
    ".....#######ddooooo##ooooo########ooo#######oo#####....",
    ".....################oooooo###oo##ooo##oo###oo##o##....",
    "...###ooooo##########oooooo###oo#######oo###oo##o##....",
    "...###ooooo###ooooo##oooooo###oo#######oo###oo##o##....",
    "...###ooooo###ooooo##oooooo###oo##ooo##oo###oo##o##....",
    "...###ooooo###ooooo##oooooo###oo##ooo##oo###oo##o##....",
    "...###ooooooooooooo##ooooooooooo##ooo##ooooooo##o##....",
    "...###ooooooooooooo##ooooooooooo##ooo##ooooooo#####....",
    "...###ooooooooooooooo###########ooooooo##########......",
    "...######oooooooooooo###########ooooooo##########......",
    "...######oooooooooooooooooooooooooooooooooooo###.......",
    ".......##ooooooooooooooooooooooooooooooooooooo##.......",
    ".......#######oooooooooooooooooooooooooooooooo##.......",
    ".......#######oooooooooooooooooooooooooooooooo##.......",
    "..........####oooooooooooooooo#########oooooo###.......",
    "...........###oooooooooooooooo#########oooo###.........",
    "...........###oooooooooooooooo########ooooo###.........",
    "............####ooooooooooooooooooooooooo#####.........",
    ".............###ooooooooooooooooooooooooo###...........",
    ".............###ooooooooooooooooooooooooo###...........",
    "...............##########################..............",
    "...............##########################..............",
    ".......................................................",
  ],
  erase: [
    [18, 22, 21, 30], // 左眉
    [18, 22, 39, 44], // 右眉
    [38, 42, 28, 39], // 嘴
  ],
  anchors: {
    browL: [22, 20], browR: [40, 20],
    eyeL: [26, 25], eyeR: [41, 25],
    mouth: [30, 39],
  },
  eyes: deriveEyes({ lw: 4, lh: 5, rw: 3, rh: 5 }),
  // 眉毛直接用原图那两条，不再 deriveBrows——搬家的比例不是整数，
  // 乘完取整会让两条眉毛差一格，而那一格肉眼一秒看得出来
  brows: { L: ["########", "########"], R: ["####", "####"] },
  mouths: {
    ...deriveMouths(9),
    // 原图那张嘴，从矩阵里读出来的
    smile: ["#########", "#########", "########."],
  },
};
