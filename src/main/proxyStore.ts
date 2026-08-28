// proxyStore —— 好友代理的授权/白名单/审计的本地落盘（issue #622 PR-D1，ADR-0151）。
// A 侧持久化：给哪些好友授了哪些服务/工具的代理权（ProxyGrant），
// 以及每一笔代理调用的审计账（谁/何时/工具/参数摘要/放行拒/结果）。
//
// 与 mcp-auth.json 同一套口径（0600、userData 下、不进事件日志）：
// 授权与审计是 A 的本地状态，不给 B、也不进 append-only 日志（日志不可删）。
//
// 纯逻辑 + 注入的读写：文件 IO 由调用方（main 装配根）做，本模块只管
// 「对象 ↔ JSON」的序列化与合并，假 fs 即可测试。

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { b64decode, b64encode } from "../shared/remote/b64.js";
import type { ProxyGrant } from "../shared/remote/proxyProtocol.js";

/** 一笔审计账 */
export interface ProxyAuditRecord {
  ts: number;
  friendUid: string;
  serverId: string;
  tool: string;
  /** 参数摘要（截断的 JSON，不存全量——审计要可查，但不复制整份参数） */
  argsSummary: string;
  decision: "executed" | "denied";
  outcome: "ok" | "denied" | "error";
  detail?: string;
}

/**
 * 一把已 pin 的好友身份公钥（base64）。
 *
 * 首次由邀请码里那把一次性 secret 的持有证明建立（proxyConnection 的 tryPair，
 * issue #657 / ADR-0162），之后握手走正常 pin 路径——邀请码是一次性、10 分钟就过期的，
 * **长期信任落在这里**：A 重启、B 重连都不必再发一张邀请。
 */
export interface ProxyPin {
  friendUid: string;
  /** 好友的身份公钥（32 字节，base64） */
  identityPub: string;
}

/**
 * A 给某好友开的 relay 频道 id。
 *
 * **要落盘**：channelId 是生成邀请码时随机出来的，B 靠它找到 A 的房间。
 * 不落盘的话 A 一重启就找不回来了，而邀请码是一次性、10 分钟过期的——
 * 总不能要求用户每次重开 app 都重发一张邀请。
 *
 * 频道 id 本身**不是**信任凭证（知道它只能 attach 到房间，握不了手，
 * 见 proxyConnection 的 tryPair），所以落盘不构成新的泄漏面。
 */
export interface ProxyChannel {
  friendUid: string;
  channelId: string;
}

/**
 * B 侧：我从哪个好友那儿借了服务（issue #676）。
 *
 * A 侧的 grants / pins / channels 记的是「我借**出去**了什么」，这一份记的是
 * 「我借**进来**了什么」——同一台机器两个角色，同一本台账两栏。
 *
 * 落盘的理由与 A 侧的 channels 同源：邀请码是一次性、10 分钟过期的，
 * 不落盘的话 B 一重启就得让对方重发一张。**secret 同样不落盘**——
 * 重连走的是 pin 路径（A 早就 pin 了 B，B 这边 pin 的是下面这把公钥）。
 */
export interface ProxyBorrow {
  hostUid: string;
  channelId: string;
  /** 对方的身份公钥（32 字节，base64）。来自那张带外传来的邀请码 */
  hostIdentityPub: string;
}

export interface ProxyStoreData {
  /** 按好友授权的代理白名单 */
  grants: ProxyGrant[];
  /** 审计账（追加式，新→旧排在前面方便读，容量封顶） */
  audits: ProxyAuditRecord[];
  /** 已 pin 的好友身份公钥（握手层认人用；与 grants 分开——授权是「能干什么」，
      pin 是「你是谁」，撤销授权时两个一起清） */
  pins: ProxyPin[];
  /** 给每个好友开的 relay 频道（A 重启后据此把房间重新开起来等 B） */
  channels: ProxyChannel[];
  /** 我从哪些好友那儿借了服务（B 重启后据此重新连回去） */
  borrows: ProxyBorrow[];
}

/** 审计账的容量上限——append 不封顶会把文件越撑越大。超了丢最旧的 */
export const AUDIT_CAP = 500;

export function emptyProxyStore(): ProxyStoreData {
  return { grants: [], audits: [], pins: [], channels: [], borrows: [] };
}

/** 解析落盘的 JSON。坏了/不是对象 → 空店（不带着坏数据跑） */
export function parseProxyStore(json: string | null | undefined): ProxyStoreData {
  if (!json) return emptyProxyStore();
  try {
    const d = JSON.parse(json);
    if (typeof d !== "object" || d === null) return emptyProxyStore();
    return {
      grants: Array.isArray(d.grants) ? d.grants : [],
      audits: Array.isArray(d.audits) ? d.audits : [],
      // pins/channels 是后加的字段（issue #657）：老台账里没有，缺席按空组读，不算坏数据
      pins: Array.isArray(d.pins) ? d.pins : [],
      channels: Array.isArray(d.channels) ? d.channels : [],
      borrows: Array.isArray(d.borrows) ? d.borrows : [],
    };
  } catch {
    return emptyProxyStore();
  }
}

export function serializeProxyStore(data: ProxyStoreData): string {
  return JSON.stringify(data, null, 2);
}

/** 给某好友设白名单（整份替换该好友的授权）。A 在分享时圈定 */
export function setGrant(data: ProxyStoreData, grant: ProxyGrant): ProxyStoreData {
  const grants = data.grants.filter((g) => g.friendUid !== grant.friendUid);
  grants.push(grant);
  return { ...data, grants };
}

/** 撤销某好友的全部代理授权。一键收回的落点。
    **pin 也一起清**：撤销的语义是「这个好友什么都不剩」，留着 pin 等于留着
    一条随时能重新握手的通道，只差 A 再点一次授权——那不是用户按下「撤销」时想要的。
    要重新给，重发一张邀请码即可（这也是重新做一次有意识的授权动作）。 */
export function revokeGrant(data: ProxyStoreData, friendUid: string): ProxyStoreData {
  return {
    ...data,
    grants: data.grants.filter((g) => g.friendUid !== friendUid),
    pins: data.pins.filter((p) => p.friendUid !== friendUid),
    channels: data.channels.filter((c) => c.friendUid !== friendUid),
  };
}

/** 记下给某好友开的频道（整份替换——一个好友一条通道） */
export function setChannel(data: ProxyStoreData, friendUid: string, channelId: string): ProxyStoreData {
  const channels = data.channels.filter((c) => c.friendUid !== friendUid);
  channels.push({ friendUid, channelId });
  return { ...data, channels };
}

/** 某好友的频道 id，没开过回 null */
export function channelFor(data: ProxyStoreData, friendUid: string): string | null {
  return data.channels.find((c) => c.friendUid === friendUid)?.channelId ?? null;
}

/** B 侧：记下（或整份替换）从某好友借来的那条通道 */
export function setBorrow(
  data: ProxyStoreData,
  hostUid: string,
  channelId: string,
  hostIdentityPub: Uint8Array
): ProxyStoreData {
  const borrows = data.borrows.filter((b) => b.hostUid !== hostUid);
  borrows.push({ hostUid, channelId, hostIdentityPub: b64encode(hostIdentityPub) });
  return { ...data, borrows };
}

/** B 侧：不再借某好友的服务（主动断开 / 对方撤销后清理） */
export function removeBorrow(data: ProxyStoreData, hostUid: string): ProxyStoreData {
  return { ...data, borrows: data.borrows.filter((b) => b.hostUid !== hostUid) };
}

/** B 侧：能连回去的那些通道（公钥解不出来/长度不对的整条丢掉——
    宁可让用户重走一次邀请码，也不能拿一把坏钥匙去 pin） */
export function usableBorrows(data: ProxyStoreData): { hostUid: string; channelId: string; hostIdentityPub: Uint8Array }[] {
  const out: { hostUid: string; channelId: string; hostIdentityPub: Uint8Array }[] = [];
  for (const b of data.borrows) {
    const raw = b64decode(b.hostIdentityPub);
    if (!raw || raw.length !== 32 || !b.channelId || !b.hostUid) continue;
    out.push({ hostUid: b.hostUid, channelId: b.channelId, hostIdentityPub: raw });
  }
  return out;
}

/** pin 一把好友公钥（同一好友整份替换——一个好友一台机器一把身份密钥） */
export function setPin(data: ProxyStoreData, friendUid: string, identityPub: Uint8Array): ProxyStoreData {
  const pins = data.pins.filter((p) => p.friendUid !== friendUid);
  pins.push({ friendUid, identityPub: b64encode(identityPub) });
  return { ...data, pins };
}

/** 某好友已 pin 的公钥（解码后；坏 base64/长度不对的整条丢掉——握手宁可拒也不能用坏钥匙）。
    回数组而不是单把：proxyConnection 的 peerIdentities 就是逐把试的形状 */
export function pinnedIdentities(data: ProxyStoreData, friendUid: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const pin of data.pins) {
    if (pin.friendUid !== friendUid) continue;
    const raw = b64decode(pin.identityPub);
    if (raw && raw.length === 32) out.push(raw);
  }
  return out;
}

/** 查某好友的授权（A 侧执行器每次收帧都查这个） */
export function grantFor(data: ProxyStoreData, friendUid: string): ProxyGrant | null {
  return data.grants.find((g) => g.friendUid === friendUid) ?? null;
}

/** 记一笔审计（新→旧排在前面，超 AUDIT_CAP 丢最旧的） */
export function appendAudit(data: ProxyStoreData, entry: ProxyAuditRecord): ProxyStoreData {
  const audits = [entry, ...data.audits];
  if (audits.length > AUDIT_CAP) audits.length = AUDIT_CAP;
  return { ...data, audits };
}


// ─── 文件落盘（0600，userData 下）────────────────────────────────
// 与 mcp-auth.json 同一套口径：好友代理的授权是「谁能用你的凭证」的台账，
// 文件只属当前用户可读写。读失败（不存在/坏 JSON）回落空台账而不是抛——
// 一个新装的实例本就该是空台账。

/** 读 userData 下的代理台账文件。不存在/坏 JSON 回空台账 */
export function readProxyStore(path: string): ProxyStoreData {
  try {
    return parseProxyStore(readFileSync(path, "utf8"));
  } catch {
    return emptyProxyStore();
  }
}

/** 写代理台账文件（0600）。先建目录再写，已有文件补一刀 chmod（同 keyVault） */
export function writeProxyStore(path: string, data: ProxyStoreData): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeProxyStore(data), { mode: 0o600 });
  chmodSync(path, 0o600);
}
