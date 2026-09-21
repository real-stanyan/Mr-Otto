// sage —— 由 scripts/extract-face-sprite.mjs 从 prep7.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.904 / 相位 (3.75, 7.25) / 重建误差 5.3%

//
// 嘴陷在胡子里。抹嘴那一框要填胡子色 `g`——填脸白会在胡子中间开一个洞。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SAGE: FaceCharacter = {
  id: "sage",
  name: "大胡子",
  w: 43,
  h: 50,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "g": "#797E86", "o": "#FAFAFA" },
  base: [
    "...........................................",
    "...............##############..............",
    "..............###############..............",
    "...........####oooooooooooooo###...........",
    "...........####oooooooooooooo###...........",
    "........###ooooooooooooooooooooo###........",
    "........###ooooooooooooooooooooo###........",
    "......##ooooooooooooooooooooooooooo##......",
    "......##ooooooooooooooooooooooooooo##......",
    "....###oooooooooooooooooooooooooooooo##....",
    "....###oooooooooooooooooooooooooooooo##....",
    "....###oooooooooooooooooooooooooooooo##....",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooooooooooooooooooooooo###..",
    "...##ooooooooooooo#####ooooooooooooo#####..",
    "...##ooooooooooooo#######oooooooo########..",
    "...##ooooooooooooooooo####ooooooo########..",
    "...#####oooooooooooooo###oooooooo###oo###..",
    "..######ggoooooooooooo###oooooooo###oo###..",
    "###oooooggoooooooooooo###oooooooo###oo###..",
    "###oooooggggoooooooooo###oooooooo###oo###..",
    "###oooooggggoooooooooo###oooooooo###oo###..",
    "###oooooggggoooooooooo###oooooooo###oo###..",
    "###oooooggggoooooooooooooooooooooooooo###..",
    "###oooooggggggoooooooooooooooooooooooo###..",
    "#####oooggggggoooooooooogggggggggggooo#####",
    "#####oooggggggoooooooooogggggggggggooo#####",
    "...#######gggggggooooogggggggggggggggggg###",
    "...#######gggggggooogggggg#######ggggggg###",
    ".......###gggggggooogggggg#######ggggggg###",
    ".......###gggggggggggggggooooooo#ggggggg###",
    ".......###ggggggggggggggoooooooooogggggg###",
    "........##ggggggggggggggoooggggooogggggg###",
    "........####gggggggggggggggggggggggggggg###",
    "........####gggggggggggggggggggggggggggg###",
    "........######gggggggggggggggggggggggg#####",
    "........######gggggggggggggggggggggggg#####",
    "............#####ggggggggggggggggggggg##...",
    "............#####ggggggggggggggggggggg##...",
    "................####gggggggggggggggg####...",
    "................####gggggggggggggggg####...",
    "...................####ggggggggggg###......",
    "...................##################......",
    ".......................###########.........",
    ".......................###########.........",
  ],
  erase: [
    [18, 21, 17, 26], // 左眉
    [18, 21, 32, 37], // 右眉——到 37 为止，38 起是脸的轮廓
    [21, 28, 21, 26], // 左眼
    [21, 28, 32, 37], // 右眼
    [32, 38, 24, 34, "g"], // 嘴：长在胡子上，填胡子色
  ],
  anchors: {
    browL: [18, 19], browR: [33, 19],
    eyeL: [22, 22], eyeR: [33, 22],
    mouth: [26, 33],
  },
  eyes: deriveEyes({ lw: 3, lh: 6, rw: 3, rh: 6 }),
  brows: deriveBrows(7, 5),
  mouths: {
    ...deriveMouths(7),
    // 这张脸的底色是「不高兴」，默认的笑弧会把它变成另一个人
    smile: ["#######", "#######", "#.....#"],
  },
};
