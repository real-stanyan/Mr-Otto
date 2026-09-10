// @vitest-environment jsdom
//
// 云会话输入框右下角那枚上下文用量环（#1138）。判据（谁的视野、哪款窗口、最吃紧是哪只）
// 钉在 tests/renderer/lib/cloudContext.test.ts；这里只盯组件这一层三件事：
//
// ① **窗口都不在目录里 → 整枚不画**（#193，同本地那枚 ctxWindow === null 的处置）。
// ② **额度那半按 owner 画**：告警点读的是 store.billing = 我的订阅，而云会话烧的是
//    owner 的额度（ADR-0233）——我不是 owner 时，额度再吃紧那枚点也不出现。
// ③ 群里不止一只时浮层逐只列一行、段头写清画的是谁的；只有一只时段头就是「会话上下文」。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { CloudContextRing } from "../../src/renderer/src/components/CloudContextRing.js";
import { useChat } from "../../src/renderer/src/store.js";
import { findModel } from "../../src/shared/modelCatalog.js";
import type { BillingMe } from "../../src/shared/billing.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { SessionEvent } from "../../src/session/events.js";

const KNOWN = "deepseek-flash";
const KNOWN_WINDOW = findModel(KNOWN)!.contextWindow;

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1_700_000_000_000 + seq });
const created = (): SessionEvent => ({ ...env(), type: "session_created", workspace: "/work", cloud: { workspaceId: "w" } });
const envelope = (agentId: string, model: string): SessionEvent =>
  ({ ...env(), type: "request_envelope", ignorable: true, model, system: "", tools: [], agentId });
const reply = (agentId: string, model: string, prompt: number): SessionEvent =>
  ({ ...env(), type: "assistant_message", content: "好。", model, usage: { promptTokens: prompt, completionTokens: 100 }, agentId });

const NOW = Date.now();
const HOUR = 3_600_000;
/** 5h 窗已用 82% —— 本地那枚环在这份账下会亮橙点（同 ContextRingTrigger.test） */
const tight = (): BillingMe =>
  ({
    plan: "pro", status: "active", plans: [], models: [], modelPlatforms: {},
    windows: {
      h5: { usedMicro: 820, limitMicro: 1000, resetAt: NOW + HOUR },
      week: { usedMicro: 100, limitMicro: 1000, resetAt: NOW + 96 * HOUR },
    },
    addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  }) as unknown as BillingMe;

const ring = () => document.querySelector("svg circle[stroke-dasharray]");
const dot = () => screen.queryByTestId("quota-alert-dot");

afterEach(() => {
  cleanup();
  useChat.setState({ billing: null });
});

describe("CloudContextRing", () => {
  it("① 窗口都不在目录里 → 整枚不画", () => {
    const { container } = render(
      <CloudContextRing events={[created(), envelope("a_1", "no-such-model"), reply("a_1", "no-such-model", 10)]} ws={ws} fallbackModel={null} quotaApplies />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("还没人开过口但团队默认款已知 → 环已经在（第一轮就画得出来）", () => {
    render(<CloudContextRing events={[created()]} ws={ws} fallbackModel={KNOWN} quotaApplies={false} />);
    expect(ring()).not.toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName("上下文用量详情");
  });

  it("② 我是 owner：额度吃紧时亮点；我不是 owner：同一份账也不亮", () => {
    useChat.setState({ billing: { me: tight(), fetchedAt: NOW, exhausted: null } });
    const events = [created(), envelope("a_1", KNOWN), reply("a_1", KNOWN, 1_000)];
    const { unmount } = render(<CloudContextRing events={events} ws={ws} fallbackModel={null} quotaApplies />);
    expect(dot()).toHaveAttribute("data-tone", "warn");
    unmount();
    render(<CloudContextRing events={events} ws={ws} fallbackModel={null} quotaApplies={false} />);
    expect(dot()).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName("上下文用量详情");
  });

  it("环画最吃紧那只：弧长按它的占比，不按整份日志的最后一笔账", () => {
    // A 占 40%，之后 B 回了一句 1% 的——环仍是 A 的 40%
    const events = [
      created(),
      envelope("a_1", KNOWN), reply("a_1", KNOWN, Math.round(KNOWN_WINDOW * 0.4)),
      envelope("a_2", KNOWN), reply("a_2", KNOWN, Math.round(KNOWN_WINDOW * 0.01)),
    ];
    render(<CloudContextRing events={events} ws={ws} fallbackModel={null} quotaApplies={false} />);
    const arc = ring() as SVGCircleElement;
    const c = Number(arc.getAttribute("stroke-dasharray"));
    const off = Number(arc.getAttribute("stroke-dashoffset"));
    expect(Math.round((1 - off / c) * 100)).toBe(40);
  });

  it("③ 群里不止一只：浮层逐只列，最吃紧那只的名字进段头", async () => {
    const events = [
      created(),
      envelope("a_1", KNOWN), reply("a_1", KNOWN, Math.round(KNOWN_WINDOW * 0.4)),
      envelope("a_2", KNOWN), reply("a_2", KNOWN, Math.round(KNOWN_WINDOW * 0.01)),
    ];
    render(<CloudContextRing events={events} ws={ws} fallbackModel={null} quotaApplies={false} />);
    // Radix Tooltip：键盘聚焦触发器即开（不走指针那 delay）
    fireEvent.focus(screen.getByRole("button"));
    const rows = await screen.findAllByTestId("agent-context-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^运营40% · /),
      expect.stringMatching(/^广告1% · /),
    ]);
    expect(screen.getByText("「运营」的上下文")).toBeInTheDocument();
  });

  it("只有一只：不列名单，段头就是「会话上下文」", async () => {
    render(
      <CloudContextRing events={[created(), envelope("a_1", KNOWN), reply("a_1", KNOWN, 1_000)]} ws={ws} fallbackModel={null} quotaApplies={false} />,
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(await screen.findByText("会话上下文")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-context-rows")).toBeNull();
  });
});
