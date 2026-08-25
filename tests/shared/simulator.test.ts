import { describe, it, expect } from "vitest";
import {
  formatElement,
  pixelToScreen,
  screenToPixel,
} from "../../src/shared/simulator.js";

// 实测数据:iPhone-test 的 Simulator 窗口 456x972 @ (636,61),截图 1206x2622。
// 缩略图按 480 宽推给面板,于是坐标系是 480x1044
const SHOT = { width: 480, height: 1044 };
const RECT = { x: 640, y: 61, width: 447, height: 972 };

describe("模拟器坐标换算", () => {
  it("截图像素 → 屏幕点:左上角落在矩形原点,右下角落在对角", () => {
    expect(pixelToScreen({ x: 0, y: 0 }, SHOT, RECT)).toEqual({ x: 640, y: 61 });
    const br = pixelToScreen({ x: SHOT.width, y: SHOT.height }, SHOT, RECT);
    expect(br.x).toBeCloseTo(640 + 447, 6);
    expect(br.y).toBeCloseTo(61 + 972, 6);
  });

  it("两个方向互为逆运算 —— 元素框换算回去还是原来那个点", () => {
    const p = { x: 123, y: 456 };
    const back = screenToPixel(
      { ...pixelToScreen(p, SHOT, RECT), width: 0, height: 0 },
      SHOT,
      RECT
    );
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it("屏幕点 → 截图像素:宽高按同一比例缩,不是只挪原点", () => {
    const r = screenToPixel({ x: 640, y: 61, width: 447 / 2, height: 972 / 2 }, SHOT, RECT);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.width).toBeCloseTo(SHOT.width / 2, 6);
    expect(r.height).toBeCloseTo(SHOT.height / 2, 6);
  });

  it("元素一行给的是中心点 —— 模型下一步要拿它去 tap", () => {
    const line = formatElement({
      role: "AXButton",
      label: "登录",
      frame: { x: 100, y: 200, width: 60, height: 40 },
    });
    expect(line).toBe("[130,220] Button: 登录");
  });

  it("有值的元素把值也带上(输入框里已经有什么,模型要知道)", () => {
    const line = formatElement({
      role: "AXTextField",
      label: "邮箱",
      value: "a@b.com",
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(line).toContain('"a@b.com"');
  });
});
