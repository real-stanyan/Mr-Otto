// @vitest-environment jsdom
//
// 浮窗里同时有几个光标（issue #894）。
//
// 用户报的是「多行光标一起输出，应该始终只有一个光标在输出文字」。主聊天那条路
// 没这个毛病（e2e `tests/e2e/streamingCaret.e2e.ts` 实测恒为 1）——投影层把一个 turn
// 里所有 assistant_message 合成一条消息，只有 live 那条是 running。
// 浮窗是另一套装配：它自己手写两个 <Streamdown>，一个画已落盘的最后一条、
// 一个画正在流的缓冲，两个都传过 `caret="block"` 且 `isAnimating` 会同时为真。
//
// 这里数的是**拿到 caret 的实例有几个**，不是「渲染对不对」：
// 前者是那个 bug 的定义，后者永远绿。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/** 记下每次 <Streamdown> 拿到的 props。真组件要跑 shiki/rehype 一整条管线，
    在 jsdom 里既慢又和这条用例无关——这里只关心谁拿到了 caret */
const seen: { caret?: unknown; isAnimating?: unknown; children?: unknown }[] = [];
// 只换掉 Streamdown 这一个导出：markdownConfig.ts 还要从同一个包里拿
// defaultRehypePlugins / useIsCodeFenceIncomplete，整包替掉会连它一起打散
vi.mock("streamdown", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Streamdown: (props: Record<string, unknown>) => {
    seen.push(props);
    return <div data-testid="sd">{String(props["children"] ?? "")}</div>;
  },
}));

const { SideChatWindow } = await import("../../src/renderer/src/components/SideChatWindow.js");
const { useChat } = await import("../../src/renderer/src/store.js");

const SIDE = "sess-side";

const userMsg = (seq: number, content: string) =>
  ({ seq, sessionId: SIDE, ts: 1_000 + seq, type: "user_message", content }) as never;
const assistantMsg = (seq: number, content: string) =>
  ({
    seq,
    sessionId: SIDE,
    ts: 1_000 + seq,
    type: "assistant_message",
    content,
    model: "fake",
  }) as never;

beforeEach(() => {
  seen.length = 0;
  // jsdom 的 outerWidth 默认 0 —— sideChatHidden(0) 恒 true，浮窗永远不渲染
  Object.defineProperty(window, "outerWidth", { value: 1400, configurable: true });
  useChat.setState({
    sideChat: {
      sessionId: SIDE,
      events: [userMsg(1, "问一句"), assistantMsg(2, "上一条回答，已经落盘了")],
      open: true,
      pos: { x: 10, y: 10 },
      size: { w: 380, h: 480 },
    },
    approvals: {},
    statusBySession: { [SIDE]: "running" },
    streamingBySession: { [SIDE]: { content: "正在长的这一段…", reasoning: "" } },
  } as never);
});
afterEach(cleanup);

const withCaret = () => seen.filter((p) => p.caret !== undefined);

describe("浮窗的流式光标（#894）", () => {
  it("上一条已落盘 + 这一条正在流：光标只有一个，且长在正在流的那条上", () => {
    render(<SideChatWindow />);
    // 前提自检：两个 <Streamdown> 都渲染了，用例才在验真东西
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(withCaret()).toHaveLength(1);
    expect(String(withCaret()[0]?.children)).toContain("正在长的这一段");
  });

  it("已落盘的那条永远不拿 caret —— 它不会再变了，给它光标就是在撒谎", () => {
    render(<SideChatWindow />);
    const landed = seen.filter((p) => String(p.children).includes("上一条回答"));
    expect(landed).toHaveLength(1);
    expect(landed[0]?.caret).toBeUndefined();
  });

  it("没有流式缓冲时一个光标都不画（没有东西在长）", () => {
    useChat.setState({ streamingBySession: {} } as never);
    render(<SideChatWindow />);
    expect(withCaret()).toHaveLength(0);
  });

  it("turn 没在跑时同样一个都不画", () => {
    useChat.setState({ statusBySession: { [SIDE]: "idle" }, streamingBySession: {} } as never);
    render(<SideChatWindow />);
    expect(withCaret()).toHaveLength(0);
  });
});
