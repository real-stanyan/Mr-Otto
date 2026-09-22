// sage —— 由 scripts/extract-face-sprite.mjs 从原图提取。
//
// 大胡子 —— 嘴陷在胡子里，抹嘴那一框填胡子色 g，填脸白会在胡子中间开个洞。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 头高 46 格，与花名册其余角色对齐（见 characters/index.ts）。

import { deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const SAGE: FaceCharacter = {
  id: "sage",
  name: "大胡子",
  w: 55,
  h: 48,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", "d": "#3C3F44", "g": "#797E86", "o": "#FAFAFA" },
  base: [
    ".......................................................",
    ".....................#############.....................",
    ".....................#############.....................",
    "..................###ooooooooooooo###..................",
    "..................###ooooooooooooo###..................",
    "...............###ooooooooooooooooooo###...............",
    "...............###ooooooooooooooooooo###...............",
    ".............##ooooooooooooooooooooooooo##.............",
    "............###ooooooooooooooooooooooooo###............",
    "...........###ooooooooooooooooooooooooooo##............",
    "...........##oooooooooooooooooooooooooooo##............",
    "..........###ooooooooooooooooooooooooooooo###..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooooooooooooooooooooo##..........",
    "..........##ooooooooooooo###ooooooooooooo####..........",
    "..........##ooooooooooooo#######oooooo#######..........",
    "..........##oooooooooooooooo####oooooo###oo##..........",
    "..........#####ooooooooooooo###ooooooo###oo##..........",
    ".......d#######ggooooooooooo###ooooooo###oo##..........",
    ".......d##ooooogggoooooooooo###ooooooo###oo##..........",
    ".......d##oooooggggooooooooo###ooooooo###oo##..........",
    ".......d##oooooggggooooooooo###ooooooo###oo##..........",
    ".......d##oooooggggoooooooooooooooooooooooo##..........",
    ".......d##ooooogggggooooooooooooooooooooooo##..........",
    ".......d####oooggggggoooooooooggggggggggooo####d.......",
    ".......d####oooggggggooooooogggggggggggggoo####d.......",
    "..........#######ggggggoooooggggggggggggggggg##d.......",
    "..........#######ggggggooogggggg######ggggggg##d.......",
    "..............###gggggggoogggg#########gggggg##d.......",
    "..............###ggggggggggggg##ooooooogggggg##d.......",
    "..............###gggggggggggggooooooooogggggg##d.......",
    "...............###ggggggggggggoooggggoogggggg##d.......",
    "...............###ggggggggggggggggggggggggggg##d.......",
    "...............####gggggggggggggggggggggggg####d.......",
    "...............######gggggggggggggggggggggg####d.......",
    "...................####gggggggggggggggggggg##..........",
    "...................####gggggggggggggggggggg##..........",
    "......................####ggggggggggggggg####..........",
    "......................####ggggggggggggggg###...........",
    ".........................####gggggggggg###.............",
    ".........................#################.............",
    ".............................##########................",
    ".............................dddddddddd................",
    ".......................................................",
  ],
  erase: [
    [17, 21, 23, 32], // 左眉
    [17, 21, 37, 43], // 右眉——到 37 为止，38 起是脸的轮廓
    [19, 26, 27, 32], // 左眼
    [19, 26, 37, 42], // 右眼
    [29, 37, 29, 40, "g"], // 嘴：长在胡子上，填胡子色
  ],
  anchors: {
    browL: [25, 18], browR: [38, 18],
    eyeL: [28, 20], eyeR: [38, 20],
    mouth: [30, 30],
  },
  eyes: deriveEyes({ lw: 4, lh: 6, rw: 3, rh: 6 }),
  // 眉毛直接用原图那两条，不再 deriveBrows——搬家的比例不是整数，
  // 乘完取整会让两条眉毛差一格，而那一格肉眼一秒看得出来
  brows: { L: ["###....", "#######", "...####"], R: ["...##", "#####", "###.."] },
  mouths: {
    ...deriveMouths(10),
    // 原图那张嘴，从矩阵里读出来的
    smile: ["##########", "##########", "##########", "##.......#", ".........#", "...####..#", "##########"],
  },
};
