import { describe, expect, it } from "vitest";
import {
  isDefaultWorkspace,
  isSessionFolderName,
  parentDir,
  sessionWorkspaceUnder,
} from "../../src/shared/defaultWorkspace.js";

const DEF = "/Users/x/Documents/Mr Otto/Default";

describe("parentDir", () => {
  it("posix / windows 都认，末尾分隔符先剥", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
    expect(parentDir("/a/b/c/")).toBe("/a/b");
    expect(parentDir("C:\\a\\b")).toBe("C:\\a");
    expect(parentDir("/")).toBeNull();
    expect(parentDir("")).toBeNull();
  });
});

describe("isDefaultWorkspace —— 任务会话的唯一判据", () => {
  it("旧形状：workspace 直接等于 Default 根", () => {
    expect(isDefaultWorkspace(DEF, DEF)).toBe(true);
  });
  it("新形状：父目录 = Default 根", () => {
    expect(isDefaultWorkspace(`${DEF}/s-20260903111128-a1b2c3d4`, DEF)).toBe(true);
  });
  it("孙目录 / 别的项目 / null 都不算", () => {
    expect(isDefaultWorkspace(`${DEF}/s-1/deeper`, DEF)).toBe(false);
    expect(isDefaultWorkspace("/p/x", DEF)).toBe(false);
    expect(isDefaultWorkspace(null, DEF)).toBe(false);
    expect(isDefaultWorkspace(DEF, null)).toBe(false);
  });
  it("前缀撞名不算：Default2 不是 Default 的孩子", () => {
    expect(isDefaultWorkspace(`${DEF}2/s-1`, DEF)).toBe(false);
  });
});

describe("sessionWorkspaceUnder", () => {
  it("分隔符跟 builtin 走", () => {
    expect(sessionWorkspaceUnder(DEF, "s-1")).toBe(`${DEF}/s-1`);
    expect(sessionWorkspaceUnder("C:\\Docs\\Default", "s-1")).toBe("C:\\Docs\\Default\\s-1");
  });
  it("与 isDefaultWorkspace 互为逆", () => {
    expect(isDefaultWorkspace(sessionWorkspaceUnder(DEF, "s-20260903111128-a1b2c3d4"), DEF)).toBe(true);
  });
});

describe("isSessionFolderName —— 清理只认这个形状", () => {
  it("完整 sessionId 认，别的一律不认", () => {
    expect(isSessionFolderName("s-20260903111128-a1b2c3d4")).toBe(true);
    expect(isSessionFolderName("report")).toBe(false);
    expect(isSessionFolderName("s-202609")).toBe(false);
    expect(isSessionFolderName("s-20260903111128-A1B2C3D4")).toBe(false);
  });
});
