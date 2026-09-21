// ottoFace/sprites —— 会动的像素脸的**画料**（#1345，ADR-0311）：13 个坑位各指向一份
// 角色包（`characters/`），外加这张脸画在圆盘里的构图常量。纯数据零 IO。
//
// 三条法理（#1307 定的，这份逐条照办）：
//
// ① **头部不变形**。每个角色是一张自己的矩阵——脸型、头发、眼镜、胡子都长在里面；
//    会动的只有擦除框里那三处：眉、眼、嘴。这是「同一个人换了表情」与「换了一个人」
//    的分界线。
//
//    与上一版的差别正在这里：上一版是**一张共用的光头 + 13 顶头发**，于是 13 个坑位
//    看过去是同一张脸戴了 13 顶假发；而且眼睛只有 2×2 格，戴眼镜那两只的镜框会把眼睛
//    整个占满。头像的用处恰恰是一眼认出是谁，那一版把它取消了。
//    代价写明：每个角色一张矩阵，画料从一张 20×16 变成 13 份 55×48。
//
// ② **位移只走整格**。像素画做亚像素平滑会立刻糊成模糊贴图，所以偏移一律整数格。
//
// ③ **坑位数和顺序都不动，仍然是 13**。`fnv1a(agentId) % 13` 是已经落库的派生
//    （agentAvatarSlot.ts），改 13 就是给所有没手动挑过头像的 agent 换一张脸，连手动
//    挑过的 `avatar_slot` 也会指到另一个人身上。

import { FACE_CANVAS, FACE_PACKS, type FaceCharacter } from "./characters/index.js";

export type { FaceCharacter };
export { FACE_CANVAS, FACE_PACKS };

/** 角色四周的留白（格）。呼吸上下各一格、摆动左右各一格，再留一格余量 ——
    少这一圈，`waiting` 摆到最左时会切掉一列，而被切是**静默的**（越界的格子直接丢掉，不抛） */
export const FACE_PAD = 2;

/** 整张脸的网格 = 共同画布 + 四周留白。**全体角色共用同一张画布**
    （characters/index.ts 的 `FACE_CANVAS`），否则一排头像里谁大一圈谁小一圈，
    而缩放那一侧补不回来（缩放只能取整） */
export const GRID_W = FACE_CANVAS.w + FACE_PAD * 2;
export const GRID_H = FACE_CANVAS.h + FACE_PAD * 2;

/** 圆盘的直径占多少格：脸占满网格宽，盘再往外留一圈底。与 `FACE_ORIGIN_*` 一起是构图 */
export const DISC_CELLS = GRID_W * 1.16;
/** 对准盘心的那一格（网格坐标）。**纵向取几何中心，不再往下挪** —— 这批形象的下巴
    本来就贴着矩阵下沿，往下挪一格会被圆盘切掉 */
export const FACE_ORIGIN_X = GRID_W / 2;
export const FACE_ORIGIN_Y = GRID_H / 2;

/** 圆盘底色。**两个主题一样** —— 纯黑头发压在纯黑底上会整个糊成一团，而圆盘把这件事
    解决在脸自己这一层，不用宿主按背景传一个描边色进来 */
export const DISC_COLOR = "#f2f2f3";

/**
 * 坑位 → 角色 id。**顺序即坑位，改顺序等于给所有 agent 换脸，别动**（法理 ③）。
 *
 * 13 个坑位、10 个角色（`otto` 是产品自己的脸，这里也占一格）。旧 `02 灰蘑菇头` /
 * `03 刺猬头` / `11 马尾＋发带` 在这批形象里没有对应的人，各借一个长相最近的顶上：
 * **只有这三个坑位的人会换脸**，其余十个坑位画的还是原来那个人，只是从一张静态图变成
 * 会动的。
 *
 * 补齐那三个之后改这张表就行 —— 派生（`% 13`）与已落库的 `avatar_slot` 都不用动。
 */
const SLOT_TO_ID: readonly string[] = [
  "stoic", //  0 ← 旧 01.png 短发平脸
  "sweep", //  1 ← 旧 02.png 灰蘑菇头（没有对应，暂借）
  "cap", //  2 ← 旧 03.png 刺猬头（没有对应，暂借）
  "sweep", //  3 ← 旧 04.png 短发微笑
  "beret", //  4 ← 旧 05.png 贝雷帽
  "specs", //  5 ← 旧 06.png 方框眼镜
  "scholar", //  6 ← 旧 07.png 圆框眼镜（种子管理员固定这一格，ADMIN_AVATAR_SLOT）
  "bob", //  7 ← 旧 08.png 齐刘海
  "sage", //  8 ← 旧 09.png 大胡子
  "grin", //  9 ← 旧 10.png 中分长发
  "mane", // 10 ← 旧 11.png 马尾＋发带（没有对应，暂借）
  "otto", // 11 ← 旧 12.png 短发微笑
  "mane", // 12 ← 旧 13.png 长卷发
];

/** 角色包按坑位排好的那一份。**索引即坑位** */
export const FACE_CHARACTERS: readonly FaceCharacter[] = SLOT_TO_ID.map(
  (id) => FACE_PACKS.find((c) => c.id === id) ?? FACE_PACKS[0]!
);

/**
 * 坑位 → 角色包。
 *
 * **越界退回第 0 格而不是取模**：取模会安静地映射到另一个人，看起来像「他挑了这张」，
 * 而事实是「这一版没有那个坑位」。上游 `agentFaceSlot` 已经做过一次同样的判断，这里是
 * 最后一道 —— 画一张头像不该因为一个坏数字把整棵树炸掉。
 */
export function faceCharacterAt(slot: number): FaceCharacter {
  if (!Number.isInteger(slot) || slot < 0 || slot >= FACE_CHARACTERS.length) return FACE_CHARACTERS[0]!;
  return FACE_CHARACTERS[slot]!;
}
