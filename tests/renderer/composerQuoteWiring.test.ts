// ChatComposer 的 `dispatch` 是「给模型的话」唯一的出口——引用折回引用块就发生在
// 那里（issue #881 / ADR-0284）。这条断言读的是**源码**，因为那个 dispatch 是
// App.tsx 里一个闭包，import 不进 vitest（同 tests/main/accountScope.test.ts 的
// 接线断言）。
//
// 钉它是因为它守的失败是**静默的**：把 `enqueue(body)` 改回 `enqueue(text)`，
// chip 照样清掉、消息照样发出去，只是引用没了——界面上一个字都不说，
// 而这正是这条 issue 修的东西。
//
// 判据故意不是「有没有调 composeQuotedMessage」而是「原样的 text 有没有直接
// 走出去」：前者在有人把结果算出来又不用的时候仍然全绿。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("../../src/renderer/src/App.tsx", import.meta.url), "utf8");

/** ChatComposer 里 `const dispatch = (text: string, …) => { … }` 那一段。 */
function dispatchBody(): string {
  const start = SRC.indexOf("const dispatch = (text: string");
  expect(start, "App.tsx 里找不到 ChatComposer 的 dispatch —— 改名了就把这条断言一起改").toBeGreaterThan(-1);
  const end = SRC.indexOf("\n  };", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("ChatComposer.dispatch 把引用折进正文（ADR-0284）", () => {
  it("引用在这里折回引用块", () => {
    expect(dispatchBody()).toContain("composeQuotedMessage(quotes, text)");
  });

  it("原样的 text 不许直接走出去 —— 那是引用被悄悄吞掉的形状", () => {
    const body = dispatchBody();
    expect(body).not.toMatch(/\benqueue\(\s*text\b/);
    expect(body).not.toMatch(/\bsend\(\s*text\b/);
  });

  it("折完要清空暂存区,否则下一条消息会把同一段引用再带一遍", () => {
    expect(dispatchBody()).toContain("clearQuotes()");
  });
});
