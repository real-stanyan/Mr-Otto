// consoleSafeSpawnOpts 的平台分岔（issue #1027）：
// win32 → windowsHide:true + detached:false（CREATE_NO_WINDOW 与 DETACHED_PROCESS
// 互斥，MSDN/ADR-0163）；其他平台 → windowsHide:true + detached:true（进程组，
// killGroup「全组连坐」的前提，issue #759）。

import { describe, expect, it } from "vitest";
import { consoleSafeSpawnOpts } from "../../src/shared/childProcess.js";

describe("consoleSafeSpawnOpts（#1027）", () => {
  it("win32：windowsHide 压住控制台窗口，且不能 detached（两旗标互斥）", () => {
    expect(consoleSafeSpawnOpts("win32")).toEqual({ windowsHide: true, detached: false });
  });

  it("darwin：windowsHide 无副作用，detached 保住独立进程组", () => {
    expect(consoleSafeSpawnOpts("darwin")).toEqual({ windowsHide: true, detached: true });
  });

  it("linux：同 darwin", () => {
    expect(consoleSafeSpawnOpts("linux")).toEqual({ windowsHide: true, detached: true });
  });

  it("缺省实参取 process.platform，本机（非 win32 门禁环境）= detached 那支", () => {
    const opts = consoleSafeSpawnOpts();
    expect(opts.windowsHide).toBe(true);
    expect(opts.detached).toBe(process.platform !== "win32");
  });
});
