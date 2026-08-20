import { describe, expect, it } from "vitest";
import { ottoDirectiveFormatter } from "../../src/renderer/src/aui/ottoDirectives.js";

const f = ottoDirectiveFormatter(["review", "review-pr", "写代码"]);

describe("ottoDirectiveFormatter", () => {
  it("serialize 出的就是本仓的真语法(末尾带空格,光标直接接正文)", () => {
    expect(f.serialize({ id: "review", type: "skill", label: "review" })).toBe("$review ");
  });

  it("句中的 $skill 认成 chip,两边的普通文本原样留着", () => {
    expect(f.parse("参考 $review 的做法")).toEqual([
      { kind: "text", text: "参考 " },
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "text", text: " 的做法" },
    ]);
  });

  it("最长优先:$review-pr 不会只认成 $review", () => {
    expect(f.parse("$review-pr")).toEqual([
      { kind: "mention", type: "skill", label: "$review-pr", id: "review-pr" },
    ]);
  });

  it("不在名单里的 $ 只是普通字符 —— 价格、shell 变量、正则行尾都不该变 chip", () => {
    expect(f.parse("要 $100,还有 $PATH 和 /a$/")).toEqual([
      { kind: "text", text: "要 $100,还有 $PATH 和 /a$/" },
    ]);
  });

  it("名字里不吃中文/标点:$review。 的句号留在正文里", () => {
    expect(f.parse("$review。")).toEqual([
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "text", text: "。" },
    ]);
  });

  it("非 ASCII 的 skill 名认不出来 —— 名字只吃字母数字连字符下划线", () => {
    // 名单里有「写代码」,但 $ 后面第一个字符就不在允许集里,整条退回普通文本。
    // 这是刻意的取舍:允许中文的话「$写代码的时候」会把后面的字一路吃进名字
    expect(f.parse("$写代码")).toEqual([{ kind: "text", text: "$写代码" }]);
  });

  it("空文本也给一个 segment —— DirectiveText 的快路径判的是 segments.length === 1", () => {
    expect(f.parse("")).toEqual([{ kind: "text", text: "" }]);
  });

  it("相邻两个 chip 之间没有多余的空 text 段", () => {
    expect(f.parse("$review$review-pr")).toEqual([
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "mention", type: "skill", label: "$review-pr", id: "review-pr" },
    ]);
  });
});
