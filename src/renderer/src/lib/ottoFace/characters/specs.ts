// specs —— 由 scripts/extract-face-sprite.mjs 从 prep4.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 8.067 / 相位 (1.5, 7.75) / 重建误差 6.4%

//
// 镜框是脸的一部分，不动。只抹镜片内腔，眼睛在框里换——这比加一层 `front` 画镜框省事：
// 收窄擦除框是四个数字，`front` 是又一张要跟着脸对齐的矩阵。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SPECS: FaceCharacter = {
  id: "specs",
  name: "方框眼镜",
  w: 46,
  h: 45,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    "..............................................",
    "............###################...............",
    "............###################...............",
    "..........##########dd#############...........",
    "..........##########dd#############...........",
    ".......#####dddddddd#################.........",
    ".......#####dddddddd#################.........",
    "....######dddddddddddd##########ddd#####......",
    "....######dddddddddddd##########ddd#####......",
    "....####ddddddddooooooooo########oooo###......",
    "....####ddddddddooooooooo########oooo###......",
    "..####ddddddddoooooooooooooooooooooooo###.....",
    "..####ddddddddoooooooooooooooooooooooo###.....",
    "..####ddddddddoooooooooooooooooooooooo###.....",
    "..###dddddddddooooooooooooooooooooooooo###....",
    "..##ddddddddddoooooooooooooooooooooooooo###...",
    "..##ddddddddddoooooooooooooooooooooooooo###...",
    "..##ddddddddddoooooooooooooooooooooooooo###...",
    "..##ddddddddddooooooooo##ooooooooooo##oo###...",
    "..##ddddddooooooooo######ooooooooooo##oo###...",
    "..##ddddddooooooooooooooooooooooooooooooo##...",
    "..##ddddddooooooooooooooooooooooooooooooo##...",
    "..##ddddddooooo##############ooo##############",
    "..######ddooooo##############ooo##############",
    "..###############ooooo#######ooo##oo###oo#####",
    "###oooo##########ooooo####o##ooo##oo###oo##o##",
    "###oooo###ooooo##ooooo####o#######oo###oo##o##",
    "###oooo###ooooo##ooooo####o#######oo###oo##o##",
    "###oooo###ooooo##ooooo####o##ooo##oo###oo##o##",
    "###oooooooooooo##oooooooooo##ooo##ooooooo##o##",
    "###oooooooooooo##oooooooooo##ooo##ooooooo#####",
    "###oooooooooooooo##########ooooooo##########..",
    "#####oooooooooooo##########ooooooo##########..",
    "######oooooooooooooooooooooooooooooooooo###...",
    "...###oooooooooooooooooooooooooooooooooo###...",
    "...#######oooooooooooooooooooooooooooooo###...",
    "...#######oooooooooooooooooooooooooooooo###...",
    ".......###oooooooooooooooo########oooooo###...",
    ".......###oooooooooooooooo########oooo###.....",
    ".......###oooooooooooooooo#######ooooo###.....",
    ".........###oooooooooooooooooooooooo#####.....",
    ".........###oooooooooooooooooooooooo###.......",
    "..........###########################.........",
    "...........#########################..........",
    "...........#########################..........",
  ],
  erase: [
    [17, 20, 18, 25], // 左眉
    [17, 20, 35, 38], // 右眉
    [24, 30, 17, 26], // 左镜片内腔——不含镜框
    [24, 30, 34, 40], // 右镜片内腔
    [36, 40, 24, 34], // 嘴
  ],
  anchors: {
    browL: [19, 18], browR: [36, 18],
    eyeL: [22, 24], eyeR: [36, 24],
    mouth: [25, 37],
  },
  eyes: deriveEyes({ lw: 4, lh: 5, rw: 3, rh: 5 }),
  brows: deriveBrows(6, 2),
  mouths: {
    ...deriveMouths(9),
    // 原图的嘴就是一条横杠，没有笑弧。默认的 smile 会把人画成另一个角色
    smile: ["#########", "#########", "#########"],
  },
};
