// @vitest-environment jsdom
//
// 旁聊浮窗的审批出口（issue #512）：side 会话是全权装配（#507 的 rationale），
// bash / write_file 都过审批门，但主视图只渲染 approvals[当前会话] 的卡——
// side 会话的卡没有出口就是一张看不见的卡、一个永远 pending 的工具。
// 这里钉：卡出现在浮窗里、批/拒的返程都走 decideApproval(sideSessionId, ...)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { SideChatWindow } from "../../src/renderer/src/components/SideChatWindow.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { ApprovalRequest } from "../../src/shared/shellBridge.js";

const SIDE = "sess-side";
const MAIN = "sess-main";

const approvalFor = (sessionId: string): ApprovalRequest => ({
  sessionId,
  call: { id: "call_9", name: "bash", args: { cmd: "npm test" } },
  toolDescription: "跑命令",
});

// jsdom 的 outerWidth 默认 0——sideChatHidden(0) 恒 true，浮窗永远不渲染。
// 组件按窗口点数判窄（lib/sideChatWindow.ts），测试里得把窗口"撑开"
beforeEach(() => {
  Object.defineProperty(window, "outerWidth", { value: 1400, configurable: true });
  useChat.setState({
    sideChat: { sessionId: SIDE, events: [], open: true, pos: { x: 10, y: 10 } },
    approvals: {},
  });
});
afterEach(cleanup);

describe("SideChatWindow 的审批出口（#512）", () => {
  it("side 会话挂审批：浮窗里出现审批行，点「允许」走 decideApproval(approved)", async () => {
    const decideApproval = vi.fn(async () => {});
    vi.stubGlobal("window", Object.assign(window, { otter: { decideApproval } }));
    useChat.setState({ approvals: { [SIDE]: approvalFor(SIDE) } });
    render(<SideChatWindow />);
    expect(screen.getByText("bash")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(decideApproval).toHaveBeenCalledWith(SIDE, "call_9", { decision: "approved" });
  });

  it("点「拒绝」走 decideApproval(denied)，带拒绝原因", async () => {
    const decideApproval = vi.fn(async () => {});
    vi.stubGlobal("window", Object.assign(window, { otter: { decideApproval } }));
    useChat.setState({ approvals: { [SIDE]: approvalFor(SIDE) } });
    render(<SideChatWindow />);
    await userEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(decideApproval).toHaveBeenCalledWith(
      SIDE,
      "call_9",
      expect.objectContaining({ decision: "denied" })
    );
  });

  it("主会话的审批卡不进浮窗（那是主视图的卡）", () => {
    useChat.setState({ approvals: { [MAIN]: approvalFor(MAIN) } });
    render(<SideChatWindow />);
    expect(screen.queryByRole("button", { name: "允许" })).not.toBeInTheDocument();
  });

  it("没有挂起审批：不渲染审批行", () => {
    render(<SideChatWindow />);
    expect(screen.queryByRole("button", { name: "允许" })).not.toBeInTheDocument();
  });
});
