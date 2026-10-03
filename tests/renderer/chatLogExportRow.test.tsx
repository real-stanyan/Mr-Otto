// @vitest-environment jsdom
//
// 聊天设置抽屉里的「导出 log」（#1446）。三条断言各对着一个具体的失败：
// ① 这条聊天没开着：按钮禁用并说清去哪儿开（不是点了没反应）
// ② 开着且还有更早的：先把历史翻齐、再导出——导出的是**翻页之后**的事件，不是点按钮那一刻的尾巴
// ③ 翻页失败：问人「重试 / 就导出这些」，选导出就用已读到的

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const downloads: { filename: string; text: string }[] = [];
vi.mock("../../src/renderer/src/lib/downloadText.js", () => ({
  downloadText: (filename: string, _mime: string, text: string) => { downloads.push({ filename, text }); },
}));

import { GroupSettingsDrawer } from "../../src/renderer/src/components/GroupSettingsDrawer.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
  // vaul 在 pointerdown 上调 setPointerCapture，jsdom 没实现——抛出来是未捕获异常、退出码 1（同 GroupSettingsDrawer.test）
  for (const m of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
    Object.defineProperty(HTMLElement.prototype, m, { configurable: true, value: () => false });
  }
});
afterEach(() => { cleanup(); downloads.length = 0; });

const HOME = {
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "home",
  agents: [{ agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null }],
} as unknown as WorkspaceSnapshot;

const ev = (seq: number) => ({ seq, ts: seq, type: "chat_message", text: `m${seq}` });

function seed(cloudSession: unknown, loadOlderCloudEvents = vi.fn()): void {
  useChat.setState({
    workspaceGroups: [HOME],
    cloudSessionList: { home: [{ id: "g-1", title: "上线冲刺", chatKind: "group", agentIds: ["a_1"], updatedTs: 1, archived: false }] },
    groupSettingsFor: "g-1",
    closeGroupSettings: vi.fn(),
    cloudSession,
    loadOlderCloudEvents,
  } as never);
}

const draw = () => render(<ConfirmProvider><GroupSettingsDrawer /></ConfirmProvider>);

describe("导出 log 按钮（#1446）", () => {
  it("这条聊天没开着：禁用，并说清先打开", () => {
    seed(null);
    draw();
    expect(screen.getByRole("button", { name: /导出 log/ })).toBeDisabled();
    expect(screen.getByText("先打开这条聊天再导出")).toBeInTheDocument();
  });

  it("开着且有更早的：先翻齐再导出，导出的是翻页之后的事件", async () => {
    const cs: Record<string, unknown> = { sessionId: "g-1", workspaceId: "home", state: "ready", hasOlder: true, events: [ev(3), ev(4)] };
    const load = vi.fn(async () => {
      const cur = useChat.getState().cloudSession as unknown as { events: unknown[] };
      useChat.setState({ cloudSession: { ...cs, hasOlder: false, events: [ev(1), ev(2), ...cur.events] } } as never);
      return { ok: true as const, hasOlder: false };
    });
    seed(cs, load);
    draw();
    await userEvent.click(screen.getByRole("button", { name: /导出 log/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(downloads[0]!.text.trim().split("\n")).toHaveLength(4);
    expect(downloads[0]!.filename).toMatch(/^otto-cloud-g-1-\d{8}-\d{6}\.jsonl$/);
  });

  it("翻页失败：问人，选「就导出这些」用已读到的", async () => {
    const cs = { sessionId: "g-1", workspaceId: "home", state: "ready", hasOlder: true, events: [ev(3), ev(4)] };
    seed(cs, vi.fn(async () => ({ ok: false as const, message: "没读到更早的消息" })));
    draw();
    await userEvent.click(screen.getByRole("button", { name: /导出 log/ }));
    expect(await screen.findByText("只读到 2 条，更早的没读到（没读到更早的消息）")).toBeInTheDocument();
    expect(downloads).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "就导出这些" }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.text.trim().split("\n")).toHaveLength(2);
  });
});
