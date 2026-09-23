// 画好的几层 + 缓存 + 三档盒子 + 相位。缓存错了的样子是安静的：要么每拍都重算（手机上一墙脸
// 一起掉帧），要么该换的帧没换（脸僵住）——两个方向各钉一条。
import { describe, expect, it } from "vitest";
import { BADGE_COLORS, frameMotion, GRID_H, GRID_W, motionKey } from "../../../src/shared/ottoFace/index.js";
import {
  createFaceArtCache,
  faceArtKey,
  faceBox,
  facePhase,
} from "../../../src/shared/ottoFace/art.js";

describe("createFaceArtCache", () => {
  it("同一个 (坑位, 状态, motion) 回同一个对象", () => {
    const art = createFaceArtCache();
    expect(art(3, "idle", 0)).toBe(art(3, "idle", 0));
  });

  it("t 不同但 motion 相同：仍是同一个对象；motion 变了：换一个", () => {
    const art = createFaceArtCache();
    let prevKey = "";
    let prev = art(0, "alive", 0);
    for (let t = 0; t < 8000; t += 40) {
      const k = motionKey(frameMotion("alive", t));
      const now = art(0, "alive", t);
      if (k === prevKey) expect(now).toBe(prev);
      else if (prevKey !== "") expect(now).not.toBe(prev);
      prevKey = k;
      prev = now;
    }
  });

  it("key 就是 faceArtKey", () => {
    const art = createFaceArtCache();
    expect(art(7, "working", 999).key).toBe(faceArtKey(7, "working", 999));
  });

  it("超过上限按最久没用的先扔", () => {
    const art = createFaceArtCache(2);
    const a = art(0, "plain", 0);
    art(1, "plain", 0);
    art(2, "plain", 0);
    expect(art(0, "plain", 0)).not.toBe(a);
  });

  it("每一层都有 d 串、真实的脸都有描边；角标跟着状态表走", () => {
    const art = createFaceArtCache();
    const a = art(4, "working", 0);
    expect(a.layers.length).toBeGreaterThan(0);
    for (const l of a.layers) expect(l.d.length, l.tone).toBeGreaterThan(0);
    expect(a.rim.length).toBeGreaterThan(0);
    expect(a.badge).toBe(BADGE_COLORS.work);
    expect(art(4, "alive", 0).badge).toBeNull();
    expect(art(4, "offline", 0).dim).toBe(true);
  });
});

describe("faceBox", () => {
  it("盒子就是网格乘档位：s / m / l = 0.5 / 1 / 2", () => {
    expect(faceBox("m")).toEqual({ w: GRID_W, h: GRID_H });
    expect(faceBox("s")).toEqual({ w: GRID_W / 2, h: GRID_H / 2 });
    expect(faceBox("l")).toEqual({ w: GRID_W * 2, h: GRID_H * 2 });
  });
});

describe("facePhase", () => {
  it("同一个 id 永远同一个相位，落在 [0, 12000)", () => {
    for (const id of ["admin", "a_000000000001", "a_0123456789ab"]) {
      const p = facePhase(id);
      expect(p).toBe(facePhase(id));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(12000);
    }
  });

  it("不同的 id 错开（否则一墙脸同时眨眼）", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `a_${String(i).padStart(12, "0")}`);
    expect(new Set(ids.map(facePhase)).size).toBeGreaterThan(1);
  });
});
