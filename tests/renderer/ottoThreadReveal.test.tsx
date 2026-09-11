// @vitest-environment jsdom
//
// 会话地图跳到时间线窗口外的那一轮(ADR-0292 × ADR-0285 决定 3 的 reveal 桥)。
// messageWindow.test.ts 验纯逻辑(planReveal),conversationMap.test.ts 验 scrollToTurn 那几步
// 滚动的先后;这里验**接线**:真 store + 真 useOttoRuntime 渲染 OttoThread,点地图上第一轮那一格
// —— 它在窗口上沿以上、没挂载 —— 窗口抬到包含它、挂上之后滚到的是**那条消息**;点一格已经
// 挂着的,只滚不抬窗。
//
// scrollToTurn 在这里是桩:jsdom 没有布局,真滚动的调用与 assistant-ui autoScroll 自己的
// scrollTo 长得一模一样(top 全是 0),分不出谁是谁;桩下来就能直接问「滚到了哪个元素、走的
// 哪条路」。真滚得到位这件事在真机上验过(#1259,autoScroll 取消跳转那个坑就是在真机上撞见的)。
//
// 原来这里验的是「旧会话留下的 revealRequest 不作用于新会话」(#1190 复审 ①):那时请求住在
// App、被 OttoThread 消费,passive effect 子先于父,切会话那一帧清理追不上。现在挂起的跳转
// 住在 OttoThread 自己手里,与窗口在同一次渲染里归零,那一帧不存在了 —— 最后一条用例钉住
// 「点过的跳转不跟到新会话去:新会话照样只开后缀窗口」。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AssistantRuntimeProvider } from "@assistant-ui/react";

import { OttoThread } from "../../src/renderer/src/aui/OttoThread.js";
import { useOttoRuntime } from "../../src/renderer/src/aui/useOttoRuntime.js";
import { useChat } from "../../src/renderer/src/store.js";
import { scrollToTurn } from "../../src/renderer/src/lib/conversationMap.js";
import type { SessionEvent } from "../../src/session/events.js";

vi.mock("../../src/renderer/src/lib/conversationMap.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/renderer/src/lib/conversationMap.js")>();
  return { ...mod, scrollToTurn: vi.fn() };
});

// jsdom 没有布局/媒体查询。补挂那条路本来就走不到(没有 IntersectionObserver,
// 哨兵只剩按钮);scrollTo 是给视口的 autoScroll 钩子的
beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
  Element.prototype.scrollTo ??= vi.fn() as never;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
});

afterEach(() => {
  cleanup();
  vi.mocked(scrollToTurn).mockClear();
});

/** 150 条消息(用户/助手交替)——越过小列表阈值,窗口启用,初始藏 90 条 */
function makeEvents(tag: string): SessionEvent[] {
  return Array.from({ length: 150 }, (_, i) => {
    const seq = i + 1;
    return (seq % 2 === 1
      ? { type: "user_message", content: `${tag} 问题 ${seq}` }
      : { type: "assistant_message", content: `${tag} 回答 ${seq}`, model: "m" }) as SessionEvent;
  }).map((e, i) => ({ ...e, sessionId: tag, ts: 1000 + i, seq: i + 1 }));
}

function Harness() {
  const runtime = useOttoRuntime();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OttoThread />
    </AssistantRuntimeProvider>
  );
}

function enter(sessionId: string, events: SessionEvent[]): void {
  useChat.setState({
    sessionId,
    events,
    skills: [],
    streamingBySession: {},
    statusBySession: {},
  });
}

const sentinelText = (): string | null =>
  document.querySelector('[data-slot="otto_window-sentinel"]')?.textContent ?? null;

/** 第 n 次 scrollToTurn 滚的是哪条消息、走的哪条路（instant = reveal 桥那条） */
function scrolledTo(n = 0): { messageId: string | undefined; viewport: string | null; instant: boolean } {
  const [viewport, element, opts] = vi.mocked(scrollToTurn).mock.calls[n]!;
  return {
    messageId: element.dataset["messageId"],
    viewport: viewport.getAttribute("data-slot"),
    instant: opts?.instant === true,
  };
}

describe("会话地图 × 时间线窗口(ADR-0292 / ADR-0285)", () => {
  it("一轮一格:75 轮对话 = 75 格刻度,标题取那一轮的问题", async () => {
    enter("s2", makeEvents("s2"));
    render(<Harness />);
    const map = await screen.findByRole("navigation", { name: "会话地图" });
    expect(map.querySelectorAll('[data-slot="conversation-map-tick"]')).toHaveLength(75);
    expect(screen.getByRole("button", { name: "s2 问题 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "s2 问题 149" })).toBeInTheDocument();
  });

  it("点窗口外的那一轮:窗口抬到包含它 → 挂上之后瞬时滚到那条消息", async () => {
    enter("s2", makeEvents("s2"));
    render(<Harness />);
    expect(sentinelText()).toContain("还有 90 条");
    fireEvent.click(await screen.findByRole("button", { name: "s2 问题 1" }));
    // 目标是第 0 条:窗口抬到底,哨兵收起
    await waitFor(() => expect(sentinelText()).toBeNull());
    await waitFor(() => expect(scrollToTurn).toHaveBeenCalledTimes(1));
    expect(scrolledTo()).toEqual({ messageId: "1", viewport: "aui_thread-viewport", instant: true });
  });

  it("点已经挂着的那一轮:只滚(平滑那条路),不抬窗", async () => {
    enter("s2", makeEvents("s2"));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "s2 问题 149" }));
    await waitFor(() => expect(scrollToTurn).toHaveBeenCalledTimes(1));
    expect(scrolledTo()).toEqual({ messageId: "149", viewport: "aui_thread-viewport", instant: false });
    expect(sentinelText()).toContain("还有 90 条");
  });

  it("切会话:窗口按新会话重开,上一条会话里点过的跳转不跟过来", async () => {
    enter("s2", makeEvents("s2"));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "s2 问题 1" }));
    await waitFor(() => expect(sentinelText()).toBeNull());
    act(() => enter("s3", makeEvents("s3")));
    await waitFor(() => expect(sentinelText()).toContain("还有 90 条"));
    expect(await screen.findByRole("button", { name: "s3 问题 1" })).toBeInTheDocument();
  });
});
