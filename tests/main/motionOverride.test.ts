import { describe, expect, it, vi } from "vitest";
import { applyMotionPref, type MotionOverrideHost } from "../../src/main/motionOverride.js";

const host = (opts: Partial<MotionOverrideHost> & { reduce?: boolean } = {}) => {
  const calls: (string | null)[] = [];
  const logs: string[] = [];
  const h: MotionOverrideHost = {
    prefersReduce: opts.prefersReduce ?? (() => Promise.resolve(opts.reduce ?? false)),
    emulate: opts.emulate ?? ((v) => {
      calls.push(v);
      return Promise.resolve();
    }),
    log: (m) => logs.push(m),
  };
  return { h, calls, logs };
};

describe("applyMotionPref", () => {
  it("跟随系统 = 撤掉覆盖", async () => {
    const { h, calls } = host({ reduce: true });
    expect(await applyMotionPref("system", h)).toBe("cleared");
    expect(calls).toEqual([null]);
  });

  it("始终开启 + 系统确实减弱 = 挂覆盖", async () => {
    const { h, calls } = host({ reduce: true });
    expect(await applyMotionPref("always", h)).toBe("overridden");
    expect(calls).toEqual(["no-preference"]);
  });

  it("始终开启但系统本来就没减弱 = 一行调试器都不挂", async () => {
    const { h, calls } = host({ reduce: false });
    expect(await applyMotionPref("always", h)).toBe("not-needed");
    expect(calls).toEqual([]);
  });

  it("挂不上(DevTools 占着调试器)不抛,记一行日志", async () => {
    const { h, logs } = host({
      reduce: true,
      emulate: () => Promise.reject(new Error("Another debugger is already attached")),
    });
    expect(await applyMotionPref("always", h)).toBe("failed");
    expect(logs[0]).toContain("Another debugger");
  });

  it("查询失败也算 failed——不让窗口起不来", async () => {
    const { h } = host({ prefersReduce: () => Promise.reject(new Error("render frame gone")) });
    expect(await applyMotionPref("always", h)).toBe("failed");
  });

  it("不需要覆盖时不去问 emulate,也不多问一次系统", async () => {
    const prefersReduce = vi.fn(() => Promise.resolve(false));
    const { h } = host({ prefersReduce });
    await applyMotionPref("always", h);
    expect(prefersReduce).toHaveBeenCalledTimes(1);
  });
});
