// 手机接应用的编排（#1430 Task 11）。判据在 src/shared/connectFlow.ts——手机代码依赖 react-native，
// 进不了 vitest 也过不了根 tsc，所以纯逻辑放 shared、这里注入依赖测；接线（mobile/src/machine/connectApp.ts）读源码钉。
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { disconnectWith, lendToTeamWith, runConnect, type TeamDeps } from "../../src/shared/connectFlow.js";

describe("runConnect", () => {
  it("直接连上：不开浏览器", async () => {
    let opened = false;
    const r = await runConnect({ startConnect: async () => ({ kind: "connected", serverId: "cloud-x" }), openAuth: async () => { opened = true; return { type: "cancel" }; } }, "x", {});
    expect(r).toEqual({ kind: "connected", serverId: "cloud-x" });
    expect(opened).toBe(false);
  });
  it("浏览器：拦 mrotto://connector-done；人关了浏览器 = cancelled（什么都不说）", async () => {
    let redirect = "";
    const cancelled = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async (_u, r) => { redirect = r; return { type: "cancel" }; } }, "notion", {});
    expect(redirect).toBe("mrotto://connector-done");
    expect(cancelled).toEqual({ kind: "cancelled" });
    const ok = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async () => ({ type: "success", url: "mrotto://connector-done?ok=1&serverId=cloud-notion" }) }, "notion", {});
    expect(ok).toEqual({ kind: "connected", serverId: "cloud-notion" });
    const bad = await runConnect({ startConnect: async () => ({ kind: "authorize", authorizeUrl: "https://a" }), openAuth: async () => ({ type: "success", url: "mrotto://connector-done?ok=0&message=%E6%8E%88%E6%9D%83%E8%B6%85%E6%97%B6%E4%BA%86" }) }, "notion", {});
    expect(bad).toEqual({ kind: "error", message: "授权超时了" });
  });
  it("startConnect 抛错 → error 带原话", async () => {
    const r = await runConnect({ startConnect: async () => { throw new Error("这个 token 用不了"); }, openAuth: async () => ({ type: "cancel" }) }, "github", { github_token: "x" });
    expect(r).toEqual({ kind: "error", message: "这个 token 用不了" });
  });
});

describe("lendToTeam / disconnect 的顺序", () => {
  const calls: string[] = [];
  let failAt: string | null = null;
  const step = (name: string): Promise<void> => {
    calls.push(name);
    return failAt === name ? Promise.reject(new Error(`${name} 炸了`)) : Promise.resolve();
  };
  const deps: TeamDeps = {
    setGrant: (s, w, on) => step(`grant:${s}:${w}:${on}`),
    removeApp: (s) => step(`remove:${s}`),
    upsertRow: (row) => step(`upsert:${row.workspaceId}:${row.serverId}`),
    deleteRow: (w, _uid, s) => step(`delete:${w}:${s}`),
  };
  const lend = (on: boolean) => lendToTeamWith(deps, { serverId: "cloud-x", workspaceId: "w1", on, label: "X", uid: "u" });

  beforeEach(() => {
    calls.length = 0;
    failAt = null;
  });

  it("借出：授权先，目录行后", async () => {
    await lend(true);
    expect(calls).toEqual(["grant:cloud-x:w1:true", "upsert:w1:cloud-x"]);
  });
  it("借出：授权失败就不写目录行（没有授权的目录行 = 团队看得见却用不了）", async () => {
    failAt = "grant:cloud-x:w1:true";
    await expect(lend(true)).rejects.toThrow();
    expect(calls).toEqual(["grant:cloud-x:w1:true"]);
  });
  it("收回：授权先关，目录行后删；授权没关成就不删行", async () => {
    await lend(false);
    expect(calls).toEqual(["grant:cloud-x:w1:false", "delete:w1:cloud-x"]);
    calls.length = 0;
    failAt = "grant:cloud-x:w1:false";
    await expect(lend(false)).rejects.toThrow();
    expect(calls).toEqual(["grant:cloud-x:w1:false"]);
  });
  it("断开：先删云端，再逐团队删目录行；云端没删成就一行都不动", async () => {
    await disconnectWith(deps, { serverId: "cloud-x", uid: "u", workspaceIds: ["w1", "w2"] });
    expect(calls).toEqual(["remove:cloud-x", "delete:w1:cloud-x", "delete:w2:cloud-x"]);
    calls.length = 0;
    failAt = "remove:cloud-x";
    await expect(disconnectWith(deps, { serverId: "cloud-x", uid: "u", workspaceIds: ["w1"] })).rejects.toThrow();
    expect(calls).toEqual(["remove:cloud-x"]);
  });
});

describe("手机端接线", () => {
  const src = readFileSync(new URL("../../mobile/src/machine/connectApp.ts", import.meta.url), "utf8");
  it("真依赖递给 shared 的编排，没有自己再写一遍顺序", () => {
    expect(src).toContain("lendToTeamWith(teamDeps, o)");
    expect(src).toContain("disconnectWith(teamDeps, o)");
    expect(src).toMatch(/teamDeps: TeamDeps = \{\s*setGrant,\s*removeApp,/);
    expect(src).toContain("openAuthSessionAsync(url, redirect)");
  });
  it("store 在换号时清掉（挂在自己的 onAuthStateChange 上，同 homeStore / machineStore）", () => {
    const store = readFileSync(new URL("../../mobile/src/machine/connectorsStore.ts", import.meta.url), "utf8");
    expect(store).toContain("supabase.auth.onAuthStateChange");
    expect(store).toMatch(/owner = next;\s*resetConnectors\(\);/);
  });
});
