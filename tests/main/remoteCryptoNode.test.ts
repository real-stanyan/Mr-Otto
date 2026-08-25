import { describe, expect, it } from "vitest";
import { nodeRemoteCrypto } from "../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

describe("nodeRemoteCrypto", () => {
  it("x25519 双方算出同一个共享秘密", () => {
    const a = P.generateX25519();
    const b = P.generateX25519();
    expect([...P.x25519(a.privateKey, b.publicKey)]).toEqual([...P.x25519(b.privateKey, a.publicKey)]);
    expect(P.x25519(a.privateKey, b.publicKey).length).toBe(32);
  });

  it("ed25519 签名可验，改一个字节就验不过", () => {
    const k = P.generateEd25519();
    const msg = new TextEncoder().encode("hello");
    const sig = P.ed25519Sign(k.privateKey, msg);
    expect(sig.length).toBe(64);
    expect(P.ed25519Verify(k.publicKey, msg, sig)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[0] = (bad[0] as number) ^ 1;
    expect(P.ed25519Verify(k.publicKey, msg, bad)).toBe(false);
  });

  it("ed25519Verify 遇到畸形公钥回 false 而不是抛", () => {
    const k = P.generateEd25519();
    const msg = new TextEncoder().encode("hello");
    const sig = P.ed25519Sign(k.privateKey, msg);
    expect(P.ed25519Verify(new Uint8Array(5), msg, sig)).toBe(false);
  });

  it("chacha 往返；nonce 改一位就认证失败（回 null 不抛）", () => {
    const key = P.randomBytes(32);
    const nonce = P.randomBytes(12);
    const plain = new TextEncoder().encode("secret payload");
    const box = P.chachaSeal(key, nonce, plain);
    expect([...P.chachaOpen(key, nonce, box)!]).toEqual([...plain]);
    const other = new Uint8Array(nonce);
    other[0] = (other[0] as number) ^ 1;
    expect(P.chachaOpen(key, other, box)).toBeNull();
  });

  it("hkdf 长度可控且随 info 变化", () => {
    const ikm = P.randomBytes(32);
    const salt = P.randomBytes(16);
    const enc = new TextEncoder();
    const a = P.hkdfSha256(ikm, salt, enc.encode("a"), 36);
    const b = P.hkdfSha256(ikm, salt, enc.encode("b"), 36);
    expect(a.length).toBe(36);
    expect([...a]).not.toEqual([...b]);
  });

  it("randomBytes 长度对且不重复", () => {
    expect(P.randomBytes(12).length).toBe(12);
    expect([...P.randomBytes(16)]).not.toEqual([...P.randomBytes(16)]);
  });
});
