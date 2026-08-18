// Supabase JWT(HS256)验签 —— 网关的身份边界。
//
// 手写而不装 jose：自建 Supabase 走的是对称 HS256(deploy/otto-auth/README.md 记着
// 新版非对称体系留空、auth/rest/realtime 都读 JWT_SECRET),验一个 HS256 就是
// 一次 HMAC + 一次定长比较,依赖换不来更少的代码。代价是必须自己堵住
// JWT 的经典坑,下面三条注释标的就是那三个坑,tests/gateway/jwt.test.ts 逐条钉住。

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  /** Supabase user id(uuid)——钱包主键 */
  sub: string;
  email: string;
  /** 过期时刻(秒) */
  exp: number;
}

export type JwtResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: string };

function decodeSegment(seg: string): unknown {
  try {
    return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * @param nowSeconds 注入而不是读时钟：过期判断要能被测试逐秒钉死
 */
export function verifyJwt(token: string, secret: string, nowSeconds: number): JwtResult {
  if (!secret) return { ok: false, reason: "服务端未配置 JWT secret" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token 格式不对" };
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = decodeSegment(rawHeader);
  if (!isRecord(header)) return { ok: false, reason: "header 解不开" };
  // 坑一:alg 必须白名单硬匹配。认 header 里的 alg = 让攻击者自己挑算法,
  // "none" 和 HS/RS 混淆都是从这里进来的
  if (header.alg !== "HS256") return { ok: false, reason: `不支持的 alg: ${String(header.alg)}` };

  const expected = createHmac("sha256", secret).update(`${rawHeader}.${rawPayload}`).digest();
  const actual = Buffer.from(rawSig, "base64url");
  // 坑二:timingSafeEqual 对不等长入参会抛,先比长度(长度本身不是秘密)
  if (actual.length !== expected.length) return { ok: false, reason: "签名不匹配" };
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: "签名不匹配" };

  const payload = decodeSegment(rawPayload);
  if (!isRecord(payload)) return { ok: false, reason: "payload 解不开" };

  // 坑三:exp 必须**存在**才算数。缺 exp 就放行 = 一把永不过期的令牌
  const exp = payload.exp;
  if (typeof exp !== "number") return { ok: false, reason: "缺少 exp" };
  if (nowSeconds >= exp) return { ok: false, reason: "token 已过期" };
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nowSeconds < nbf) return { ok: false, reason: "token 尚未生效" };

  const sub = payload.sub;
  if (typeof sub !== "string" || sub === "") return { ok: false, reason: "缺少 sub" };

  return {
    ok: true,
    claims: { sub, email: typeof payload.email === "string" ? payload.email : "", exp },
  };
}
