// TURN 时限凭据（#1534）：coturn 的 use-auth-secret——用户名 `<过期秒>:<标识>`，密码 = base64(HMAC-SHA1(secret, 用户名))。
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUN } from "../../src/shared/humanCall.js";
import { TURN_TTL_SEC, iceServersFor, turnCredential } from "../../services/runtime/src/turnCredentials.js";

const T = { urls: ["turn:h:3478?transport=udp", "turn:h:3478?transport=tcp"], secret: "s3cret" };

describe("turnCredential", () => {
  it("用户名 = 过期秒:uid；密码 = HMAC-SHA1 base64；urls 原样", () => {
    const c = turnCredential(T, "u1", 1_700_000_000_000, 60);
    expect(c.username).toBe("1700000060:u1");
    expect(c.credential).toBe(createHmac("sha1", "s3cret").update("1700000060:u1").digest("base64"));
    expect(c.urls).toEqual(T.urls);
  });
  it("缺省活两小时（响铃 45 秒 + 通话 1 小时上限再宽一点）", () => {
    expect(TURN_TTL_SEC).toBe(7200);
  });
});

describe("iceServersFor", () => {
  it("没配 TURN 只有 STUN；配了 = STUN + 一张票；两个人的票不一样", () => {
    expect(iceServersFor(null, "u1", 0, DEFAULT_STUN)).toEqual([DEFAULT_STUN]);
    const a = iceServersFor(T, "u1", 0, DEFAULT_STUN);
    const b = iceServersFor(T, "u2", 0, DEFAULT_STUN);
    expect(a[0]).toEqual(DEFAULT_STUN);
    expect(a[1]?.username).toMatch(/:u1$/);
    expect(a[1]?.credential).not.toBe(b[1]?.credential);
  });
});
