import { describe, expect, it } from "vitest";
import { humanizeWorkspaceError, isSchemaBehind, SCHEMA_BEHIND } from "../../src/shared/workspaceError.js";

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("humanizeWorkspaceError（#843 ③）", () => {
  it("缺列 = 客户端比库新，且原文保留（维护者要看缺的是哪一列）", () => {
    const raw = "column workspace_sessions.kind does not exist";
    const out = humanizeWorkspaceError(withCode(raw, "42703"));
    expect(out.startsWith(SCHEMA_BEHIND)).toBe(true);
    expect(out).toContain(raw);
    // code 缺席时靠文案兜底
    expect(humanizeWorkspaceError(new Error(raw))).toContain(SCHEMA_BEHIND);
    expect(humanizeWorkspaceError(new Error("relation \"public.workspace_agents\" does not exist"))).toContain(SCHEMA_BEHIND);
    expect(humanizeWorkspaceError(withCode("Could not find the 'kind' column of 'workspace_sessions' in the schema cache", "PGRST204"))).toContain(SCHEMA_BEHIND);
  });

  it("23505 / 42501 按 code 判，不靠文案", () => {
    expect(humanizeWorkspaceError(withCode("duplicate key value violates unique constraint", "23505"))).toBe("已经有同名的了");
    expect(humanizeWorkspaceError(withCode("new row violates row-level security policy for table \"workspaces\"", "42501"))).toMatch(/没有权限/);
  });

  it("认不出的原样留着——一句看不懂的英文比自信的错译有用", () => {
    expect(humanizeWorkspaceError(new Error("something odd happened"))).toBe("something odd happened");
    expect(humanizeWorkspaceError("plain string")).toBe("plain string");
    expect(humanizeWorkspaceError({ message: "obj message" })).toBe("obj message");
  });

  it("网络 / 登录过期各一句", () => {
    expect(humanizeWorkspaceError(new Error("TypeError: fetch failed"))).toBe("连不上服务器——网络不通");
    expect(humanizeWorkspaceError(new Error("JWT expired"))).toBe("登录已过期，重新登录再试");
  });
});

describe("isSchemaBehind（#1356 A2）", () => {
  it("缺列 / 缺表 / schema cache 里没这一列：三个 code 与两句文案都认", () => {
    expect(isSchemaBehind(Object.assign(new Error("x"), { code: "PGRST204" }))).toBe(true);
    expect(isSchemaBehind(Object.assign(new Error("x"), { code: "42703" }))).toBe(true);
    expect(isSchemaBehind({ message: "relation \"public.x\" does not exist", code: "42P01" })).toBe(true);
    expect(isSchemaBehind(new Error("Could not find the 'onboarding' column of 'workspace_agents' in the schema cache"))).toBe(true);
    expect(isSchemaBehind(new Error("column workspace_agents.onboarding does not exist"))).toBe(true);
  });
  it("别的错误不认（唯一索引、权限、网络）", () => {
    expect(isSchemaBehind(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isSchemaBehind(Object.assign(new Error("new row violates row-level security policy"), { code: "42501" }))).toBe(false);
    expect(isSchemaBehind(new Error("fetch failed"))).toBe(false);
  });
});
