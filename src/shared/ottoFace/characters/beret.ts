// beret —— 由 scripts/extract-face-sprite.mjs 从原图提取。
//
// 贝雷帽 —— 四分之三侧脸：近眼睁、远眼是个眨眼，原图就这么画的。左眉被帽檐压住，不画。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 头高 47 格，与花名册其余角色对齐（见 characters/index.ts）。

import { deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const BERET: FaceCharacter = {
  id: "beret",
  name: "贝雷帽",
  w: 55,
  h: 48,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    ".......................##############..................",
    ".......................###############.................",
    ".......................##################..............",
    "....................########################...........",
    "................############################...........",
    "................###############################........",
    ".............####################################......",
    ".............####################################......",
    "..........#######################################......",
    "..........#######################################......",
    "..........########################################.....",
    "........##########################################.....",
    ".......##############################dddddddd#####.....",
    "......#########################dddddddddddddddd##......",
    "......#########################dddddddddddddddd##......",
    "......#####################ddddddddddddd####ddddd##....",
    "....#######################dddddddddd##oooo###ddd##....",
    "....####################ddddddddddddd##ooooo##ddddd##..",
    "..##################ddddddddddddddd###ooooooo###ddd##..",
    "..##################ddddddddddddddd##oooooooo###ddd##..",
    "..################ddddddddddddddddooooooooooooo#ddd##..",
    "..################ddddddddddd####ooooooooo###oo##dd##..",
    "..#############ddddddddddddd#####ooooooooo###oo####....",
    "...############dddddddddd####oooooooooooooooooo####....",
    "....######ddddddddddddddd####oooooooooooooooooo####....",
    "......####dddddddddddd###oooooooooooooooooooooo##......",
    "......##ddddddddddddd####oooooooooooooooo####oo##......",
    "......##dddd######dd##ooooooooooooooooooo####oo##......",
    "......##dddd######dd##oooo######ooooooooo####oo##......",
    ".....###dddd##oooodd##oooo#######oooooooo####oo##......",
    ".....###dddd##oooo####ooooooooo##oooooooo####oo##......",
    ".....##ddddd##oooo###oooooooooooooooooooooooooo##......",
    ".....##ddddd##ooooooooooooooooooooooooooooooooo##......",
    "..#####ddddd##ooooooooooooooooooooooooooooooooo##......",
    "..####ddddddd###ooooooooooooooooooooooooooooooo##......",
    "..##dddddddddd##ooooooooooooooooooooooooooooooo##......",
    "..##dddddddddd#######ooooooooooo#oooooooooooooo##......",
    "..##dddddddddd#######oooooooooooooooooo#ooooooo##......",
    "....##ddddddddddddd##oooooooooooo#######ooooooo##......",
    "....###dddddddddddd##oooooooooooo#######oooo#####......",
    ".....###ddddddddddd##ooooooooooooooooooooooo###........",
    ".....###ddddddddddd##ooooooooooooooooooooooo###........",
    "........####ddddddd####oooooooooooooooooo###...........",
    "........#######dddd####oooooooooooooooooo###...........",
    "...........#####dd#####oooo###############.............",
    "............#########...##################.............",
    "...............######..................................",
    ".......................................................",
  ],
  erase: [
    [20, 24, 41, 45], // 右眉
    [26, 32, 25, 33], // 左眼（原图是个眨眼，抹平了重画）
    [25, 32, 40, 45], // 右眼
    [35, 43, 31, 43], // 嘴
  ],
  anchors: {
    browL: [0, 0], browR: [42, 21],
    eyeL: [28, 27], eyeR: [41, 26],
    mouth: [32, 36],
  },
  // 左眼原图画的是眨眼——一道七格宽的斜杠。照搬当睁眼是一条粗眯缝，
  // 所以这一处不取矩阵里那团墨的尺寸，按右眼收窄
  eyes: deriveEyes({ lw: 3, lh: 5, rw: 4, rh: 5 }),
  // 眉毛直接用原图那两条，不再 deriveBrows——搬家的比例不是整数，
  // 乘完取整会让两条眉毛差一格，而那一格肉眼一秒看得出来
  brows: { L: [], R: ["###", "###"] },
  mouths: {
    ...deriveMouths(11),
    // 原图那张嘴，从矩阵里读出来的
    smile: ["#..........", ".......#...", ".#######...", ".#######...", "...........", "...........", ".........##"],
  },
};
