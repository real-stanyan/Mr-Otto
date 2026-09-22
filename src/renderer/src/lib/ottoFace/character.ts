// 角色数据包的契约 —— 一个角色 = 一份纯数据，不改引擎代码。
//
// 智能体头像是用户在创建时自选的（`avatar_slot`，迁移 0027 / #1007），今天有 13 张内置，
// 以后还会加。所以「让头像动起来」必须是 N 份数据配一套引擎，而不是 N 份各自的动画代码——
// 后者第二个角色就开始复制粘贴，第五个开始分家。
//
// ## 一个角色要提供什么
//
// 必须的只有四样：像素矩阵、色板、擦除框、五官锚点。眼形嘴形不用手画——
// `deriveEyes` / `deriveMouths` 从两三个尺寸数字推出全套，因为这些头像共享同一套画风，
// 差别只在五官的大小位置。手画七种眼形 × 13 个角色 = 91 张图案，其中 90 张是同构的。
//
// ## 眼镜 / 胡子 / 刘海怎么办
//
// **靠擦除框收窄，不靠图层。** 06、07 戴眼镜，08、10、13 有头发压在脸上——这些都在
// `base` 里。擦除框只圈镜片内部（不含镜框）、只圈发丝之间的空当，那些结构就自然留下来了。
// 加一层 `front` 覆盖听起来更通用，但它要求每个角色多维护一张对齐的矩阵，而收窄一个
// 四元组是改四个数字。真遇到擦不干净的角色再上 `front`，别提前付这个成本。

/** 一格的色调。`.` 透明、`A` 角标强调色由状态表给，其余由角色色板自定义 */
export type Tone = string;

export type EyeShape = "open" | "blink" | "happy" | "wide" | "squint" | "sleep" | "dizzy";
export type MouthShape = "smile" | "grin" | "flat" | "o" | "small" | "purse" | "wavy";

/** `[row0, row1, col0, col1]`，闭区间，写在角色自己的矩阵坐标里。
 *
 *  第五项是**这块抹平之后填什么色**，默认 `skin`。绝大多数角色不用写：五官长在脸上，
 *  抹掉就该露出脸色。需要它的是五官长在别的东西上的角色——大胡子的嘴陷在胡子里，
 *  抹成脸白会在胡子中间开一个洞。 */
export type Box =
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, Tone];

/** 一对眼睛。左右分开存而不是镜像：这批头像多是四分之三侧脸，两眼宽度本来就差一格，
 *  镜像会把那点透视抹掉，脸立刻变正而且变呆 */
export interface EyePair {
  readonly L: readonly string[];
  readonly R: readonly string[];
  readonly lx: number;
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
}

export interface FaceCharacter {
  readonly id: string;
  readonly name: string;
  readonly w: number;
  readonly h: number;
  /** 角色本体。五官也画在里面——合成时先按 `erase` 擦掉再重画 */
  readonly base: readonly string[];
  /** 色调 → CSS 颜色。`.` 不要出现在这里 */
  readonly palette: Readonly<Record<string, string>>;
  /** 冻结态用的降饱和色板；缺省时由引擎按 `palette` 自动压灰 */
  readonly dimPalette?: Readonly<Record<string, string>>;
  /** 画五官用哪个色调 */
  readonly ink: Tone;
  /** 擦除框填成哪个色调（脸的底色） */
  readonly skin: Tone;
  readonly erase: readonly Box[];
  readonly anchors: {
    readonly browL: readonly [number, number];
    readonly browR: readonly [number, number];
    readonly eyeL: readonly [number, number];
    readonly eyeR: readonly [number, number];
    readonly mouth: readonly [number, number];
  };
  readonly eyes: Readonly<Record<EyeShape, EyePair>>;
  readonly brows: { readonly L: readonly string[]; readonly R: readonly string[] };
  readonly mouths: Readonly<Record<MouthShape, readonly string[]>>;
  /** 画在五官之上的覆盖层（镜框、压脸的发丝）。可选，绝大多数角色不需要 */
  readonly front?: readonly string[];
}

function bar(w: number, h: number): string[] {
  return Array.from({ length: h }, () => "#".repeat(w));
}

/** 睁眼的宽高 → 全套七种眼形。
 *
 *  形状本身是画风决定的常量（这批头像的笑眼都是 `^`、眯眼都是上粗下细），
 *  这里只按角色的尺寸缩放。偏移量保证不同大小的图案仍然落在同一个锚点上，
 *  否则换个表情眼睛会整体漂一格——38 格宽的脸上那一格肉眼可见。 */
export function deriveEyes(spec: {
  readonly lw: number; readonly lh: number; readonly rw: number; readonly rh: number;
}): Record<EyeShape, EyePair> {
  const { lw, lh, rw, rh } = spec;
  const wide = (w: number): number => w + 2;
  const pad = (w: number): number => -Math.floor((wide(w) - w) / 2);
  const arc = (w: number): string[] => {
    const inner = Math.max(1, w - 2);
    return [`.${"#".repeat(inner)}.`, `#${".".repeat(inner)}#`];
  };
  const lid = (w: number): string[] => ["#".repeat(w + 2), `.${"#".repeat(w)}.`];
  const shut = (w: number): string[] => [`#${".".repeat(w)}#`, `.${"#".repeat(w)}.`];
  const x = (w: number): string[] => [`#${".".repeat(w)}#`, `.${"#".repeat(w)}.`, `.${"#".repeat(w)}.`, `#${".".repeat(w)}#`];
  return {
    open: { L: bar(lw, lh), R: bar(rw, rh), lx: 0, ly: 0, rx: 0, ry: 0 },
    blink: { L: [`${"#".repeat(lw + 2)}`], R: [`${"#".repeat(rw + 2)}`], lx: pad(lw), ly: Math.floor(lh / 2), rx: pad(rw), ry: Math.floor(rh / 2) },
    happy: { L: arc(lw + 2), R: arc(rw + 2), lx: pad(lw), ly: 1, rx: pad(rw), ry: 1 },
    wide: { L: bar(lw + 2, lh + 1), R: bar(rw + 2, rh + 1), lx: pad(lw), ly: -1, rx: pad(rw), ry: -1 },
    squint: { L: lid(lw), R: lid(rw), lx: pad(lw), ly: 1, rx: pad(rw), ry: 1 },
    sleep: { L: shut(lw), R: shut(rw), lx: pad(lw), ly: 1, rx: pad(rw), ry: 1 },
    dizzy: { L: x(lw), R: x(rw), lx: pad(lw), ly: 0, rx: pad(rw), ry: 0 },
  };
}

/** 嘴宽 → 全套七种嘴形。宽度必须是奇数，居中对称才成立。
 *
 *  下限 5：再窄的话 `corners()` 的两对嘴角就接在一起了，出来的行比 w 还长——
 *  不是崩，是画出一张宽度对不上的嘴，正是那种没人会去报的 bug */
export function deriveMouths(width: number): Record<MouthShape, string[]> {
  const w = Math.max(5, width % 2 === 0 ? width + 1 : width);
  const mid = Math.floor(w / 2);
  const row = (fill: string): string => fill.padEnd(w, ".").slice(0, w);
  const centred = (n: number): string => {
    const k = Math.min(n, w);
    const left = Math.floor((w - k) / 2);
    return ".".repeat(left) + "#".repeat(k) + ".".repeat(w - left - k);
  };
  const corners = (): string => `##${".".repeat(Math.max(0, w - 4))}##`;
  const blank = ".".repeat(w);
  return {
    // 原装微笑：两个上扬的嘴角 + 下面一条横杠。这是这批头像共同的嘴
    smile: [corners(), corners(), `.${"#".repeat(w - 2)}.`, centred(Math.max(2, w - 4))],
    grin: [centred(w - 2), centred(w - 2), centred(w - 2), centred(w - 4)],
    flat: [blank, centred(w - 2), centred(w - 2), blank],
    o: [centred(3), centred(5), centred(5), centred(3)],
    small: [blank, centred(3), centred(3), blank],
    purse: [blank, row(`${".".repeat(Math.max(0, mid - 2))}####`), row(`${".".repeat(Math.max(0, mid - 2))}####`), blank],
    wavy: [blank, row(".##..##."), row("..##..##"), blank],
  };
}

/** 眉毛：一条横杠，左右可不等宽（同样是那点透视） */
export function deriveBrows(lw: number, rw: number): { L: string[]; R: string[] } {
  return { L: bar(lw, 2), R: bar(rw, 2) };
}
