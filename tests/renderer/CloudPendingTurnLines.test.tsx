// @vitest-environment jsdom
//
// 时间线末尾那几行「谁还没回」**真渲染一遍**（#1055）。谁进这份清单、谁画得出
// 「停止」两件事分别钉在 tests/shared/turnLedger.test.ts 与
// tests/renderer/cloudTimelineLabels.test.ts（stopButtonRows）里；这里补的是那两份
// 纯逻辑够不到的一件事——**running 与 queued 画成两种东西**：
// 前者是一枚输入指示器（三点跳动的气泡，长在回复要落的位置上），后者只是一行小灰字。
// 这条分别不是装饰：自 #1055 起中间步骤整段不上时间线，那枚指示器成了「它在忙」
// 在界面上唯一的痕迹；而给一个一个 token 都还没跑的 queued 也画上打字气泡，
// 就是 #722 那个撒谎的勾的一般形式。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PendingTurnLines } from "../../src/renderer/src/components/CloudSessionPage.js";
import type { CloudSessionState } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};

const cs: CloudSessionState = {
  workspaceId: "w", sessionId: "s", state: "ready",
  initiatorUid: "u1", ownerUid: "u1", selfUid: "u1",
  modelRoute: null, gapNote: null, events: [],
};

const base = { sessionId: "s", ts: 0 } as const;

/** 「运营」已经有动静了（running），「广告」还没轮到（queued）—— openTurns 的两种状态 */
const events: SessionEvent[] = [
  { ...base, seq: 1, type: "user_message", content: "[Stan]: @运营 @广告 一起看下", fromUid: "u1", mentions: ["a_1", "a_2"] },
  { ...base, seq: 2, type: "assistant_message", content: "", model: "m", agentId: "a_1", toolCalls: [{ id: "c1", name: "bash", args: {} }] },
];

const typingIndicators = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="typing-indicator"]'));

afterEach(cleanup);

describe("PendingTurnLines（#1055：等待过程改用输入指示器呈现）", () => {
  it("running 那只画一枚输入指示器，queued 那只不画 —— 排着队的一个 token 都还没跑", () => {
    render(<PendingTurnLines events={events} ws={ws} selfUid="u1" cs={cs} />);

    const dots = typingIndicators();
    expect(dots).toHaveLength(1);
    // 读屏软件念得出是**谁**在打字：群里同一刻可能有好几只，上游写死的
    // "Assistant is typing" 念四遍等于没说（本仓对 registry 那份的改动 ②）
    expect(dots[0]).toHaveAttribute("aria-label", "运营 正在输入");

    expect(screen.getByText("广告 排队中…")).toBeInTheDocument();
    // queued 那行不该冒出「正在输入」这类说它在打字的话
    expect(screen.queryByLabelText("广告 正在输入")).toBeNull();
  });

  it("指示器长在气泡里 —— 答案到了是同一张气泡里点变成字，不是一个东西消失另一个出现", () => {
    render(<PendingTurnLines events={events} ws={ws} selfUid="u1" cs={cs} />);
    expect(typingIndicators()[0]?.closest('[data-slot="bubble"]')).not.toBeNull();
  });

  it("「停止」只画在 running 那行上 —— queued 没有可停的东西（stopButtonRows 本来就只收 running）", () => {
    render(<PendingTurnLines events={events} ws={ws} selfUid="u1" cs={cs} />);
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
  });

  it("一条都不欠时整块不出 —— 不画一行「没有人在回复」", () => {
    const { container } = render(<PendingTurnLines events={[]} ws={ws} selfUid="u1" cs={cs} />);
    expect(container).toBeEmptyDOMElement();
    expect(typingIndicators()).toHaveLength(0);
  });
});
