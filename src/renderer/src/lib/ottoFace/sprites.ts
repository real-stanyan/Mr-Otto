// ottoFace/sprites —— 会动的像素脸的**画料**（#1345，ADR-0311）：一张光头 + 13 个角色包
// + 眉/眼/嘴三层可替换的图案。纯数据零 IO，`frame.ts` 把它们叠成一帧。
//
// 三条法理（#1307 定的，这份逐条照办）：
//
// ① **头部不变形**。所有角色长在同一张 `HEAD` 上，角色包只是盖在它上面的头发 / 帽子 /
//    配件。会动的只有 `BROWS` / `EYES` / `MOUTHS` 三层 —— 这是「同一只水獭换了表情」
//    与「换了一只水獭」的分界线。
// ② **位移只走整格**。像素画做亚像素平滑会立刻糊成模糊贴图，所以偏移一律是整数格
//    （`paint.ts` 另配 `imageSmoothingEnabled=false`）。这是整套方案唯一的硬约束。
// ③ **坑位数和顺序都不动，仍然是 13**。`fnv1a(agentId) % 13` 是今天已经落库的派生
//    （agentAvatarSlot.ts），改 13 就是给所有没手动挑过头像的 agent 换一张脸，连
//    手动挑过的 `avatar_slot` 也会指到另一个人身上。所以这里是 13 个角色包、
//    **一个坑位对一个角色**，01–13 的长相一一对上 —— 谁的脸都不换，只是从静态画
//    变成会动的。角色包的**顺序即坑位**，改顺序等于给所有 agent 换脸，别动。
//
// 这批像素是照着原来那 13 张 128px PNG（`assets/agent-avatars/01–13.png`，已随本次改动
// 删除，要回看去 git 历史）描的，不是重新设计的一套形象。

/** 四色 + 盘底。`O` 是**轮廓**：它在原型里写作 `#`，而原型的取色是 `FC[c] || c`，
    `FC['#']` 取不到就把字面量 `'#'` 赋给 `fillStyle` —— 那是一个非法颜色值，canvas
    规范要求**忽略这次赋值**，于是那一格用的是上一格的颜色，画出来取决于遍历顺序。
    在 20px 的原型上看不出来，搬进产品必须挑一个值：取 `L`（已有的浅灰），于是
    白脸在纸白盘底上有一圈说得清的边，而调色板还是四色。 */
export const FACE_COLORS: Readonly<Record<string, string>> = {
  /** 墨黑：眉 / 眼 / 嘴 / 眼镜框 */
  I: "#101012",
  /** 深灰：头发、帽子 */
  D: "#2f2f36",
  /** 浅灰：浅色头发、胡子、发带 */
  L: "#83838d",
  /** 纯白：脸 */
  W: "#ffffff",
  /** 纸白：圆盘底色。**两个主题一样** —— 纯黑头发压在纯黑底上会整个糊成一团，
      而盘底把这件事解决在脸自己这一层，不用宿主按背景传一个描边色进来 */
  P: "#f2f2f3",
  /** 轮廓（原型里的 `#`），见上 */
  O: "#83838d",
};

/** 网格。整张脸画在 20×16 格里，头占 cols 3..16 / rows 0..13 */
export const GRID_W = 20;
export const GRID_H = 16;

/** 圆盘的直径占多少格 —— 头 14 格宽，盘 15.8 格，于是四周留一圈盘底。
    与 `FACE_ORIGIN_*` 一起是原型上量出来的值，改它们就是改这张脸的构图 */
export const DISC_CELLS = 15.8;
/** 对准盘心的那一格（网格坐标）*/
export const FACE_ORIGIN_X = 10;
export const FACE_ORIGIN_Y = 7;

/** 蒙皮：一张光头。所有角色都长在它上面 ——「头部不变形」就是这一句的意思。
    脸内 cols 4..15 / rows 2..11 */
export const HEAD: readonly string[] = [
  ".......OOOOOO.......",
  ".....OOWWWWWWOO.....",
  "....OWWWWWWWWWWO....",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "...OWWWWWWWWWWWWO...",
  "....OWWWWWWWWWWO....",
  ".....OOWWWWWWOO.....",
  ".......OOOOOO.......",
  "....................",
  "....................",
];

/** 五官的锚点（网格坐标）。右眉是左眉的镜像，所以只有左眼一个 x */
export const EYE_LX = 6;
export const EYE_RX = 11;
export const BROW_Y = 4;
export const EYE_Y = 6;
export const MOUTH_X = 8;
export const MOUTH_Y = 10;

/** 一个角色包 = 盖在光头上的头发 / 帽子 / 配件。全部字段可选，`{}` 就是光头 */
export interface FaceCharacter {
  /** 盖住 rows 0..n 的头顶轮廓（头发本来就长在那几行） */
  top?: readonly string[];
  /** 两侧的长发：row → 两个字符 `[左, 右]`，`.` = 这一侧不画。
      左画 cols 3..4、右画 cols 15..16 */
  side?: Readonly<Record<number, string>>;
  /** 帽子上那个小揪（贝雷帽）：一格 `D` */
  nub?: readonly [number, number];
  /** 马尾 */
  tail?: true;
  /** 络腮胡 + 上唇一撇 */
  beard?: true;
  /** 胡茬：下巴那一行隔一格一点 */
  stubble?: true;
  /** 黑框眼镜：两个镜框 + 一道鼻梁，套在眼睛外面 */
  specs?: true;
}

/** 13 个角色包，**顺序即坑位**（01 → 0 … 13 → 12）。见文件头法理 ③ */
export const FACE_CHARACTERS: readonly FaceCharacter[] = [
  /* 01 短平头 */
  { top: [".......DDDDDD.......", ".....ODDDDDDDDO.....", "....ODDDDDDDDDDO....", "...DD..........DD..."] },
  /* 02 蘑菇头 */
  {
    top: [".......LLLLLL.......", ".....LLLLLLLLLL.....", "....LLLLLLLLLLLL....", "...LLL........LLL..."],
    side: { 4: "LL", 5: "L." },
  },
  /* 03 刺猬头 */
  { top: ["....D.D.D.DD.D.D....", "....DD.DDDDDD.DD....", "....DDDDDDDDDDDD....", "...DD..........DD..."] },
  /* 04 背头 */
  { top: [".......DDDDDD.......", ".....DDDLLDDDDD.....", "....ODDDDDDDDDDO....", "...DD..........DD..."] },
  /* 05 贝雷帽 */
  {
    top: ["....DDDDDDDDD.......", "...DDDDDDDDDDDD.....", "..DDDDDDDDDDDDDD....", "...LL..........DD..."],
    nub: [4, 0],
  },
  /* 06 眼镜平头 */
  {
    top: [".......LLLLLL.......", ".....OLLLLLLLLO.....", "....OLLLLLLLLLLO....", "...LL..........LL..."],
    specs: true,
  },
  /* 07 眼镜分头 */
  {
    top: ["......DDDDDDD.......", "....DDDDDDDDDDD.....", "....ODDLDDDDDDDO....", "...DD..........DD..."],
    specs: true,
  },
  /* 08 波波头 */
  {
    top: [".......DDDDDD.......", ".....DDDDDDDDDD.....", "....DDDDDDDDDDDD....", "...DDD........DDD..."],
    side: { 4: "DD", 5: "DD", 6: "DD", 7: "DD", 8: "D." },
  },
  /* 09 光头胡子 */
  { beard: true },
  /* 10 长直发 */
  {
    top: [".......DDDDDD.......", ".....DDDDDDDDDD.....", "....DDDDDDDDDDDD....", "...DDD........DDD..."],
    side: { 4: "DD", 5: "DD", 6: "DD", 7: "DD", 8: "DD", 9: "DD", 10: "DD", 11: "D." },
  },
  /* 11 马尾发带 */
  {
    top: [".......DDDDDD.......", ".....DDDDDDDDDD.....", "....LLLLLLLLLLLL....", "...DD..........DD..."],
    tail: true,
  },
  /* 12 卷发 */
  {
    top: ["....DD.DD..DD.DD....", "...DDDDDDDDDDDDDD...", "...DDDDDDDDDDDDDD...", "...DDD........DDD..."],
    side: { 4: "DD", 5: "D." },
  },
  /* 13 乱发胡茬 */
  {
    top: ["....D...DD..D.D.....", "...DDDDDDDDDDDDD....", "...ODDDDDDDDDDO.....", "...DD..........DD..."],
    stubble: true,
  },
];

/** 马尾那几格（网格坐标） */
export const TAIL_CELLS: readonly (readonly [number, number])[] = [
  [16, 3], [16, 4], [16, 5], [16, 6], [16, 7], [15, 7], [15, 3],
];

/** 络腮胡两颊那几格 */
export const BEARD_CHEEK_CELLS: readonly (readonly [number, number])[] = [
  [4, 8], [15, 8], [4, 9], [15, 9], [5, 10], [14, 10], [5, 11], [14, 11],
];

/** 三层特征。眼 / 眉 / 嘴各是一小张相对锚点的图案，**只有这三层会换** */
export const EYES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  open: [[0, 0], [1, 0], [0, 1], [1, 1]],
  half: [[0, 1], [1, 1]],
  shut: [[0, 1], [1, 1]],
  left: [[-1, 0], [0, 0], [-1, 1], [0, 1]],
  right: [[1, 0], [2, 0], [1, 1], [2, 1]],
  up: [[0, 0], [1, 0]],
  cross: [[0, 0], [1, 1], [1, 0], [0, 1]],
};

export const BROWS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  flat: [[0, 0], [1, 0]],
  up: [[0, -1], [1, -1]],
  knit: [[0, 1], [1, 0]],
  none: [],
};

export const MOUTHS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  smile: [[0, 1], [1, 1], [2, 1], [-1, 0], [3, 0]],
  flat: [[0, 0], [1, 0], [2, 0]],
  small: [[1, 0], [2, 0]],
  oh: [[1, 0], [1, 1]],
  talk: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  frown: [[0, 0], [1, 0], [2, 0], [-1, 1], [3, 1]],
  zig: [[0, 1], [1, 0], [2, 1]],
};
