// @vitest-environment jsdom
//
// 名单那一行真渲染一遍（#1280 A4）。纯逻辑那份（cloudTimeline.test.ts）钉的是
// 每一格的值，钉不到「有没有被画出来」——同 voiceCallCard.test.tsx / #1068 的理由。
//
// 三条断言各对着一个具体的失败：
// ① 居中（`self-center`）——这一条说的是整个群此刻的状态，不是机器的内务，所以
//    与旁边那几行靠左的旁白故意分家（ADR-0286 给通话那一行定的结论）
// ② 每个名字左边一张脸
// ③ **名册里查不到的不给脸**：派生对陌生 id 也算得出一张脸，画上去等于宣称它还在
//    名册里——而被移出的那只常常正是刚被删掉的那只
//
// #1345 之后脸是一张 `<canvas data-face>`（会动的像素形象）而不是 `<img>`；三条
// 判据一个字没改，只是「一张脸」在 DOM 里换了个形状。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ChatRosterRow } from "../../src/renderer/src/components/CloudSessionPage.js";
import type { RosterLinePart } from "../../src/shared/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
});
afterEach(cleanup);

const agent = (agentId: string, name: string) => ({
  agentId, name, description: "", instructions: "", models: [], tools: [],
  createdBy: "me", updatedTs: 0, avatarSlot: null,
});

const WS = {
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "home",
  agents: [agent("admin", "管理员"), agent("a_1", "投放")],
} as unknown as WorkspaceSnapshot;

const parts = (...p: RosterLinePart[]): RosterLinePart[] => p;

describe("ChatRosterRow（#1280）", () => {
  it("整句画出来、居中", () => {
    const { container } = render(
      <ChatRosterRow ws={WS} parts={parts({ text: "你把" }, { text: "「投放」", agentId: "a_1" }, { text: "拉进了群聊" })} />
    );
    expect(screen.getByText(/你把/)).toBeInTheDocument();
    expect(container.querySelector("p")!.className).toContain("self-center");
    expect(container.textContent).toBe("你把「投放」拉进了群聊");
  });

  it("名字左边一张脸", () => {
    const { container } = render(
      <ChatRosterRow ws={WS} parts={parts({ text: "你把" }, { text: "「投放」", agentId: "a_1" }, { text: "拉进了群聊" })} />
    );
    const face = container.querySelector("canvas[data-face]");
    expect(face).not.toBeNull();
    // 脸与名字包在同一个 whitespace-nowrap 里：断在中间就是一张没有主人的脸
    expect(face!.parentElement!.className).toContain("whitespace-nowrap");
    expect(face!.parentElement!.textContent).toBe("「投放」");
  });

  it("名册里查不到的那只不给脸（多半是刚被删掉的那只）", () => {
    const { container } = render(
      <ChatRosterRow ws={WS} parts={parts({ text: "你把" }, { text: "「已删的那只」", agentId: "a_9" }, { text: "移出了群聊" })} />
    );
    expect(container.querySelector("canvas[data-face]")).toBeNull();
    // 话照说——没有脸不等于没有这件事
    expect(container.textContent).toBe("你把「已删的那只」移出了群聊");
  });
});
