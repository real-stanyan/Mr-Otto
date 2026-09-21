// 把「哪个角色 + 哪个状态 + 此刻第几毫秒」合成一帧像素网格。**纯函数，零 DOM**。
//
// 拆出来的直接理由是测不了：门禁跑在 jsdom 上，而 jsdom 不实现 `getContext()`
// （基线那一跑里就有四条 "Not implemented: HTMLCanvasElement's getContext()"）。
// 合成和上色搅在一起的话这里所有判定都只能靠肉眼——包括「角标会不会压到头发上」
// 这种改一个数字就复发的东西。现在它是一张字符网格，测得动。
//
// 第二个好处是确定性：时间是入参不是 `Date.now()`，同一个 (角色, 状态, t) 永远是同一帧。
// 眨眼因此也不用随机数——两个互质周期叠出来的图案看着不规律，但可复现。
//
// 画布比角色大一圈：左右各留位给整格摆动，右上角留一个 8×8 的角标槽。**角标槽整个
// 在角色右侧之外**，所以「角标压到头发」在布局这一层就不可能发生，不用每加一个角色
// 重新对一遍位置。

import { BADGES, GEAR_FRAMES, type BadgeName } from "./badges.js";
import type { EyeShape, FaceCharacter, MouthShape, Tone } from "./character.js";
import { FACE_STATES, type FaceState } from "./states.js";

/** 角色四周的留白。左右各 1 是给摆动的，右侧 9 = 1 格间隙 + 8 格角标槽 */
export const PAD_L = 1;
export const PAD_T = 2;
export const PAD_B = 2;
export const BADGE_SIZE = 8;
const PAD_R = BADGE_SIZE + 1;

export interface Layout {
  readonly gridW: number;
  readonly gridH: number;
  readonly headX: number;
  readonly headY: number;
  readonly badgeX: number;
  readonly badgeY: number;
}

export function layoutFor(ch: FaceCharacter): Layout {
  return {
    gridW: PAD_L + ch.w + PAD_R,
    gridH: PAD_T + ch.h + PAD_B,
    headX: PAD_L,
    headY: PAD_T,
    badgeX: PAD_L + ch.w + 1,
    badgeY: PAD_T,
  };
}

/** 想让这张脸占多高（像素）→ 该用第几档缩放。
 *
 *  角色的网格大小是各画各的：Otto 的 logo 原生 19×18，这批头像原生二十四五格，
 *  同一个 scale 摆一排，Otto 会小掉四成。缩放只能取整（取小数就是次像素插值，
 *  像素画当场糊掉），所以这里不是等比，是「就近的那一档」——一排脸高度差几格，
 *  比差四成好看得多，也比把谁的矩阵硬拉一遍诚实。 */
export function scaleForHeight(ch: FaceCharacter, targetPx: number): number {
  const unit = layoutFor(ch).gridH;
  const lo = Math.max(1, Math.floor(targetPx / unit));
  // 正好卡在两档中间时往小里取。往大取会超出目标一整格高，而一排脸里冒出来的
  // 那一个比整排矮一点显眼得多——Math.round 的 .5 进位恰好会踩这个坑
  return Math.abs(lo * unit - targetPx) <= Math.abs((lo + 1) * unit - targetPx) ? lo : lo + 1;
}

export interface Frame {
  readonly w: number;
  readonly h: number;
  /** `h` 行，每行 `w` 个色调字符 */
  readonly rows: readonly string[];
  /** 色调 → CSS 颜色；`.` 不在表里（透明） */
  readonly palette: Readonly<Record<string, string>>;
}

export interface ComposeOptions {
  /** 指针相对脸心的横纵偏移，各自 -1..1。只有 `look: "pointer"` 的状态读它 */
  readonly pointerX?: number;
  readonly pointerY?: number;
}

/** 思考时的扫视时间线：左上 → 正上 → 右上 → 回正。
 *  静态的「往上看」读起来只是个姿势；思考的本质是在搜索，视线不游走就不成立。 */
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

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** 缺省的降饱和：往中灰收 62%。角色可以自带 `dimPalette` 覆盖它 */
function dim(palette: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tone, hex] of Object.entries(palette)) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m?.[1] === undefined) { out[tone] = hex; continue; }
    const n = Number.parseInt(m[1], 16);
    const mix = (c: number): number => Math.round(c * 0.38 + 0x6e * 0.62);
    const r = mix((n >> 16) & 0xff), g = mix((n >> 8) & 0xff), b = mix(n & 0xff);
    out[tone] = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }
  return out;
}

export interface BadgePainter {
  /** 角标图案；`bars` / `gear` / `bang` 由引擎现算，其余查角色无关的公共表 */
  readonly draw: (put: (x: number, y: number) => void, timeMs: number) => void;
}

export function composeFrame(
  ch: FaceCharacter,
  state: FaceState,
  timeMs: number,
  opts?: ComposeOptions,
): Frame {
  const def = FACE_STATES[state];
  const L = layoutFor(ch);
  const cells: Tone[] = new Array<Tone>(L.gridW * L.gridH).fill(".");
  const put = (x: number, y: number, tone: Tone): void => {
    if (tone === "." || x < 0 || x >= L.gridW || y < 0 || y >= L.gridH) return;
    cells[y * L.gridW + x] = tone;
  };
  /** 图案里的非 `.` 一律画成同一个色调 */
  const stamp = (sprite: readonly string[], x0: number, y0: number, tone: Tone): void => {
    for (let j = 0; j < sprite.length; j++) {
      const row = sprite[j] ?? "";
      for (let i = 0; i < row.length; i++) if ((row[i] ?? ".") !== ".") put(x0 + i, y0 + j, tone);
    }
  };

  // ---- 位移。全部整数格：像素画做亚像素平滑会立刻糊 ----
  const bob = def.bobMs > 0 ? Math.round(Math.sin((timeMs / def.bobMs) * Math.PI * 2) * def.bobAmp) : 0;
  const sway =
    def.sway === "urgent" ? (Math.floor(timeMs / 260) % 2 === 0 ? -1 : 1)
    : def.sway === "lean" ? (Math.sin(timeMs / 3700) > 0 ? -1 : 0)
    : 0;

  let lookX = 0;
  let lookY = 0;
  if (def.look === "pointer") {
    lookX = Math.round(clampUnit(opts?.pointerX ?? 0) * 2);
    lookY = Math.round(clampUnit(opts?.pointerY ?? 0));
  } else if (def.look === "scan") {
    const [sx, sy] = scanAt(timeMs);
    lookX = sx; lookY = sy;
  } else if (def.look === "dart") {
    lookX = Math.floor(timeMs / 190) % 2 === 0 ? -2 : 2;
  } else if (def.look === "fixed") {
    lookX = def.fixedLook?.[0] ?? 0;
    lookY = def.fixedLook?.[1] ?? 0;
  }

  const ox = L.headX + sway;
  const oy = L.headY + bob;

  // ---- 角色本体：品牌锁死，原样搬 ----
  for (let j = 0; j < ch.h; j++) {
    const row = ch.base[j] ?? "";
    for (let i = 0; i < ch.w; i++) put(i + ox, j + oy, (row[i] ?? ".") as Tone);
  }
  for (const [r0, r1, c0, c1, fill] of ch.erase) {
    const tone = fill ?? ch.skin;
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) put(x + ox, y + oy, tone);
  }

  // ---- 五官 ----
  const browDy = (def.browDy ?? 0) + (lookY < 0 ? -1 : 0);
  stamp(ch.brows.L, ch.anchors.browL[0] + ox, ch.anchors.browL[1] + oy + browDy + (def.browAsym ?? 0), ch.ink);
  stamp(ch.brows.R, ch.anchors.browR[0] + ox, ch.anchors.browR[1] + oy + browDy, ch.ink);

  const eyeShape: EyeShape = def.blinks && blinkingAt(timeMs) ? "blink" : def.eye;
  const eye = ch.eyes[eyeShape];
  stamp(eye.L, ch.anchors.eyeL[0] + ox + eye.lx + lookX, ch.anchors.eyeL[1] + oy + eye.ly + lookY, ch.ink);
  stamp(eye.R, ch.anchors.eyeR[0] + ox + eye.rx + lookX, ch.anchors.eyeR[1] + oy + eye.ry + lookY, ch.ink);

  const mouthShape: MouthShape =
    def.mouth === "talk" ? (TALK_CYCLE[Math.floor(timeMs / 130) % TALK_CYCLE.length] ?? "smile") : def.mouth;
  stamp(ch.mouths[mouthShape], ch.anchors.mouth[0] + ox + (def.mouthDx ?? 0), ch.anchors.mouth[1] + oy, ch.ink);

  // ---- 覆盖层（镜框、压脸的发丝）画在五官之上 ----
  if (ch.front !== undefined) {
    for (let j = 0; j < ch.front.length; j++) {
      const row = ch.front[j] ?? "";
      for (let i = 0; i < row.length; i++) put(i + ox, j + oy, (row[i] ?? ".") as Tone);
    }
  }

  // ---- 角标。整个槽在角色右侧之外，所以不可能压到头发 ----
  if (def.badge !== undefined) drawBadge(def.badge, L, timeMs, (x, y) => put(x, y, "A"));

  const rows: string[] = [];
  for (let y = 0; y < L.gridH; y++) rows.push(cells.slice(y * L.gridW, (y + 1) * L.gridW).join(""));

  const tones = def.desaturate === true ? (ch.dimPalette ?? dim(ch.palette)) : ch.palette;
  const palette: Record<string, string> = { ...tones };
  if (def.accent !== undefined) palette["A"] = def.accent;

  return { w: L.gridW, h: L.gridH, rows, palette };
}

const TALK_CYCLE: readonly MouthShape[] = ["smile", "o", "flat", "o"];
export { TALK_CYCLE };

function drawBadge(name: BadgeName, L: Layout, t: number, mark: (x: number, y: number) => void): void {
  const stampAt = (sprite: readonly string[], dx: number, dy: number): void => {
    for (let j = 0; j < sprite.length; j++) {
      const row = sprite[j] ?? "";
      for (let i = 0; i < row.length; i++) if ((row[i] ?? ".") !== ".") mark(L.badgeX + dx + i, L.badgeY + dy + j);
    }
  };
  if (name === "bars") {
    for (let k = 0; k < 3; k++) {
      const h = 2 + Math.floor(Math.abs(Math.sin(t / 170 + k * 1.1)) * 5);
      for (let y = 0; y < h; y++) {
        mark(L.badgeX + k * 3, L.badgeY + 7 - y);
        mark(L.badgeX + k * 3 + 1, L.badgeY + 7 - y);
      }
    }
    return;
  }
  if (name === "gear") { stampAt(GEAR_FRAMES[Math.floor(t / 220) % GEAR_FRAMES.length] ?? [], 0, 0); return; }
  // 闪烁本身是信号：一墙头像里，间歇出现比常亮更抓眼
  if (name === "bang") { if (t % 760 < 520) stampAt(BADGES.bang, 1, 0); return; }
  stampAt(BADGES[name], 0, 0);
  if (name === "bubble") {
    for (let d = 0; d < 3; d++) {
      if (Math.floor(t / 300) % 4 > d) { mark(L.badgeX + 2 + d * 2, L.badgeY + 1); mark(L.badgeX + 2 + d * 2, L.badgeY + 2); }
    }
  }
}
