// TURN 的时限凭据（#1534）：coturn 的 `use-auth-secret` / `static-auth-secret`（TURN REST API 草案）——
// 用户名 = `<过期的 unix 秒>:<随便一个标识>`，密码 = base64(HMAC-SHA1(secret, 用户名))。coturn 自己验：过期的拒、签不对的拒。
// 这样 runtime 不用给 coturn 建账号，手机也拿不到长期密码；一张票只活一通电话那么久。
// 只在人打人的电话上签（human_call 帖）：打的人在回执里拿，接的人在来电推送里拿。
import { createHmac } from "node:crypto";
import type { IceServer } from "../../../src/shared/humanCall.js";

export interface TurnSettings {
  /** 形如 turn:host:3478?transport=udp / turns:host:5349；逗号分开 */
  urls: string[];
  /** 与 coturn 的 static-auth-secret 同一个值 */
  secret: string;
}

/** 票活多久：响铃 45 秒 + 通话上限 1 小时，再宽一点 */
export const TURN_TTL_SEC = 2 * 60 * 60;

export function turnCredential(t: TurnSettings, uid: string, nowMs: number, ttlSec: number = TURN_TTL_SEC): IceServer {
  const expiry = Math.floor(nowMs / 1000) + ttlSec;
  // uid 只是个标识，coturn 不认它；带着是为了日志里看得出这张票给了谁
  const username = `${expiry}:${uid}`;
  const credential = createHmac("sha1", t.secret).update(username).digest("base64");
  return { urls: t.urls, username, credential };
}

/** 两端各一张（用户名里有 uid，不能共用一张） */
export function iceServersFor(t: TurnSettings | null, uid: string, nowMs: number, stun: IceServer): IceServer[] {
  return t === null ? [stun] : [stun, turnCredential(t, uid, nowMs)];
}
