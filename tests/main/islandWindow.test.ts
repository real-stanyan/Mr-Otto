import { describe, it, expect } from "vitest";
import { islandBounds } from "../../src/main/islandWindow.js";

describe("islandBounds", () => {
  it("水平居中、贴显示器顶边", () => {
    expect(islandBounds({ x: 0, y: 0, width: 1440 }, { w: 200, h: 36 }))
      .toEqual({ x: 620, y: 0, width: 200, height: 36 });
  });
  it("外接屏有偏移时按该屏原点算", () => {
    expect(islandBounds({ x: 1440, y: -200, width: 1000 }, { w: 100, h: 30 }))
      .toEqual({ x: 1890, y: -200, width: 100, height: 30 });
  });
});
