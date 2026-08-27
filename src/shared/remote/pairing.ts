// 扫码配对:桌面出一次性二维码,手机扫一下就完成**双向**信任建立(issue #583)。
//
// 为什么要有它。原来的配对是两端各显示一个 6 位安全码、人眼比对、**两边各按一次**
// (ADR-0095 的 TOFU)。两次点头不是啰嗦,是那套机制的必然:两边各自算出一个数、
// 由人搬运,这个动作天然对称。而 ADR-0095 的后果表里那行 ❌ ——「服务器在手机首次
// pin 之前下发假公钥 → 中间人成立」—— 也是同一个缺口的另一面:信任的源头是
// Supabase 那张 `devices` 表,而它不是信任来源。
//
// 二维码是一条**带外通道**,一下子办成两件事:
//   1. 手机**直接读到**桌面的身份公钥 —— 不经过目录,中间人换不掉
//   2. 二维码里那把一次性 secret,手机在握手里证明它持有 → 桌面据此认得这台手机
// 于是人只需要动一次(扫),而两个方向都被认证了。
//
// **目录仍然不是信任来源。** 桌面这一侧验的是「谁能对 secret 签出名」,
// 手机自称的身份公钥进的是**签名验证的输入**,不是"查表查出来的可信值":
// 拿到库的人插一行假公钥,签不出这个证明,照样连不上。
//
// 纯文件:不许 import node builtin / electron。手机端 import 的就是这一份。

import { b64decode, b64encode } from "./b64.js";
import type { KeyPair, RemoteCryptoPrimitives } from "./crypto.js";
import type { Role } from "./handshake.js";

/** 原始公钥/secret 都是 32 字节。扫回来的东西一律先验长度再用 —— 二维码是外部输入 */
const RAW_BYTES = 32;

/** 二维码活多久。短到"贴在屏幕上被拍走"这件事没什么用,长到够人拿起手机 */
export const PAIRING_TTL_MS = 3 * 60_000;

const PREFIX = "otto-pair";
const VERSION = "1";

/** 桌面这一侧的一次性配对邀请。**只在内存里** —— 落盘等于把一次性变成长期 */
export interface PairingOffer {
  deviceId: string;
  identityPub: Uint8Array;
  secret: Uint8Array;
  expiresAt: number;
}

/** 手机扫回来的那三样。没有 expiresAt:过期与否由桌面说了算,手机说了不算 */
export interface ScannedOffer {
  deviceId: string;
  identityPub: Uint8Array;
  secret: Uint8Array;
}

export function createPairingOffer(
  p: RemoteCryptoPrimitives,
  args: { deviceId: string; identityPub: Uint8Array; now: number; ttlMs?: number }
): PairingOffer {
  return {
    deviceId: args.deviceId,
    identityPub: args.identityPub,
    secret: p.randomBytes(RAW_BYTES),
    expiresAt: args.now + (args.ttlMs ?? PAIRING_TTL_MS),
  };
}

/** 二维码里那串字。定长字段用 base64url,分隔符是冒号 —— deviceId 是 uuid,不含冒号 */
export function encodePairingOffer(o: PairingOffer): string {
  return [PREFIX, VERSION, o.deviceId, b64encode(o.identityPub), b64encode(o.secret)].join(":");
}

/**
 * 解二维码。**认不出就回 null,不猜** —— 扫到的可能是任何一张别的码。
 * 长度不对的公钥/secret 在这里就被挡掉,不留到后面变成一个"32 字节以外的密钥"。
 */
export function decodePairingOffer(text: string): ScannedOffer | null {
  const parts = text.trim().split(":");
  if (parts.length !== 5) return null;
  const [prefix, version, deviceId, pubB64, secretB64] = parts as [string, string, string, string, string];
  if (prefix !== PREFIX || version !== VERSION || !deviceId) return null;
  const identityPub = b64decode(pubB64);
  const secret = b64decode(secretB64);
  if (!identityPub || identityPub.length !== RAW_BYTES) return null;
  if (!secret || secret.length !== RAW_BYTES) return null;
  return { deviceId, identityPub, secret };
}

/**
 * 被签的字节:角色 + 设备 id + secret + 这一轮的临时公钥 + 自己那半个 nonce。
 *
 * - **secret 进签名**:没扫过码的人签不出来 —— 这是"手机是我的"的全部依据
 * - **eph/nonceHalf 进签名**:证明绑在这一次连接上,截走的证明换到另一条连接上用不了
 * - **角色进签名**:同 ADR-0095 第 3 条,挡反射
 *
 * secret 本身不出现在线上(只出现在签名的输入里),所以中继看不到它。
 */
function proofPayload(
  role: Role,
  deviceId: string,
  secret: Uint8Array,
  ephPub: Uint8Array,
  nonceHalf: Uint8Array
): Uint8Array {
  const head = new TextEncoder().encode(`otto-pair-proof-v1|${role}|${deviceId}|`);
  const out = new Uint8Array(head.length + secret.length + ephPub.length + nonceHalf.length);
  let at = 0;
  for (const seg of [head, secret, ephPub, nonceHalf]) {
    out.set(seg, at);
    at += seg.length;
  }
  return out;
}

/** 手机侧:握手包里那条 `pair` 字段 */
export function buildPairProof(
  p: RemoteCryptoPrimitives,
  args: { role: Role; deviceId: string; identity: KeyPair; secret: Uint8Array; ephPub: Uint8Array; nonceHalf: Uint8Array }
): string {
  const payload = proofPayload(args.role, args.deviceId, args.secret, args.ephPub, args.nonceHalf);
  return b64encode(p.ed25519Sign(args.identity.privateKey, payload));
}

/**
 * 桌面侧:这条 hello 是不是"刚扫过我这张码"的那台手机发的。
 * 验不过一律 false —— 和 deriveSession 一样,失败是常态分支,不抛。
 */
export function verifyPairProof(
  p: RemoteCryptoPrimitives,
  args: {
    proof: string;
    role: Role;
    deviceId: string;
    identityPub: Uint8Array;
    secret: Uint8Array;
    ephPub: Uint8Array;
    nonceHalf: Uint8Array;
  }
): boolean {
  const sig = b64decode(args.proof);
  if (!sig || sig.length !== 64) return false;
  if (args.identityPub.length !== RAW_BYTES) return false;
  const payload = proofPayload(args.role, args.deviceId, args.secret, args.ephPub, args.nonceHalf);
  return p.ed25519Verify(args.identityPub, payload, sig);
}

/**
 * 桌面手里那一张码的生命周期:**一次性 + 短寿命**。
 *
 * 两条性质都在 `live()` 里:过期了回 null、用掉了回 null。
 * 时钟注入而不是读 `Date.now()` —— 过期这条性质要能在单测里跑,
 * 而"等三分钟"不是测试(同 ADR-0104 的理由:能推的就不读时钟)。
 */
export function createPairingOffers(
  p: RemoteCryptoPrimitives,
  deps: { deviceId: string; identityPub: Uint8Array; now: () => number; ttlMs?: number }
): {
  /** 开一张新的。**旧的当场作废** —— 屏幕上只可能有一张码,内存里也就该只有一张 */
  start(): PairingOffer;
  cancel(): void;
  /** 还能用的那张,没有就 null */
  live(): PairingOffer | null;
  /** 配上了。用掉即废,第二台手机拿同一张码连不上 */
  consume(): void;
} {
  let current: PairingOffer | null = null;
  return {
    start() {
      current = createPairingOffer(p, {
        deviceId: deps.deviceId,
        identityPub: deps.identityPub,
        now: deps.now(),
        ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
      });
      return current;
    },
    cancel() {
      current = null;
    },
    live() {
      if (!current) return null;
      if (deps.now() >= current.expiresAt) {
        current = null; // 过期的就地清掉,免得它在内存里躺到下一次 start
        return null;
      }
      return current;
    },
    consume() {
      current = null;
    },
  };
}
