// formatPickedElement:选中元素 → 注入 composer 的上下文块。
// 纯函数——注入后的文本用户看得见、能改,这里只管把字段摆清楚。
import { describe, it, expect } from "vitest";
import { formatPickedElement } from "../../src/renderer/src/lib/pickedElement.js";
import type { BrowserPickedElement } from "../../src/shared/browser.js";

const full: BrowserPickedElement = {
  selector: "#app > form > button.submit",
  tag: "button",
  html: '<button class="submit">提交</button>',
  text: "提交",
  source: "src/components/Form.tsx:42",
  components: ["SubmitButton", "Form"],
  url: "http://localhost:5173/",
};

describe("formatPickedElement", () => {
  it("全字段:URL、selector、组件链、源码位置、HTML 全在", () => {
    const s = formatPickedElement(full);
    expect(s).toContain("http://localhost:5173/");
    expect(s).toContain("#app > form > button.submit");
    expect(s).toContain("SubmitButton");
    expect(s).toContain("src/components/Form.tsx:42");
    expect(s).toContain('<button class="submit">提交</button>');
  });

  it("HTML 放进代码围栏,别和用户接着打的指令搅在一起", () => {
    const s = formatPickedElement(full);
    expect(s).toMatch(/```html\n[\s\S]*\n```/);
  });

  it("可选字段缺席就整行不出现,不留空标签", () => {
    const s = formatPickedElement({
      selector: "div",
      tag: "div",
      html: "<div></div>",
      text: "",
      url: "https://a.com/",
    });
    expect(s).not.toContain("源码");
    expect(s).not.toContain("组件");
  });

  it("末尾带空行,用户光标落在块后面直接打指令", () => {
    expect(formatPickedElement(full).endsWith("\n")).toBe(true);
  });
});
