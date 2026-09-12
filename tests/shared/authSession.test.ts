// 「这台设备上有没有一份登录记录」——闸门的判据，桌面与手机共用（ADR-0183 的形状判）。
// 桌面那侧的文件读取由 tests/main/authStorage.test.ts 守着；这里钉纯判据本身。
import { describe, expect, it } from "vitest";
import { hasStoredSession, parseStoredSession } from "../../src/shared/authSession.js";

const session = JSON.stringify({ access_token: "a.b.c", user: { id: "u1" } });

describe("parseStoredSession", () => {
  it("一份真 session：回解析出来的对象（调用方还要读 user.id）", () => {
    const p = parseStoredSession("sb-kpee-auth-token", session);
    expect(p).not.toBeNull();
    expect((p as { user: { id: string } }).user.id).toBe("u1");
  });

  it("code-verifier 不算——那是「点过一次 OAuth 然后放弃」(#729 被它骗过一次)", () => {
    // 值即使长得像 session 也不算：判据先看 key
    expect(parseStoredSession("sb-otto-auth-token-code-verifier", session)).toBeNull();
  });

  it("裸串、非对象、access_token 空或缺席，都不算", () => {
    expect(parseStoredSession("k", "not json")).toBeNull();
    expect(parseStoredSession("k", JSON.stringify("a string"))).toBeNull();
    expect(parseStoredSession("k", JSON.stringify({ access_token: "" }))).toBeNull();
    expect(parseStoredSession("k", JSON.stringify({ refresh_token: "r" }))).toBeNull();
    expect(parseStoredSession("k", null)).toBeNull();
  });

  it("按形状认，不按 key 名硬拼：退役项目的旧 token 也算一份记录", () => {
    // 硬拼 key 的失败模式是「登录了也进不去」的死循环；按形状认只会多放进一个
    // 进去之后处处未登录态的人，而那正是闸门本来就决定要放行的那一类（ADR-0183）
    expect(parseStoredSession("sb-retired-project-auth-token", session)).not.toBeNull();
  });
});

describe("hasStoredSession", () => {
  it("一堆 key 里有一份就算有", () => {
    expect(hasStoredSession([["a-code-verifier", "xyz"], ["sb-x-auth-token", session]])).toBe(true);
  });

  it("只有 code-verifier 残留 = 没有登录过（维护者的 dev 目录当年就是这样）", () => {
    expect(hasStoredSession([
      ["sb-otto-auth-auth-token-code-verifier", "xyz"],
      ["sb-otto-auth-auth-token-flows-code-verifier", "xyz"],
    ])).toBe(false);
  });

  it("空存储 = 没有", () => {
    expect(hasStoredSession([])).toBe(false);
  });
});
