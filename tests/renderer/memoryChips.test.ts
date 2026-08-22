import { describe, expect, it } from "vitest";
import { chipEntryText, memoryChipsFromResult } from "../../src/renderer/src/aui/memoryChips.js";
import type { MemoryToolResult } from "../../src/shared/memoryStore.js";

function result(partial: Partial<MemoryToolResult>): MemoryToolResult {
  return {
    ok: true,
    target: "user",
    added: [],
    updated: [],
    removed: [],
    used: 0,
    limit: 1375,
    ...partial,
  };
}

describe("memoryChipsFromResult", () => {
  it("added 在前,updated 跟后;id 分别带 a:/u: 前缀", () => {
    const chips = memoryChipsFromResult(result({ added: ["用户住悉尼"], updated: ["用 pnpm"] }));
    expect(chips).toEqual([
      { id: "a:用户住悉尼", text: "用户住悉尼", change: "added" },
      { id: "u:用 pnpm", text: "用 pnpm", change: "updated" },
    ]);
  });

  it("都为空 → 空数组(调用方据此决定整张卡要不要渲染)", () => {
    expect(memoryChipsFromResult(result({}))).toEqual([]);
  });

  it("removed 不进 chips —— 工具卡只展示新增/更新,删除没有对应的「忘掉」动作", () => {
    const chips = memoryChipsFromResult(result({ removed: ["旧条目"] }));
    expect(chips).toEqual([]);
  });
});

describe("chipEntryText", () => {
  it("去掉两字节前缀,拿回原文", () => {
    expect(chipEntryText("a:用户住悉尼")).toBe("用户住悉尼");
    expect(chipEntryText("u:用 pnpm")).toBe("用 pnpm");
  });
});
