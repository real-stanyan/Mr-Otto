// proxyInvite —— 好友代理的「频道 + 邀请码」纯逻辑（issue #622 PR-C1，ADR-0151）。
//
// 好友代理要 B 能连上 A 的 relay 房间。relay 是盲管道、不管好友关系（ADR-0151：
// 鉴权放握手层），所以「B 有权代理 A」不靠 relay 判断，靠**邀请码**：
//
//   A 生成一个一次性邀请码，带：
//     - channelId   B 要连的 relay 房间
//     - secret      一次性秘密——B 在握手时证明「我持有它」，A 据此认得这条连接
//     - A 的身份公钥  B 握到一半就能确认「我对面的确是 A」
//     - A 的 userId  B 据此给这条通道贴标签（代理来的服务按好友加前缀）
//                    并记下 (userId ↔ 身份公钥) 的绑定（issue #670）
//
// 信任来源是**邀请码本身**（它走了带外渠道：DM/当面）。relay 从头到尾不知道
// 什么叫好友、什么叫代理——它只看到「一个频道 id + 两条连接」，转发而已。
// 「这个频道是给好友代理用的」这个语义，只活在 A 和 B 两端，不进 relay。
//
// 纯逻辑零 IO：不连 relay、不碰存储。随机性/编解码靠注入的 RemoteCryptoPrimitives。

import { b64decode, b64encode } from "./b64.js";
import type { RemoteCryptoPrimitives } from "./crypto.js";
import { PROXY_FRAME_VERSION } from "./proxyProtocol.js";

/** 一次性 secret 与身份公钥都是 32 字节。邀请码是带外输入，先验长度再用 */
const RAW_BYTES = 32;
/** 邀请码有效期：默认 10 分钟。过期没用完就作废，A 得重发——限制 secret 暴露窗口 */
export const PROXY_INVITE_TTL_MS = 10 * 60_000;

const PREFIX = "otto-proxy";

/** A 生成的一份邀请（发出前的完整形态，含 secret） */
export interface ProxyInvite {
  /** 协议版本号（= PROXY_FRAME_VERSION） */
  v: number;
  /**
   * A 的 Supabase userId（issue #670）。B 拿它做两件事：
   *   1. 给这条通道贴标签——代理来的服务要按好友加前缀，前缀就是从它算的；
   *   2. 记下 (userId ↔ hostIdentityPub) 的绑定，这是 ADR-0151 §2 说的
   *      「配对时**互相**记录」里 B 欠的那一半。
   *
   * 它是**自报**的，和 hostIdentityPub 一样由这张带外传来的码背书——
   * 拿到码的人本来就能冒充这张码里的一切，多一个字段不改变信任模型。
   * B 侧另有一道：这个 uid 不在 B 的好友里就不接（说人话，而不是连上了什么都没有）。
   */
  hostUid: string;
  /** B 要连的 relay 频道 id（随机 32 字节，base64） */
  channelId: string;
  /** 一次性秘密（32 字节）。只存在于 A 发出前 + B 收到后，不落 relay、不落日志 */
  secret: Uint8Array;
  /** A 的身份公钥（32 字节）。B 据此确认对面是 A */
  hostIdentityPub: Uint8Array;
  /** 生成时刻（epoch ms）。配合 TTL 判过期 */
  createdTs: number;
}

/** B 扫到/收到的邀请（解码后，字段与 ProxyInvite 一致） */
export type ScannedProxyInvite = ProxyInvite;

/** A 生成一份代理邀请。channelId 与 secret 都随机——频道 id 不可猜，secret 一次性 */
export function createProxyInvite(
  p: RemoteCryptoPrimitives,
  hostIdentityPub: Uint8Array,
  createdTs: number,
  hostUid: string
): ProxyInvite {
  if (hostIdentityPub.length !== RAW_BYTES) {
    throw new Error(`host 身份公钥须 ${RAW_BYTES} 字节，实际 ${hostIdentityPub.length}`);
  }
  return {
    v: PROXY_FRAME_VERSION,
    hostUid,
    channelId: b64encode(p.randomBytes(RAW_BYTES)),
    secret: p.randomBytes(RAW_BYTES),
    hostIdentityPub,
    createdTs,
  };
}

/** 编码成可带外传输的字符串（DM/当面发）。冒号分隔，公钥/secret 走 base64。
    uuid 与 base64url 都不含冒号，所以分隔符不会被字段内容撞上 */
export function encodeProxyInvite(inv: ProxyInvite): string {
  return [
    PREFIX,
    String(inv.v),
    inv.hostUid,
    inv.channelId,
    b64encode(inv.hostIdentityPub),
    b64encode(inv.secret),
    String(inv.createdTs),
  ].join(":");
}

/** 解码邀请码。形状不对/长度不对/版本不符 → null（外部输入，一律先验再用） */
export function decodeProxyInvite(text: string): ScannedProxyInvite | null {
  const parts = text.trim().split(":");
  if (parts.length !== 7) return null;
  const [prefix, vStr, hostUid, channelId, pubB64, secretB64, tsStr] = parts as [
    string, string, string, string, string, string, string,
  ];
  if (prefix !== PREFIX) return null;
  if (vStr !== String(PROXY_FRAME_VERSION)) return null;
  const hostIdentityPub = b64decode(pubB64);
  const secret = b64decode(secretB64);
  const createdTs = Number(tsStr);
  if (!hostIdentityPub || hostIdentityPub.length !== RAW_BYTES) return null;
  if (!secret || secret.length !== RAW_BYTES) return null;
  if (!hostUid || !channelId || !Number.isFinite(createdTs)) return null;
  return { v: PROXY_FRAME_VERSION, hostUid, channelId, hostIdentityPub, secret, createdTs };
}

/** 邀请是否已过期。now 由调用方给（好测），默认 TTL 10 分钟 */
export function proxyInviteExpired(
  inv: Pick<ProxyInvite, "createdTs">,
  now: number,
  ttlMs: number = PROXY_INVITE_TTL_MS
): boolean {
  return now - inv.createdTs > ttlMs;
}
