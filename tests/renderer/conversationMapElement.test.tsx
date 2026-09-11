// @vitest-environment jsdom
//
// 会话地图的元件那半（elements/conversation-map，ADR-0292）：一轮一格、三档记号、
// 键盘、点一格、悬停卡。纯逻辑（怎么切轮、怎么量位置）钉在 conversationMap.test.ts，
// 与时间线窗口的接线钉在 ottoThreadReveal.test.tsx。
//
// 悬停卡是 Radix HoverCard（元件头注的本仓改动 ①）：jsdom 里用真焦点
// （element.focus()——React 的 onFocus 听的是 focusin，fireEvent.focus 派不出它）
// 加假时钟推过 openDelay。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ConversationMap } from "../../src/renderer/src/components/elements/conversation-map.js";

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const entries = [
  { id: "1", title: "帮我修登录", preview: "改好了 auth.ts" },
  { id: "3", title: "再看看注册", eyebrow: "小红" },
  { id: "5", title: "谢谢" },
];

describe("ConversationMap（elements/conversation-map）", () => {
  it("一轮一格：aria-label 是标题，当前那格 aria-current，屏幕上的几格带 data-in-view", () => {
    render(<ConversationMap entries={entries} activeId="3" visibleIds={["1", "3"]} />);
    expect(screen.getByRole("navigation", { name: "会话地图" })).toBeInTheDocument();
    const ticks = screen.getAllByRole("button");
    expect(ticks.map((t) => t.getAttribute("aria-label"))).toEqual(["帮我修登录", "再看看注册", "谢谢"]);
    expect(ticks[1]).toHaveAttribute("aria-current", "true");
    expect(ticks[0]).not.toHaveAttribute("aria-current");
    expect(ticks.map((t) => t.hasAttribute("data-in-view"))).toEqual([true, true, false]);
  });

  it("roving tabindex：只有当前那格进 Tab 序；方向键 / Home / End 在格间挪焦点，到头不绕回", () => {
    render(<ConversationMap entries={entries} activeId="3" />);
    const ticks = screen.getAllByRole("button");
    expect(ticks.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    act(() => ticks[1]!.focus());
    fireEvent.keyDown(ticks[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks[2]);
    fireEvent.keyDown(ticks[2]!, { key: "Home" });
    expect(document.activeElement).toBe(ticks[0]);
    fireEvent.keyDown(ticks[0]!, { key: "End" });
    expect(document.activeElement).toBe(ticks[2]);
    fireEvent.keyDown(ticks[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks[2]);
  });

  it("点一格 → onSelect(那一轮的 id)", () => {
    const onSelect = vi.fn();
    render(<ConversationMap entries={entries} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "谢谢" }));
    expect(onSelect).toHaveBeenCalledWith("5");
  });

  it("停在一格上过了 openDelay 才出悬停卡；挪到下一格是同一张卡换内容，不是再开一张", () => {
    vi.useFakeTimers();
    render(<ConversationMap entries={entries} />);
    act(() => screen.getByRole("button", { name: "帮我修登录" }).focus());
    // 还没到 openDelay：扫过轨的指针不该一路弹卡
    expect(screen.queryByText("改好了 auth.ts")).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText("改好了 auth.ts")).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "再看看注册" }).focus());
    act(() => vi.advanceTimersByTime(200));
    // 群聊那一格多一行是谁说的（eyebrow，本仓改动 ④）
    expect(screen.getByText("小红")).toBeInTheDocument();
    expect(screen.queryByText("改好了 auth.ts")).toBeNull();
    expect(document.querySelectorAll('[data-slot="conversation-map-card"]')).toHaveLength(1);
  });
});
