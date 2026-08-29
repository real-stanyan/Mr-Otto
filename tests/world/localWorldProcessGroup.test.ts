import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

describe("进程组硬杀", () => {
  it("超时杀掉后台孙进程（旧实现只杀 shell，孙进程逃逸）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    const pidFile = join(dir, "grandchild.pid");
    const world = createLocalWorld({ root: dir });
    // sleep 100 & 是逃逸原型：shell 被杀后它以前会被 reparent 到 launchd
    const r = await world.exec(`sleep 100 & echo $! > ${pidFile}; wait`, {
      timeoutMs: 500,
    });
    expect(r.exitCode).toBe(124);
    const gpid = Number(readFileSync(pidFile, "utf8").trim());
    // SIGTERM 后给 200ms 让信号送达
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(gpid)).toBe(false);
  }, 10_000);

  it("abort 杀掉后台孙进程", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    const pidFile = join(dir, "grandchild.pid");
    const world = createLocalWorld({ root: dir });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(
      world.exec(`sleep 100 & echo $! > ${pidFile}; wait`, { signal: ac.signal })
    ).rejects.toThrow(/中断/);
    const gpid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(gpid)).toBe(false);
  }, 10_000);

  it("调用时 signal 已经 aborted → 同步短路 reject，不起进程（回归：AbortSignal 不重放事后注册的 listener）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    const pidFile = join(dir, "grandchild.pid");
    const world = createLocalWorld({ root: dir });
    const ac = new AbortController();
    ac.abort(); // 调用前已中止——事后 addEventListener("abort", …) 收不到这次
    await expect(
      world.exec(`sleep 100 & echo $! > ${pidFile}; wait`, { signal: ac.signal })
    ).rejects.toThrow(/中断/);
    // 短路不 spawn：连 shell 都没起，pid 文件不该出现
    expect(existsSync(pidFile)).toBe(false);
  }, 10_000);
});
