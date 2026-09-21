// stoic —— 由 scripts/extract-face-sprite.mjs 从原图提取。
//
// 平头 —— 眉眼是斜的，左右锚点不在同一行，别看着不齐就去对齐。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 头高 45 格，与花名册其余角色对齐（见 characters/index.ts）。

import { deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const STOIC: FaceCharacter = {
  id: "stoic",
  name: "平头",
  w: 55,
  h: 48,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "g": "#9AA0A8", "o": "#FAFAFA" },
  base: [
    ".......................................................",
    "....................################...................",
    "....................################...................",
    "....................################...................",
    "...............##########################..............",
    "...............##########################..............",
    "...............###########################.............",
    ".............###############################...........",
    ".............###############################...........",
    "..........####################################.........",
    "..........####################################.........",
    "..........####################################.........",
    ".......###ddd#####oooooooo#############ooooooo###......",
    ".......###dddddd##oooooooo#############ooooooo###......",
    ".......###ddddddd#oooooooooooooooooooooooooooo###g.....",
    ".......###ddddddd#oooooooooooooooooooooooooooo###g.....",
    ".......###dddddd##oooooooooooooooooooooooooooo###g.....",
    ".......###dddddd##oooooooooooooooooooooooooooo###d.....",
    ".......###dddddd##oooooooooooooooooooooooooooo###d.....",
    ".......###ddddddoooooo######oooooooooooooooooo###d.....",
    ".......###ddddddoooooo######oooooooooooooooooo###d.....",
    ".......###ddddddoooooo#######ooooooooooooooooo###d.....",
    ".......###ddddddooooooooooo###oooooooo######oo###d.....",
    ".......######dddooooooooooo###oooooooo######oo###d.....",
    ".......######dddoooooooo####oooooooooo####oooo####.....",
    ".......######dddoooooooo####oooooooooo####oooo####.....",
    "....####ooooodddoooooooo####oooooooooo####oooo####.....",
    "....####ooooodddoooooooo####oooooooooo####oooo####.....",
    "....####ooooodddoooooooo####oooooooooo####oooo####.....",
    "....####oooooddooooooooo####oooooooooo####oooo####.....",
    "....####ooooooooooooooooo###oooooooooo####oooo####.....",
    "....####oooooooooooooooooooooooooooooooooooooo####.....",
    "....####oooooooooooooooooooooooooooooooooooooo####.....",
    "....####oooooooooooooooooooooooooooooooooooooo####.....",
    "....####oooooooooooooooooooooooooooooooooooooo####.....",
    "........###ooooooooooooooooooooooooooooooooooo####.....",
    "........########oooooooooooooooooooooooooooooo####.....",
    "........########ooooooooooo###########oooooooo####.....",
    ".............###ooooooooooo###########ooooo###.........",
    ".............###ooooooooooooooooooooooooooo###.........",
    ".............#####ooooooooooooooooooooooo#####.........",
    "...............###oooooooooooooooooooooo####...........",
    "...............###oooooooooooooooooooooo####...........",
    "..................#######################..............",
    "..................#######################..............",
    "..................#######################..............",
    ".......................................................",
    ".......................................................",
  ],
  erase: [
    [18, 23, 21, 31], // 左眉
    [20, 25, 37, 45], // 右眉
    [23, 31, 23, 30], // 左眼
    [23, 31, 37, 44], // 右眼
    [36, 40, 26, 38], // 嘴
  ],
  anchors: {
    browL: [22, 19], browR: [38, 22],
    eyeL: [24, 24], eyeR: [38, 24],
    mouth: [27, 37],
  },
  eyes: deriveEyes({ lw: 4, lh: 7, rw: 4, rh: 7 }),
  // 眉毛直接用原图那两条，不再 deriveBrows——搬家的比例不是整数，
  // 乘完取整会让两条眉毛差一格，而那一格肉眼一秒看得出来
  brows: { L: ["######..", "######..", "#######.", ".....###"], R: ["######", "######", "####.."] },
  mouths: {
    ...deriveMouths(11),
    // 原图那张嘴，从矩阵里读出来的
    smile: ["###########", "###########"],
  },
};
