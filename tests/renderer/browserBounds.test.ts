import { describe, it, expect } from "vitest";
import { rectToBounds } from "../../src/renderer/src/lib/browserBounds.js";

describe("rectToBounds", () => {
  it("可见时按 DOMRect 取整", () => {
    expect(rectToBounds({ x: 10.4, y: 20.6, width: 300.2, height: 400.8 }, true))
      .toEqual({ x: 10, y: 21, width: 300, height: 401 });
  });

  it("不可见 = null(面板收起,view 从窗口摘下来)", () => {
    expect(rectToBounds({ x: 0, y: 0, width: 300, height: 400 }, false)).toBeNull();
  });

  it("零尺寸 = null —— 首帧布局还没算完时 DOMRect 是全 0," +
     "照原样报上去会让 view 在左上角闪一下", () => {
    expect(rectToBounds({ x: 0, y: 0, width: 0, height: 0 }, true)).toBeNull();
    expect(rectToBounds({ x: 5, y: 5, width: 300, height: 0 }, true)).toBeNull();
  });

  it("负坐标钳到 0 —— 面板被拖出窗口左沿时,负 x 会让 view 盖住窗口外的桌面", () => {
    expect(rectToBounds({ x: -12, y: -3, width: 300, height: 400 }, true))
      .toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });
});
