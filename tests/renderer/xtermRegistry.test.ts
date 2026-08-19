import { describe, it, expect, vi } from "vitest";
import { createXtermRegistry } from "../../src/renderer/src/lib/xtermRegistry.js";

function fakeFactory() {
  const disposed: string[] = [];
  const made: string[] = [];
  return {
    disposed,
    made,
    factory: (id: string) => {
      made.push(id);
      return { dispose: () => disposed.push(id) };
    },
  };
}

describe("xtermRegistry", () => {
  it("同一个 id 只造一次实例（切走再切回来拿回同一个）", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    const a = reg.get("t1");
    const b = reg.get("t1");
    expect(a).toBe(b);
    expect(f.made).toEqual(["t1"]);
  });

  it("不同 id 各造各的", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    expect(reg.get("t1")).not.toBe(reg.get("t2"));
    expect(f.made).toEqual(["t1", "t2"]);
  });

  it("dispose 只在显式调用时发生——这就是'关面板不丢滚动历史'的实现", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    reg.get("t1");
    expect(f.disposed).toEqual([]); // 没人调 dispose，实例就活着
    reg.dispose("t1");
    expect(f.disposed).toEqual(["t1"]);
  });

  it("dispose 之后再 get 是一个全新实例", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    const a = reg.get("t1");
    reg.dispose("t1");
    const b = reg.get("t1");
    expect(b).not.toBe(a);
    expect(f.made).toEqual(["t1", "t1"]);
  });

  it("dispose 不存在的 id 不炸", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    expect(() => reg.dispose("nope")).not.toThrow();
  });

  it("disposeAll 清空所有实例", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    reg.get("t1");
    reg.get("t2");
    reg.disposeAll();
    expect(f.disposed.sort()).toEqual(["t1", "t2"]);
  });
});
