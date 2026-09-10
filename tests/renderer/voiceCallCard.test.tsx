// @vitest-environment jsdom
//
// 通话卡**真渲染一遍**（#1233，ADR-0288；这个文件取代了 #1228 的 voiceCallRow.test.tsx
// —— 它测的那个组件被这一版换掉了，不是删掉一条测试去换绿：ADR-0286 的两条结论
// 原样成立，只是从「时间线上那一行」搬到了「卡片 + 卡里的分隔线」，所以那几条断言
// 也跟着搬进来了，另外补上这一版新增的几条）。
//
// 折卡的判据钉在 tests/renderer/voiceCallCards.test.ts（纯逻辑）；这里补的是那份
// 够不到的四件事：
// ① 卡**居中**（VoiceCallCard 的值里没有「对齐」这个概念）
// ② 收起时**只报多久 / 多少句**，且**不带最新一句**（维护者拍板）
// ③ 名字左边**真有一张脸**（avatarSrc 是对的，不代表 <img> 挂上去了）
// ④ 点一下**真打开弹窗**，通话里说过的每一句在里面
//
// Radix 的 Avatar.Image 要等图片真的加载完才挂 <img>，而 jsdom 从不真的取图 ——
// 桩打在 complete / naturalWidth 上而不是 onload 上（naturalWidth 恒为 0，光派
// load 事件仍然判成 error）。这段抄自 #1228 那份，来源是 mentionOptionRow.test.tsx。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { VoiceCallCardRow } from "../../src/renderer/src/components/CloudSessionPage.js";
import { voiceCallCards } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { SessionEvent } from "../../src/session/events.js";

beforeAll(() => {
  const store = new WeakMap<object, string>();
  Object.defineProperty(window.Image.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return store.get(this) ?? "";
    },
    set(this: HTMLImageElement, value: string) {
      store.set(this, value);
    },
  });
  Object.defineProperty(window.Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(window.Image.prototype, "naturalWidth", { configurable: true, get: () => 1 });
});

afterEach(cleanup);

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "https://example.test/stan.png" },
    { uid: "u2", role: "member", label: "无头像的人", avatarUrl: "" },
  ],
};

const base = { sessionId: "s" } as const;
const callChanged = (seq: number, ts: number, ids: string[]): SessionEvent => ({
  ...base, seq, ts, type: "voice_call_changed", ignorable: true, byUid: "u1",
  participants: ids.map((id) => ({ agentId: id, name: `快照${id}` })),
});
const spoke = (seq: number, ts: number, text: string): SessionEvent => ({
  ...base, seq, ts, type: "user_message", content: `[Stan]: ${text}`, fromUid: "u1", mentions: ["a_1"], voice: true,
});
/** agent 的最终答案（有正文、没要工具 → isAgentStep 为假，进得了卡） */
const answered = (seq: number, ts: number, text: string, agentId = "a_1"): SessionEvent => ({
  ...base, seq, ts, type: "assistant_message", content: text, agentId, model: "m",
});

/** 一场结束了的通话：两句人话 + 一句回复，中途拉了「广告」进来 */
const ENDED: SessionEvent[] = [
  callChanged(1, 0, ["a_1"]),
  spoke(2, 2_000, "能听到吗"),
  answered(3, 4_000, "能，很清楚。"),
  callChanged(4, 80_000, ["a_1", "a_2"]),
  spoke(5, 92_000, "广告那边也看一眼"),
  callChanged(6, 372_000, []),
];

function renderCard(events: SessionEvent[]): HTMLElement {
  const { cards } = voiceCallCards(events, ws, "u1");
  const card = cards.get(1);
  if (card === undefined) throw new Error("这场通话没折出卡");
  const { container } = render(<VoiceCallCardRow card={card} />);
  const el = container.firstElementChild;
  if (el === null) throw new Error("卡没画出来");
  return el as HTMLElement;
}

describe("通话卡收起时（#1233）", () => {
  it("居中：这一条说的是整个群此刻的状态，与旁边那几行靠左的旁白故意不同款", () => {
    expect(renderCard(ENDED).className).toContain("justify-center");
  });

  it("只报「多久 · 多少句」——句数不含名单变更那两行", () => {
    renderCard(ENDED);
    expect(screen.getByText("· 6 分 12 秒 · 3 句")).toBeInTheDocument();
    expect(screen.getByText("语音通话")).toBeInTheDocument();
  });

  it("不带最新一句（维护者拍板）：收起时正文一个字都不露", () => {
    const el = renderCard(ENDED);
    expect(el.textContent).not.toContain("广告那边也看一眼");
    expect(el.textContent).not.toContain("能听到吗");
  });

  it("参与者是整场的并集：中途才进来的那只也在那一排脸里", () => {
    renderCard(ENDED);
    expect(screen.getByText("运营、广告、Stan")).toBeInTheDocument();
  });

  it("每个参与者一张脸：agent 画内置像素图、人画成员表里那张", () => {
    const srcs = [...renderCard(ENDED).querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toHaveLength(3);
    expect(srcs.filter((s) => s?.includes("agent-avatars"))).toHaveLength(2);
    expect(srcs).toContain("https://example.test/stan.png");
  });

  it("还开着的那场画「通话中」不画「语音通话」", () => {
    renderCard(ENDED.slice(0, 3));
    expect(screen.getByText("通话中")).toBeInTheDocument();
    expect(screen.queryByText("语音通话")).toBeNull();
  });

  it("名册里查不到的不画空 <img>，退回首字母（同 ADR-0286 那条纪律）", () => {
    renderCard([callChanged(1, 0, ["a_x"]), callChanged(2, 1_000, [])]);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("快")).toBeInTheDocument(); // 快照a_x 的首字
  });
});

describe("点开那个弹窗（#1233）", () => {
  it("通话里说过的每一句都在里面，中途的名单变更画成一道分隔", () => {
    renderCard(ENDED);
    fireEvent.click(screen.getByRole("button", { name: /看记录/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("能听到吗")).toBeInTheDocument();
    expect(screen.getByText("能，很清楚。")).toBeInTheDocument();
    expect(screen.getByText("广告那边也看一眼")).toBeInTheDocument();
    // 名单变更那行：走的仍然是 voiceCallLineParts，所以那句话逐字没变（ADR-0286）
    expect(screen.getByText("把")).toBeInTheDocument();
    expect(screen.getByText("拉进了通话")).toBeInTheDocument();
  });

  it("每一行带说话人与「第几分几秒说的」——通话里墙上时间没有意义", () => {
    renderCard(ENDED);
    fireEvent.click(screen.getByRole("button", { name: /看记录/ }));
    expect(screen.getByText("00:02")).toBeInTheDocument();
    expect(screen.getByText("01:32")).toBeInTheDocument();
  });

  it("一句话都没说的通话：说「还没有人说话」而不是一片空白", () => {
    renderCard([callChanged(1, 0, ["a_1"])]);
    fireEvent.click(screen.getByRole("button", { name: /看记录/ }));
    expect(screen.getByText("还没有人说话。")).toBeInTheDocument();
  });
});
