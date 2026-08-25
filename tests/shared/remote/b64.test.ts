import { describe, expect, it } from "vitest";
import { b64decode, b64encode } from "../../../src/shared/remote/b64.js";

describe("base64url", () => {
  it("往返任意字节", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 64, 255]) {
      const u = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256);
      expect([...b64decode(b64encode(u))!]).toEqual([...u]);
    }
  });
  it("用 url 安全字母表，不带填充", () => {
    const u = new Uint8Array([251, 255, 190]);
    const e = b64encode(u);
    expect(e).not.toMatch(/[+/=]/);
  });
  it("与 Node 的 base64url 逐字节一致（跨实现互通的凭证）", () => {
    const u = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
    expect(b64encode(u)).toBe(Buffer.from(u).toString("base64url"));
    expect([...b64decode(Buffer.from(u).toString("base64url"))!]).toEqual([...u]);
  });
  it("非法字符 → null，不抛", () => {
    expect(b64decode("abc!def")).toBeNull();
    expect(b64decode("a+b/c=")).toBeNull(); // 标准 base64 的字母表不收
  });
  it("长度非法（余数为 1）→ null", () => {
    expect(b64decode("A")).toBeNull();
  });
});
