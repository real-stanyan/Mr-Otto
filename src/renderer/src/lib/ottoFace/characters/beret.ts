// beret —— 由 scripts/extract-face-sprite.mjs 从 prep3.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.898 / 相位 (3.25, 1.75) / 重建误差 5.5%

//
// 四分之三侧脸：近眼睁、远眼是个眨眼，原图就这么画的，别把它掰正。左眉被帽檐压住，不画。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const BERET: FaceCharacter = {
  id: "beret",
  name: "贝雷帽",
  w: 49,
  h: 45,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    "....................##############...............",
    "....................##################...........",
    ".................#####################...........",
    ".................########################........",
    "..............#############################......",
    "...........#################################.....",
    "...........##################################....",
    "........#####################################....",
    "........#####################################....",
    "........######################################...",
    ".....#########################################...",
    ".....#############################dddddddd####...",
    "....########################ddddddddddddddd##....",
    "....########################ddddddddddddddddd....",
    "....####################ddddddddddddd##dddddd##..",
    "..######################dddddddddd##oooo##ddd##..",
    "..###################ddddddddddddd##oooo##ddddd##",
    "##################dddddddddddddd##ooooooo###ddd##",
    "#################ddddddddddddd####oooooooo##ddd##",
    "###############ddddddddddddddd##ooooooooooo#ddd##",
    "###############dddddddddd#####oooooooo###oo##dd##",
    "#############dddddddddddd#####oooooooo###oo####..",
    "..##########dddddddddd####ooooooooooooooooo####..",
    "..######dddddddddddddd####ooooooooooooooooo####..",
    "....###dddddddddddd###oooooooooooooooo###oo##....",
    "....##dddddddddddd####oooooooooooooooo###oo##....",
    "....##dddd#####dd##oooo######ooooooooo###oo##....",
    "...###dddd##oooo###oooo#######oooooooo###oo##....",
    "...###dddd##oooo###ooooooooo##oooooooo###oo##....",
    "...##ddddd##oooo###ooooooooooooooooooo###oo##....",
    "...##ddddd##ooooooooooooooooooooooooooooooo##....",
    "#####ddddd##ooooooooooooooooooooooooooooooo##....",
    "#####ddddd###oooooooooooooooooooooooooooooo##....",
    "##dddddddddd#oooooooooooooooooooooooooooooo##....",
    "##dddddddddd#######oooooooooooooooooooooooo##....",
    "##dddddddddd#######oooooooooo#ooooooooooooo##....",
    "..##dddddddddddd###ooooooooooo#######oooooo##....",
    "..###ddddddddddd###ooooooooooo#######oooo####....",
    "...###dddddddddd###oooooooooooooooooooooo###.....",
    "...###dddddddddd###ooooooooooooooooooooo###......",
    "......####dddddd####oooooooooooooooooo###........",
    "......#######ddd####oooooo###############........",
    ".........#############################...........",
    "...........###########################...........",
    ".................................................",
  ],
  erase: [
    [19, 22, 37, 41], // 右眉
    [24, 30, 22, 30], // 左眼（原图是个眨眼，抹平了重画）
    [23, 30, 37, 41], // 右眼
    [34, 39, 28, 38], // 嘴
  ],
  anchors: {
    browL: [0, 0], browR: [38, 20],
    eyeL: [24, 25], eyeR: [38, 24],
    mouth: [30, 36],
  },
  eyes: deriveEyes({ lw: 3, lh: 5, rw: 3, rh: 6 }),
  // 左眉被帽檐压住，原图里根本没有——宽度给 0，`deriveBrows` 出空串，等于不画
  brows: deriveBrows(0, 3),
  mouths: deriveMouths(7),
};
