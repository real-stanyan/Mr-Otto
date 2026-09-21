// ottoFace/paint —— 把一帧画到 canvas 上（#1345，ADR-0311）。
//
// 这一层**一个判断都不做**：网格坐标 → 像素，就这些。所有「画什么」的判断都在
// `frame.ts`（纯函数，进得了 vitest）。这么分的理由不是洁癖 —— jsdom 没有
// `getContext()`，判断留在这边等于那部分零执行覆盖。
//
// `getContext` 拿不到（jsdom / 上下文丢失）就**什么都不画、也不抛**：一张空白圆盘
// 是可接受的退化，为了一张头像把整棵树炸掉不是。

import { composeFrame } from "./frame.js";
import { DISC_CELLS, FACE_COLORS, FACE_ORIGIN_X, FACE_ORIGIN_Y } from "./sprites.js";
import type { FaceState } from "./states.js";

/** 离线那一档整张脸压到这个透明度 */
const DIM_ALPHA = 0.45;

/** 角标的半径（按边长的比例）与它到右下角的距离系数 —— 原型上量出来的 */
const BADGE_R = 0.15;
const BADGE_INSET = 1.05;
/** 角标外那圈盘底：把它与脸隔开，否则压在深色头发上读不出形状 */
const BADGE_RING = 1.42;

/**
 * 画一帧。`canvas.width`/`height` 由调用方按 dpr 设好（正方形），这里只认它。
 *
 * `t` 是毫秒时刻；静态一帧传 0 —— 与动画走同一段代码，见 `frame.ts` 的头注。
 */
export function paintFace(canvas: HTMLCanvasElement, slot: number, state: FaceState, t: number): void {
  const g = canvas.getContext("2d");
  if (g === null) return;
  const px = canvas.width;
  if (px <= 0) return;

  const frame = composeFrame(slot, state, t);
  // 像素画的整条命脉：一开平滑就糊成模糊贴图（sprites.ts 法理 ②）
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, px, px);

  const disc = (): void => {
    g.beginPath();
    g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    g.fill();
  };

  g.fillStyle = FACE_COLORS["P"]!;
  disc();

  g.save();
  g.beginPath();
  g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
  g.clip();
  if (frame.dim) g.globalAlpha = DIM_ALPHA;

  const cell = Math.max(1, px / DISC_CELLS);
  const ox = px / 2 - FACE_ORIGIN_X * cell;
  const oy = px / 2 - FACE_ORIGIN_Y * cell;
  for (const c of frame.cells) {
    g.fillStyle = FACE_COLORS[c.key] ?? FACE_COLORS["I"]!;
    g.fillRect(Math.round(ox + c.x * cell), Math.round(oy + c.y * cell), Math.ceil(cell), Math.ceil(cell));
  }
  g.restore();

  if (frame.badge !== null) {
    const r = Math.max(2.5, px * BADGE_R);
    const cx = px - r * BADGE_INSET;
    g.fillStyle = FACE_COLORS["P"]!;
    g.beginPath();
    g.arc(cx, cx, r * BADGE_RING, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = frame.badge;
    g.beginPath();
    g.arc(cx, cx, r, 0, Math.PI * 2);
    g.fill();
  }
}

/** 按 css 尺寸 + dpr 把画布调到位；尺寸没变就不碰（改 width 会清空画布） */
export function sizeFaceCanvas(canvas: HTMLCanvasElement, cssSize: number, dpr: number): void {
  const want = Math.max(1, Math.round(cssSize * Math.min(3, Math.max(1, dpr))));
  if (canvas.width !== want || canvas.height !== want) {
    canvas.width = want;
    canvas.height = want;
  }
}

export type { FaceState };
