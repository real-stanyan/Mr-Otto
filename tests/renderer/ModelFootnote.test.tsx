// @vitest-environment jsdom
//
// 型号脚注**画出来**那一半（#1071）。文案规则钉在 modelFootnote.test.ts；这里盯的是
// 「整行不换行」这条机制 —— jsdom 没有布局，量不出换没换行，所以判据只能是那几个
// 类名本身：容器 `whitespace-nowrap`、右边那串 `shrink-0`（定长事实永不收缩）、
// 名字 `truncate`（挤不下时唯一让步的那一格）。三者缺一，这一行就会折回两行。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ModelFootnote } from "../../src/renderer/src/components/ModelFootnote.js";
import type { ModelUsage } from "../../src/session/deriveUsage.js";

const row = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  model: "deepseek-flash", route: "hosted", promptTokens: 373_500, completionTokens: 5_900, cachedTokens: 0, ...over,
});

afterEach(cleanup);

describe("ModelFootnote", () => {
  it("一次模型都没调过就不占地方", () => {
    const { container } = render(<ModelFootnote rows={[]} cache={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("一行到底：容器不换行、右边那串不收缩、只有名字会被截", () => {
    const { container } = render(<ModelFootnote rows={[row()]} cache={null} />);
    const line = container.firstElementChild!;
    expect(line.className).toContain("whitespace-nowrap");
    expect(screen.getByText("deepseek-flash").className).toContain("truncate");
    expect(screen.getByText("379K").className).toContain("shrink-0");
  });

  it("认得出的厂商画标，认不出的画首字母方块 —— 两条路都不会让这一行空着", () => {
    const { unmount } = render(<ModelFootnote rows={[row()]} cache={null} />);
    expect(screen.getByTestId("provider-mark")).toHaveAttribute("data-mark", "deepseek");
    unmount();
    render(<ModelFootnote rows={[row({ model: "some-selfhosted-llm" })]} cache={null} />);
    expect(screen.getByTestId("provider-letter")).toHaveTextContent("S");
  });

  it("完整那份（带单位、带全名）进 title", () => {
    const { container } = render(
      <ModelFootnote rows={[row()]} cache={{ cachedTokens: 311_300, measuredPromptTokens: 373_500 }} />,
    );
    expect(container.firstElementChild).toHaveAttribute(
      "title",
      "deepseek-flash · 379K tokens，cache 命中 83%",
    );
  });
});
