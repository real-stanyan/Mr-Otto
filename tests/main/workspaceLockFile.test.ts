// 跨进程锁的落盘那一半（issue #634，ADR-0155）。
//
// 用真临时目录跑：这层的价值全在「两个进程看得见同一份文件」，用假 fs 测等于没测。
// 同进程内没法真起第二个 Electron，所以用「手写一份别的 pid 的锁文件」模拟对方——
// 判定读的就是这份文件，与真的两个进程等价。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceLock } from "../../src/main/workspaceLockFile.js";
import { STALE_AFTER_MS, lockFileName } from "../../src/shared/workspaceLock.js";
import { createHash } from "node:crypto";

let dir: string;
const WS = "/Users/x/repo";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "otter-wslock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 这个工作区的锁文件路径。与实现同一个算法（sha256 前 32 位十六进制）——
    测试自己算，不依赖实现暴露内部路径 */
function lockPath(workspace = WS): string {
  return join(dir, lockFileName(workspace, (x) => createHash("sha256").update(x).digest("hex")));
}

/** 冒充另一个进程写的锁。pid 1 在所有平台上都存在且活着（init/launchd），
    正好表示「对方还在」而不需要真起一个进程 */
async function foreignLock(heartbeatTs: number, pid = 1) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    lockPath(),
    JSON.stringify({ pid, sessionId: "s-other", app: "Mr Otto Dev", heartbeatTs }),
    "utf8"
  );
}

describe("createWorkspaceLock（issue #634）", () => {
  it("没人占 → 拿到句柄；release 之后别人能再拿", () => {
    const a = createWorkspaceLock({ appName: "A", dir });
    const h = a.acquire(WS, "s-1");
    expect(typeof h).not.toBe("string");
    (h as { release(): void }).release();
    expect(typeof a.acquire(WS, "s-2")).not.toBe("string");
  });

  it("别的进程占着且心跳新鲜 → 返回提示语，点名对方", async () => {
    const now = Date.now();
    await foreignLock(now);
    const svc = createWorkspaceLock({ appName: "A", dir, now: () => now + 1_000 });
    const r = svc.acquire(WS, "s-1");
    expect(typeof r).toBe("string");
    expect(r as string).toContain("Mr Otto Dev");
  });

  it("陈旧锁（心跳过期）→ 抢过来，不让一次崩溃把文件夹永久锁死", async () => {
    const now = Date.now();
    await foreignLock(now - STALE_AFTER_MS - 1);
    const svc = createWorkspaceLock({ appName: "A", dir, now: () => now });
    expect(typeof svc.acquire(WS, "s-1")).not.toBe("string");
  });

  it("锁文件坏了 → 当作没锁（fail-open：这一层是额外的一道，不是唯一那道）", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(lockPath(), "{ 这不是 json", "utf8");
    const svc = createWorkspaceLock({ appName: "A", dir });
    expect(typeof svc.acquire(WS, "s-1")).not.toBe("string");
  });

  it("不同工作区互不影响", () => {
    const svc = createWorkspaceLock({ appName: "A", dir });
    const h1 = svc.acquire("/w/one", "s-1");
    expect(typeof h1).not.toBe("string");
    expect(typeof svc.acquire("/w/two", "s-2")).not.toBe("string");
  });

  it("release 可重复调用（turn 收口路径可能走两次）", () => {
    const svc = createWorkspaceLock({ appName: "A", dir });
    const h = svc.acquire(WS, "s-1") as { release(): void };
    h.release();
    expect(() => h.release()).not.toThrow();
  });
});
