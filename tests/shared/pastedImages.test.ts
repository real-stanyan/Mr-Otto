import { describe, expect, it } from "vitest";
import { pastedImagesOf } from "../../src/shared/pastedImages.js";

describe("pastedImagesOf：otto-paste 原生事件的验（#1645）", () => {
  it("收下 file:// 的图，按到达顺序", () => {
    expect(pastedImagesOf({ images: [
      { uri: "file:///tmp/otto-paste-a.png", width: 1206, height: 2622, bytes: 812345 },
      { uri: "file:///tmp/otto-paste-b.png", width: 10, height: 20, bytes: 99 },
    ] })).toEqual([
      { uri: "file:///tmp/otto-paste-a.png", width: 1206, height: 2622, bytes: 812345 },
      { uri: "file:///tmp/otto-paste-b.png", width: 10, height: 20, bytes: 99 },
    ]);
  });
  it("不是 file:// 的、字段缺的、数不对的整格丢掉；一张都不剩回 []", () => {
    expect(pastedImagesOf({ images: [
      { uri: "https://evil/x.png", width: 1, height: 1, bytes: 1 },
      { uri: "file:///tmp/a.png", width: "1", height: 1, bytes: 1 },
      { uri: "file:///tmp/b.png", width: -1, height: 1, bytes: 1 },
      { uri: "file:///tmp/c.png", width: 1, height: 1 },
    ] })).toEqual([]);
    expect(pastedImagesOf(null)).toEqual([]);
    expect(pastedImagesOf({ images: "x" })).toEqual([]);
  });
  it("一次最多交出九张（同相册多选的上限），多的不要", () => {
    const one = { uri: "file:///tmp/a.png", width: 1, height: 1, bytes: 1 };
    expect(pastedImagesOf({ images: Array.from({ length: 12 }, () => one) })).toHaveLength(9);
  });
});
