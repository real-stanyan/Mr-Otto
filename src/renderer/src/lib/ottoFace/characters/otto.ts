// otto —— 由 scripts/extract-face-sprite.mjs 从原图提取。
//
// Otto —— 产品自己的脸。矩阵由现有精修版重采样到统一头高，不是从 logo PNG 重提：那张 PNG 是软渲染，提出来是一团糊。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 头高 46 格，与花名册其余角色对齐（见 characters/index.ts）。

import { deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const OTTO: FaceCharacter = {
  id: "otto",
  name: "Otto",
  w: 55,
  h: 48,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    ".......................................................",
    ".................######################................",
    ".................######################................",
    ".................#######################...............",
    "..............##########ddddddddd#########.............",
    "..............##########ddddddddd#########.............",
    "...........######ddd##ddddddddddd###ddd######..........",
    "...........######dddd#ddddddddddd###ddd#######.........",
    "...........######dddddddddddddddd###ddd#######.........",
    "........#####ddddddddd##########################.......",
    "........#####ddddddddd##########################.......",
    ".....###dddddddddddddd##########################.......",
    ".....###dddddddddddddd##########################.......",
    ".....###dddddddddddddd##########################.......",
    ".....###dddddddddd#####oooooooooooooooooo#########.....",
    ".....###dddddddddd#####oooooooooooooooooo#########.....",
    ".....###ddddd########oooooooooooooooooooooo#######.....",
    ".....###ddddd########oooooooooooooooooooooo#######.....",
    ".....###ddddd########oooooooooooooooooooooo#######.....",
    ".....###ddd#######ooooooooooooooooooooooooo#######.....",
    ".....###ddd#######ooooooooooooooooooooooooo#######.....",
    ".....###########ooooo######oooooooooo###ooo#######.....",
    ".....###########ooooo######oooooooooo####oo#######.....",
    ".....###########ooooo######oooooooooo####oo#######.....",
    ".....###########oooooooooooooooooooooooooooooo####.....",
    ".....###########oooooooooooooooooooooooooooooo####.....",
    ".....###ooooo###oooooooo###oooooooooo###oooooo###......",
    ".....###ooooo###ooooooo####oooooooooo####ooooo##.......",
    ".....###ooooo###ooooooo####oooooooooo####ooooo##.......",
    ".....###ooooo###ooooooo####oooooooooo####ooooo##.......",
    ".....###ooooo###ooooooo####oooooooooo####ooooo##.......",
    ".....###oooooooooooooooooooooooooooooooooooooo##.......",
    ".....###oooooooooooooooooooooooooooooooooooooo##.......",
    ".....###oooooooooooooooooooooooooooooooooooooo##.......",
    "........###ooooooooooooooooooooooooooooooooooo##.......",
    "........###ooooooooooooooo##oooooooooooooooooo##.......",
    "........#######ooooooooooo##ooooooo##ooooooooo##.......",
    "........########oooooooooo##oooooo###ooooooooo##.......",
    "........########oooooooooo###dddd####ooooooooo##.......",
    ".............###ooooooooooo#########ooooooo###.........",
    ".............###ooooooooooooooooooooooooooo###.........",
    "...............###ooooooooooooooooooooooo###...........",
    "................##ooooooooooooooooooooooo##............",
    "................##ooooooooooooooooooooooo##............",
    "..................#######################..............",
    "..................#######################..............",
    "..................#######################..............",
    ".......................................................",
  ],
  erase: [
    [20, 24, 20, 27], // 左眉
    [20, 24, 36, 41], // 右眉
    [26, 31, 22, 27], // 左眼
    [26, 31, 36, 41], // 右眼
    [35, 40, 25, 37], // 嘴
  ],
  anchors: {
    browL: [21, 21], browR: [37, 21],
    eyeL: [23, 27], eyeR: [37, 27],
    mouth: [26, 36],
  },
  eyes: deriveEyes({ lw: 4, lh: 4, rw: 4, rh: 4 }),
  // 眉毛直接用原图那两条，不再 deriveBrows——搬家的比例不是整数，
  // 乘完取整会让两条眉毛差一格，而那一格肉眼一秒看得出来
  brows: { L: ["######", "######", "######"], R: ["###.", "####", "####"] },
  mouths: {
    ...deriveMouths(11),
    // 原图那张嘴，从矩阵里读出来的
    smile: ["##.......##", "##......###", "###########", ".#########."],
  },
};
