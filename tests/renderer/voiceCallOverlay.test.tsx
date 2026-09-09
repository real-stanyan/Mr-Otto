// @vitest-environment jsdom
//
// 全屏通话视图真渲染一遍（#1185，ADR-0278；同 voiceCallBar.test.tsx 的理由）。判据：agent 与人
// （发起人 + 自己）都画成一格、在说的那格 data-state=speaking、顶上那句状态、字幕两行、
// 收起 / 关麦 / 静音 / 结束四颗钮各自打到回调。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { VoiceCallOverlay } from "../../src/renderer/src/components/VoiceCallOverlay.js";
import { MIC_OFF } from "../../src/renderer/src/lib/voiceMic.js";
import type { VoiceListenState } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { VoiceCallState } from "../../src/shared/voiceCall.js";

afterEach(() => cleanup());

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }, { uid: "u2", role: "member", label: "Mia", avatarUrl: "" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};
const call: VoiceCallState = { participants: [{ agentId: "admin", name: "管理员" }, { agentId: "a_1", name: "运营" }], sinceSeq: 3, sinceTs: Date.now() - 65_000 };
const listening = (over: Partial<VoiceListenState> = {}): VoiceListenState => ({
  sessionId: "s", listening: true, muted: false, sinceSeq: 3, speaking: null, queued: 0, error: null, text: null,
  mic: { ...MIC_OFF, status: "listening" }, ...over,
});
const handlers = () => ({
  onOpenChange: vi.fn(), onJoin: vi.fn(), onMic: vi.fn(), onMute: vi.fn(),
  onUpdate: vi.fn(async () => ({ ok: true as const })), onEnd: vi.fn(async () => ({ ok: true as const })),
});

describe("VoiceCallOverlay", () => {
  it("每个 agent 与人（发起人 + 自己）一格；在说的那格 data-state=speaking、状态句与字幕跟着它", () => {
    const h = handlers();
    render(
      <VoiceCallOverlay open onOpenChange={h.onOpenChange} ws={ws} call={call}
        voice={listening({ speaking: "admin", text: "能听到，你说话我这边都收得到" })}
        view={{ selfUid: "u1", starterUid: "u2", openAgentIds: new Set(["a_1"]) }}
        available ready onJoin={h.onJoin} onMic={h.onMic} onMute={h.onMute} onUpdate={h.onUpdate} onEnd={h.onEnd} />
    );
    const tiles = screen.getAllByRole("figure");
    expect(tiles.map((t) => t.getAttribute("data-state"))).toEqual(["speaking", "thinking", "listening", "listening"]);
    expect(tiles[3]).toHaveAttribute("data-self", "true");
    expect(screen.getByText("Stan（你）")).toBeInTheDocument();
    expect(screen.getByText("Mia")).toBeInTheDocument();
    expect(screen.getByText("管理员 正在说话")).toBeInTheDocument();
    expect(screen.getByText("能听到，你说话我这边都收得到")).toBeInTheDocument();
    expect(screen.getByText(/1:0\d/)).toBeInTheDocument();
  });

  it("我在说：自己那格 speaking、字幕「你：…」；四颗钮各打到自己的回调；收起 → onOpenChange(false)", async () => {
    const h = handlers();
    render(
      <VoiceCallOverlay open onOpenChange={h.onOpenChange} ws={ws} call={call}
        voice={listening({ mic: { ...MIC_OFF, status: "listening", active: true, level: 0.5, transcript: "帮我看下" } })}
        view={{ selfUid: "u1", starterUid: "u1", openAgentIds: new Set() }}
        available ready onJoin={h.onJoin} onMic={h.onMic} onMute={h.onMute} onUpdate={h.onUpdate} onEnd={h.onEnd} />
    );
    expect(screen.getAllByRole("figure")).toHaveLength(3); // 发起人就是自己：只画一格
    expect(screen.getByText("你在说话")).toBeInTheDocument();
    expect(screen.getByText("帮我看下")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关麦" }));
    expect(h.onMic).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    expect(h.onMute).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "结束通话" }));
    expect(h.onEnd).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(h.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("没加入：状态句「你还没加入」、自己那格 idle、画「加入」；没订阅画一句话不画钮", () => {
    const h = handlers();
    const { unmount } = render(
      <VoiceCallOverlay open onOpenChange={h.onOpenChange} ws={ws} call={call} voice={null}
        view={{ selfUid: "u1", starterUid: null, openAgentIds: new Set() }}
        available ready onJoin={h.onJoin} onMic={h.onMic} onMute={h.onMute} onUpdate={h.onUpdate} onEnd={h.onEnd} />
    );
    expect(screen.getByText("你还没加入")).toBeInTheDocument();
    expect(screen.getAllByRole("figure").at(-1)).toHaveAttribute("data-state", "idle");
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    expect(h.onJoin).toHaveBeenCalled();
    unmount();
    render(
      <VoiceCallOverlay open onOpenChange={h.onOpenChange} ws={ws} call={call} voice={null}
        view={{ selfUid: "u1", starterUid: null, openAgentIds: new Set() }}
        available={false} ready onJoin={h.onJoin} onMic={h.onMic} onMute={h.onMute} onUpdate={h.onUpdate} onEnd={h.onEnd} />
    );
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
    expect(screen.getByText("语音要订阅 Mr Otto")).toBeInTheDocument();
  });
});
