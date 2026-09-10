// @vitest-environment jsdom
//
// 时间线窗口的渲染缝(ADR-0285 决定 2,#1190):hiddenCount 不是纯逻辑层的一个数,
// 它要真的穿过 Thread → ThreadRoot → WindowedMessages → assistant-ui 的
// unstable_useThreadMessageIds / Unstable_MessageById 这条链,DOM 里少挂载才算数。
// jsdom 没有 IntersectionObserver —— 正好走「哨兵退化成按钮」那条路。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import { Thread } from "../../src/renderer/src/components/assistant-ui/thread.js";

// jsdom 没有 ResizeObserver,而视口的 autoScroll 钩子一上来就 new 它
// (同 ModelPicker.test.tsx 的 stub)
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as never;

afterEach(cleanup);

/** 100 条 user 消息(纯文本,不碰 Streamdown——这条链验的是挂载窗口,不是解析) */
const MESSAGES: ThreadMessageLike[] = Array.from({ length: 100 }, (_, i) => ({
  role: "user" as const,
  id: String(i),
  content: [{ type: "text" as const, text: `消息 ${i}` }],
}));

const identityConvert = (m: ThreadMessageLike) => m;

function Harness({
  hiddenCount,
  onGrowWindow,
}: {
  hiddenCount: number;
  onGrowWindow: () => void;
}) {
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessageLike>>(
    () => ({
      messages: MESSAGES,
      convertMessage: identityConvert,
      isRunning: false,
      onNew: async () => {},
    }),
    []
  );
  const runtime = useExternalStoreRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread hiddenCount={hiddenCount} onGrowWindow={onGrowWindow} />
    </AssistantRuntimeProvider>
  );
}

const mountedRows = (): number => document.querySelectorAll('[data-role="user"]').length;

describe("Thread 的时间线窗口缝(ADR-0285)", () => {
  it("hiddenCount > 0 时只挂载后缀,哨兵画出剩余条数", () => {
    render(<Harness hiddenCount={40} onGrowWindow={() => {}} />);
    expect(mountedRows()).toBe(60);
    const sentinel = document.querySelector('[data-slot="otto_window-sentinel"]');
    expect(sentinel).not.toBeNull();
    expect(sentinel!.textContent).toContain("还有 40 条");
    // 挂载的是**后缀**:第一条是第 40 条,最后一条是第 99 条
    const rows = document.querySelectorAll('[data-role="user"]');
    expect(rows[0]!.textContent).toContain("消息 40");
    expect(rows[rows.length - 1]!.textContent).toContain("消息 99");
  });

  it("jsdom 没有 IntersectionObserver:哨兵退化成按钮,点了就调 onGrowWindow", () => {
    expect(typeof IntersectionObserver).toBe("undefined");
    const onGrow = vi.fn();
    render(<Harness hiddenCount={40} onGrowWindow={onGrow} />);
    fireEvent.click(document.querySelector('[data-slot="otto_window-sentinel"] button')!);
    expect(onGrow).toHaveBeenCalledTimes(1);
  });

  it("hiddenCount = 0 与开窗前逐字相同:全量挂载,没有哨兵", () => {
    render(<Harness hiddenCount={0} onGrowWindow={() => {}} />);
    expect(mountedRows()).toBe(100);
    expect(document.querySelector('[data-slot="otto_window-sentinel"]')).toBeNull();
  });
});
