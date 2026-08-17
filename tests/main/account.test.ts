import { describe, it, expect, vi } from "vitest";
import { parseAuthCallback, toAccountInfo, AccountManager } from "../../src/main/account.js";
import type { SupabaseLike } from "../../src/main/account.js";

describe("parseAuthCallback", () => {
  it("mrotto 深链带 code → 提取 code", () => {
    expect(parseAuthCallback("mrotto://auth-callback?code=abc123")).toBe("abc123");
  });

  it("loopback URL 带 code → 提取 code", () => {
    expect(parseAuthCallback("http://127.0.0.1:43110/callback?code=xyz789")).toBe("xyz789");
  });

  it("mrotto 深链无 code → null", () => {
    expect(parseAuthCallback("mrotto://auth-callback")).toBeNull();
  });

  it("loopback 无 code → null", () => {
    expect(parseAuthCallback("http://127.0.0.1:43110/callback")).toBeNull();
  });

  it("别的 scheme/host → null", () => {
    expect(parseAuthCallback("https://example.com/callback?code=abc")).toBeNull();
  });

  it("mrotto 深链但 host 不是 auth-callback → null", () => {
    expect(parseAuthCallback("mrotto://something-else?code=abc")).toBeNull();
  });

  it("loopback 但 pathname 不是 /callback → null", () => {
    expect(parseAuthCallback("http://127.0.0.1:43110/other?code=abc")).toBeNull();
  });

  it("不是合法 URL → null（不炸）", () => {
    expect(parseAuthCallback("not a url")).toBeNull();
  });
});

describe("toAccountInfo", () => {
  it("null 用户 → 全空 signedIn=false", () => {
    expect(toAccountInfo(null)).toEqual({
      signedIn: false,
      email: "",
      name: "",
      avatarUrl: "",
    });
  });

  it("Google 形态 metadata（name + avatar_url）", () => {
    const user = {
      email: "alice@example.com",
      user_metadata: { name: "Alice", avatar_url: "https://g.example/a.png" },
    };
    expect(toAccountInfo(user)).toEqual({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
  });

  it("GitHub 形态 metadata（user_name + picture，无 name/avatar_url）", () => {
    const user = {
      email: "bob@example.com",
      user_metadata: { user_name: "bobgh", picture: "https://gh.example/b.png" },
    };
    expect(toAccountInfo(user)).toEqual({
      signedIn: true,
      email: "bob@example.com",
      name: "bobgh",
      avatarUrl: "https://gh.example/b.png",
    });
  });

  it("metadata 全无 name/user_name → 用 email @ 前缀", () => {
    const user = { email: "carol@example.com", user_metadata: {} };
    expect(toAccountInfo(user)).toEqual({
      signedIn: true,
      email: "carol@example.com",
      name: "carol",
      avatarUrl: "",
    });
  });

  it("无 email 也无 metadata → name/avatarUrl 为空字符串", () => {
    const user = {};
    expect(toAccountInfo(user)).toEqual({
      signedIn: true,
      email: "",
      name: "",
      avatarUrl: "",
    });
  });
});

function fakeClient(overrides?: Partial<SupabaseLike>): SupabaseLike {
  return {
    auth: {
      signInWithOAuth: vi.fn(async () => ({ data: { url: "https://oauth.example/authorize" }, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({
        data: {
          user: {
            email: "alice@example.com",
            user_metadata: { name: "Alice", avatar_url: "https://g.example/a.png" },
          },
        },
        error: null,
      })),
      signOut: vi.fn(async () => ({ error: null })),
      ...overrides?.auth,
    },
  };
}

describe("AccountManager", () => {
  it("signIn 调 signInWithOAuth 拿到 URL 后调 openExternal", async () => {
    const client = fakeClient();
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await manager.signIn("google");

    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "mrotto://auth-callback", skipBrowserRedirect: true },
    });
    expect(openExternal).toHaveBeenCalledWith("https://oauth.example/authorize");
  });

  it("handleCallback 提取 code 后 exchangeCodeForSession，成功后 onChange 收到 signedIn=true", async () => {
    const client = fakeClient();
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await manager.handleCallback("mrotto://auth-callback?code=abc123");

    expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(onChange).toHaveBeenCalledWith({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
    expect(manager.getAccount()).toEqual({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
  });

  it("handleCallback 收到非回调 URL（无 code）→ 不调 exchangeCodeForSession，不调 onChange", async () => {
    const client = fakeClient();
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await manager.handleCallback("https://example.com/not-a-callback");

    expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("signOut 调 client.auth.signOut 后 onChange 收到 signedIn=false", async () => {
    const client = fakeClient();
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await manager.handleCallback("mrotto://auth-callback?code=abc123");
    onChange.mockClear();

    await manager.signOut();

    expect(client.auth.signOut).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({
      signedIn: false,
      email: "",
      name: "",
      avatarUrl: "",
    });
    expect(manager.getAccount()).toEqual({
      signedIn: false,
      email: "",
      name: "",
      avatarUrl: "",
    });
  });

  it("getAccount 初始状态为 signedIn=false", () => {
    const client = fakeClient();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange: vi.fn(), client });
    expect(manager.getAccount()).toEqual({
      signedIn: false,
      email: "",
      name: "",
      avatarUrl: "",
    });
  });
});
