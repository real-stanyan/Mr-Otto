// Otto —— 产品自己的 logo（`resources/icon.png`）。
//
// 它本来就是一张脸，所以这个角色不是新画的，是让 logo 自己动起来。没有第二套视觉资产
// 要维护，也不存在「吉祥物和 logo 不像」这种问题。
//
// 矩阵是从 icon.png 反解的：逐格取样 + 边缘抗锯齿清理（原始提取在右缘多采了一列，
// 中段凭空多出一条 1 格宽 9 格高的竖条；清掉的是那一类）。与原图约 3% 偏差，全在右侧
// 头发的厚度上。有原始源文件的话换掉 `base` 即可，下游一个字不用改。
//
// 眼睛左 2 格宽、右 3 格宽，眉毛左 5 右 3 —— 不是画错，是 logo 本身的四分之三侧脸。
// 做成左右对称会把那点透视抹掉，脸立刻变正而且变呆。

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

const MOUTHS = deriveMouths(9);

export const OTTO: FaceCharacter = {
  id: "otto",
  name: "Otto",
  w: 38,
  h: 36,
  ink: "#",
  skin: "o",
  palette: { "#": "#0A0A0B", d: "#26282A", g: "#4E5054", o: "#FEFEFE" },
  base: [
    "...........##################.........",
    "...........##################.........",
    ".........###dddddgggggggdddd###.......",
    ".........###dddddgggggggdddd###.......",
    "......###ddgggdgggggggggddgggdd###....",
    "......###ddgggdgggggggggddgggdd###....",
    "....##ddgggggggddddddddddddddddddd##..",
    "....##ddgggggggddddddddddddddddddd##..",
    "..##ggggggggggg###############ddddd#..",
    "..##ggggggggggg###############ddddd#..",
    "..##ggggggggdd##oooooooooooooo##ddddd.",
    "..##ggggggggdd##oooooooooooooo##ddddd.",
    "..##ggggdddd##oooooooooooooooooo##ddd.",
    "..##ggggdddd##oooooooooooooooooo##ddd.",
    "..##ggdddd##oooooooooooooooooooo##ddd.",
    "..##ggdddd##oooooooooooooooooooo##ddd.",
    "..##ddddd#oooo#####oooooooo###oo##ddd.",
    "..##ddddd#oooo#####oooooooo###oo##ddd.",
    "..######d#oooooooooooooooooooooooo###.",
    "..######d#oooooooooooooooooooooooo###.",
    "..##ooood#ooooood##oooooooo###oooo##..",
    "..##ooood#ooooood##oooooooo###oooo##..",
    "..##oooo##ooooood##oooooooo###oooo##..",
    "..##oooo##ooooood##oooooooo###oooo##..",
    "..##oooooooooooooooooooooooooooooo##..",
    "..##oooooooooooooooooooooooooooooo##..",
    "....##oooooooooooooooooooooooooooo##..",
    "....##oooooooooooo##oooooggooooooo##..",
    "....######oooooooo##ooooo##ooooooo##..",
    "....######oooooooog#gggggdgooooooo##..",
    "........##ooooooooo######goooooo##....",
    "........##oooooooooooooooooooooo##....",
    "..........##oooooooooooooooooo##......",
    "..........##oooooooooooooooooo##......",
    "............##################........",
    "............##################........",
  ],
  // 眼睛那两块各往外多擦一列：眼眶边上留着一格抗锯齿灰，不擦掉的话换成窄一点的
  // 表情（眯眼 / 笑眼）时它会露在外面，看着像一颗没擦干净的脏点
  erase: [
    [16, 17, 14, 18], // 左眉
    [16, 17, 27, 29], // 右眉
    [20, 23, 16, 19], // 左眼
    [20, 23, 26, 30], // 右眼
    [27, 30, 18, 26], // 嘴
  ],
  // 锚点是从原 logo 里量出来的，不按几何中心重排 —— 重排会让换表情时眼睛整体漂一格，
  // 而那一格在 38 格宽的脸上肉眼可见
  anchors: {
    browL: [14, 16],
    browR: [27, 16],
    eyeL: [17, 20],
    eyeR: [27, 20],
    mouth: [18, 27],
  },
  eyes: deriveEyes({ lw: 2, lh: 4, rw: 3, rh: 4 }),
  brows: deriveBrows(5, 3),
  mouths: {
    ...MOUTHS,
    // logo 原装的那张嘴：两个上扬的嘴角 + 下面一条横杠。这是 Otto 的静息表情，
    // 属于品牌的一部分，所以不用推导出来的对称版
    smile: ["##.....##", "##.....##", ".########", ".######.."],
  },
};
