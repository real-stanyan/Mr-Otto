import { describe, it, expect, vi } from "vitest";
import { singleFlight } from "../../src/shared/singleFlight.js";

const defer = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("singleFlight", () => {
  it("同一个 key 并发调用只跑一次 build（issue #155 的那条竞态）", async () => {
    const run = singleFlight<string, number>();
    const gate = defer<number>();
    const build = vi.fn(() => gate.promise);

    const a = run("s1", build);
    const b = run("s1", build);
    expect(build).toHaveBeenCalledTimes(1);

    gate.resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
  });

  it("不同 key 各跑各的", async () => {
    const run = singleFlight<string, string>();
    const build = vi.fn((v: string) => Promise.resolve(v));
    const [a, b] = await Promise.all([run("s1", () => build("a")), run("s2", () => build("b"))]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("settle 之后 key 释放：下一次是全新的一次，不是缓存", async () => {
    const run = singleFlight<string, number>();
    let n = 0;
    const build = () => Promise.resolve(++n);
    expect(await run("s1", build)).toBe(1);
    expect(await run("s1", build)).toBe(2);
  });

  it("失败的那次，两个调用方拿到同一个错误", async () => {
    const run = singleFlight<string, number>();
    const gate = defer<number>();
    const a = run("s1", () => gate.promise);
    const b = run("s1", () => Promise.resolve(999));
    gate.reject(new Error("这个子会话正在跑"));
    await expect(a).rejects.toThrow("这个子会话正在跑");
    await expect(b).rejects.toThrow("这个子会话正在跑");
  });

  it("失败之后 key 也释放，可以重试", async () => {
    const run = singleFlight<string, number>();
    await expect(run("s1", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(run("s1", () => Promise.resolve(1))).resolves.toBe(1);
  });

  it("build 同步抛也变成 rejection（不炸穿调用点）", async () => {
    const run = singleFlight<string, number>();
    await expect(
      run("s1", () => { throw new Error("同步炸"); })
    ).rejects.toThrow("同步炸");
  });
});
