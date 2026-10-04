// keyboardInsetOf —— 聊天页键盘让位的算术（#1490）。真机偶发：输入栏贴到标题栏下、底下整块空白，
// 反推是让位算成了整个内容区；这里钉住「让位不可能比键盘高」与几种报错值的收口。
import { describe, expect, it } from "vitest";
import { keyboardInsetOf } from "../../src/shared/keyboardInset.js";

describe("keyboardInsetOf", () => {
  it("正常：底边减键盘顶边", () => {
    expect(keyboardInsetOf(932, { screenY: 580, height: 352 })).toBe(352);
  });
  it("这一屏底边在键盘顶边上面（比如底下还有一条栏）：只让露出来的那一截", () => {
    expect(keyboardInsetOf(900, { screenY: 580, height: 352 })).toBe(320);
  });
  it("收起：screenY 到了屏幕高度，差值归零", () => {
    expect(keyboardInsetOf(932, { screenY: 932, height: 352 })).toBe(0);
    expect(keyboardInsetOf(932, { screenY: 1000, height: 352 })).toBe(0);
  });
  it("screenY 偶发报 0（iOS 的坑）：夹到键盘自己的高度，不是整屏", () => {
    expect(keyboardInsetOf(932, { screenY: 0, height: 352 })).toBe(352);
  });
  it("还没量到底边 / 键盘高度是 0 或不是数：不让", () => {
    expect(keyboardInsetOf(null, { screenY: 580, height: 352 })).toBe(0);
    expect(keyboardInsetOf(932, { screenY: 580, height: 0 })).toBe(0);
    expect(keyboardInsetOf(932, { screenY: Number.NaN, height: 352 })).toBe(0);
    expect(keyboardInsetOf(932, { screenY: 580, height: Number.NaN })).toBe(0);
  });
});
