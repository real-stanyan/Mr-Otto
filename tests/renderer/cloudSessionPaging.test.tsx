// @vitest-environment jsdom
//
// 聊天页的窗口化挂载 + 往前翻（#1280）。真渲染一遍 CloudSessionPage，钉纯逻辑那份
// （cloudWindow.test.ts）够不到的三件事：
// ① 窗口数的是**会真的画出来的行**（被藏起来的事件不占窗口的名额）；
// ② 哨兵那条岔路走得通：先补挂内存里的，挂完了才去拉上一页；
// ③ **团队会话不窗口化** —— 那边的上下文环与通话折卡都靠「把整份日志读一遍」。
//
// 滚动补偿不写成断言：jsdom 没有布局（offsetTop 恒 0、scrollTo 是桩），写出来
// 只钉得住「调了这个函数」，而真正会坏的是时序。保鲜期在紧挨代码的注释里
// （同 ADR-0236 第 1 条 / ADR-0285 的取舍）。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { CloudSessionPage } from "../../src/renderer/src/components/CloudSessionPage.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import { GROW_STEP, INITIAL_WINDOW } from "../../src/renderer/src/lib/cloudWindow.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
  Element.prototype.scrollTo ??= vi.fn() as never;
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
});

afterEach(cleanup);

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "" },
    { uid: "u2", role: "member", label: "小红", avatarUrl: "" },
  ],
};

const base = { sessionId: "cs1" } as const;

/** n 条会真的画出来的行 + 一条画不出来的（session_created）。后者是关键：
    它不该占掉窗口的一个名额 */
function log(n: number): SessionEvent[] {
  return [
    { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/w" },
    ...Array.from({ length: n }, (_, i): SessionEvent => ({
      ...base, seq: i + 1, ts: i + 1, type: "chat_message",
      fromUid: "u2", label: "小红", content: `句${i}`, mention: false,
    })),
  ];
}

/** 「这一页画的是一条聊天」是 CloudSessionPage 的 **prop**，不是从 store 读的 */
const CHAT = { kind: "group" as const, agentIds: ["a_1"], title: "群" };

const loadOlder = vi.fn(async () => {});

function renderPage(o: {
  events: SessionEvent[];
  chat?: typeof CHAT | null;
  hasOlder?: boolean;
  older?: "idle" | "loading" | "failed";
}): void {
  loadOlder.mockClear();
  const chat = o.chat === undefined ? CHAT : o.chat;
  useChat.setState({
    cloudSession: {
      workspaceId: "w", sessionId: "cs1", state: "ready", initiatorUid: "u1", ownerUid: "u1", selfUid: "u1",
      modelRoute: null, gapNote: null,
      chat: null,
      hasOlder: o.hasOlder ?? false,
      older: o.older ?? "idle",
      events: o.events,
    },
    loadOlderCloudEvents: loadOlder,
  } as never);
  render(
    <TooltipPrimitive.Provider>
      <ConfirmProvider>
        <CloudSessionPage ws={ws} selfUid="u1" {...(chat === null ? {} : { chat })} />
      </ConfirmProvider>
    </TooltipPrimitive.Provider>,
  );
}

const shown = (): number => screen.queryAllByText(/^句\d+$/).length;

describe("聊天页窗口化（#1280）", () => {
  it("300 行只挂后缀；被藏起来的那条事件不占窗口的名额", () => {
    renderPage({ events: log(300) });
    expect(shown()).toBe(INITIAL_WINDOW);
    // 挂的是**最后** 60 条：新的在底下，人一进来看的就是这一屏
    expect(screen.getByText("句299")).toBeInTheDocument();
    expect(screen.queryByText("句239")).toBeNull();
    expect(screen.getByText("句240")).toBeInTheDocument();
  });

  it("点哨兵：先补挂内存里的，不打网络", async () => {
    renderPage({ events: log(300), hasOlder: true });
    await userEvent.click(screen.getByRole("button", { name: "更早的消息" }));
    expect(shown()).toBe(INITIAL_WINDOW + GROW_STEP);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("内存里挂完了、云端还有：这一下才去拉上一页", async () => {
    renderPage({ events: log(10), hasOlder: true });
    expect(shown()).toBe(10); // 短列表不开窗
    await userEvent.click(screen.getByRole("button", { name: "更早的消息" }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("到头了：哨兵整个不画——一颗点了每次都空手而回的钮就是撒谎的勾", () => {
    renderPage({ events: log(10), hasOlder: false });
    expect(screen.queryByRole("button", { name: "更早的消息" })).toBeNull();
  });

  it("上一次失败了：画「没读到更早的消息 · 重试」，上一页的内容留在原地；点重试再拉一次", async () => {
    renderPage({ events: log(10), hasOlder: true, older: "failed" });
    expect(screen.getByText(/没读到更早的消息/)).toBeInTheDocument();
    expect(screen.getByText("句9")).toBeInTheDocument(); // 不清屏
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("团队会话不窗口化：300 行全挂，也没有哨兵", () => {
    renderPage({ events: log(300), chat: null });
    expect(shown()).toBe(300);
    expect(screen.queryByRole("button", { name: "更早的消息" })).toBeNull();
  });
});
