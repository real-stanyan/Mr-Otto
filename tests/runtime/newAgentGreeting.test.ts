// greetOnCreate —— 新建的智能体先开口（#1356 A2，spec §7.2 第 2 步）：抢到那一格才落开场白。
// daemon.ts 进不了 vitest，这段判断在这里钉（接线那半由 daemonNewAgentWiring.test.ts 读源码钉）。
import { describe, expect, it, vi } from "vitest";
import { greetOnCreate } from "../../services/runtime/src/newAgentGreeting.js";

describe("greetOnCreate（#1356 A2）", () => {
  it("抢到了才落开场白，回 true", async () => {
    const greet = vi.fn();
    const log = vi.fn();
    expect(await greetOnCreate({ claimGreeting: async () => true, log }, "w1", "a_000000000001", greet)).toBe(true);
    expect(greet).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
  it("没抢到（那一格不是 greet：桌面建的 / 早开过口 / 别的进程抢先了）→ 什么都不落", async () => {
    const greet = vi.fn();
    expect(await greetOnCreate({ claimGreeting: async () => false, log: vi.fn() }, "w1", "a_000000000001", greet)).toBe(false);
    expect(greet).not.toHaveBeenCalled();
  });
  it("抢的时候出错（0041 没跑 / 库抖了）→ 当没抢到、记一行、不抛", async () => {
    const greet = vi.fn();
    const log = vi.fn();
    const r = await greetOnCreate(
      { claimGreeting: async () => { throw new Error("column does not exist"); }, log },
      "w1", "a_000000000001", greet,
    );
    expect(r).toBe(false);
    expect(greet).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("column does not exist"));
  });
  it("先抢再落：greet 在抢那一下 resolve 之后才调", async () => {
    const order: string[] = [];
    await greetOnCreate(
      { claimGreeting: async () => { order.push("claim"); return true; }, log: vi.fn() },
      "w1", "a_000000000001", () => order.push("greet"),
    );
    expect(order).toEqual(["claim", "greet"]);
  });
});
