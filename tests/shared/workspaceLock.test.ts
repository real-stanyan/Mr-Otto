// 跨进程工作区锁的可执行版（issue #634，ADR-0155）。
//
// 这层锁最危险的失败不是「没挡住」，是**挡错了**——一次崩溃留下的陈旧锁如果永远
// 算数，那个文件夹就再也用不了了。所以自愈的两道判据（心跳过期 / 进程已死）各有
// 断言压着，比「能挡住」那条更重要。

import { describe, it, expect } from "vitest";
import {
  lockHeld,
  lockFileName,
  crossProcessMessage,
  STALE_AFTER_MS,
  type WorkspaceLockFile,
} from "../../src/shared/workspaceLock.js";

const lock = (over: Partial<WorkspaceLockFile> = {}): WorkspaceLockFile => ({
  pid: 4242,
  sessionId: "s-1",
  app: "Mr Otto",
  heartbeatTs: 1_000_000,
  ...over,
});

const alive = () => true;
const dead = () => false;

describe("lockHeld：别的进程还占着吗（issue #634）", () => {
  it("心跳新鲜 + 进程活着 → 占着，本进程退让", () => {
    expect(lockHeld(lock(), 1_000_000 + 5_000, alive, 1)).toBe(true);
  });

  it("心跳过期 → 陈旧，可以抢（机器休眠 / 进程卡死不该把文件夹锁死）", () => {
    expect(lockHeld(lock(), 1_000_000 + STALE_AFTER_MS + 1, alive, 1)).toBe(false);
  });

  it("进程已经不在 → 陈旧，可以抢（崩溃自愈）", () => {
    expect(lockHeld(lock(), 1_000_000 + 1, dead, 1)).toBe(false);
  });

  it("自己写的锁不挡自己——同进程那一半由 ADR-0152 管", () => {
    expect(lockHeld(lock({ pid: 99 }), 1_000_000 + 1, alive, 99)).toBe(false);
  });
});

describe("lockFileName", () => {
  it("同一路径稳定、不同路径不同，且不含路径分隔符", () => {
    const h = (s: string) => `${s.length}`.padEnd(64, "a");
    const a = lockFileName("/w/one", h);
    expect(a).toBe(lockFileName("/w/one", h));
    expect(a).not.toContain("/");
    expect(a).not.toBe(lockFileName("/w/another/deeper", h));
  });
});

describe("crossProcessMessage", () => {
  it("点名程序与进程号，并说明锁会自己过期", () => {
    const m = crossProcessMessage(lock({ app: "Mr Otto Dev" }), "/Users/x/repo");
    expect(m).toContain("Mr Otto Dev");
    expect(m).toContain("4242");
    expect(m).toContain("/Users/x/repo");
    // 「等一分钟会过期」必须在场：否则用户以为自己被永久锁死了
    expect(m).toContain("过期");
  });
});
