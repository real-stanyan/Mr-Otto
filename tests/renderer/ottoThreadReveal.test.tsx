// @vitest-environment jsdom
//
// reveal 桥的会话归属(#1190 复审 ①):passive effect **子先于父**跑,切会话那一帧
// OttoThread 的 reveal effect 会先于 App 的清理 effect 看到旧会话留下的
// revealRequest —— 修法是请求自带发起时的 sessionId、消费前核对(planReveal 的
// stale 分支)。messageWindow.test.ts 验纯逻辑,这里验**接线**:同一个请求挂在
// OttoThread 上,戳对会话 → 抬窗 + 滚 + 收口;戳不对 → 窗口纹丝不动。
//
// 会话用真 store(useChat.setState,与 filesPanelStore.test.ts 同一个手法),
// runtime 就是真 useOttoRuntime —— 不然 OttoThread 与 Thread 各读一份假数据,
// 验的就不是真接线了。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createRef, type RefObject } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";

import { OttoThread } from "../../src/renderer/src/aui/OttoThread.js";
import { useOttoRuntime } from "../../src/renderer/src/aui/useOttoRuntime.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { Section } from "../../src/session/deriveSections.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { RevealRequest } from "../../src/renderer/src/lib/messageWindow.js";

// jsdom 三件套:布局/平滑滚动/媒体查询都没有。补挂那条路本来就走不到
// (没有 IntersectionObserver,哨兵只剩按钮),这里 stub 的是 reveal 的滚动分支
// 和视口的 autoScroll 钩子(同 threadWindow.test.tsx 的 ResizeObserver)
beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
  Element.prototype.scrollIntoView ??= vi.fn() as never;
  // autoScroll 钩子的 scrollToBottom 走 div.scrollTo(jsdom 没有);窗口模块自己的
  // 补偿在这条测试里走不到(没有 IO,哨兵不自动补挂)
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
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
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

const SECTIONS: Section[] = [{ title: "开头", startSeq: 1, preview: "" }];

function Harness({
  revealRequest,
  onRevealSettled,
  viewportRef,
}: {
  revealRequest: RevealRequest;
  onRevealSettled: () => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const runtime = useOttoRuntime();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OttoThread
        sections={SECTIONS}
        revealRequest={revealRequest}
        onRevealSettled={onRevealSettled}
        viewportRef={viewportRef}
      />
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

describe("reveal 桥的会话归属(#1190 复审)", () => {
  it("戳对了会话:抬窗 → 滚过去 → 收口(对照组,证明接线本身是通的)", async () => {
    enter("s2", makeEvents("s2"));
    const onSettled = vi.fn();
    const viewportRef = createRef<HTMLDivElement | null>();
    render(
      <Harness
        revealRequest={{ section: 0, nonce: 1, sessionId: "s2" }}
        onRevealSettled={onSettled}
        viewportRef={viewportRef}
      />
    );
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // 窗口抬到了底(目标在第 0 条):哨兵收起
    expect(sentinelText()).toBeNull();
  });

  it("旧会话留下的 revealRequest 不作用于新会话:不抬窗、不滚、不收口", async () => {
    enter("s2", makeEvents("s2"));
    const onSettled = vi.fn();
    const viewportRef = createRef<HTMLDivElement | null>();
    render(
      <Harness
        // s1 发起的请求留到了 s2 的帧里 —— 复审抓的那一行
        revealRequest={{ section: 0, nonce: 1, sessionId: "s1" }}
        onRevealSettled={onSettled}
        viewportRef={viewportRef}
      />
    );
    // 等一拍再说没发生:被动 effect 链(抬窗→再跑→滚)若动了,这一拍内必露馅
    await new Promise((r) => setTimeout(r, 50));
    expect(onSettled).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    // 窗口保持初始的 90 条,没被旧请求抬走
    expect(sentinelText()).toContain("还有 90 条");
  });
});
