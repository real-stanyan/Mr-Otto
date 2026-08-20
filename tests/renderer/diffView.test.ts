import { describe, it, expect } from "vitest";
import { diffView, diffDoc, composeContent } from "../../src/renderer/src/lib/diffView.js";

describe("diffView", () => {
  it("新文件:全是 added,删除计数为 0", () => {
    const v = diffView(null, "a\nb");
    expect(v).toEqual({
      lines: [
        { kind: "added", text: "a" },
        { kind: "added", text: "b" },
      ],
      additions: 2,
      deletions: 0,
    });
  });

  it("改一行:一删一加,计数各 1", () => {
    const v = diffView("a", "b");
    expect(v?.additions).toBe(1);
    expect(v?.deletions).toBe(1);
    expect(v?.lines.map((l) => l.kind)).toEqual(["removed", "added"]);
  });

  it("短的未变段原样留着 —— 折叠它反而更占地方", () => {
    // 5 行未变 = 上下文上限(2*2+1),不折
    const same = ["1", "2", "3", "4", "5"];
    const v = diffView(["x", ...same].join("\n"), ["y", ...same].join("\n"));
    expect(v?.lines.filter((l) => l.kind === "skip")).toHaveLength(0);
    expect(v?.lines.filter((l) => l.kind === "context")).toHaveLength(5);
  });

  it("长的未变段抽掉中间,首尾各留两行,中间换成一句计数", () => {
    const same = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const v = diffView(["x", ...same].join("\n"), ["y", ...same].join("\n"));
    const kinds = v!.lines.map((l) => l.kind);
    expect(kinds).toEqual([
      "removed",
      "added",
      "context",
      "context",
      "skip",
      "context",
      "context",
    ]);
    expect(v!.lines.find((l) => l.kind === "skip")?.text).toBe("… 6 行未变 …");
  });

  it("折叠行不进增删计数 —— 它是一句说明,不是一行改动", () => {
    const same = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const v = diffView(same.join("\n"), [...same, "new"].join("\n"));
    expect(v?.additions).toBe(1);
    expect(v?.deletions).toBe(0);
  });

  it("没改:全是 context,增删都是 0", () => {
    const v = diffView("a\nb", "a\nb");
    expect(v?.additions).toBe(0);
    expect(v?.deletions).toBe(0);
    expect(v?.lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("算不动的超大文件返回 null,调用方据此退回文本兜底", () => {
    const huge = Array.from({ length: 2100 }, (_, i) => String(i)).join("\n");
    const other = Array.from({ length: 2100 }, (_, i) => String(i * 2)).join("\n");
    expect(diffView(huge, other)).toBeNull();
  });
});

describe("diffDoc — 分块", () => {
  it("一处改动 = 一块,带两侧各两行上下文", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const neu = ["a", "b", "c", "X", "e", "f", "g"].join("\n");
    const doc = diffDoc(old, neu)!;
    expect(doc.hunks).toHaveLength(1);
    expect(doc.hunks[0]!.lines.map((l) => l.kind)).toEqual([
      "context", "context", "removed", "added", "context", "context",
    ]);
    expect(doc.additions).toBe(1);
    expect(doc.deletions).toBe(1);
  });

  it("隔得远的两处改动分成两块", () => {
    const filler = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const old = ["a", ...filler, "z"].join("\n");
    const neu = ["A", ...filler, "Z"].join("\n");
    const doc = diffDoc(old, neu)!;
    expect(doc.hunks).toHaveLength(2);
    expect(doc.hunks.map((h) => h.id)).toEqual(["h0", "h1"]);
  });

  it("隔得近的两处改动合成一块 —— 不逼人对同一处按两次", () => {
    const old = ["a", "1", "2", "3", "z"].join("\n");
    const neu = ["A", "1", "2", "3", "Z"].join("\n");
    const doc = diffDoc(old, neu)!;
    expect(doc.hunks).toHaveLength(1);
  });

  it("没有任何改动 = 零块", () => {
    expect(diffDoc("a\nb", "a\nb")!.hunks).toEqual([]);
  });

  it("range 是新文件里的行号", () => {
    const old = ["a", "b", "c", "d", "e"].join("\n");
    const neu = ["a", "b", "X", "d", "e"].join("\n");
    expect(diffDoc(old, neu)!.hunks[0]!.range).toBe("第 1–5 行");
  });
});

describe("composeContent — 按取舍拼内容", () => {
  const old = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
               "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"].join("\n");
  const neu = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j",
               "k", "l", "m", "n", "o", "p", "q", "r", "s", "T"].join("\n");

  it("一块没丢就是模型请求的原文(连字符串都不重拼)", () => {
    expect(composeContent(old, neu, new Set())).toBe(neu);
  });

  it("丢掉第一块:那一段回到旧样子,另一块照改", () => {
    const doc = diffDoc(old, neu)!;
    expect(doc.hunks).toHaveLength(2);
    const out = composeContent(old, neu, new Set([doc.hunks[0]!.id]))!;
    expect(out.split("\n")[0]).toBe("a");
    expect(out.split("\n").at(-1)).toBe("T");
  });

  it("两块全丢 = 旧文件原样(等于没改)", () => {
    const doc = diffDoc(old, neu)!;
    const out = composeContent(old, neu, new Set(doc.hunks.map((h) => h.id)))!;
    expect(out).toBe(old);
  });

  it("新文件把唯一那块丢掉 = 空文件", () => {
    expect(composeContent(null, "x\ny", new Set(["h0"]))).toBe("");
  });

  it("id 不认识就当没丢 —— 不许因为一个野 id 把改动整段吞掉", () => {
    expect(composeContent(old, neu, new Set(["h99"]))).toBe(neu);
  });
});
