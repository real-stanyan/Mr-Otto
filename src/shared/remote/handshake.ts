// 每次连接一轮的握手:签名的临时公钥交换 + 双向密钥派生 + 指纹。
//
// 形状约等于 Noise 的 KK:静态 Ed25519 身份密钥只用来**签临时 X25519 公钥**,
// 会话密钥完全由临时密钥算出。于是拿到静态私钥也解不开旧密文(前向保密),
// 而临时公钥被换掉会因为签名对不上被拒(双向认证)。
//
// 信任的来源是**已 pin 住的** peerIdentityPub —— TOFU 在这里落地:
// 调用方负责首次 pin 与后续比对,本文件只负责"对不上就回 null"。
//
// 纯文件:不许 import node builtin / electron。

import { b64decode, b64encode } from "./b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";

export type Role = "desktop" | "mobile";

/** 线上的握手包(JSON 安全:字节一律 base64url) */
export interface HandshakeHello {
  role: Role;
  deviceId: string;
  ephPub: string;
  nonceHalf: string;
  sig: string;
}

export interface SelfParty {
  /** 长期状态:身份不变,可以跨连接复用 */
  role: Role;
  deviceId: string;
  identity: KeyPair;
  /**
   * 每连接一次性状态 —— 绝不可跨连接复用。
   * `deriveSession` 用它派生会话密钥,而 `createSealer` 每次都从 counter=0n 起算
   * (sealedStream.ts);同一把 `eph`/`nonceHalf` 用在第二次连接上,会算出同一把
   * key 和同一条 nonce 前缀,于是第 0 帧的 nonce 在两次连接里完全相同 ——
   * 同 key 同 nonce 加密不同明文,ChaCha20-Poly1305 的机密性和认证性一起崩掉
   * (keystream 可还原、Poly1305 一次性密钥可还原)。
   * 用 `newConnectionParty` 构造,不要手搭这个字段。
   */
  eph: KeyPair;
  /** 同上:每连接一次性,绝不可跨连接复用 */
  nonceHalf: Uint8Array;
}

export interface DirectionKeys {
  key: Uint8Array;
  prefix: Uint8Array;
}

export interface SessionKeys {
  send: DirectionKeys;
  recv: DirectionKeys;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * 构造一个"新连接"用的 SelfParty:每次连接都要调用一次,不要缓存/复用返回值。
 * 长期身份(identity)由调用方传入并可以跨连接复用;eph 和 nonceHalf 在这里
 * 现场生成,是让"每连接必须新鲜"这件事变成默认路径,而不是靠调用方自觉。
 */
export function newConnectionParty(
  p: RemoteCryptoPrimitives,
  args: { role: Role; deviceId: string; identity: KeyPair }
): SelfParty {
  return {
    role: args.role,
    deviceId: args.deviceId,
    identity: args.identity,
    eph: p.generateX25519(),
    nonceHalf: p.randomBytes(16),
  };
}

/** 被签的字节:角色 + 设备 id + 临时公钥 + 自己那半个 nonce。
    角色进签名,是为了让"把桌面的 hello 原样转发给另一台桌面"这种反射攻击签不过 */
function signedPayload(role: Role, deviceId: string, ephPub: Uint8Array, nonceHalf: Uint8Array): Uint8Array {
  const head = utf8(`otto-remote-hello-v1|${role}|${deviceId}|`);
  const out = new Uint8Array(head.length + ephPub.length + nonceHalf.length);
  out.set(head, 0);
  out.set(ephPub, head.length);
  out.set(nonceHalf, head.length + ephPub.length);
  return out;
}

export function buildHello(p: RemoteCryptoPrimitives, self: SelfParty): HandshakeHello {
  const payload = signedPayload(self.role, self.deviceId, self.eph.publicKey, self.nonceHalf);
  return {
    role: self.role,
    deviceId: self.deviceId,
    ephPub: b64encode(self.eph.publicKey),
    nonceHalf: b64encode(self.nonceHalf),
    sig: b64encode(p.ed25519Sign(self.identity.privateKey, payload)),
  };
}

/** 双方的 nonceHalf 拼成 KDF 的 salt。拼接顺序按角色钉死(desktop 在前),
    两边才能算出同一个 salt —— 不能按"我的在前" */
function connectionNonce(selfRole: Role, selfHalf: Uint8Array, peerHalf: Uint8Array): Uint8Array {
  const [first, second] = selfRole === "desktop" ? [selfHalf, peerHalf] : [peerHalf, selfHalf];
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

function directionKeys(
  p: RemoteCryptoPrimitives,
  shared: Uint8Array,
  salt: Uint8Array,
  info: string
): DirectionKeys {
  const out = p.hkdfSha256(shared, salt, utf8(info), 36);
  return { key: out.slice(0, 32), prefix: out.slice(32, 36) };
}

export function deriveSession(
  p: RemoteCryptoPrimitives,
  args: { self: SelfParty; peerHello: HandshakeHello; peerIdentityPub: Uint8Array }
): SessionKeys | null {
  const { self, peerHello, peerIdentityPub } = args;

  // 两台桌面 / 两台手机之间不该建连
  if (peerHello.role === self.role) return null;
  if (peerHello.role !== "desktop" && peerHello.role !== "mobile") return null;

  const ephPub = b64decode(peerHello.ephPub);
  const peerHalf = b64decode(peerHello.nonceHalf);
  const sig = b64decode(peerHello.sig);
  if (!ephPub || !peerHalf || !sig) return null;
  if (ephPub.length !== 32 || peerHalf.length !== 16 || sig.length !== 64) return null;

  // TOFU 的执行面:验的是**调用方 pin 住的**那把公钥,不是 hello 自称的身份
  const payload = signedPayload(peerHello.role, peerHello.deviceId, ephPub, peerHalf);
  if (!p.ed25519Verify(peerIdentityPub, payload, sig)) return null;

  // 低阶(如全零)对端公钥会让 node 的 diffieHellman 抛
  // ERR_OSSL_FAILED_DURING_DERIVATION 而不是回一个零共享秘密。
  // 这里的每一条其它拒绝路径都回 null,x25519 也不能例外——
  // 对端公钥是 pin 过身份的攻击者也能塞进来的字段,不能让它把整条连接炸掉。
  // 放在调用点(而不是塞进 nodeRemoteCrypto)是因为 RN 侧实现同一个接口时
  // 也要经过这同一道 deriveSession,防线不能只补一半。
  let shared: Uint8Array;
  try {
    shared = p.x25519(self.eph.privateKey, ephPub);
  } catch {
    return null;
  }

  const salt = connectionNonce(self.role, self.nonceHalf, peerHalf);
  const d2m = directionKeys(p, shared, salt, "otto-stream-v1:d2m");
  const m2d = directionKeys(p, shared, salt, "otto-stream-v1:m2d");
  return self.role === "desktop" ? { send: d2m, recv: m2d } : { send: m2d, recv: d2m };
}

/** 两端各自显示的 6 位安全码。排序后哈希 —— 两边看到同一个数,
    而"看到同一个数"正是它唯一要做的事 */
export function fingerprint(p: RemoteCryptoPrimitives, a: Uint8Array, b: Uint8Array): string {
  const [x, y] = b64encode(a) <= b64encode(b) ? [a, b] : [b, a];
  const buf = new Uint8Array(x.length + y.length);
  buf.set(x, 0);
  buf.set(y, x.length);
  const h = p.sha256(buf);
  const n = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % 1000000;
  return String(n).padStart(6, "0");
}
