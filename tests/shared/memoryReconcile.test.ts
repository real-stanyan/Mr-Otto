import { describe, expect, it } from "vitest";
import { planReconcile } from "../../src/shared/memoryReconcile.js";

describe("planReconcile —— 后写胜，内容相同不动", () => {
  it("只有本地 → push；只有云端 → pull", () => {
    const p = planReconcile(
      [{ key: "memories/USER.md", content: "a", mtimeMs: 10 }],
      [{ key: "memories/MEMORY.md", content: "b", updatedAtMs: 20 }],
    );
    expect(p.push.map((d) => d.key)).toEqual(["memories/USER.md"]);
    expect(p.pull.map((d) => d.key)).toEqual(["memories/MEMORY.md"]);
  });
  it("两边都有且内容相同 → 不动（不管时间）", () => {
    const p = planReconcile(
      [{ key: "k", content: "same", mtimeMs: 1 }],
      [{ key: "k", content: "same", updatedAtMs: 999 }],
    );
    expect(p).toEqual({ pull: [], push: [] });
  });
  it("内容不同：云端新 → pull；本地新或相等 → push", () => {
    const newer = planReconcile([{ key: "k", content: "l", mtimeMs: 1 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(newer.pull.map((d) => d.key)).toEqual(["k"]);
    expect(newer.push).toEqual([]);
    const older = planReconcile([{ key: "k", content: "l", mtimeMs: 3 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(older.push.map((d) => d.key)).toEqual(["k"]);
    const tie = planReconcile([{ key: "k", content: "l", mtimeMs: 2 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(tie.push.map((d) => d.key)).toEqual(["k"]);
  });
  it("输出按 key 排序，输入不改", () => {
    const local = [{ key: "z", content: "1", mtimeMs: 1 }, { key: "a", content: "1", mtimeMs: 1 }];
    const p = planReconcile(local, []);
    expect(p.push.map((d) => d.key)).toEqual(["a", "z"]);
    expect(local[0]!.key).toBe("z");
  });
});
