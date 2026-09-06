import { describe, it, expect } from "vitest";
import { createWorkspaceLock, createWorkspaceLocks, lockAbortedError } from "../../services/runtime/src/workspaceLock.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("容器锁（#979 第 2 条，ADR-0232）", () => {
  it("空闲直接给；被占则 FIFO 排队，放锁那一刻下一位拿到", async () => {
    const lock = createWorkspaceLock();
    const r1 = await lock.acquire("s1");
    expect(lock.holder()).toBe("s1");
    const order: string[] = [];
    const p2 = lock.acquire("s2").then((r) => { order.push("s2"); return r; });
    const p3 = lock.acquire("s3").then((r) => { order.push("s3"); return r; });
    await tick();
    expect(order).toEqual([]);
    expect(lock.waiting()).toBe(2);
    r1();
    const r2 = await p2;
    expect(order).toEqual(["s2"]);
    expect(lock.holder()).toBe("s2");
    r2();
    await p3;
    expect(order).toEqual(["s2", "s3"]);
    expect(lock.holder()).toBe("s3");
  });

  it("放锁幂等：同一个 release 调两次不会把别人的锁也放掉", async () => {
    const lock = createWorkspaceLock();
    const r1 = await lock.acquire("s1");
    r1();
    const r2 = await lock.acquire("s2");
    r1(); // 陈旧的那把，应无操作
    expect(lock.holder()).toBe("s2");
    r2();
    expect(lock.holder()).toBeNull();
  });

  it("等待期间 abort → reject 且从队列摘掉；后面的人照常按序拿到", async () => {
    const lock = createWorkspaceLock();
    const r1 = await lock.acquire("s1");
    const ac = new AbortController();
    const p2 = lock.acquire("s2", ac.signal);
    const p3 = lock.acquire("s3");
    ac.abort();
    await expect(p2).rejects.toThrow(lockAbortedError().message);
    expect(lock.waiting()).toBe(1);
    r1();
    const r3 = await p3;
    expect(lock.holder()).toBe("s3");
    r3();
  });

  it("调用时已 abort：不排队直接 reject", async () => {
    const lock = createWorkspaceLock();
    const ac = new AbortController();
    ac.abort();
    await expect(lock.acquire("s1", ac.signal)).rejects.toThrow();
    expect(lock.holder()).toBeNull();
    expect(lock.waiting()).toBe(0);
  });

  it("createWorkspaceLocks：同一个工作区拿到同一把，不同工作区各一把", () => {
    const locks = createWorkspaceLocks();
    expect(locks.for("w1")).toBe(locks.for("w1"));
    expect(locks.for("w1")).not.toBe(locks.for("w2"));
  });
});
