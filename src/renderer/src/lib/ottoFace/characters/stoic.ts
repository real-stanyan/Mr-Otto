// stoic —— 由 scripts/extract-face-sprite.mjs 从 prep8.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.764 / 相位 (7.25, 2.25) / 重建误差 5.6%

//
// 眉眼是斜的（四分之三侧脸），左右锚点不在同一行，别看着不齐就去对齐。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const STOIC: FaceCharacter = {
  id: "stoic",
  name: "平头",
  w: 45,
  h: 44,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    "................################.............",
    "................################.............",
    "................################.............",
    "...........#########################.........",
    "...........#########################.........",
    "...........#########################.........",
    ".........##############################......",
    ".........##############################......",
    "......###################################....",
    "......###################################....",
    "......###################################....",
    "...###ddd#####oooooooo#############oooooo###.",
    "...###dddddd##oooooooo############ooooooo###.",
    "...###ddddddd#ooooooooooooooooooooooooooo###.",
    "...###ddddddd#ooooooooooooooooooooooooooo###.",
    "...###dddddd##ooooooooooooooooooooooooooo###.",
    "...###dddddd##ooooooooooooooooooooooooooo###.",
    "...###dddddd##ooooooooooooooooooooooooooo###.",
    "...###ddddddoooooo######ooooooooooooooooo###.",
    "...###ddddddoooooo######ooooooooooooooooo###.",
    "...###ddddddoooooo########oooooooo#####oo###.",
    "...###ddddddoooooooooo####ooooooo######oo###.",
    "...######dddoooooooooo####ooooooo######oo###.",
    "...######dddoooooooo####ooooooooo####oooo###.",
    ".########dddoooooooo####ooooooooo####oooo###.",
    ".###ooooodddoooooooo####ooooooooo####oooo###.",
    ".###ooooodddoooooooo####ooooooooo####oooo###.",
    ".###ooooodd#oooooooo####ooooooooo####oooo###.",
    ".###oooood#ooooooooo####ooooooooo####oooo###.",
    ".###ooooooooooooooooooooooooooooooooooooo###.",
    ".###ooooooooooooooooooooooooooooooooooooo###.",
    ".###ooooooooooooooooooooooooooooooooooooo###.",
    ".###ooooooooooooooooooooooooooooooooooooo###.",
    "....##ooooooooooooooooooooooooooooooooooo###.",
    "....########ooooooooooooooooooooooooooooo###.",
    "....########ooooooooooo##########oooooooo###.",
    "........####ooooooooooo##########oooooo###...",
    ".........###ooooooooooo#########oooooo###....",
    ".........###oooooooooooooooooooooooooo###....",
    "...........###oooooooooooooooooooooo###......",
    "...........###oooooooooooooooooooooo###......",
    "..............######################.........",
    "..............######################.........",
    "..............######################.........",
  ],
  erase: [
    [17, 21, 17, 26], // 左眉
    [19, 22, 32, 39], // 右眉
    [22, 29, 19, 25], // 左眼
    [22, 29, 32, 38], // 右眼
    [34, 38, 22, 33], // 嘴
  ],
  anchors: {
    browL: [18, 18], browR: [33, 20],
    eyeL: [20, 23], eyeR: [33, 23],
    mouth: [23, 35],
  },
  eyes: deriveEyes({ lw: 4, lh: 6, rw: 4, rh: 6 }),
  brows: deriveBrows(6, 6),
  mouths: {
    ...deriveMouths(9),
    smile: ["#########", "#########", "#########"],
  },
};
