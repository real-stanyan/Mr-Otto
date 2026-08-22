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
