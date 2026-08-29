import { describe, it, expect, vi } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createAuthStorage, nodeIO } from "../../src/main/authStorage.js";
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

  // hasAny 是进门闸（SignInScreen / ADR-0181）唯一的判据：它必须同步、离线也答得出，
  // 所以停在"文件里有没有 key"这一层，不解析 session、更不发网络校验
  it("hasAny：没存过东西 = 没有登录记录", () => {
    const io = fakeIO();
    expect(createAuthStorage("/fake/auth.json", io).hasAny()).toBe(false);
  });

  it("hasAny：存过任意一个 key 就算有登录记录", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token", "token-value");
    expect(storage.hasAny()).toBe(true);
  });

  it("hasAny：登出把最后一个 key 删掉之后回到没有", () => {
    const io = fakeIO();
    const storage = createAuthStorage("/fake/auth.json", io);
    storage.setItem("sb-xxx-auth-token", "token-value");
    storage.removeItem("sb-xxx-auth-token");
    expect(storage.hasAny()).toBe(false);
  });

  it("hasAny：坏 JSON 当没存过——闸门宁可让人重登，也不能靠一个解析不了的文件放行", () => {
    const io = fakeIO();
    io.write("/fake/auth.json", "{ 这不是 JSON");
    expect(createAuthStorage("/fake/auth.json", io).hasAny()).toBe(false);
  });
});
