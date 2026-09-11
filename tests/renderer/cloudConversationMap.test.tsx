// @vitest-environment jsdom
//
// 会话地图的云会话那半（ADR-0292）：真渲染一遍 CloudSessionPage，钉纯逻辑那份
// （conversationMap.test.ts 的 cloudConversationEntries）够不到的两件事——
// ① 条目与记号出自同一份结果：每一格刻度，时间线上都有带同一个 data-turn-id 的那一行；
//    旁白 / 中间步骤 / 被通话卡吞掉的那些一个记号都不带（多带一个 = 一格点了跳不过去的刻度）；
// ② 点一格滚的是那一行。
// 云会话的真机验收要真登录 + 活着的云会话（ADR-0292「代价」一节），这份是它够不到时的替身。
//
// scrollToTurn 是桩：jsdom 没有布局，滚到哪儿问不出来，只能问「滚的是谁」。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { CloudSessionPage } from "../../src/renderer/src/components/CloudSessionPage.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { scrollToTurn } from "../../src/renderer/src/lib/conversationMap.js";
import { useChat } from "../../src/renderer/src/store.js";
import { SYSTEM_SPEAKER_UID } from "../../src/shared/promptSafe.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

vi.mock("../../src/renderer/src/lib/conversationMap.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/renderer/src/lib/conversationMap.js")>();
  return { ...mod, scrollToTurn: vi.fn() };
});

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
const callChanged = (seq: number, ts: number, ids: string[]): SessionEvent => ({
  ...base, seq, ts, type: "voice_call_changed", ignorable: true, byUid: "u1",
  participants: ids.map((id) => ({ agentId: id, name: `快照${id}` })),
});
const events: SessionEvent[] = [
  { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/w" },
  { ...base, seq: 1, ts: 1, type: "user_message", content: "[Stan]: @运营 帮我查下订单\n急", fromUid: "u1", mentions: ["a_1"] },
  { ...base, seq: 2, ts: 2, type: "assistant_message", content: "", model: "m", agentId: "a_1", toolCalls: [{ id: "t", name: "bash", args: {} }] },
  { ...base, seq: 3, ts: 3, type: "tool_result", toolCallId: "t", status: "ok", output: "x" },
  { ...base, seq: 4, ts: 4, type: "assistant_message", content: "查到了，三笔。", model: "m", agentId: "a_1" },
  { ...base, seq: 5, ts: 5, type: "chat_message", fromUid: "u2", label: "小红", content: "我也看看", mention: false },
  { ...base, seq: 6, ts: 6, type: "chat_message", fromUid: SYSTEM_SPEAKER_UID, label: "系统", content: "接力到上限了", mention: false },
  { ...base, seq: 7, ts: 7, type: "user_message", content: "后台任务完成了", origin: "background" },
  callChanged(8, 10, ["a_1"]),
  { ...base, seq: 9, ts: 11, type: "user_message", content: "[Stan]: 你好", fromUid: "u1", voice: true },
  { ...base, seq: 10, ts: 12, type: "assistant_message", content: "在呢", model: "m", agentId: "a_1" },
  callChanged(11, 20, []),
];

function renderPage(): void {
  useChat.setState({
    cloudSession: {
      workspaceId: "w", sessionId: "cs1", state: "ready", initiatorUid: "u1", ownerUid: "u1", selfUid: "u1",
      modelRoute: null, gapNote: null, events,
    },
  });
  // 两层 provider 都是 App 根上本来就有的：确认弹窗（useConfirm）与 Radix 的 Tooltip
  render(
    <TooltipPrimitive.Provider>
      <ConfirmProvider>
        <CloudSessionPage ws={ws} selfUid="u1" />
      </ConfirmProvider>
    </TooltipPrimitive.Provider>
  );
}

describe("会话地图 × 云会话时间线（ADR-0292）", () => {
  it("每一格刻度都对得上时间线上带同一个 data-turn-id 的那一行；旁白 / 步骤 / 被卡吞掉的一个记号都不带", async () => {
    renderPage();
    const map = await screen.findByRole("navigation", { name: "会话地图" });
    const labels = [...map.querySelectorAll('[data-slot="conversation-map-tick"]')].map((t) => t.getAttribute("aria-label"));
    expect(labels).toEqual(["@运营 帮我查下订单", "我也看看", "语音通话"]);
    const marked = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].map((el) => el.dataset["turnId"]);
    expect(marked).toEqual(["1", "5", "8"]);
  });

  it("点一格：滚的是带那个记号的那一行，在时间线自己的滚动区里", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "我也看看" }));
    expect(scrollToTurn).toHaveBeenCalledTimes(1);
    const [viewport, row] = vi.mocked(scrollToTurn).mock.calls[0]!;
    expect(row.dataset["turnId"]).toBe("5");
    expect(viewport.contains(row)).toBe(true);
    expect(viewport.className).toContain("overflow-y-auto");
  });
});
