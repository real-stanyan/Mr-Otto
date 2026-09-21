// sweep —— 由 scripts/extract-face-sprite.mjs 从 prep11.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.867 / 相位 (4.25, 4.75) / 重建误差 3.8%

//
// 刘海从左边斜过来，左眉露六格、右眉只露三格——不是画歪了，是那点透视。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SWEEP: FaceCharacter = {
  id: "sweep",
  name: "偏分",
  w: 48,
  h: 46,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    ".............######################.............",
    ".............######################.............",
    ".............######################.............",
    ".............######################.............",
    "..........#############################.........",
    "..........#############################.........",
    ".......#####################################....",
    ".......#####################################....",
    ".......########d############################....",
    "......######d###############################....",
    "...#########d###############################....",
    "...#########################################....",
    "...#################ooooooooooooooooooo#####....",
    "...#################ooooooooooooooooooo#########",
    "...#################ooooooooooooooooooo#########",
    "...###############ooooooooooooooooooooo#########",
    "...###############ooooooooooooooooooooo#########",
    "...###############ooooooooooooooooooooooo#######",
    "...###############ooooooooooooooooooooooo#######",
    "...############ooooo######oooooooooo###oo#######",
    "...############ooooo######oooooooooo###oo#######",
    "...############oooooooooooooooooooooooooo#######",
    "...############oooooooooooooooooooooooooo#######",
    "...############oooooooo###oooooooooo###oo#######",
    "...############oooooooo###oooooooooo###oo###....",
    "...#####oooo###oooooooo###oooooooooo###oo###....",
    "########oooo###oooooooo###oooooooooo###oo###....",
    "########oooo###oooooooo###oooooooooo###oo###....",
    "########oooo###oooooooo###oooooooooo###oo###....",
    "########oooo###oooooooo###oooooooooo###oo###....",
    "########ooooooooooooooooooooooooooooooooo###....",
    "########ooooooooooooooooooooooooooooooooo###....",
    "########ooooooooooooooooooooooooooooooooo###....",
    "########ooooooooooooooooooooooooooooooooo###....",
    "##########ooooooooooooooooooooooooooooooo###....",
    "...############ooooooooo##ooooooooooooooo###....",
    "...############ooooooooo###oooooo##oooooo###....",
    "...############ooooooooooo#########oooooo###....",
    "...############ooooooooooo########ooooo###......",
    "......#########ooooooooooo########ooooo##.......",
    "......###########ooooooooooooooooooo#####.......",
    ".............####ooooooooooooooooooo###.........",
    ".............####ooooooooooooooooooo###.........",
    "...............#####################............",
    "...............#####################............",
    "...............#####################............",
  ],
  erase: [
    [18, 21, 19, 26], // 左眉
    [18, 21, 35, 39], // 右眉
    [22, 30, 22, 26], // 左眼
    [22, 30, 35, 39], // 右眼
    [34, 40, 23, 35], // 嘴
  ],
  anchors: {
    browL: [20, 19], browR: [36, 19],
    eyeL: [23, 23], eyeR: [36, 23],
    mouth: [24, 35],
  },
  eyes: deriveEyes({ lw: 3, lh: 7, rw: 3, rh: 7 }),
  brows: deriveBrows(6, 3),
  mouths: deriveMouths(11),
};
