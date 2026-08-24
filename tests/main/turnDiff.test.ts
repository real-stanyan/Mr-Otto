import { describe, expect, it } from "vitest";
import { TurnDiffTracker, createTurnDiffMiddleware } from "../../src/main/turnDiff.js";
import type { ToolCallContext, ToolOutcome } from "../../src/loop/middleware.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { TurnDiffUpdate } from "../../src/shared/shellBridge.js";

// turn 级聚合 diff（issue #345）：同文件多次修改叠成一份、基线只记第一次、
// turnId 换代整份作废、失败/被拒的写盘不进聚合。

describe("TurnDiffTracker", () => {
  it("同文件多次修改叠加为一份 diff（基线 → 最后写入，不是逐次相邻 diff）", () => {
    const t = new TurnDiffTracker();
    t.noteBaseline(1, "/a.txt", "one\ntwo");
    t.noteWrite("s1", 1, "/a.txt", "one\ntwo\nthree");
    // 第二次写同一个文件：基线不覆盖
    t.noteBaseline(1, "/a.txt", "one\ntwo\nthree");
    const u = t.noteWrite("s1", 1, "/a.txt", "one\nTWO\nthree");
    expect(u.files).toHaveLength(1);
    // 相对原始基线：two→TWO（1 增 1 删），three 新增 = 共 +2 −1
    expect(u.files[0]).toMatchObject({ path: "/a.txt", additions: 2, deletions: 1 });
    expect(u.additions).toBe(2);
    expect(u.deletions).toBe(1);
    expect(u.turnId).toBe(1);
  });

  it("多文件汇总；新文件基线 null 全算新增", () => {
    const t = new TurnDiffTracker();
    t.noteBaseline(1, "/a.txt", "x");
    t.noteWrite("s1", 1, "/a.txt", "y");
    t.noteBaseline(1, "/new.txt", null);
    const u = t.noteWrite("s1", 1, "/new.txt", "l1\nl2\nl3");
    expect(u.files.map((f) => f.path).sort()).toEqual(["/a.txt", "/new.txt"]);
    const nf = u.files.find((f) => f.path === "/new.txt")!;
    expect(nf).toMatchObject({ additions: 3, deletions: 0 });
    expect(u.additions).toBe(1 + 3);
    expect(u.deletions).toBe(1);
  });

  it("turnId 换代：上一轮的聚合整份作废", () => {
    const t = new TurnDiffTracker();
    t.noteBaseline(1, "/a.txt", "x");
    t.noteWrite("s1", 1, "/a.txt", "y");
    t.noteBaseline(9, "/b.txt", null);
    const u = t.noteWrite("s1", 9, "/b.txt", "hi");
    expect(u.turnId).toBe(9);
    expect(u.files.map((f) => f.path)).toEqual(["/b.txt"]);
  });

  it("写入一模一样的内容 = 零改动，不进清单", () => {
    const t = new TurnDiffTracker();
    t.noteBaseline(1, "/a.txt", "same");
    const u = t.noteWrite("s1", 1, "/a.txt", "same");
    expect(u.files).toEqual([]);
    expect(u.additions).toBe(0);
  });

  it("超大文件退化为行数计数，lines 缺席", () => {
    const t = new TurnDiffTracker();
    const big = "x\n".repeat(150_000); // 300k 字符 > 200k 上限
    t.noteBaseline(1, "/big.txt", null);
    const u = t.noteWrite("s1", 1, "/big.txt", big);
    expect(u.files[0]!.lines).toBeUndefined();
    expect(u.files[0]!.additions).toBeGreaterThan(0);
  });
});

describe("createTurnDiffMiddleware", () => {
  const world = (files: Record<string, string>): ExecutionWorld => ({
    fs: {
      read: async (p) => {
        if (p in files) return files[p]!;
        throw new Error("ENOENT");
      },
      write: async (p, c) => {
        files[p] = c;
      },
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  });

  const ctx = (w: ExecutionWorld, name: string, args: unknown): ToolCallContext => ({
    call: { id: "c1", name, args },
    tool: undefined,
    world: w,
    sessionId: "s1",
  });

  it("写成推聚合：基线取自写前盘上内容", async () => {
    const files: Record<string, string> = { "/a.txt": "old" };
    const w = world(files);
    const updates: TurnDiffUpdate[] = [];
    const mw = createTurnDiffMiddleware(new TurnDiffTracker(), "s1", () => 7, (u) => updates.push(u));

    const outcome = await mw(ctx(w, "write_file", { path: "/a.txt", content: "new" }), async () => {
      await w.fs.write("/a.txt", "new");
      return { status: "ok", output: "写好了" } satisfies ToolOutcome;
    });

    expect(outcome.status).toBe("ok");
    expect(updates).toHaveLength(1);
    expect(updates[0]!).toMatchObject({ sessionId: "s1", turnId: 7, additions: 1, deletions: 1 });
  });

  it("写盘失败/被拒不推、不进聚合", async () => {
    const w = world({ "/a.txt": "old" });
    const updates: TurnDiffUpdate[] = [];
    const mw = createTurnDiffMiddleware(new TurnDiffTracker(), "s1", () => 7, (u) => updates.push(u));

    await mw(ctx(w, "write_file", { path: "/a.txt", content: "new" }), async () => ({
      status: "denied",
      output: "用户拒绝",
    }));
    expect(updates).toEqual([]);
  });

  it("非 write_file / 形状不对 / turn 之外：放行不记账", async () => {
    const w = world({});
    const updates: TurnDiffUpdate[] = [];
    const mkNext = () => async () => ({ status: "ok", output: "" }) as ToolOutcome;

    const mw = createTurnDiffMiddleware(new TurnDiffTracker(), "s1", () => 7, (u) => updates.push(u));
    await mw(ctx(w, "bash", { cmd: "ls" }), mkNext());
    await mw(ctx(w, "write_file", { path: 42, content: "x" }), mkNext());
    const idleMw = createTurnDiffMiddleware(new TurnDiffTracker(), "s1", () => null, (u) => updates.push(u));
    await idleMw(ctx(w, "write_file", { path: "/a", content: "x" }), mkNext());

    expect(updates).toEqual([]);
  });
});
