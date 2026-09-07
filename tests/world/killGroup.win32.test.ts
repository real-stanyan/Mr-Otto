// killGroup / groupAlive 的 win32 分支（issue #1033）。
// vitest 跑在 mac 上，win32 分支只能靠注入测：平台与三个系统调用点
// （killTree / signalGroup / probe）都做成 KillDeps 的可注入项——
// 生产代码一个都不传，测试喂 platform:"win32" + 假 runner。
// 默认 runner（taskkillTree）的参数与 windowsHide 用 vi.mock 钉住：
// taskkill 是 console 程序，漏了 windowsHide 的话 #1027 刚修的弹窗
// 从「杀进程」这条路复活，而 mac 门禁上没有任何症状。

import { describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn(
  (_cmd: string, _args: string[], _opts: object) => ({ status: 0 })
);
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawnSync: spawnSyncMock };
});

const { killGroup, groupAlive } = await import("../../src/world/localWorld.js");

const ESRCH = () => Object.assign(new Error("no such process"), { code: "ESRCH" });
const EPERM = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });

describe("killGroup 的 win32 分支（#1033）", () => {
  it("走 killTree 杀整棵 pid 树，不再碰负 pid 信号（Windows 上那是静默 no-op）", () => {
    const killed: number[] = [];
    const signaled: [number, string][] = [];
    killGroup(4321, "SIGTERM", {
      platform: "win32",
      killTree: (pid) => killed.push(pid),
      signalGroup: (pgid, signal) => signaled.push([pgid, signal]),
    });
    expect(killed).toEqual([4321]);
    expect(signaled).toEqual([]);
  });

  it("SIGTERM/SIGKILL 合并成一档：signal 参数不影响杀法（Windows 只有 TerminateProcess 硬杀）", () => {
    const killed: number[] = [];
    killGroup(100, "SIGTERM", { platform: "win32", killTree: (p) => killed.push(p) });
    killGroup(100, "SIGKILL", { platform: "win32", killTree: (p) => killed.push(p) });
    // 调用点的「SIGTERM → 宽限 → SIGKILL」两拍结构不动，第二拍重发 taskkill 是幂等的
    expect(killed).toEqual([100, 100]);
  });

  it("默认 runner 起 taskkill /PID <pid> /T /F，且带 windowsHide（#1027 的弹窗不能从这条路复活）", () => {
    spawnSyncMock.mockClear();
    killGroup(4321, "SIGTERM", { platform: "win32" });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0]!;
    expect(cmd).toBe("taskkill");
    expect(args).toEqual(["/PID", "4321", "/T", "/F"]);
    expect(opts).toMatchObject({ windowsHide: true });
  });
});

describe("groupAlive 的 win32 分支（#1033）", () => {
  it("探的是正 pid（树头），不是负 pid 进程组", () => {
    const probed: number[] = [];
    groupAlive(4321, { platform: "win32", probe: (pid) => probed.push(pid) });
    expect(probed).toEqual([4321]);
  });

  it("probe 抛 ESRCH = 树已死 → false；不抛 → true", () => {
    expect(groupAlive(4321, { platform: "win32", probe: () => { throw ESRCH(); } })).toBe(false);
    expect(groupAlive(4321, { platform: "win32", probe: () => {} })).toBe(true);
  });

  it("EPERM 也算活着（有进程但无权限——POSIX 分支的既有语义在 win32 不变）", () => {
    expect(groupAlive(4321, { platform: "win32", probe: () => { throw EPERM(); } })).toBe(true);
  });
});

describe("POSIX 行为一字不变（回归）", () => {
  it("killGroup 仍走进程组信号（取负在缺省实现里），signal 原样透传，不碰 killTree", () => {
    const signaled: [number, string][] = [];
    const killed: number[] = [];
    killGroup(4321, "SIGKILL", {
      platform: "darwin",
      signalGroup: (pgid, signal) => signaled.push([pgid, signal]),
      killTree: (pid) => killed.push(pid),
    });
    // 注入点拿到的是正 pgid；process.kill(-pgid, …) 的取负在缺省实现里
    expect(signaled).toEqual([[4321, "SIGKILL"]]);
    expect(killed).toEqual([]);
  });

  it("signalGroup 抛错（组已死）照旧吞掉", () => {
    expect(() =>
      killGroup(4321, "SIGTERM", {
        platform: "darwin",
        signalGroup: () => { throw ESRCH(); },
      })
    ).not.toThrow();
  });

  it("groupAlive 仍探负 pid；ESRCH → false，EPERM → true", () => {
    const probed: number[] = [];
    groupAlive(4321, { platform: "darwin", probe: (pid) => probed.push(pid) });
    expect(probed).toEqual([-4321]);
    expect(groupAlive(4321, { platform: "darwin", probe: () => { throw ESRCH(); } })).toBe(false);
    expect(groupAlive(4321, { platform: "darwin", probe: () => { throw EPERM(); } })).toBe(true);
  });
});
