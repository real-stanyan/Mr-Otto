import { describe, it, expect, vi } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createAuthStorage, nodeIO, sessionIdentity } from "../../src/main/authStorage.js";
import { tempDir } from "../helpers/tempDir.js";

function fakeIO() {
  const store = new Map<string, string>();
  return {
    read: vi.fn((p: string) => (store.has(p) ? (store.get(p) as string) : null)),
    write: vi.fn((p: string, data: string) => {
      store.set(p, data);
    }),
    remove: vi.fn((p: string) => {
      store.delete(p);
    }),
  };
}

describe("authStorage", () => {
  it("roundtrip：setItem 后 getItem 取回", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token", "token-value");
    expect(storage.getItem("sb-xxx-auth-token")).toBe("token-value");
  });

  it("removeItem 后 getItem 为 null", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("k", "v");
    storage.removeItem("k");
    expect(storage.getItem("k")).toBeNull();
  });

  it("文件不存在 → getItem 为 null", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    expect(storage.getItem("missing")).toBeNull();
  });

  it("单文件 JSON 多 key 合并存：setItem 不覆盖其他已存 key", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("key-a", "value-a");
    storage.setItem("key-b", "value-b");
    expect(storage.getItem("key-a")).toBe("value-a");
    expect(storage.getItem("key-b")).toBe("value-b");
    const lastWriteData = io.write.mock.calls.at(-1)?.[1] as string;
    expect(JSON.parse(lastWriteData)).toEqual({ "key-a": "value-a", "key-b": "value-b" });
  });

  it("removeItem 只删目标 key，其余 key 保留", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("key-a", "value-a");
    storage.setItem("key-b", "value-b");
    storage.removeItem("key-a");
    expect(storage.getItem("key-a")).toBeNull();
    expect(storage.getItem("key-b")).toBe("value-b");
  });

  it("坏 JSON 当空处理，不炸", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", "{not valid json");
    const storage = createAuthStorage("/fake/auth.json", io);
    expect(storage.getItem("any")).toBeNull();
    storage.setItem("k", "v");
    const lastWriteData = io.write.mock.calls.at(-1)?.[1] as string;
    expect(JSON.parse(lastWriteData)).toEqual({ k: "v" });
  });

  it("setItem 落盘走 io.write，序列化为 JSON 字符串", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token", "token-value");
    expect(io.write).toHaveBeenCalledWith(
      "/fake/auth.json",
      JSON.stringify({ "sb-xxx-auth-token": "token-value" })
    );
  });

  it("nodeIO 落盘权限恒 0600（含二次写入）", () => {
    const dir = tempDir("otter-authstorage-");
    const filePath = join(dir, "auth.json");
    const storage = createAuthStorage(filePath, nodeIO);
    storage.setItem("sb-token", "abc");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    storage.setItem("sb-token", "def"); // 已存在文件的二次写入，mode 参数对已存在文件不生效，需靠 chmod/unlink 兜底
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(storage.getItem("sb-token")).toBe("def");
  });

  it("nodeIO：文件不存在时 getItem 为 null（真实文件系统）", () => {
    const dir = tempDir("otter-authstorage-");
    const filePath = join(dir, "does-not-exist.json");
    const storage = createAuthStorage(filePath, nodeIO);
    expect(storage.getItem("anything")).toBeNull();
  });

  // hasSession 是进门闸（SignInScreen / ADR-0182，判据由 ADR-0183 收紧）唯一的判据：
  // 它必须同步、离线也答得出，所以停在本地文件这一层，不发网络校验
  const SESSION = JSON.stringify({
    access_token: "at",
    refresh_token: "rt",
    token_type: "bearer",
    expires_at: 1,
    user: { id: "u1" },
  });

  it("hasSession：没存过东西 = 没有登录记录", () => {
    const io = fakeIO();
    expect(createAuthStorage("/fake/auth.json", io).hasSession()).toBe(false);
  });

  it("hasSession：存着一份 session 就算有登录记录", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-kpeemypbhkynapkjzewr-auth-token", SESSION);
    expect(storage.hasSession()).toBe(true);
  });

  // #729 的原样复现：维护者 dev 目录里就是这三条、一份 session 都没有，而闸门放行了。
  // code verifier 是 signInWithOAuth **一开始**就写的，它证明有人点过按钮，不证明登录过
  it("hasSession：只有 PKCE 的 code-verifier 残留时不算登录记录（#729）", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-otto-auth-auth-token-code-verifier", "abc123");
    storage.setItem("sb-otto-auth-auth-token-flows-code-verifier", "[]");
    storage.setItem("sb-otto-auth-auth-token-flow-de7873f9-code-verifier", "def456");
    expect(storage.hasSession()).toBe(false);
  });

  // 就算 code verifier 那笔碰巧是个带 access_token 的 JSON，key 名也一票否决 ——
  // 判 key 在前、判形状在后，两道都要过
  it("hasSession：key 里带 code-verifier 的一律不算，哪怕值长得像 session", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token-code-verifier", SESSION);
    expect(storage.hasSession()).toBe(false);
  });

  it("hasSession：值不是 JSON、或解析出来没有 access_token，都不算", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token", "不是 JSON");
    storage.setItem("sb-yyy-auth-token", JSON.stringify({ user: { id: "u1" } }));
    storage.setItem("sb-zzz-auth-token", JSON.stringify({ access_token: "" }));
    expect(storage.hasSession()).toBe(false);
  });

  it("hasSession：登出把 session 删掉之后回到没有", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-kpeemypbhkynapkjzewr-auth-token", SESSION);
    storage.removeItem("sb-kpeemypbhkynapkjzewr-auth-token");
    expect(storage.hasSession()).toBe(false);
  });

  it("hasSession：坏 JSON 当没存过——闸门宁可让人重登，也不能靠一个解析不了的文件放行", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", "{ 这不是 JSON");
    expect(createAuthStorage("/fake/auth.json", io).hasSession()).toBe(false);
  });
});

// ADR-0187：本机数据按账号分抽屉，而抽屉在 whenReady 的第一行就得选定 —— 那时
// supabase client 还没造、restore() 的网络往返更没影子。答案本来就在盘上：
// supabase 落的那份 session 自带 user.id。
describe("sessionIdentity —— 落盘 session 里的「这是谁」", () => {
  const session = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      access_token: "tok",
      refresh_token: "r",
      user: { id: "uid-alice", email: "alice@example.com" },
      ...over,
    });

  it("读出 uid 和邮箱，同步、不发网络", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", JSON.stringify({ "sb-abc-auth-token": session() }));
    expect(sessionIdentity("/fake/auth.json", io)).toEqual({
      uid: "uid-alice",
      email: "alice@example.com",
    });
  });

  it("没有文件 → uid 为 null（「没登录记录」不是异常，走 _signed-out 那一格）", () => {
    expect(sessionIdentity("/fake/auth.json", fakeIO())).toEqual({ uid: null, email: "" });
  });

  it("只有 code-verifier 残留 → uid 为 null（#729 那三条骗过闸门的东西）", () => {
    const io = fakeIO();
    io.write(
      "/fake/auth.json",
      JSON.stringify({ "sb-abc-auth-token-code-verifier": "just-a-bare-string" })
    );
    expect(sessionIdentity("/fake/auth.json", io).uid).toBeNull();
  });

  it("有 session 但没有 user.id → uid 为 null，不瞎猜一个", () => {
    const io = fakeIO();
    io.write(
      "/fake/auth.json",
      JSON.stringify({ "sb-abc-auth-token": session({ user: { email: "a@b.c" } }) })
    );
    expect(sessionIdentity("/fake/auth.json", io).uid).toBeNull();
  });

  it("坏 JSON 不炸 —— 开机路径上抛异常等于整个 app 起不来", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", "{ 这不是 JSON");
    expect(sessionIdentity("/fake/auth.json", io)).toEqual({ uid: null, email: "" });
  });

  it("和 hasSession 认的是同一份形状 —— 判据只有一份，不会漂移", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", JSON.stringify({ "sb-abc-auth-token": session() }));
    expect(createAuthStorage("/fake/auth.json", io).hasSession()).toBe(true);
    expect(sessionIdentity("/fake/auth.json", io).uid).toBe("uid-alice");
  });
});
