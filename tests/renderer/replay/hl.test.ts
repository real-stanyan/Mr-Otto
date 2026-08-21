import { describe, it, expect } from "vitest";
import { hl } from "../../../src/renderer/src/replay/hl.js";

describe("hl：数据卡迷你高亮器", () => {
  it("key（后跟冒号）与普通字符串分开着色", () => {
    const toks = hl('{ "path": "a.txt" }');
    expect(toks.find((t) => t.text === '"path"')?.cls).toBe("hk");
    expect(toks.find((t) => t.text === '"a.txt"')?.cls).toBe("hs");
  });

  it("数字 / 关键字 / 标识符各归各类，素色文字原样保留", () => {
    const toks = hl("seq = 42 → return foo");
    expect(toks.find((t) => t.text === "42")?.cls).toBe("hd");
    expect(toks.find((t) => t.text === "return")?.cls).toBe("hw");
    expect(toks.find((t) => t.text === "foo")?.cls).toBe("hv");
    // 拼回去 = 原文（一个字都不丢——高亮器只染色不改内容）
    expect(toks.map((t) => t.text).join("")).toBe("seq = 42 → return foo");
  });
});

