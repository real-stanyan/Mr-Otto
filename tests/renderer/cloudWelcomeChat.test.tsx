// @vitest-environment jsdom
//
// 聊天版开局卡（#1280）。三条各对着一个具体的失败：
// ① 私聊那一支换主语——这一屏只有它一个主语，不是「在某某团队里开一条会话」；
// ② 说清**什么都还没建**（ADR-0218：那颗 ＋ 也只是把主区换成 composer），
//    以及这条线是永久的（不用以后再找「那次的会话」）；
// ③ **没有「取消」钮**——点花名册上别的一只就走了，而「取消」暗示这里有个
//    待办要收拾。团队那颗 ＋ 开的卡照旧有它。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { CloudWelcome } from "../../src/renderer/src/components/CloudWelcome.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
});
afterEach(cleanup);

const agent = (agentId: string, name: string, description: string) => ({
  agentId, name, description, instructions: "", models: [], tools: [],
  createdBy: "me", updatedTs: 0, avatarSlot: null,
});

const HOME = {
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "home",
  agents: [agent("a_000000000001", "运营", "盯店铺数据、写周报")],
} as unknown as WorkspaceSnapshot;

const TEAM = {
  id: "t1", name: "奶茶店", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "team", agents: [],
} as unknown as WorkspaceSnapshot;

describe("CloudWelcome 的聊天版（#1280）", () => {
  it("私聊的开局卡：写它是谁、说清「什么都还没建」、没有取消钮", () => {
    useChat.setState({
      workspaceGroups: [HOME],
      cloudDraftChat: { kind: "dm", agentId: "a_000000000001" },
      workspaceGroupsError: null,
    } as never);
    render(<CloudWelcome workspaceId="home" />);
    expect(screen.getByText("运营")).toBeInTheDocument();
    expect(screen.getByText(/说第一句话就开始了/)).toBeInTheDocument();
    expect(screen.getByText(/以后一直是这一条/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("跟运营说点什么")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    // 主语换了：不再是「在「我的智能体」里开一条会话」
    expect(screen.queryByText(/里开一条会话/)).toBeNull();
  });

  it("团队那颗 ＋ 开的卡一字不变", () => {
    useChat.setState({ workspaceGroups: [TEAM], cloudDraftChat: null, workspaceGroupsError: null } as never);
    render(<CloudWelcome workspaceId="t1" />);
    expect(screen.getByText("在「奶茶店」里开一条会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("要它做什么？不 @ 谁的话，谁的活谁接。回车发送")).toBeInTheDocument();
  });

  it("名册里查不到那只（快照还没到 / 刚被删）：退回团队那套文案，不画一张没有主人的脸", () => {
    useChat.setState({
      workspaceGroups: [HOME],
      cloudDraftChat: { kind: "dm", agentId: "a_ffffffffffff" },
      workspaceGroupsError: null,
    } as never);
    render(<CloudWelcome workspaceId="home" />);
    expect(screen.getByText("在「我的智能体」里开一条会话")).toBeInTheDocument();
  });
});
