import { describe, it, expect, beforeEach } from "vitest";
import { statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  loadMcpAuth, readMcpAuth, writeMcpAuth, clearMcpAuth, dropMcpAuthClientRegistration,
  setMcpManualClient,
} from "../../src/main/mcpAuthStore.js";
// 走本仓的 tempDir（#474）：清理挂在 setupFiles 上，不用每个文件自己记得删
import { tempDir } from "../helpers/tempDir.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = tempDir("mcp-auth-");
  path = join(dir, "sub", "mcp-auth.json");
});

describe("mcpAuthStore", () => {
  it("没有文件时读出空表——「还没授权过」不是错误", () => {
    expect(loadMcpAuth(path)).toEqual({});
    expect(readMcpAuth(path, "supabase")).toEqual({});
  });

  it("坏 JSON 当「还没授权过」，不抛", () => {
    writeFileSync(join(dir, "broken.json"), "{ 这不是 JSON");
    expect(loadMcpAuth(join(dir, "broken.json"))).toEqual({});
  });

  it("顶层不是对象（数组/字符串）也当空表", () => {
    writeFileSync(join(dir, "arr.json"), "[1,2,3]");
    expect(loadMcpAuth(join(dir, "arr.json"))).toEqual({});
  });

  it("单台记录形状不对只废它自己，不连累同伴（#474）", () => {
    writeFileSync(
      join(dir, "mixed.json"),
      JSON.stringify({ good: { codeVerifier: "v" }, bad: "一条字符串", worse: [1, 2] })
    );
    expect(loadMcpAuth(join(dir, "mixed.json"))).toEqual({ good: { codeVerifier: "v" } });
  });

  it("部分更新不擦掉上一步存的字段——SDK 分三次回调落盘", () => {
    writeMcpAuth(path, "supabase", { clientInformation: { client_id: "c1" } });
    writeMcpAuth(path, "supabase", { codeVerifier: "v1" });
    writeMcpAuth(path, "supabase", { tokens: { access_token: "a1" } });
    expect(readMcpAuth(path, "supabase")).toEqual({
      clientInformation: { client_id: "c1" },
      codeVerifier: "v1",
      tokens: { access_token: "a1" },
    });
  });

  it("刷新覆盖旧 token", () => {
    writeMcpAuth(path, "supabase", { tokens: { access_token: "old" } });
    writeMcpAuth(path, "supabase", { tokens: { access_token: "new" } });
    expect(readMcpAuth(path, "supabase").tokens).toEqual({ access_token: "new" });
  });

  it("文件权限 0600——里面是凭据，与 keys.json 同档", () => {
    writeMcpAuth(path, "supabase", { tokens: { access_token: "a1" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("已存在的文件也补一刀 chmod（writeFileSync 的 mode 只在新建时生效）", () => {
    writeMcpAuth(path, "a", { codeVerifier: "v" });
    // 模拟外部把权限放宽
    chmodSync(path, 0o644);
    writeMcpAuth(path, "a", { codeVerifier: "v2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("清一台不误伤同伴", () => {
    writeMcpAuth(path, "a", { codeVerifier: "va" });
    writeMcpAuth(path, "b", { codeVerifier: "vb" });
    clearMcpAuth(path, "a");
    expect(readMcpAuth(path, "a")).toEqual({});
    expect(readMcpAuth(path, "b")).toEqual({ codeVerifier: "vb" });
  });

  it("父目录不存在时自己建出来", () => {
    writeMcpAuth(path, "a", { codeVerifier: "v" });
    expect(existsSync(path)).toBe(true);
  });

  // #471：二次授权时 loopback 端口换了，盘上的动态客户端注册绑的还是旧
  // redirect_uri——精确匹配的授权服务器会直接拒。丢注册要保 token：
  // token 可能还能 refresh，丢了用户就得整个重授权
  it("丢客户端注册：clientInformation/codeVerifier 删掉，tokens/redirectUri 保留（#471）", () => {
    writeMcpAuth(path, "s", {
      clientInformation: { client_id: "c1" },
      codeVerifier: "v1",
      tokens: { access_token: "a1" },
      redirectUri: "http://127.0.0.1:1111/callback",
    });
    dropMcpAuthClientRegistration(path, "s");
    expect(readMcpAuth(path, "s")).toEqual({
      tokens: { access_token: "a1" },
      redirectUri: "http://127.0.0.1:1111/callback",
    });
  });

  // ── 手填的那对 OAuth 客户端凭据（#697）────────────────────────────────
  //
  // 存进**另一格**（manualClient）而不是复用 clientInformation：后者的语义是
  // 「DCR 那一次的产物」，仓里有两处逻辑按这个语义行事（needsFreshRegistration 会
  // 丢掉它重注册、SDK 的 saveClientInformation 会覆盖它）。手打的东西丢了就得去
  // 服务商后台重抄一遍，不是可再生的缓存。

  it("存一对：落进 manualClient，client_secret 带着", () => {
    setMcpManualClient(path, "slack", { client_id: "cid-1", client_secret: "sec-1" });
    expect(readMcpAuth(path, "slack").manualClient).toEqual({ client_id: "cid-1", client_secret: "sec-1" });
  });

  it("空 secret 不落一个空串——公开客户端就是没有 secret，而空串会被 SDK 当成「有」", () => {
    setMcpManualClient(path, "slack", { client_id: "cid-1", client_secret: "" });
    expect(readMcpAuth(path, "slack").manualClient).toEqual({ client_id: "cid-1" });
  });

  it("存的时候丢掉 DCR 那一份与 codeVerifier，但**不动 tokens**", () => {
    writeMcpAuth(path, "slack", {
      clientInformation: { client_id: "dcr-老的" },
      codeVerifier: "verifier-老的",
      tokens: { access_token: "a1" },
      redirectUri: "http://127.0.0.1:1111/callback",
    });
    setMcpManualClient(path, "slack", { client_id: "cid-1" });
    const rec = readMcpAuth(path, "slack");
    expect(rec.clientInformation).toBeUndefined();
    expect(rec.codeVerifier).toBeUndefined();
    // 换客户端凭据不该把一份还能 refresh 的授权也作废
    expect(rec.tokens).toEqual({ access_token: "a1" });
    expect(rec.manualClient).toEqual({ client_id: "cid-1" });
  });

  it("null = 清掉，只清这一格", () => {
    setMcpManualClient(path, "slack", { client_id: "cid-1", client_secret: "sec-1" });
    writeMcpAuth(path, "slack", { tokens: { access_token: "a1" } });
    setMcpManualClient(path, "slack", null);
    expect(readMcpAuth(path, "slack")).toEqual({ tokens: { access_token: "a1" } });
  });

  it("清一台从没填过的是 no-op，不误伤同伴", () => {
    setMcpManualClient(path, "slack", { client_id: "cid-1" });
    setMcpManualClient(path, "figma", null);
    expect(readMcpAuth(path, "slack").manualClient).toEqual({ client_id: "cid-1" });
    expect(readMcpAuth(path, "figma")).toEqual({});
  });

  it("丢一台不存在的注册是 no-op，不误伤同伴", () => {
    writeMcpAuth(path, "b", { codeVerifier: "vb" });
    dropMcpAuthClientRegistration(path, "没这台");
    expect(readMcpAuth(path, "b")).toEqual({ codeVerifier: "vb" });
  });
});
