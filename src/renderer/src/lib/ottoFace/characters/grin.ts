// grin —— 由 scripts/extract-face-sprite.mjs 从 hi12.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.985 / 相位 (1, 7.5) / 重建误差 5.0%

//
// 眉毛三格高，`deriveBrows` 的两格会瘦一圈，直接写死。
// 左右擦除框不对称（左 [23,27]、右 [24,26]）：右眉挨着头发的内沿，往上下各多抹一格
// 就会在头发上啃掉一口。
//
// **原图嘴里有一条浅灰的舌头，这里丢掉了。** 五官是单色图案（`stamp` 只画 ink），
// 留住舌头要么给角色加一层双色覆盖层，要么把嘴锁死不许换——为一个角色做这两件事
// 都不划算。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const GRIN: FaceCharacter = {
  id: "grin",
  name: "中分长发",
  w: 61,
  h: 57,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "m": "#B6BBC2", "o": "#FAFAFA" },
  base: [
    "...............############..###############.................",
    "...............############..###############.................",
    "...............############..###############.................",
    "...............#############################.................",
    "...............#############################.................",
    "..........######################################.............",
    "..........#######dd#############################.............",
    "..........#####d#################ddd######dd####.............",
    ".......##################dd######ddddddddddddd#####..........",
    ".......##################dd####ddddddddddddddd#####..........",
    ".......##dddd##################ddd#####dddddddddd##..........",
    ".......##dddd##########################dddddddddd##..........",
    ".....####dddd############################dddddddddd###.......",
    ".....####dddd############################dddddddddd###.......",
    ".....####ddd#############################dddddddddd###.......",
    ".....###dddd#########oooooooooooooooooo####dddddddd###.......",
    ".....##ddddddd#######oooooooooooooooooo####dddddddd###.......",
    "...####ddddddddd#####oooooooooooooooooo####dddddddd######....",
    "...####ddddddddd#####oooooooooooooooooo####dddddddd######....",
    "...####ddddddddd###ooooooooooooooooooooooo###dddddd######....",
    "...####ddddddddd###ooooooooooooooooooooooo###dddddd######....",
    "...####ddddddd#####ooooooooooooooooooooooo###dddddd######....",
    "...#####dddddd#####ooooooooooooooooooooooo###dddddd######....",
    "...######ddddd#####ooooooooooooooooooooooo###dddddd######....",
    "...######ddddd###ooo#######oooooooooooo#######dddd#######....",
    "...######ddddd###ooo#######oooooooooooo########ddd#######....",
    "...######ddd#####ooo#######oooooooooooo########dddd######....",
    "...######ddd#####oooooooooooooooooooooooooo####dddd######....",
    "...######ddd#####oooooooooooooooooooooooooo####dddd######....",
    "...######ddd#####ooooo#####oooooooooooo####oo###dd#######....",
    "...######ddd#####ooooo#####oooooooooooo####oo###dd#######....",
    "...######ddd#####ooooo#####oooooooooooo####oo###ddd######....",
    "...######dd######ooooo#####oooooooooooo####ooo###############",
    "#########d#######ooooo#####oooooooooooo####ooo###############",
    "###############ooooooo#####oooooooooooo####oooo##############",
    "##############oooooooo#####oooooooooooo####oooooo############",
    "##############oooooooo#####oooooooooooo####oooooo############",
    "##############ooooooooooooooooooooooooooooooooooo############",
    "##############ooooooooooooooooooooooooooooooooooo############",
    "############ooooooooooooooooooooooooooooooooooooo############",
    "###########oooooooooooooooooooooooooooooooooooooo############",
    "###########oooooooooooooooooooooooooooooooooooooo############",
    "###########ooooooooooo###oooooooooooo###ooooooooo############",
    "############ddoooooooo###oooooooooooo###ooooooooo############",
    "############ddoooooooo##################ooooooooo############",
    ".###########ddoooooooo################ooooooooooo############",
    ".###########ddoooooooo###mmmm#########ooooooooooo########....",
    ".#############ooooooooooommmmmm#######oooooooo###########....",
    ".#############ooooooooooommmmmm#######oooooooo###########....",
    "....##########ooooooooooo##mmmm####ooooooooooo###########....",
    "....#############oooooooo##########oooooooo###########.......",
    "....#############oooooooooooooooooooooooooo###########.......",
    "....#############oooooooooooooooooooooooooo###########.......",
    "....##################################################.......",
    "..........######################################.............",
    "..........######################################.............",
    "..........######################################.............",
  ],
  erase: [
    [23, 27, 19, 27], // 左眉
    [24, 26, 38, 45], // 右眉——上下各只抹到眉毛本身，再往外是头发内沿
    [28, 37, 21, 27], // 左眼
    [28, 37, 38, 42], // 右眼
    [41, 51, 21, 40], // 嘴
  ],
  anchors: {
    browL: [20, 24], browR: [39, 24],
    eyeL: [22, 29], eyeR: [39, 29],
    mouth: [23, 43],
  },
  eyes: deriveEyes({ lw: 5, lh: 8, rw: 4, rh: 8 }),
  brows: {
    L: ["#######", "#######", "#######"],
    R: ["#######", "#######", "#######"],
  },
  mouths: {
    ...deriveMouths(15),
    smile: [
      "###############",
      "###############",
      "##...........##",
      "##...........##",
      "##...........##",
      "###############",
    ],
  },
};
