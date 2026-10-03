// src/shared/speechTicket.ts
// 语音合成的票（#1441）：派智能体给好友打电话时，好友听到的 TTS 记在主人账上。runtime 签、edge 验，
// 两端共用这一份编码。WebCrypto（Node 22 与 Workers 都有 globalThis.crypto.subtle），不 import node:crypto。
export const SPEECH_TICKET_HEADER = "x-otto-speech-ticket";
export const SPEECH_TICKET_TTL_MS = 15 * 60_000;
export interface SpeechTicket { ownerUid: string; peerUid: string; workspaceId: string; sessionId: string; exp: number }

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const keyOf = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signSpeechTicket(t: SpeechTicket, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify([t.ownerUid, t.peerUid, t.workspaceId, t.sessionId, t.exp])));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await keyOf(secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySpeechTicket(raw: string, secret: string, callerUid: string, now: number): Promise<SpeechTicket | null> {
  const parts = raw.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  const sig = unb64url(parts[1]!);
  const body = unb64url(parts[0]!);
  if (sig === null || body === null) return null;
  // subtle.verify 是定长比较，不自己写 ===
  if (!(await crypto.subtle.verify("HMAC", await keyOf(secret), sig, enc.encode(parts[0]!)))) return null;
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 5) return null;
  const [ownerUid, peerUid, workspaceId, sessionId, exp] = v as unknown[];
  if (typeof ownerUid !== "string" || typeof peerUid !== "string" || typeof workspaceId !== "string" || typeof sessionId !== "string") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || now >= exp) return null;
  if (peerUid !== callerUid) return null;
  return { ownerUid, peerUid, workspaceId, sessionId, exp };
}
