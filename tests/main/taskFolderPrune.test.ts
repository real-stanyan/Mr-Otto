import { describe, expect, it } from "vitest";
import { pruneEmptyTaskFolders, type PruneFs } from "../../src/main/taskFolderPrune.js";

const DEF = "/docs/Mr Otto/Default";
function fakeFs(entries: { name: string; isDir: boolean; empty: boolean }[]): PruneFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: () => entries.map((e) => ({ name: e.name, isDir: e.isDir })),
    rmdirIfEmpty: (abs) => {
      const e = entries.find((x) => abs.endsWith(x.name));
      if (!e || !e.empty) return false;
      removed.push(abs);
      return true;
    },
  };
}

describe("pruneEmptyTaskFolders（#851）", () => {
  it("只删名字像 sessionId 且为空的目录；非空的记 kept；别的名字碰都不碰", () => {
    const fs = fakeFs([
      { name: "s-20260903111128-a1b2c3d4", isDir: true, empty: true },
      { name: "s-20260903111129-b1b2c3d4", isDir: true, empty: false },
      { name: "report.md", isDir: false, empty: true },
      { name: "my-notes", isDir: true, empty: true },
    ]);
    expect(pruneEmptyTaskFolders(DEF, fs)).toEqual({ removed: 1, kept: 1 });
    expect(fs.removed).toEqual([`${DEF}/s-20260903111128-a1b2c3d4`]);
  });
  it("Default 还没出生：0/0", () => {
    expect(pruneEmptyTaskFolders(DEF, fakeFs([]))).toEqual({ removed: 0, kept: 0 });
  });
  it("活着的会话的空文件夹不删——那是正在跑的水獭的 cwd", () => {
    const fs = fakeFs([{ name: "s-20260903111128-a1b2c3d4", isDir: true, empty: true }]);
    expect(pruneEmptyTaskFolders(DEF, fs, new Set(["s-20260903111128-a1b2c3d4"]))).toEqual({ removed: 0, kept: 0 });
    expect(fs.removed).toEqual([]);
  });
});
