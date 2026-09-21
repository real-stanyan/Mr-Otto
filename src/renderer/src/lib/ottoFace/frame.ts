// ottoFace/frame —— 把画料叠成一帧（#1345，ADR-0311）。
//
// **纯函数**：给定坑位 / 状态 / 时刻，画出来的东西完全确定。所以「静态一帧」和「动画」
// 走的是同一段代码 —— 不会出现「不动的那版长得不一样」，也不用为名册那一墙脸另写
// 一条渲染路径。canvas 那一层（`paint.ts`）只把网格坐标换成像素，一个判断都不做，
// 于是这个文件进得了 vitest 而 jsdom 没有 canvas 这件事碍不着它。
//
// 时间是**入参不是 `Date.now()`**，所以同一个 (坑位, 状态, t) 永远是同一帧。眨眼因此也
// 不用随机数 —— 两个互质周期叠出来的图案看着不规律，但可复现；用随机数的话下面每一条
// 断言都是碰运气。
//
// 叠的顺序即盖住的顺序：角色本体 → 抹掉原装五官 → 画新的眉眼嘴 → 覆盖层（镜框 / 压脸
// 的发丝）。**镜框归脸、不归五官**：只抹镜片内腔，眼睛在框里换，所以眯眼 / 闭眼 /
// 左右看 / 叉叉在戴眼镜那两只身上照样成立。

import type { EyeShape, FaceCharacter, MouthShape, Tone } from "./character.js";
import { FACE_PAD, faceCharacterAt } from "./sprites.js";
import { BADGE_COLORS, FACE_STATES, type FaceState } from "./states.js";

/** 一格。`x`/`y` 是网格坐标（已经把位移算进去了），`key` 是调色板的键 */
export interface FaceCell {
  x: number;
  y: number;
  key: string;
}

export interface FaceFrame {
  cells: readonly FaceCell[];
  /** 色调 → CSS 颜色。**每个角色自带一份** —— 大胡子的胡子灰和头发灰不是一个值 */
  palette: Readonly<Record<string, string>>;
  /** 右下角那枚角标的颜色；`null` = 不画（`plain` 那一档） */
  badge: string | null;
  /** 整张脸压淡 */
  dim: boolean;
}

export { faceCharacterAt };

/** 思考时的扫视时间线：左上 → 正上 → 右上 → 回正。
 *  静态的「往上看」读起来只是个姿势；思考的本质是在搜索，视线不游走就不成立 */
const SCAN: readonly (readonly [number, number, number])[] = [
  [-2, -1, 900], [0, -2, 620], [2, -1, 900], [0, 0, 520],
];
const SCAN_TOTAL = SCAN.reduce((a, s) => a + s[2], 0);

function scanAt(t: number): readonly [number, number] {
  const u = ((t % SCAN_TOTAL) + SCAN_TOTAL) % SCAN_TOTAL;
  let acc = 0;
  for (const step of SCAN) {
    acc += step[2];
    if (u < acc) return [step[0], step[1]];
  }
  return [0, 0];
}

/** 两个互质周期叠出来的眨眼：看着不规律，但同一个 t 永远给同一个答案 */
function blinkingAt(t: number): boolean {
  return t % 4200 < 110 || t % 6700 < 110;
}

const TALK_CYCLE: readonly MouthShape[] = ["smile", "o", "flat", "o"];

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** 往中灰收 62% */
function dimHex(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m?.[1] === undefined) return hex;
  const n = Number.parseInt(m[1], 16);
  const mix = (c: number): number => Math.round(c * 0.38 + 0x6e * 0.62);
  const r = mix((n >> 16) & 0xff), g = mix((n >> 8) & 0xff), b = mix(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function desaturated(palette: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tone, hex] of Object.entries(palette)) out[tone] = dimHex(hex);
  return out;
}

export interface FrameOptions {
  /** 指针相对脸心的横纵偏移，各自 -1..1。只有 `look: "pointer"` 的状态读它 */
  readonly pointerX?: number;
  readonly pointerY?: number;
}

/**
 * 一帧。`t` 是毫秒时刻（`performance.now()`），静态帧传 0。
 */
export function composeFrame(slot: number, state: FaceState, t: number, opts?: FrameOptions): FaceFrame {
  const ch: FaceCharacter = faceCharacterAt(slot);
  const def = FACE_STATES[state];

  // ---- 位移。全部整数格：像素画做亚像素平滑会立刻糊 ----
  const bob = def.bobMs > 0 ? Math.round(Math.sin((t / def.bobMs) * Math.PI * 2) * def.bobAmp) : 0;
  const sway =
    def.sway === "urgent" ? (Math.floor(t / 260) % 2 === 0 ? -1 : 1)
    : def.sway === "lean" ? (Math.sin(t / 3700) > 0 ? -1 : 0)
    : 0;

  let lookX = 0;
  let lookY = 0;
  if (def.look === "pointer") {
    lookX = Math.round(clampUnit(opts?.pointerX ?? 0) * 2);
    lookY = Math.round(clampUnit(opts?.pointerY ?? 0));
  } else if (def.look === "scan") {
    const [sx, sy] = scanAt(t);
    lookX = sx; lookY = sy;
  } else if (def.look === "dart") {
    lookX = Math.floor(t / 190) % 2 === 0 ? -2 : 2;
  } else if (def.look === "fixed") {
    lookX = def.fixedLook?.[0] ?? 0;
    lookY = def.fixedLook?.[1] ?? 0;
  }

  const grid: Tone[] = new Array<Tone>(ch.w * ch.h).fill(".");
  const put = (x: number, y: number, tone: Tone): void => {
    if (tone === "." || x < 0 || x >= ch.w || y < 0 || y >= ch.h) return;
    grid[y * ch.w + x] = tone;
  };
  const stamp = (sprite: readonly string[], x0: number, y0: number, tone: Tone): void => {
    for (let j = 0; j < sprite.length; j++) {
      const row = sprite[j] ?? "";
      for (let i = 0; i < row.length; i++) if ((row[i] ?? ".") !== ".") put(x0 + i, y0 + j, tone);
    }
  };

  // ---- 角色本体：品牌锁死，原样搬 ----
  for (let j = 0; j < ch.h; j++) {
    const row = ch.base[j] ?? "";
    for (let i = 0; i < ch.w; i++) put(i, j, (row[i] ?? ".") as Tone);
  }
  // ---- 抹掉原装的眉眼嘴。第五项指定填什么色（大胡子的嘴长在胡子上）----
  for (const [r0, r1, c0, c1, fill] of ch.erase) {
    const tone = fill ?? ch.skin;
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) put(x, y, tone);
  }

  // ---- 五官 ----
  const browDy = (def.browDy ?? 0) + (lookY < 0 ? -1 : 0);
  stamp(ch.brows.L, ch.anchors.browL[0], ch.anchors.browL[1] + browDy + (def.browAsym ?? 0), ch.ink);
  stamp(ch.brows.R, ch.anchors.browR[0], ch.anchors.browR[1] + browDy, ch.ink);

  const eyeShape: EyeShape = def.blinks && blinkingAt(t) ? "blink" : def.eye;
  const eye = ch.eyes[eyeShape];
  stamp(eye.L, ch.anchors.eyeL[0] + eye.lx + lookX, ch.anchors.eyeL[1] + eye.ly + lookY, ch.ink);
  stamp(eye.R, ch.anchors.eyeR[0] + eye.rx + lookX, ch.anchors.eyeR[1] + eye.ry + lookY, ch.ink);

  const mouthShape: MouthShape =
    def.mouth === "talk" ? (TALK_CYCLE[Math.floor(t / 130) % TALK_CYCLE.length] ?? "smile") : def.mouth;
  stamp(ch.mouths[mouthShape], ch.anchors.mouth[0] + (def.mouthDx ?? 0), ch.anchors.mouth[1], ch.ink);

  // ---- 覆盖层（镜框、压脸的发丝）画在五官之上 ----
  if (ch.front !== undefined) {
    for (let j = 0; j < ch.front.length; j++) {
      const row = ch.front[j] ?? "";
      for (let i = 0; i < row.length; i++) put(i, j, (row[i] ?? ".") as Tone);
    }
  }

  const cells: FaceCell[] = [];
  for (let y = 0; y < ch.h; y++) {
    for (let x = 0; x < ch.w; x++) {
      const tone = grid[y * ch.w + x]!;
      if (tone !== ".") cells.push({ x: x + FACE_PAD + sway, y: y + FACE_PAD + bob, key: tone });
    }
  }

  const palette = def.desaturate === true ? (ch.dimPalette ?? desaturated(ch.palette)) : ch.palette;
  return {
    cells,
    palette,
    badge: def.badge === null ? null : BADGE_COLORS[def.badge],
    dim: def.dim === true,
  };
}
