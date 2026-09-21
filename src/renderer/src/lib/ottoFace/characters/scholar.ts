// scholar —— 由 scripts/extract-face-sprite.mjs 从 prep5.png 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 7.876 / 相位 (6.75, 3.75) / 重建误差 6.4%

//
// 同 specs：只抹镜片内腔。嘴是个小圆点，比这批里其他角色都小一圈。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SCHOLAR: FaceCharacter = {
  id: "scholar",
  name: "圆框眼镜",
  w: 46,
  h: 46,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "o": "#FAFAFA" },
  base: [
    ".......................##########.............",
    ".......................##########.............",
    ".......................##########.............",
    ".............######################...........",
    ".............######################...........",
    "...........############################.......",
    "...........#############################......",
    "......##################################......",
    "......##################################......",
    "....############dd########################....",
    "....############dd########################....",
    "....####dddd##ddd############ooooooo#########.",
    "....####dddd##ddd############ooooooo#########.",
    ".#####ddddd##################ooooooo#########.",
    ".#####ddddd########ooooooooooooooooo#########.",
    ".#####ddd##########oooooooooooooooooooo######.",
    ".#####ddd##########oooooooooooooooooooo######.",
    ".#####ddd########oooooooooooooooooooooo######.",
    ".#####dd#########oooooooooooooooooo#######....",
    ".#####d##########oooooooooooooooooo#######....",
    ".#####d#######ooooooo######oooooooo#######....",
    ".#####d#######ooooooo######oooooooooooo###....",
    ".#####d#######ooooooooooooooooooo#############",
    ".#############oooo############ooo##ooooo##oo##",
    ".#############oooo##oooooooo##ooo##oo##o##oo##",
    ".#############oooo##oooo###o#######oo##o##oo##",
    "####################oooo###o#######oo##o##oo##",
    "####################oooo###o##ooo##oo##o##oo##",
    "...####oooo###oooo##oooo###o##ooo##oo##o##oo##",
    "...####oooo###oooo##oooo###o##ooo##ooooo##oo##",
    "....###oooo###oooo##oooooooo##oooo##########..",
    "....###oooo###oooo##oooooooo#oooooo#########..",
    "....###oooooooooooo##########ooooooooooo##....",
    "....###ooooooooooooooooooooooooooooooooo##....",
    "....###ooooooooooooooooooooooooooooooooo##....",
    "....#####ooooooooooooooooooooooooooooooo##....",
    "....#####ooooooooooooooooooooo###ooooooo##....",
    ".......#######oooooooooooooooo###ooooooo##....",
    ".......#######oooooooooooooooo###ooooooo##....",
    "..........####oooooooooooooooo###ooooo##......",
    "..........####oooooooooooooooooooooooo##......",
    ".............###oooooooooooooooooooo##........",
    ".............###oooooooooooooooooooo##........",
    "...............#####################..........",
    "................####################..........",
    "................###################...........",
  ],
  erase: [
    [19, 22, 20, 27], // 左眉
    [24, 31, 20, 27], // 左镜片内腔
    [23, 29, 35, 39], // 右镜片内腔
    [35, 40, 29, 33], // 嘴
  ],
  anchors: {
    browL: [21, 20], browR: [0, 0],
    eyeL: [24, 25], eyeR: [37, 24],
    mouth: [29, 36],
  },
  eyes: deriveEyes({ lw: 3, lh: 5, rw: 2, rh: 5 }),
  // 右眉在头发底下，同 beret，宽度给 0
  brows: deriveBrows(6, 0),
  mouths: {
    ...deriveMouths(5),
    smile: [".###.", ".###.", ".###.", ".###."],
  },
};
