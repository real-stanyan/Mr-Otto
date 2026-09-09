// @vitest-environment jsdom
//
// 通话栏真渲染一遍（#1163，同 mentionOptionRow.test.tsx 的理由：纯逻辑钉得住每一格的值，
// 钉不到「有没有被画出来」）。判据四条：有通话画参与者；正在说话的那只带 data-speaking；
// 没在听 → 有订阅画「加入」、没订阅画一句话不画钮（#722 纪律：点了必然失败的钮是撒谎）；
// 在听 → 静音 / 结束通话两颗钮。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { VoiceCallBar } from "../../src/renderer/src/components/VoiceCallBar.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { VoiceCallState } from "../../src/shared/voiceCall.js";
import type { VoiceListenState } from "../../src/renderer/src/store.js";
import { MIC_OFF } from "../../src/renderer/src/lib/voiceMic.js";

afterEach(() => cleanup());

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};
const call: VoiceCallState = {
  participants: [{ agentId: "admin", name: "管理员" }, { agentId: "a_1", name: "运营" }],
  sinceSeq: 3, sinceTs: Date.now() - 65_000,
};
const listening = (over: Partial<VoiceListenState> = {}): VoiceListenState => ({
  sessionId: "s", listening: true, muted: false, sinceSeq: 3, speaking: null, queued: 0, error: null, mic: MIC_OFF, ...over,
});
const noop = { onJoin: () => {}, onMute: () => {}, onMic: () => {}, onUpdate: async () => ({ ok: true as const }), onEnd: async () => ({ ok: true as const }) };

describe("VoiceCallBar", () => {
  it("画通话中的参与者（名字现查名单）、计时从 sinceTs 起", () => {
    render(<VoiceCallBar ws={ws} call={call} voice={null} available={true} ready={true} {...noop} />);
    expect(screen.getByRole("region", { name: "语音通话" })).toBeInTheDocument();
    expect(screen.getByText("语音通话中")).toBeInTheDocument();
    expect(screen.getByLabelText("管理员")).toBeInTheDocument();
    expect(screen.getByLabelText("运营")).toBeInTheDocument();
    expect(screen.queryByLabelText("广告")).not.toBeInTheDocument();
    expect(screen.getByText(/1:0\d/)).toBeInTheDocument();
  });

  it("正在说话的那只带 data-speaking", () => {
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ speaking: "a_1" })} available={true} ready={true} {...noop} />);
    expect(screen.getByLabelText("运营")).toHaveAttribute("data-speaking", "true");
    expect(screen.getByLabelText("管理员")).toHaveAttribute("data-speaking", "false");
  });

  it("没在听：有订阅画「加入」，点了调 onJoin；没订阅画一句话、不画钮", () => {
    const onJoin = vi.fn();
    render(<VoiceCallBar ws={ws} call={call} voice={null} available={true} ready={true} {...noop} onJoin={onJoin} />);
    screen.getByRole("button", { name: "加入" }).click();
    expect(onJoin).toHaveBeenCalledTimes(1);
    cleanup();
    render(<VoiceCallBar ws={ws} call={call} voice={null} available={false} ready={true} {...noop} />);
    expect(screen.queryByRole("button", { name: "加入" })).not.toBeInTheDocument();
    expect(screen.getByText(/订阅/)).toBeInTheDocument();
  });

  it("在听：静音钮翻 onMute；「结束通话」在；error 那句画出来", () => {
    const onMute = vi.fn();
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ error: "订阅网关暂时不供语音合成。" })} available={true} ready={true} {...noop} onMute={onMute} />);
    screen.getByRole("button", { name: "静音" }).click();
    expect(onMute).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "结束通话" })).toBeInTheDocument();
    expect(screen.getByText("订阅网关暂时不供语音合成。")).toBeInTheDocument();
    cleanup();
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ muted: true })} available={true} ready={true} {...noop} onMute={onMute} />);
    screen.getByRole("button", { name: "取消静音" }).click();
    expect(onMute).toHaveBeenLastCalledWith(false);
  });

  it("没连上（ready=false）：加人 / 结束都禁用，加入照旧能点（本机动作不走网络）", () => {
    render(<VoiceCallBar ws={ws} call={call} voice={listening()} available={true} ready={false} {...noop} />);
    expect(screen.getByRole("button", { name: "结束通话" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加人" })).toBeDisabled();
  });
});

// 麦克风那半（#1176，ADR-0273）：在听时多一颗麦克风钮（开着 = 「关麦」，关着 = 「开麦」），
// 实时字幕一行，没权限那句画在错误行。
describe("VoiceCallBar：麦克风", () => {
  it("麦开着：钮叫「关麦」、点了 onMic(false)；字幕画「你：…」", () => {
    const onMic = vi.fn();
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ mic: { ...MIC_OFF, status: "listening", transcript: "帮我看" } })} available={true} ready={true} {...noop} onMic={onMic} />);
    screen.getByRole("button", { name: "关麦" }).click();
    expect(onMic).toHaveBeenCalledWith(false);
    expect(screen.getByText(/你：帮我看/)).toBeInTheDocument();
  });

  it("麦关着：钮叫「开麦」、点了 onMic(true)；没字幕", () => {
    const onMic = vi.fn();
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ mic: MIC_OFF })} available={true} ready={true} {...noop} onMic={onMic} />);
    screen.getByRole("button", { name: "开麦" }).click();
    expect(onMic).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/你：/)).not.toBeInTheDocument();
  });

  it("半双工暂停：钮仍是「关麦」但标出「对方在说」；没权限：那句话画在错误行", () => {
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ mic: { ...MIC_OFF, status: "paused" } })} available={true} ready={true} {...noop} />);
    const btn = screen.getByRole("button", { name: "关麦" });
    expect(btn).toHaveAttribute("data-mic", "paused");
    expect(btn).toHaveAttribute("title", expect.stringContaining("在说话"));
    cleanup();
    render(<VoiceCallBar ws={ws} call={call} voice={listening({ mic: { ...MIC_OFF, status: "denied", error: "没有「麦克风」权限：系统设置 → 隐私与安全性 → 麦克风" } })} available={true} ready={true} {...noop} />);
    expect(screen.getByText(/系统设置/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开麦" })).toHaveAttribute("data-mic", "denied");
  });

  it("没在听：没有麦克风钮", () => {
    render(<VoiceCallBar ws={ws} call={call} voice={null} available={true} ready={true} {...noop} />);
    expect(screen.queryByRole("button", { name: /麦/ })).not.toBeInTheDocument();
  });
});
