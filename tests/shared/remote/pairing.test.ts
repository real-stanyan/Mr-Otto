import { describe, expect, it } from "vitest";
import { b64encode } from "../../../src/shared/remote/b64.js";
import { newConnectionParty } from "../../../src/shared/remote/handshake.js";
import {
  buildPairProof,
  createPairingOffer,
  createPairingOffers,
  decodePairingOffer,
  encodePairingOffer,
  PAIRING_TTL_MS,
  verifyPairProof,
} from "../../../src/shared/remote/pairing.js";
import { nodeRemoteCrypto } from "../../../src/main/remoteCryptoNode.js";

const P = nodeRemoteCrypto();

/** 一台桌面出码、一台手机扫码,把两边要用到的东西凑齐 */
function scene(now = 1000) {
  const desktopIdentity = P.generateEd25519();
  const mobileIdentity = P.generateEd25519();
  const offer = createPairingOffer(P, { deviceId: "d1", identityPub: desktopIdentity.publicKey, now });
  const scanned = decodePairingOffer(encodePairingOffer(offer))!;
  const m = newConnectionParty(P, { role: "mobile", deviceId: "m1", identity: mobileIdentity });
  const proof = buildPairProof(P, {
    role: "mobile",
    deviceId: "m1",
    identity: mobileIdentity,
    secret: scanned.secret,
    ephPub: m.eph.publicKey,
    nonceHalf: m.nonceHalf,
  });
  const verify = (over: Partial<Parameters<typeof verifyPairProof>[1]> = {}): boolean =>
    verifyPairProof(P, {
      proof,
      role: "mobile",
      deviceId: "m1",
      identityPub: mobileIdentity.publicKey,
      secret: offer.secret,
      ephPub: m.eph.publicKey,
      nonceHalf: m.nonceHalf,
      ...over,
    });
  return { desktopIdentity, mobileIdentity, offer, scanned, m, proof, verify };
}

describe("二维码的编解码", () => {
  it("原样往返:设备 id、桌面公钥、secret 三样都回得来", () => {
    const { offer, scanned } = scene();
    expect(scanned.deviceId).toBe("d1");
    expect(b64encode(scanned.identityPub)).toBe(b64encode(offer.identityPub));
    expect(b64encode(scanned.secret)).toBe(b64encode(offer.secret));
  });

  it("secret 每张码都不一样", () => {
    const a = createPairingOffer(P, { deviceId: "d1", identityPub: P.generateEd25519().publicKey, now: 0 });
    const b = createPairingOffer(P, { deviceId: "d1", identityPub: P.generateEd25519().publicKey, now: 0 });
    expect(b64encode(a.secret)).not.toBe(b64encode(b.secret));
  });

  it("扫到别的码 / 少一段 / 版本不认识 → null,不猜", () => {
    expect(decodePairingOffer("https://example.com")).toBeNull();
    expect(decodePairingOffer("otto-pair:1:d1:AAAA")).toBeNull();
    const { offer } = scene();
    expect(decodePairingOffer(encodePairingOffer(offer).replace("otto-pair:1", "otto-pair:2"))).toBeNull();
  });

  it("公钥/secret 长度不对 → null(二维码是外部输入,长度先验)", () => {
    const short = b64encode(new Uint8Array(16));
    const ok = b64encode(new Uint8Array(32));
    expect(decodePairingOffer(`otto-pair:1:d1:${short}:${ok}`)).toBeNull();
    expect(decodePairingOffer(`otto-pair:1:d1:${ok}:${short}`)).toBeNull();
    expect(decodePairingOffer(`otto-pair:1:d1:${ok}:${ok}`)).not.toBeNull();
  });
});

describe("持有证明", () => {
  it("扫过码的手机签得出,桌面验得过", () => {
    expect(scene().verify()).toBe(true);
  });

  it("没扫过码 → 签不出(换一把 secret 就验不过)", () => {
    const { verify } = scene();
    expect(verify({ secret: P.randomBytes(32) })).toBe(false);
  });

  it("换一把身份公钥验 → 不过(证明绑着签名的那把私钥)", () => {
    const { verify } = scene();
    expect(verify({ identityPub: P.generateEd25519().publicKey })).toBe(false);
  });

  it("换到另一条连接上用 → 不过(证明绑着这一轮的 eph 和 nonceHalf)", () => {
    const { verify, mobileIdentity } = scene();
    const other = newConnectionParty(P, { role: "mobile", deviceId: "m1", identity: mobileIdentity });
    expect(verify({ ephPub: other.eph.publicKey })).toBe(false);
    expect(verify({ nonceHalf: other.nonceHalf })).toBe(false);
  });

  it("改设备 id / 改角色 → 不过(角色进签名,挡反射)", () => {
    const { verify } = scene();
    expect(verify({ deviceId: "m2" })).toBe(false);
    expect(verify({ role: "desktop" })).toBe(false);
  });

  it("证明不是合法签名 → false,不抛", () => {
    const { verify } = scene();
    expect(verify({ proof: "" })).toBe(false);
    expect(verify({ proof: "@@@@" })).toBe(false);
    expect(verify({ proof: b64encode(new Uint8Array(64)) })).toBe(false);
  });

  it("secret 不出现在线上:二维码之外,证明本身只是一条签名", () => {
    const { offer, proof } = scene();
    expect(proof).not.toContain(b64encode(offer.secret));
  });
});

describe("一次性 + 短寿命", () => {
  const offers = (now: () => number) =>
    createPairingOffers(P, { deviceId: "d1", identityPub: P.generateEd25519().publicKey, now });

  it("没开过码 → 没有活着的邀请", () => {
    expect(offers(() => 0).live()).toBeNull();
  });

  it("配上之后那张码就废了(第二台手机拿同一张码连不上)", () => {
    const o = offers(() => 0);
    o.start();
    expect(o.live()).not.toBeNull();
    o.consume();
    expect(o.live()).toBeNull();
  });

  it("过了有效期 → null", () => {
    let t = 0;
    const o = offers(() => t);
    o.start();
    t = PAIRING_TTL_MS - 1;
    expect(o.live()).not.toBeNull();
    t = PAIRING_TTL_MS;
    expect(o.live()).toBeNull();
  });

  it("再开一张,旧的当场作废(屏幕上只有一张码)", () => {
    const o = offers(() => 0);
    const first = o.start();
    const second = o.start();
    expect(b64encode(second.secret)).not.toBe(b64encode(first.secret));
    expect(b64encode(o.live()!.secret)).toBe(b64encode(second.secret));
  });

  it("撤掉 → null", () => {
    const o = offers(() => 0);
    o.start();
    o.cancel();
    expect(o.live()).toBeNull();
  });
});
