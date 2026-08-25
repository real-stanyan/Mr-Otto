import { describe, expect, it } from "vitest";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";
import type { RemoteCryptoPrimitives } from "../../../src/shared/remote/crypto.js";

/** 测试替身：把 ChaCha 换成"异或 key[0] 再挂一个把 nonce 也算进去的 tag"。
    真算法的正确性由 libsodium/node 自己保证，这里要测的是**我们写的那部分**：
    计数器怎么走、重放怎么拒、nonce 有没有真的进到 AEAD 里。 */
const fake: Pick<RemoteCryptoPrimitives, "chachaSeal" | "chachaOpen"> = {
  chachaSeal(key, nonce, plaintext) {
    const ct = plaintext.map((b) => b ^ key[0]!);
    const tag = new Uint8Array(16);
    tag.set(nonce.slice(0, 12));
    tag[15] = key[0]!;
    return new Uint8Array([...ct, ...tag]);
  },
  chachaOpen(key, nonce, box) {
    if (box.length < 16) return null;
    const ct = box.slice(0, box.length - 16);
    const tag = box.slice(box.length - 16);
    const want = new Uint8Array(16);
    want.set(nonce.slice(0, 12));
    want[15] = key[0]!;
    if (!tag.every((b, i) => b === want[i])) return null; // nonce/key 不对 → 认证失败
    return ct.map((b) => b ^ key[0]!);
  },
};

const P = fake as RemoteCryptoPrimitives;
const KEY = new Uint8Array(32).fill(7);
const PREFIX = new Uint8Array([1, 2, 3, 4]);
const msg = (s: string) => new TextEncoder().encode(s);
const str = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null);

describe("sealedStream", () => {
  it("往返：封进去什么，拆出来还是什么", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    expect(str(o.open(s.seal(msg("hello"))))).toBe("hello");
    expect(str(o.open(s.seal(msg("world"))))).toBe("world");
  });

  it("计数器每封一次 +1，前 8 字节是大端计数器", () => {
    const s = createSealer(P, KEY, PREFIX);
    const a = s.seal(msg("x"));
    const b = s.seal(msg("x"));
    expect([...a.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...b.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    // 同一段明文，两次密文不同 —— nonce 真的变了
    expect([...a.slice(8)]).not.toEqual([...b.slice(8)]);
  });

  it("重放同一帧 → 拒（计数器必须严格递增）", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    const frame = s.seal(msg("once"));
    expect(str(o.open(frame))).toBe("once");
    expect(o.open(frame)).toBeNull(); // 第二次
  });

  it("乱序/迟到帧 → 拒", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, PREFIX);
    const f0 = s.seal(msg("a"));
    const f1 = s.seal(msg("b"));
    expect(str(o.open(f1))).toBe("b"); // 先收到 1
    expect(o.open(f0)).toBeNull();     // 0 迟到 → 丢
  });

  it("nonce 前缀不同 → 认证失败（前缀真的进了 AEAD）", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, KEY, new Uint8Array([9, 9, 9, 9]));
    expect(o.open(s.seal(msg("x")))).toBeNull();
  });

  it("密钥不同 → 认证失败", () => {
    const s = createSealer(P, KEY, PREFIX);
    const o = createOpener(P, new Uint8Array(32).fill(8), PREFIX);
    expect(o.open(s.seal(msg("x")))).toBeNull();
  });

  it("截断的帧 → null，不抛", () => {
    const o = createOpener(P, KEY, PREFIX);
    expect(o.open(new Uint8Array(3))).toBeNull();
  });
});
