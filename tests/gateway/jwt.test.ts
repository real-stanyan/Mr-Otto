import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyJwt } from "../../services/gateway/src/jwt.js";

const SECRET = "super-secret-jwt-value";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const head = b64(header);
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const NOW = 1_800_000_000;
const valid = { sub: "user-1", email: "a@b.c", exp: NOW + 3600 };

describe("verifyJwt", () => {
  it("合法令牌 → 取出 sub / email", () => {
    expect(verifyJwt(sign(valid), SECRET, NOW)).toEqual({
      ok: true,
      claims: { sub: "user-1", email: "a@b.c", exp: NOW + 3600 },
    });
  });

  it("换一把 secret 签的 → 拒", () => {
    const res = verifyJwt(sign(valid, "别的 secret"), SECRET, NOW);
    expect(res).toEqual({ ok: false, reason: "签名不匹配" });
  });

  it("改了 payload 但没重签 → 拒（篡改 sub 就能冒充别人花钱）", () => {
    const token = sign(valid);
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64({ ...valid, sub: "别人" })}.${s}`;
    expect(verifyJwt(forged, SECRET, NOW).ok).toBe(false);
  });

  it("alg: none → 拒（经典绕过：无签名也放行）", () => {
    const head = b64({ alg: "none", typ: "JWT" });
    expect(verifyJwt(`${head}.${b64(valid)}.`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "不支持的 alg: none",
    });
  });

  it("alg 换成别的对称算法 → 拒（不认 header 里的 alg，只认白名单）", () => {
    const token = sign(valid, SECRET, { alg: "HS512", typ: "JWT" });
    expect(verifyJwt(token, SECRET, NOW).ok).toBe(false);
  });

  it("已过期 → 拒；恰好到点也算过期", () => {
    expect(verifyJwt(sign({ ...valid, exp: NOW - 1 }), SECRET, NOW).ok).toBe(false);
    expect(verifyJwt(sign({ ...valid, exp: NOW }), SECRET, NOW)).toEqual({
      ok: false,
      reason: "token 已过期",
    });
  });

  it("没有 exp → 拒（缺就放行等于发了张永久令牌）", () => {
    expect(verifyJwt(sign({ sub: "user-1" }), SECRET, NOW)).toEqual({
      ok: false,
      reason: "缺少 exp",
    });
  });

  it("nbf 还没到 → 拒", () => {
    expect(verifyJwt(sign({ ...valid, nbf: NOW + 10 }), SECRET, NOW)).toEqual({
      ok: false,
      reason: "token 尚未生效",
    });
  });

  it("没有 sub → 拒（钱包没有主键）", () => {
    expect(verifyJwt(sign({ exp: NOW + 10 }), SECRET, NOW)).toEqual({
      ok: false,
      reason: "缺少 sub",
    });
  });

  it("形状不对 / 空 secret 一律拒，且不抛异常", () => {
    expect(verifyJwt("", SECRET, NOW).ok).toBe(false);
    expect(verifyJwt("a.b", SECRET, NOW).ok).toBe(false);
    expect(verifyJwt("!!!.???.***", SECRET, NOW).ok).toBe(false);
    expect(verifyJwt(sign(valid), "", NOW)).toEqual({ ok: false, reason: "服务端未配置 JWT secret" });
  });

  it("签名长度不对不炸（timingSafeEqual 对不等长入参会抛）", () => {
    const [h, p] = sign(valid).split(".");
    expect(verifyJwt(`${h}.${p}.QQ`, SECRET, NOW)).toEqual({ ok: false, reason: "签名不匹配" });
  });

  it("email 缺失时给空串，不让 undefined 漏进下游", () => {
    const res = verifyJwt(sign({ sub: "u", exp: NOW + 5 }), SECRET, NOW);
    expect(res.ok && res.claims.email).toBe("");
  });
});
