import { describe, expect, it } from "vitest";
import { nobleRemoteCrypto } from "../../../src/shared/remote/nobleCrypto.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";
import { buildHello, deriveSession, fingerprint, newConnectionParty } from "../../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";

// **这个文件测的是互通,不是自洽。**
//
// 桌面用 node:crypto、手机用 @noble/*。两个实现各自"能跑"没有任何意义 ——
// 只要有一个原语的字节不一样,两端就算不出同一把会话密钥,整条链路是坏的,
// 而且坏法是"连上了、解不开",最难查的那一种。
//
// 所以每条用例都是交叉的:一边产出、另一边消费。

const N = nodeRemoteCrypto();
const B = nobleRemoteCrypto();
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("noble ⇄ node 逐项互通", () => {
  it("X25519：两边算出同一个共享秘密（会话密钥的根）", () => {
    const a = N.generateX25519();
    const b = B.generateX25519();
    expect(hex(N.x25519(a.privateKey, b.publicKey))).toBe(hex(B.x25519(b.privateKey, a.publicKey)));
  });

  it("Ed25519：noble 签的 node 验得过，node 签的 noble 也验得过", () => {
    const msg = utf8("otto-remote-hello-v1|mobile|m1|");
    const kp = B.generateEd25519();
    expect(N.ed25519Verify(kp.publicKey, msg, B.ed25519Sign(kp.privateKey, msg))).toBe(true);

    const kp2 = N.generateEd25519();
    expect(B.ed25519Verify(kp2.publicKey, msg, N.ed25519Sign(kp2.privateKey, msg))).toBe(true);
  });

  it("签名被改一位：两边都回 false，不是一边 false 一边抛", () => {
    const msg = utf8("m");
    const kp = N.generateEd25519();
    const sig = N.ed25519Sign(kp.privateKey, msg);
    sig[0]! ^= 1;
    expect(N.ed25519Verify(kp.publicKey, msg, sig)).toBe(false);
    expect(B.ed25519Verify(kp.publicKey, msg, sig)).toBe(false);
    // 长度不对也一样:handshake 已经挡了一层,但两个实现在这儿必须同型
    expect(B.ed25519Verify(kp.publicKey, msg, sig.slice(0, 10))).toBe(false);
  });

  it("HKDF-SHA256 与 SHA-256：逐字节相同", () => {
    const ikm = N.randomBytes(32), salt = N.randomBytes(32), info = utf8("otto-stream-v1:d2m");
    expect(hex(B.hkdfSha256(ikm, salt, info, 36))).toBe(hex(N.hkdfSha256(ikm, salt, info, 36)));
    expect(hex(B.sha256(ikm))).toBe(hex(N.sha256(ikm)));
  });

  it("ChaCha20-Poly1305-IETF：一边封、另一边开（12 字节 nonce）", () => {
    const key = N.randomBytes(32), nonce = N.randomBytes(12);
    const plain = utf8("会话标题 + pendingApproval 的全路径");
    expect(new TextDecoder().decode(N.chachaOpen(key, nonce, B.chachaSeal(key, nonce, plain))!)).toBe(
      new TextDecoder().decode(plain)
    );
    expect(hex(B.chachaSeal(key, nonce, plain))).toBe(hex(N.chachaSeal(key, nonce, plain)));
  });

  it("被篡改的密文：两边都回 null，不抛", () => {
    const key = N.randomBytes(32), nonce = N.randomBytes(12);
    const box = N.chachaSeal(key, nonce, utf8("x"));
    box[0]! ^= 1;
    expect(N.chachaOpen(key, nonce, box)).toBeNull();
    expect(B.chachaOpen(key, nonce, box)).toBeNull();
  });

  // 逐个原语对得上还不够:真正要成立的是"整轮握手 + 一帧密文"能跨实现走通。
  // 这一条把 handshake.ts 与 sealedStream.ts 都拉进来,一端全用 node、一端全用 noble。
  it("整轮握手跨实现走通：桌面(node) ⇄ 手机(noble)，帧解得开，安全码一致", () => {
    const desktopIdentity = N.generateEd25519();
    const phoneIdentity = B.generateEd25519();
    const desktop = newConnectionParty(N, { role: "desktop", deviceId: "d1", identity: desktopIdentity });
    const phone = newConnectionParty(B, { role: "mobile", deviceId: "m1", identity: phoneIdentity });

    const dKeys = deriveSession(N, {
      self: desktop, peerHello: buildHello(B, phone), peerIdentityPub: phoneIdentity.publicKey,
    })!;
    const pKeys = deriveSession(B, {
      self: phone, peerHello: buildHello(N, desktop), peerIdentityPub: desktopIdentity.publicKey,
    })!;
    expect(dKeys).not.toBeNull();
    expect(pKeys).not.toBeNull();

    // 桌面封的那一帧,手机开得开
    const sealer = createSealer(N, dKeys.send.key, dKeys.send.prefix);
    const opener = createOpener(B, pKeys.recv.key, pKeys.recv.prefix);
    const wire = utf8('{"type":"fleet"}');
    expect(new TextDecoder().decode(opener.open(sealer.seal(wire))!)).toBe('{"type":"fleet"}');

    // 反方向也要通(上行命令走这条)
    const up = createSealer(B, pKeys.send.key, pKeys.send.prefix);
    const down = createOpener(N, dKeys.recv.key, dKeys.recv.prefix);
    expect(new TextDecoder().decode(down.open(up.seal(utf8("approve")))!)).toBe("approve");

    // 人要核对的那个 6 位数,两端各自算出来必须一样
    expect(fingerprint(B, phoneIdentity.publicKey, desktopIdentity.publicKey))
      .toBe(fingerprint(N, desktopIdentity.publicKey, phoneIdentity.publicKey));
  });
});
