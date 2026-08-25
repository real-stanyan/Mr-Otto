import { describe, expect, it } from "vitest";
import { b64encode } from "../../../src/shared/remote/b64.js";
import { buildHello, deriveSession, fingerprint } from "../../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

function party(role: "desktop" | "mobile", deviceId: string) {
  const identity = P.generateEd25519();
  const eph = P.generateX25519();
  const nonceHalf = P.randomBytes(16);
  return { role, deviceId, identity, eph, nonceHalf } as const;
}

function connect(a: ReturnType<typeof party>, b: ReturnType<typeof party>) {
  const helloA = buildHello(P, a);
  const helloB = buildHello(P, b);
  const sa = deriveSession(P, { self: a, peerHello: helloB, peerIdentityPub: b.identity.publicKey });
  const sb = deriveSession(P, { self: b, peerHello: helloA, peerIdentityPub: a.identity.publicKey });
  return { helloA, helloB, sa, sb };
}

describe("握手", () => {
  it("双方派生出对得上的两条单向密钥", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const { sa, sb } = connect(d, m);
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    // 桌面的发 = 手机的收
    expect([...sa!.send.key]).toEqual([...sb!.recv.key]);
    expect([...sa!.send.prefix]).toEqual([...sb!.recv.prefix]);
    // 反向同理，且两条方向的密钥必须不同
    expect([...sa!.recv.key]).toEqual([...sb!.send.key]);
    expect([...sa!.send.key]).not.toEqual([...sa!.recv.key]);
  });

  it("端到端：桌面封，手机拆", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const { sa, sb } = connect(d, m);
    const sealer = createSealer(P, sa!.send.key, sa!.send.prefix);
    const opener = createOpener(P, sb!.recv.key, sb!.recv.prefix);
    const plain = new TextEncoder().encode('{"type":"ping","ts":1}');
    expect([...opener.open(sealer.seal(plain))!]).toEqual([...plain]);
  });

  it("签名被篡改 → 拒", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const helloD = buildHello(P, d);
    const tampered = { ...helloD, sig: helloD.sig.slice(0, -2) + (helloD.sig.endsWith("A") ? "B" : "A") };
    expect(deriveSession(P, { self: m, peerHello: tampered, peerIdentityPub: d.identity.publicKey })).toBeNull();
  });

  it("pin 住的公钥对不上 → 拒（TOFU 的执行面）", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const impostor = party("desktop", "d1"); // 同一个 deviceId，不同身份密钥
    const helloImpostor = buildHello(P, impostor);
    expect(
      deriveSession(P, { self: m, peerHello: helloImpostor, peerIdentityPub: d.identity.publicKey })
    ).toBeNull();
  });

  it("临时公钥被换掉（签名仍是原主的）→ 拒", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    const helloD = buildHello(P, d);
    const evil = P.generateX25519();
    const swapped = { ...helloD, ephPub: b64encode(evil.publicKey) };
    expect(deriveSession(P, { self: m, peerHello: swapped, peerIdentityPub: d.identity.publicKey })).toBeNull();
  });

  it("角色相同 → 拒（两台桌面之间不该建连）", () => {
    const d1 = party("desktop", "d1");
    const d2 = party("desktop", "d2");
    const hello2 = buildHello(P, d2);
    expect(deriveSession(P, { self: d1, peerHello: hello2, peerIdentityPub: d2.identity.publicKey })).toBeNull();
  });

  it("重放上一次连接的 hello → 派生出的密钥不同（nonce 参与了 KDF）", () => {
    const d = party("desktop", "d1");
    const m1 = party("mobile", "m1");
    const m2 = { ...m1, nonceHalf: P.randomBytes(16) }; // 同一台手机，新一次连接
    const helloD = buildHello(P, d);
    const s1 = deriveSession(P, { self: m1, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    const s2 = deriveSession(P, { self: m2, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    expect([...s1!.recv.key]).not.toEqual([...s2!.recv.key]);
  });
});

describe("指纹", () => {
  it("6 位数字，与两把公钥的顺序无关", () => {
    const a = P.generateEd25519().publicKey;
    const b = P.generateEd25519().publicKey;
    const f = fingerprint(P, a, b);
    expect(f).toMatch(/^\d{6}$/);
    expect(fingerprint(P, b, a)).toBe(f);
  });
  it("换一把公钥就换一个指纹", () => {
    const a = P.generateEd25519().publicKey;
    const b = P.generateEd25519().publicKey;
    const c = P.generateEd25519().publicKey;
    expect(fingerprint(P, a, c)).not.toBe(fingerprint(P, a, b));
  });
});
