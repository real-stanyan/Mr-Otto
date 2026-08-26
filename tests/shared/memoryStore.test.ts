import { describe, expect, it } from "vitest";
import {
  applyOps, charCount, formatEntries, parseEntries, MEMORY_LIMITS, ENTRY_DELIMITER,
  parseMemoryResult, MEMORY_RESULT_MARK,
} from "../../src/shared/memoryStore.js";

describe("parseEntries / formatEntries", () => {
  it("null = 空；按 § 切、trim、去空、保序去重", () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries(`a${ENTRY_DELIMITER} b ${ENTRY_DELIMITER}${ENTRY_DELIMITER}a`)).toEqual(["a", "b"]);
  });
  it("round-trip", () => {
    const text = formatEntries(["x", "多行\n第二行"]);
    expect(parseEntries(text)).toEqual(["x", "多行\n第二行"]);
  });
  it("charCount 按码点：emoji 算 1", () => {
    expect(charCount("a😀")).toBe(2);
  });
});

describe("applyOps", () => {
  it("add 追加；精确重复拒绝", () => {
    const r = applyOps("memory", ["a"], [{ action: "add", target: "memory", content: "b" }]);
    expect(r).toMatchObject({ ok: true, entries: ["a", "b"], changed: { added: ["b"] } });
    expect(applyOps("memory", ["a"], [{ action: "add", target: "memory", content: "a" }])).toMatchObject({
      ok: false, error: expect.stringContaining("已存在"),
    });
  });
  it("replace 按唯一子串定位；0 个或多个命中报错", () => {
    const ok = applyOps("memory", ["用户住悉尼", "用户用 pnpm"], [
      { action: "replace", target: "memory", old_text: "悉尼", content: "用户住墨尔本" },
    ]);
    expect(ok).toMatchObject({ ok: true, entries: ["用户住墨尔本", "用户用 pnpm"], changed: { updated: ["用户住墨尔本"] } });
    expect(applyOps("memory", ["用户 a", "用户 b"], [
      { action: "replace", target: "memory", old_text: "用户", content: "x" },
    ])).toMatchObject({ ok: false, error: expect.stringContaining("2 条") });
    expect(applyOps("memory", ["a"], [{ action: "remove", target: "memory", old_text: "zzz" }]))
      .toMatchObject({ ok: false, error: expect.stringContaining("没有") });
  });
  it("批量原子：中途失败整批不落", () => {
    const r = applyOps("memory", ["a"], [
      { action: "add", target: "memory", content: "b" },
      { action: "remove", target: "memory", old_text: "nope" },
    ]);
    expect(r.ok).toBe(false);
  });
  it("字符上限只在批量结果上校验：先 remove 腾地再 add 可以过", () => {
    const big = "x".repeat(MEMORY_LIMITS.user - 10);
    const over = applyOps("user", [big], [{ action: "add", target: "user", content: "y".repeat(20) }]);
    expect(over).toMatchObject({ ok: false, error: expect.stringContaining("1375") });
    const swap = applyOps("user", [big], [
      { action: "remove", target: "user", old_text: "xxxx" },
      { action: "add", target: "user", content: "y".repeat(20) },
    ]);
    expect(swap.ok).toBe(true);
  });
  it("target 不匹配的 op 报错", () => {
    expect(applyOps("memory", [], [{ action: "add", target: "user", content: "x" }]).ok).toBe(false);
  });
  it("content 混进分隔符 § 拒绝：add 和 replace 都要挡", () => {
    expect(applyOps("memory", [], [
      { action: "add", target: "memory", content: `一半${ENTRY_DELIMITER}另一半` },
    ])).toMatchObject({ ok: false, error: expect.stringContaining("条目内容不能包含分隔符 §") });
    expect(applyOps("memory", [], [
      { action: "add", target: "memory", content: "第一行\n§\n第二行" },
    ])).toMatchObject({ ok: false, error: expect.stringContaining("条目内容不能包含分隔符 §") });
    expect(applyOps("memory", ["旧条目"], [
      { action: "replace", target: "memory", old_text: "旧条目", content: `新的${ENTRY_DELIMITER}内容` },
    ])).toMatchObject({ ok: false, error: expect.stringContaining("条目内容不能包含分隔符 §") });
  });
});

describe("parseMemoryResult", () => {
  it("valid result parses correctly", () => {
    const output = `已更新…\n${MEMORY_RESULT_MARK}{"ok":true,"target":"user","added":["x"],"updated":[],"removed":[],"used":1,"limit":1375}-->`;
    const result = parseMemoryResult(output);
    expect(result).toEqual({
      ok: true,
      target: "user",
      added: ["x"],
      updated: [],
      removed: [],
      used: 1,
      limit: 1375,
    });
  });
  it("invalid or missing marks return null", () => {
    expect(parseMemoryResult("no mark")).toBeNull();
    expect(parseMemoryResult(`${MEMORY_RESULT_MARK}{bad-->`)).toBeNull();
  });
  it("valid JSON but ok !== true returns null", () => {
    expect(parseMemoryResult(`${MEMORY_RESULT_MARK}{"ok":false,"target":"user","added":[],"updated":[],"removed":[],"used":0,"limit":1375}-->`)).toBeNull();
  });
  it("valid JSON but ok field absent returns null", () => {
    expect(parseMemoryResult(`${MEMORY_RESULT_MARK}{"target":"user","added":[],"updated":[],"removed":[],"used":0,"limit":1375}-->`)).toBeNull();
  });
});

import { memoryRelPath, isMemoryTarget, withMemoryFileLock } from "../../src/shared/memoryStore.js";

describe("三档路径与上限", () => {
  it("memoryRelPath：三档各自的相对路径", () => {
    expect(memoryRelPath("user")).toBe("memories/USER.md");
    expect(memoryRelPath("memory")).toBe("memories/MEMORY.md");
    expect(memoryRelPath("project", "memories/projects/abc123")).toBe("memories/projects/abc123/MEMORY.md");
  });

  it("memoryRelPath：project 没给 projectDir 就抛——绝不静默落到全局档", () => {
    expect(() => memoryRelPath("project")).toThrow(/projectDir/);
    expect(() => memoryRelPath("project", null)).toThrow(/projectDir/);
  });

  it("isMemoryTarget 认得第三档", () => {
    expect(isMemoryTarget("project")).toBe(true);
    expect(isMemoryTarget("projects")).toBe(false);
  });

  it("三档上限：全局档让位给项目档", () => {
    expect(MEMORY_LIMITS).toEqual({ memory: 1100, user: 1375, project: 2200 });
  });

  it("project 超限的报错文案带 PROJECT 字样", () => {
    const long = "x".repeat(2300);
    const r = applyOps("project", [], [{ action: "add", target: "project", content: long }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("PROJECT") });
    expect((r as { error: string }).error).toContain("2200");
  });
});

describe("withMemoryFileLock 按文件路径加锁", () => {
  it("同一路径串行", async () => {
    const order: string[] = [];
    const p = "memories/MEMORY.md";
    const a = withMemoryFileLock(p, async () => { order.push("a-in"); await Promise.resolve(); order.push("a-out"); });
    const b = withMemoryFileLock(p, async () => { order.push("b-in"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-in", "a-out", "b-in"]);
  });

  it("不同项目的项目档互不阻塞（锁 key 是路径不是 target）", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const a = withMemoryFileLock("memories/projects/aaa/MEMORY.md", async () => { order.push("a-in"); await gate; order.push("a-out"); });
    const b = withMemoryFileLock("memories/projects/bbb/MEMORY.md", async () => { order.push("b-in"); });
    await b;
    expect(order).toEqual(["a-in", "b-in"]); // b 没被 a 堵住
    releaseA();
    await a;
  });
});

import { assertMemoryFits } from "../../src/shared/memoryStore.js";

// moveToProject（设置页「移到项目档」，src/renderer/src/components/MemorySettings.tsx）
// 在写盘前用 assertMemoryFits 做前置超限检查，写盘本身发生在渲染层，没有 RTL 测不了
// 组件本体（见 MemorySettings.tsx 顶部注释）——但这条检查底下就是纯函数组合，这里
// 直接测这一层，覆盖 moveToProject 会撞到的三种情况：不超限、超限、去重后没超限。
describe("assertMemoryFits（moveToProject 的超限前置检查用的是这条）", () => {
  it("没超限：不抛", () => {
    expect(() => assertMemoryFits("project", "x".repeat(2200))).not.toThrow();
  });

  it("超限：抛错，文案带 target 的大写标签 + used/limit 数字，同 applyOps 的报错语义", () => {
    expect(() => assertMemoryFits("project", "x".repeat(2201))).toThrow(/PROJECT 超限.*2201\/2200/);
  });

  it("按归一化后的长度算，不是原始字符串长度——三条重复条目归一化后只剩一条", () => {
    const text = ["x".repeat(2200), "x".repeat(2200), "x".repeat(2200)].join(ENTRY_DELIMITER);
    expect(() => assertMemoryFits("project", text)).not.toThrow();
  });

  it("三档各自认自己的上限", () => {
    expect(() => assertMemoryFits("memory", "x".repeat(1101))).toThrow(/MEMORY 超限/);
    expect(() => assertMemoryFits("user", "x".repeat(1376))).toThrow(/USER 超限/);
  });
});
