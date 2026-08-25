import { describe, expect, it } from "vitest";
import { b64decode, b64encode } from "../../../src/shared/remote/b64.js";
import { buildHello, deriveSession, fingerprint, newConnectionParty } from "../../../src/shared/remote/handshake.js";
import { createOpener, createSealer } from "../../../src/shared/remote/sealedStream.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

function party(role: "desktop" | "mobile", deviceId: string) {
  const identity = P.generateEd25519();
  return newConnectionParty(P, { role, deviceId, identity });
}

function connect(a: ReturnType<typeof party>, b: ReturnType<typeof party>) {
  const helloA = buildHello(P, a);
  const helloB = buildHello(P, b);
  const sa = deriveSession(P, { self: a, peerHello: helloB, peerIdentityPub: b.identity.publicKey });
  const sb = deriveSession(P, { self: b, peerHello: helloA, peerIdentityPub: a.identity.publicKey });
  return { helloA, helloB, sa, sb };
}

describe("newConnectionParty", () => {
  it("同一个 identity 连续调用两次 → eph 和 nonceHalf 都不同(每连接必须新鲜)", () => {
    const identity = P.generateEd25519();
    const a = newConnectionParty(P, { role: "desktop", deviceId: "d1", identity });
    const b = newConnectionParty(P, { role: "desktop", deviceId: "d1", identity });
    expect([...a.eph.publicKey]).not.toEqual([...b.eph.publicKey]);
    expect([...a.nonceHalf]).not.toEqual([...b.nonceHalf]);
  });
});

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
    // 翻转签名里的一个 bit,而不是切字符串:切字符串会把 base64url 长度变成
    // 4n+1,在 b64decode 的长度守卫那一步就被拒了,ed25519Verify 根本没被跑到
    // (删掉验签那一行这条用例照样绿) —— 这里要的是真的走到验签失败那条分支。
    const sigBytes = b64decode(helloD.sig)!;
    const tamperedSig = new Uint8Array(sigBytes);
    tamperedSig[0] = (tamperedSig[0] as number) ^ 1;
    const tampered = { ...helloD, sig: b64encode(tamperedSig) };
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

  // 标题曾是「重放上一次连接的 hello → 拒」，但断言的是"派生出的密钥不同"——
  // 那是弱得多的一句话，而且 deriveSession 这一层**根本不做**重放拒绝
  // （它是纯函数，看不见"上一次"）。spec 必测负例三「重放旧 connectionNonce → 拒」
  // 落在桥那一层的 phase 门上，见 tests/main/remoteBridge.test.ts
  // 「重放上一次的 hello → 拒」。这条留下来守它自己那句真话。
  it("换一次连接就换一套密钥（自己的 nonceHalf 进了 KDF 的 salt）", () => {
    const d = party("desktop", "d1");
    const m1 = party("mobile", "m1");
    // 同一台手机、同一个身份，新一次连接 —— 走 newConnectionParty 拿到全新的 eph/nonceHalf
    const m2 = newConnectionParty(P, { role: "mobile", deviceId: "m1", identity: m1.identity });
    const helloD = buildHello(P, d);
    const s1 = deriveSession(P, { self: m1, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    const s2 = deriveSession(P, { self: m2, peerHello: helloD, peerIdentityPub: d.identity.publicKey });
    expect([...s1!.recv.key]).not.toEqual([...s2!.recv.key]);
  });

  it("对端临时公钥是全零(低阶点) → deriveSession 回 null 而不是抛", () => {
    const d = party("desktop", "d1");
    const m = party("mobile", "m1");
    // 全零公钥让 node 的 diffieHellman 抛 ERR_OSSL_FAILED_DURING_DERIVATION,
    // 而不是回一个零共享秘密。把 hello 里的 ephPub 换成全零、但签名照常用
    // d 的真实身份签(payload 里签的就是这个全零公钥),这样才能测到
    // "验签通过之后、x25519 那一步"这条真正会抛的路径。
    const lowOrderEph = { privateKey: d.eph.privateKey, publicKey: new Uint8Array(32) };
    const helloLowOrder = buildHello(P, { ...d, eph: lowOrderEph });
    expect(() =>
      deriveSession(P, { self: m, peerHello: helloLowOrder, peerIdentityPub: d.identity.publicKey })
    ).not.toThrow();
    expect(
      deriveSession(P, { self: m, peerHello: helloLowOrder, peerIdentityPub: d.identity.publicKey })
    ).toBeNull();
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
