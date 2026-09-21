// 把一帧字符网格画到 canvas 上。**这是整个库唯一碰 DOM 的文件**，所以它也是唯一
// 在 jsdom 门禁下测不了的文件（jsdom 不实现 getContext）。除它之外全是纯函数。
//
// 走 ImageData 而不是逐格 fillRect：一帧两三千格，fillRect 是两三千次调用，
// ImageData 是一次。放大靠 `imageSmoothingEnabled = false` + 整数倍 drawImage——
// **非整数倍会把硬边插值成糊**，而硬边是像素画的全部身份。

import type { Frame } from "./compose.js";

/** 把一帧写进一张与网格同尺寸的离屏 canvas（1 格 = 1 像素） */
export function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const img = ctx.createImageData(frame.w, frame.h);
  const d = img.data;
  for (let y = 0; y < frame.h; y++) {
    const row = frame.rows[y] ?? "";
    for (let x = 0; x < frame.w; x++) {
      const hex = frame.palette[row[x] ?? "."];
      const o = (y * frame.w + x) * 4;
      if (hex === undefined) { d[o + 3] = 0; continue; }
      d[o] = Number.parseInt(hex.slice(1, 3), 16);
      d[o + 1] = Number.parseInt(hex.slice(3, 5), 16);
      d[o + 2] = Number.parseInt(hex.slice(5, 7), 16);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 整数倍最近邻放大。`scale` 会向下取整到 ≥1——小数倍数在像素画里没有正确答案 */
export function blitScaled(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  scale: number,
): void {
  const k = Math.max(1, Math.floor(scale));
  dst.clearRect(0, 0, w * k, h * k);
  dst.imageSmoothingEnabled = false;
  dst.drawImage(src, 0, 0, w * k, h * k);
}
