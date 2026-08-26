import { describe, expect, it } from "vitest";
import { inline, parseMarkdown } from "../../../src/shared/remote/markdown.js";

describe("parseMarkdown", () => {
  it("围栏代码块带语言", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n```")).toEqual([
      { kind: "code", lang: "ts", text: "const a = 1;" },
    ]);
  });

  it("没有收尾围栏的代码块照样成块 —— 流式输出的最后一块永远是没收尾的", () => {
    expect(parseMarkdown("```\nhalf")).toEqual([{ kind: "code", lang: "", text: "half" }]);
  });

  it("标题 / 无序 / 有序", () => {
    const bs = parseMarkdown("## 标题\n- 一\n1. 二");
    expect(bs.map((b) => b.kind)).toEqual(["heading", "bullet", "ordered"]);
    expect(bs[0]).toMatchObject({ level: 2 });
    expect(bs[2]).toMatchObject({ marker: "1" });
  });

  it("空行只做分隔,不产出块", () => {
    expect(parseMarkdown("a\n\n\nb").map((b) => b.kind)).toEqual(["para", "para"]);
  });
});

describe("inline", () => {
  it("行内 code", () => {
    expect(inline("跑 `npm test` 看看")).toEqual([
      { text: "跑 " }, { text: "npm test", code: true }, { text: " 看看" },
    ]);
  });

  it("粗体", () => {
    expect(inline("这是**重点**了")).toEqual([
      { text: "这是" }, { text: "重点", bold: true }, { text: "了" },
    ]);
  });

  it("code 压过 bold —— 反引号里的星号是字面量", () => {
    expect(inline("`a**b**c`")).toEqual([{ text: "a**b**c", code: true }]);
  });

  it("落单的反引号是普通字符,不是「从这里到结尾都是 code」", () => {
    expect(inline("它的 shell 里 ` 是转义")).toEqual([{ text: "它的 shell 里 ` 是转义" }]);
  });

  it("落单的星号也不吞字", () => {
    expect(inline("2 ** 3").map((s) => s.text).join("")).toBe("2 ** 3");
  });

  it("认不出来的原样留着,不报错也不吞掉", () => {
    expect(inline("[链接](http://x)")).toEqual([{ text: "[链接](http://x)" }]);
  });
});
