// @vitest-environment jsdom
//
// 输入框上方那一行 chips（issue #881）。纯逻辑（引用折成什么、chip 上写什么）
// 钉在 tests/renderer/quote.test.ts；这里补的是那份够不到的两件事：
//
// ① **引用真被画成了一张 chip**，而不是仍旧贴进输入框——这正是这条 issue 的全部内容，
//    而 store 里多一格 `quotes` 并不代表屏幕上多一张 chip。
// ② **引用排在附件前面**：那一排的读序要和发出去的读序一致（引用块在正文之前）。
//    这一条只在 DOM 顺序里看得见，纯函数验不到。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { StagedChips } from "../../src/renderer/src/components/StagedChips.js";
import { useChat } from "../../src/renderer/src/store.js";

function seed(over: Partial<Parameters<typeof useChat.setState>[0]> = {}) {
  useChat.setState({ quotes: [], staged: [], attachError: null, ...over });
}

afterEach(cleanup);

describe("StagedChips 里的引用 chip", () => {
  it("引用画成一张 chip：首行当名字，副行报行数", () => {
    seed({ quotes: [{ id: "q1", text: "function foo() {\n  return 1;\n}" }] });
    render(<StagedChips />);
    expect(screen.getByText("function foo() {")).toBeInTheDocument();
    expect(screen.getByText("引用 · 3 行")).toBeInTheDocument();
  });

  it("全文挂在 title 上——chip 上那行名字是截断的，这是唯一的出口", () => {
    seed({ quotes: [{ id: "q1", text: "一\n二" }] });
    const { container } = render(<StagedChips />);
    expect(container.querySelector('[data-slot="composer-attachment"]')).toHaveAttribute(
      "title",
      "一\n二"
    );
  });

  it("多条引用各一张,按加入顺序", () => {
    seed({ quotes: [{ id: "q1", text: "甲" }, { id: "q2", text: "乙" }] });
    const { container } = render(<StagedChips />);
    const names = [...container.querySelectorAll('[data-slot="composer-attachment"]')].map(
      (el) => el.textContent
    );
    expect(names[0]).toContain("甲");
    expect(names[1]).toContain("乙");
  });

  it("引用排在附件前面:这一排的读序 = 发出去的读序(引用块在正文之前)", () => {
    seed({
      quotes: [{ id: "q1", text: "引来的" }],
      staged: [{ kind: "text", name: "notes.md", content: "x", bytes: 1 }],
    });
    const { container } = render(<StagedChips />);
    const chips = [...container.querySelectorAll('[data-slot="composer-attachment"]')];
    expect(chips[0]?.textContent).toContain("引来的");
    expect(chips[1]?.textContent).toContain("notes.md");
  });

  it("× 只摘掉这一条,别的引用留着", async () => {
    seed({ quotes: [{ id: "q1", text: "甲" }, { id: "q2", text: "乙" }] });
    render(<StagedChips />);
    await userEvent.click(screen.getByRole("button", { name: "Remove 甲" }));
    expect(useChat.getState().quotes.map((q) => q.id)).toEqual(["q2"]);
  });

  it("一条引用一个附件都没有时整行不画(旧行为不变)", () => {
    seed();
    const { container } = render(<StagedChips />);
    expect(container.querySelector('[data-slot="composer-attachments"]')).toBeNull();
  });

  it("只有引用没有附件也要画——判据漏了 quotes 的话这一行会整个不出现", () => {
    seed({ quotes: [{ id: "q1", text: "甲" }] });
    const { container } = render(<StagedChips />);
    expect(container.querySelector('[data-slot="composer-attachments"]')).not.toBeNull();
  });
});

describe("store.addQuote 的不变量", () => {
  it("全空白不收:一条引用存在 = 折出来的正文必然非空,composer 的「有东西可发」靠这条", () => {
    seed();
    useChat.getState().addQuote("  \n ");
    expect(useChat.getState().quotes).toEqual([]);
  });

  it("逐字相同的两段引两遍是两条:文字不是身份", () => {
    seed();
    useChat.getState().addQuote("甲");
    useChat.getState().addQuote("甲");
    expect(useChat.getState().quotes).toHaveLength(2);
  });
});
