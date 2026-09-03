// fitImage 的四种结局各走一遍(issue #882)。
// 编解码器是注入的,所以这一层完全测得动 —— 真 nativeImage 那半边的天花板
// (只解 png/jpeg)写在 src/main/imageCodec.ts 的文件头,由 undecodable 这条路承接。

import { describe, expect, it } from "vitest";
import {
  IMAGE_FIT_LADDER,
  asJpegName,
  fitImage,
  type FitEncoder,
} from "../../src/shared/imageFit.js";

const CAP = 1000;
const bytes = (n: number): Uint8Array => new Uint8Array(n);

describe("fitImage", () => {
  it("本来就够小 → unchanged,编解码器一次都不调(截图是 PNG,别白转一道 JPEG)", async () => {
    let calls = 0;
    const encode: FitEncoder = async () => {
      calls++;
      return bytes(1);
    };
    const src = bytes(CAP);
    const out = await fitImage(src, CAP, encode);
    expect(out).toEqual({ kind: "unchanged", data: src });
    expect(calls).toBe(0);
  });

  it("一级一级往下走,第一个过线的那级胜出", async () => {
    const seen: number[] = [];
    const encode: FitEncoder = async (_d, edge) => {
      seen.push(edge);
      return edge === 1280 ? bytes(CAP) : bytes(CAP + 1);
    };
    const out = await fitImage(bytes(9999), CAP, encode);
    expect(out.kind).toBe("shrunk");
    if (out.kind !== "shrunk") return;
    expect(out.from).toBe(9999);
    expect(out.data.byteLength).toBe(CAP);
    // 走到 1280 就停,1024 那级不该跑
    expect(seen).toEqual([2048, 1600, 1280]);
  });

  it("回 null = 格式解不了 → undecodable,后面几级不白跑", async () => {
    let calls = 0;
    const out = await fitImage(bytes(9999), CAP, async () => {
      calls++;
      return null;
    });
    expect(out).toEqual({ kind: "undecodable" });
    expect(calls).toBe(1);
  });

  it("阶梯走到底仍然超 → stillTooBig,报最小那一版的字节数", async () => {
    const encode: FitEncoder = async (_d, edge) => bytes(CAP + edge);
    const out = await fitImage(bytes(999999), CAP, encode);
    expect(out).toEqual({ kind: "stillTooBig", bytes: CAP + 1024 });
  });

  it("阶梯只降不升 —— 一级比一级小才谈得上「往下试」", () => {
    const edges = IMAGE_FIT_LADDER.map((s) => s.edge);
    const qualities = IMAGE_FIT_LADDER.map((s) => s.quality);
    expect(edges).toEqual([...edges].sort((a, b) => b - a));
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a));
  });
});

describe("asJpegName", () => {
  it("换掉扩展名,不碰路径里的点", () => {
    expect(asJpegName("cat.png")).toBe("cat.jpg");
    expect(asJpegName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(asJpegName("/a.b/c/照片")).toBe("/a.b/c/照片.jpg");
  });
});
