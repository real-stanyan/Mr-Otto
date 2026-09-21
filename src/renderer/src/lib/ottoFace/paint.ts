// ottoFace/paint —— 把一帧画到 canvas 上（#1345，ADR-0311）。
//
// 这一层**一个判断都不做**：网格坐标 → 像素，就这些。所有「画什么」的判断都在
// `frame.ts`（纯函数，进得了 vitest）。这么分的理由不是洁癖 —— jsdom 没有
// `getContext()`，判断留在这边等于那部分零执行覆盖。
//
// `getContext` 拿不到（jsdom / 上下文丢失）就**什么都不画、也不抛**：一张空白圆盘
// 是可接受的退化，为了一张头像把整棵树炸掉不是。
//
// ## 为什么要先画到离屏再缩过去
//
// 这批脸是 55×48 格，而产品里头像的真实尺寸是 16 / 20 / 22 / 26 / 30 / 34 / 48 / 56 /
// 128px —— 九成调用点在 16..34。直接按 `px / 格数` 画方块的话，24px 下一格只有 0.4 个
// 像素：`fillRect` 会把相邻格子叠在同一个像素上，谁最后画谁赢，脸会碎成噪点。
//
// 所以先画到一张**一格一像素**的离屏画布，再整张 `drawImage` 过去：
//
// · 放大（目标 ≥ 网格）关平滑 —— 像素画的整条命脉，一开平滑就糊成模糊贴图
// · 缩小（目标 < 网格）开平滑 —— 这时候「保持硬边」已经不可能（一个像素装不下一格），
//   而面积平均出来的小图恰恰就是旧那 13 张 128px PNG 被浏览器缩到 24px 的样子。
//   换句话说这不是新引入的妥协，是回到原来的做法。

import { composeFrame, type FaceFrame } from "./frame.js";
import { DISC_CELLS, DISC_COLOR, FACE_ORIGIN_X, FACE_ORIGIN_Y, GRID_H, GRID_W } from "./sprites.js";
import type { FaceState } from "./states.js";

/** 离线那一档整张脸压到这个透明度 */
const DIM_ALPHA = 0.45;

/** 角标的半径（按边长的比例）与它到右下角的距离系数 */
const BADGE_R = 0.15;
const BADGE_INSET = 1.05;
/** 角标外那圈盘底：把它与脸隔开，否则压在深色头发上读不出形状 */
const BADGE_RING = 1.42;

/** 离屏画布一格一像素。整张脸就这么大，重建一次的代价可以忽略，所以不做缓存池 ——
    一个按 (坑位, 状态, 时刻) 索引的缓存会比它本身贵 */
let scratch: HTMLCanvasElement | null = null;

function renderGrid(frame: FaceFrame): HTMLCanvasElement | null {
  if (scratch === null) {
    if (typeof document === "undefined") return null;
    scratch = document.createElement("canvas");
  }
  scratch.width = GRID_W;
  scratch.height = GRID_H;
  const g = scratch.getContext("2d");
  if (g === null) return null;
  g.clearRect(0, 0, GRID_W, GRID_H);
  for (const c of frame.cells) {
    const hex = frame.palette[c.key];
    if (hex === undefined) continue;
    g.fillStyle = hex;
    g.fillRect(c.x, c.y, 1, 1);
  }
  return scratch;
}

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
  g.clearRect(0, 0, px, px);

  const disc = (): void => {
    g.beginPath();
    g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    g.fill();
  };

  g.fillStyle = DISC_COLOR;
  disc();

  const sheet = renderGrid(frame);
  if (sheet !== null) {
    g.save();
    g.beginPath();
    g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    g.clip();
    if (frame.dim) g.globalAlpha = DIM_ALPHA;
    const cell = px / DISC_CELLS;
    // 一格铺得下一个像素才谈得上「硬边」；铺不下就只能交给面积平均，见文件头
    g.imageSmoothingEnabled = cell < 1;
    g.drawImage(
      sheet,
      px / 2 - FACE_ORIGIN_X * cell,
      px / 2 - FACE_ORIGIN_Y * cell,
      GRID_W * cell,
      GRID_H * cell
    );
    g.restore();
  }

  if (frame.badge !== null) {
    const r = Math.max(2.5, px * BADGE_R);
    const cx = px - r * BADGE_INSET;
    g.fillStyle = DISC_COLOR;
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
