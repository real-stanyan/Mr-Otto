import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpAuth, readMcpAuth, writeMcpAuth, clearMcpAuth, dropMcpAuthClientRegistration,
} from "../../src/main/mcpAuthStore.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  path = join(dir, "sub", "mcp-auth.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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

  it("丢一台不存在的注册是 no-op，不误伤同伴", () => {
    writeMcpAuth(path, "b", { codeVerifier: "vb" });
    dropMcpAuthClientRegistration(path, "没这台");
    expect(readMcpAuth(path, "b")).toEqual({ codeVerifier: "vb" });
  });
});
