// parsePickPayload:选取脚本跑在不可信页面的 main world 里,
// 返回值当敌方输入对待——形状校验 + 全字段截断上限。
import { describe, it, expect } from "vitest";
import { parsePickPayload, PICKER_JS, PICKER_CANCEL_JS } from "../../src/main/browserPicker.js";

const valid = () =>
  JSON.stringify({
    selector: "#app > form > button.submit",
    tag: "button",
    html: '<button class="submit">提交</button>',
    text: "提交",
    source: "src/components/Form.tsx:42",
    components: ["SubmitButton", "Form"],
  });

describe("parsePickPayload", () => {
  it("合法 payload 解析出全部字段", () => {
    const p = parsePickPayload(valid());
    expect(p).toEqual({
      selector: "#app > form > button.submit",
      tag: "button",
      html: '<button class="submit">提交</button>',
      text: "提交",
      source: "src/components/Form.tsx:42",
      components: ["SubmitButton", "Form"],
    });
  });

  it("null = 用户取消(Esc/取消脚本),原样传出去", () => {
    expect(parsePickPayload(null)).toBeNull();
  });

  it("可选字段缺席时不出现在结果里", () => {
    const p = parsePickPayload(
      JSON.stringify({ selector: "div", tag: "div", html: "<div></div>", text: "" })
    );
    expect(p).not.toBeNull();
    expect("source" in p!).toBe(false);
    expect("components" in p!).toBe(false);
  });

  it("非字符串非 null 一律抛:页面把返回值换掉了", () => {
    expect(() => parsePickPayload(42)).toThrow();
    expect(() => parsePickPayload({ selector: "x" })).toThrow();
  });

  it("坏 JSON 抛错", () => {
    expect(() => parsePickPayload("{oops")).toThrow();
  });

  it("缺必填字段抛错", () => {
    expect(() =>
      parsePickPayload(JSON.stringify({ tag: "div", html: "", text: "" }))
    ).toThrow();
  });

  it("超长字段被截断:页面能塞多大的 outerHTML 是它说了算,上限得是我们的", () => {
    const p = parsePickPayload(
      JSON.stringify({
        selector: "s".repeat(1000),
        tag: "t".repeat(1000),
        html: "h".repeat(100_000),
        text: "x".repeat(10_000),
        source: "f".repeat(10_000),
        components: Array.from({ length: 50 }, (_, i) => "C" + "x".repeat(500) + i),
      })
    )!;
    expect(p.selector.length).toBeLessThanOrEqual(400);
    expect(p.tag.length).toBeLessThanOrEqual(60);
    expect(p.html.length).toBeLessThanOrEqual(2000);
    expect(p.text.length).toBeLessThanOrEqual(300);
    expect(p.source!.length).toBeLessThanOrEqual(300);
    expect(p.components!.length).toBeLessThanOrEqual(5);
    for (const c of p.components!) expect(c.length).toBeLessThanOrEqual(80);
  });

  it("components 里混进非字符串就整个丢掉(宁缺毋假)", () => {
    const p = parsePickPayload(
      JSON.stringify({
        selector: "div",
        tag: "div",
        html: "<div></div>",
        text: "",
        components: ["A", 1, "B"],
      })
    )!;
    expect("components" in p).toBe(false);
  });
});

describe("注入脚本形状", () => {
  it("PICKER_JS 是个自执行表达式,装好取消钩子", () => {
    expect(PICKER_JS).toContain("__ottoPickCancel");
    expect(PICKER_CANCEL_JS).toContain("__ottoPickCancel");
  });
});
