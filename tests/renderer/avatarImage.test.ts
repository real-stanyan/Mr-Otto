// avatarImage — 裁剪框和降质阶梯这两段纯逻辑。
// canvas 那半段(drawImage/toDataURL)不测:它是浏览器的实现,在这里 mock 出来
// 只会测到 mock 本身。

import { describe, expect, it } from "vitest";
import { coverCropRect, nextQuality } from "../../src/renderer/src/lib/avatarImage.js";

describe("coverCropRect", () => {
  it("横图从中间取正方形", () => {
    expect(coverCropRect(400, 200)).toEqual({ sx: 100, sy: 0, size: 200 });
  });

  it("竖图同理,裁的是上下", () => {
    expect(coverCropRect(200, 400)).toEqual({ sx: 0, sy: 100, size: 200 });
  });

  it("本来就是方的:一刀不裁", () => {
    expect(coverCropRect(256, 256)).toEqual({ sx: 0, sy: 0, size: 256 });
  });

  it("奇数差值取整,不产生半像素起点(drawImage 的半像素源会糊一圈)", () => {
    expect(coverCropRect(101, 100)).toEqual({ sx: 1, sy: 0, size: 100 });
  });
});

describe("nextQuality", () => {
  it("每次降一档", () => {
    expect(nextQuality(0.82)).toBe(0.67);
  });

  it("降到底就回 null —— 到这一步说明源图不是常规照片,该让用户换一张", () => {
    expect(nextQuality(0.52)).toBeNull();
  });

  it("阶梯一定收敛(不会无限循环)", () => {
    let q: number | null = 0.82;
    let steps = 0;
    while (q !== null && steps < 100) {
      q = nextQuality(q);
      steps += 1;
    }
    expect(q).toBeNull();
    expect(steps).toBeLessThan(10);
  });
});
