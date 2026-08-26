// @vitest-environment jsdom
//
// SideChatWindow 的组件测试（issue #502 / ADR-0128）。纯逻辑（拖拽夹取、
// 时间线投影）在 tests/renderer/lib/sideChatWindow.test.ts；这里钉渲染层
// 特有的三件事：关着/窄窗不渲染、审批行的出现与按钮返程、发送走 sendSideChat。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { SideChatWindow } from "../../src/renderer/src/components/SideChatWindow.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";

const SIDE = "sess-side";

const msg = (seq: number, content: string): SessionEvent => ({
  seq, sessionId: SIDE, ts: seq, type: "user_message", content,
});

// jsdom 的 outerWidth 默认 0——isNarrowWidth(0) 恒 true，浮窗永远隐身。
// 组件按窗口点数判窄（见 lib/sidebarNarrow.ts），测试里得把窗口"撑开"
function stubWidth(width: number) {
  Object.defineProperty(window, "outerWidth", { value: width, configurable: true });
}

function resetStore(over: Partial<Parameters<typeof useChat.setState>[0]> = {}) {
  useChat.setState({
    sideChatOpen: true,
    sideChatSessionId: SIDE,
    sideChatEvents: [],
    sideChatCreating: false,
    sideChatError: null,
    streamingBySession: {},
    statusBySession: {},
    approvals: {},
    ...over,
  });
}

afterEach(cleanup);
beforeEach(() => {
  stubWidth(1200);
  resetStore();
});

describe("SideChatWindow", () => {
  it("关着不渲染", () => {
    resetStore({ sideChatOpen: false });
    render(<SideChatWindow />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("窄窗口（< AUTO_COLLAPSE_WIDTH）不渲染——显示不下（issue #502 的验收项）", () => {
    stubWidth(800);
    render(<SideChatWindow />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("开着渲染时间线：用户和模型的话都上屏", () => {
    resetStore({
      sideChatEvents: [
        msg(1, "浮窗里问的"),
        { seq: 2, sessionId: SIDE, ts: 2, type: "assistant_message", content: "浮窗里答的", model: "m" },
      ],
    });
    render(<SideChatWindow />);
    expect(screen.getByText("浮窗里问的")).toBeInTheDocument();
    expect(screen.getByText("浮窗里答的")).toBeInTheDocument();
  });

  it("side session 的审批卡在浮窗里有出口：点「允许」走 decideApproval(approved)", async () => {
    const decideApproval = vi.fn(async () => {});
    vi.stubGlobal("window", Object.assign(window, { otter: { decideApproval } }));
    resetStore({
      approvals: {
        [SIDE]: {
          sessionId: SIDE,
          call: { id: "call_9", name: "bash", arguments: "{}" },
          toolDescription: "跑命令",
        },
      },
    });
    render(<SideChatWindow />);
    await userEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(decideApproval).toHaveBeenCalledWith(SIDE, "call_9", { decision: "approved" });
  });

  it("输入回车走 sendSideChat", async () => {
    const sendMessage = vi.fn(async () => {});
    vi.stubGlobal("window", Object.assign(window, { otter: { sendMessage } }));
    render(<SideChatWindow />);
    await userEvent.type(screen.getByPlaceholderText(/说点什么/), "你好{Enter}");
    expect(sendMessage).toHaveBeenCalledWith(SIDE, "你好");
  });
});
