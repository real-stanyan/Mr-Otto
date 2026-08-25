import { describe, expect, it } from "vitest";

import { detectImageType } from "../../src/shared/images.js";

const of = (...head: number[]): Uint8Array => new Uint8Array([...head, ...new Array(16).fill(0)]);

describe("detectImageType", () => {
  it("按字节签名认四种", () => {
    expect(detectImageType(of(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(detectImageType(of(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(detectImageType(of(0x47, 0x49, 0x46, 0x38))).toBe("image/gif");
    expect(detectImageType(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]))).toBe("image/webp");
  });

  it("扩展名不算数 —— 只看字节", () => {
    expect(detectImageType(new TextEncoder().encode("PNG but not really"))).toBeNull();
  });

  it("**HEIC 不认**:iPhone 默认就拍这个,手机端必须在发之前转成 JPEG", () => {
    // ftypheic 盒:HEIC 的实际头部
    const heic = new Uint8Array([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detectImageType(heic)).toBeNull();
  });

  it("太短的输入不越界", () => {
    expect(detectImageType(new Uint8Array(0))).toBeNull();
    expect(detectImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});
