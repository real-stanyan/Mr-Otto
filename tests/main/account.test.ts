import { describe, it, expect, vi } from "vitest";
import { parseAuthCallback, toAccountInfo, AccountManager } from "../../src/main/account.js";
import type { SupabaseLike } from "../../src/main/account.js";
import { authLandingUrl } from "../../src/shared/gatewayConfig.js";

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

function fakeClient(overrides?: { auth?: Partial<SupabaseLike["auth"]> }): SupabaseLike {
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
      signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: null })),
      signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
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
      // redirect_to 是落地页(浏览器要有个看得见的终点),深链那一跳在落地页内发生
      options: { redirectTo: authLandingUrl(), skipBrowserRedirect: true },
    });
    expect(openExternal).toHaveBeenCalledWith("https://oauth.example/authorize");
  });

  it("signIn：signInWithOAuth 回 error → throw，不调 openExternal", async () => {
    const client = fakeClient({
      auth: {
        signInWithOAuth: vi.fn(async () => ({
          data: { url: null },
          error: { message: "oauth provider rejected" },
        })),
      },
    });
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await expect(manager.signIn("google")).rejects.toThrow("oauth provider rejected");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("signIn：data.url 为空但无 error → throw，不调 openExternal", async () => {
    const client = fakeClient({
      auth: {
        signInWithOAuth: vi.fn(async () => ({ data: { url: null }, error: null })),
      },
    });
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await expect(manager.signIn("google")).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
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

  it("handleCallback：exchangeCodeForSession 回 error → throw，不调 onChange（失败不能伪装成登出态）", async () => {
    const client = fakeClient({
      auth: {
        exchangeCodeForSession: vi.fn(async () => ({
          data: { user: null },
          error: { message: "invalid or expired code" },
        })),
      },
    });
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });

    await expect(manager.handleCallback("mrotto://auth-callback?code=bad")).rejects.toThrow(
      "invalid or expired code"
    );
    expect(onChange).not.toHaveBeenCalled();
    // 失败态下 getAccount 仍是初始空账户——不能读出一个"看似登出"的假状态
    expect(manager.getAccount()).toEqual({ signedIn: false, email: "", name: "", avatarUrl: "" });
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

  it("signOut：服务端 signOut 回 error → 仍清本地状态、仍调 onChange，只 console.error 记录", async () => {
    const client = fakeClient({
      auth: {
        signOut: vi.fn(async () => ({ error: { message: "network unreachable" } })),
      },
    });
    const openExternal = vi.fn();
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal, onChange, client });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await manager.handleCallback("mrotto://auth-callback?code=abc123");
    onChange.mockClear();

    await manager.signOut();

    expect(client.auth.signOut).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ signedIn: false, email: "", name: "", avatarUrl: "" });
    expect(manager.getAccount()).toEqual({ signedIn: false, email: "", name: "", avatarUrl: "" });

    consoleErrorSpy.mockRestore();
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

  it("restore：getUser 回真 user → getAccount().signedIn 为 true 且 onChange 收到", async () => {
    const client = fakeClient({
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: {
              email: "alice@example.com",
              user_metadata: { name: "Alice", avatar_url: "https://g.example/a.png" },
            },
          },
          error: null,
        })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await manager.restore();

    expect(client.auth.getUser).toHaveBeenCalled();
    expect(manager.getAccount()).toEqual({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
    expect(onChange).toHaveBeenCalledWith({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
  });

  it("restore：getUser 回 user=null（无 session / 从未登录）→ 保持 EMPTY，不触发 onChange", async () => {
    const client = fakeClient({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await manager.restore();

    expect(manager.getAccount()).toEqual({ signedIn: false, email: "", name: "", avatarUrl: "" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restore：getUser 回 error（离线/过期）→ 静默保持 EMPTY，不 throw，不触发 onChange", async () => {
    const client = fakeClient({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "network unreachable" } })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(manager.restore()).resolves.toBeUndefined();

    expect(manager.getAccount()).toEqual({ signedIn: false, email: "", name: "", avatarUrl: "" });
    expect(onChange).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe("AccountManager 邮箱密码", () => {
  const aliceUser = {
    email: "alice@example.com",
    user_metadata: { name: "Alice", avatar_url: "https://g.example/a.png" },
  };

  it("signInWithPassword 成功 → onChange 收到 signedIn=true", async () => {
    const signInWithPassword = vi.fn(async () => ({
      data: { user: aliceUser, session: { access_token: "tok" } },
      error: null,
    }));
    const client = fakeClient({ auth: { signInWithPassword } });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await manager.signInWithPassword("alice@example.com", "hunter22");

    expect(signInWithPassword).toHaveBeenCalledWith({ email: "alice@example.com", password: "hunter22" });
    expect(onChange).toHaveBeenCalledWith({
      signedIn: true,
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://g.example/a.png",
    });
    expect(manager.getAccount().signedIn).toBe(true);
  });

  it("signInWithPassword 密码错 → throw，不调 onChange", async () => {
    const client = fakeClient({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: null, session: null },
          error: { message: "Invalid login credentials" },
        })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await expect(manager.signInWithPassword("alice@example.com", "wrong")).rejects.toThrow(
      "Invalid login credentials",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(manager.getAccount().signedIn).toBe(false);
  });

  it("signUpWithPassword 拿到 session（免验证）→ 'signed-in' 且 onChange", async () => {
    const client = fakeClient({
      auth: {
        signUp: vi.fn(async () => ({
          data: { user: aliceUser, session: { access_token: "tok" } },
          error: null,
        })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await expect(manager.signUpWithPassword("alice@example.com", "hunter22")).resolves.toBe("signed-in");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ signedIn: true, email: "alice@example.com" }));
  });

  it("signUpWithPassword 有 user 无 session（需邮箱验证）→ 'confirm-email'，不调 onChange", async () => {
    const client = fakeClient({
      auth: {
        signUp: vi.fn(async () => ({ data: { user: aliceUser, session: null }, error: null })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await expect(manager.signUpWithPassword("alice@example.com", "hunter22")).resolves.toBe("confirm-email");
    expect(onChange).not.toHaveBeenCalled();
    expect(manager.getAccount().signedIn).toBe(false);
  });

  it("signUpWithPassword 回 error（如邮箱已注册）→ throw，不调 onChange", async () => {
    const client = fakeClient({
      auth: {
        signUp: vi.fn(async () => ({
          data: { user: null, session: null },
          error: { message: "User already registered" },
        })),
      },
    });
    const onChange = vi.fn();
    const manager = new AccountManager({ openExternal: vi.fn(), onChange, client });

    await expect(manager.signUpWithPassword("alice@example.com", "hunter22")).rejects.toThrow(
      "User already registered",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
