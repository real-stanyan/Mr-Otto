// @vitest-environment jsdom
//
// 群头部那颗「添加智能体」（#1280 A4）。四条断言各对着一个具体的失败：
// ① 只列不在群里的——已经在群里的那几只列出来，勾与不勾都说不出意思
// ② 「还能加 N 只」是算出来的，不是一句写死的话
// ③ 一只都没勾时按不动：按下去是一次什么都没改的 chat_update
// ④ 回调收到的是**变动之后的完整名单**（现有 + 勾的），不是只有勾的那几只——
//    chat_update 要的是名单不是「加了谁」，只发勾的那几只等于把群里原来的人全踢了
// ⑤ 满员时整颗钮按不动，并说清为什么（点了必然拿到服务端拒绝 = #722 的撒谎的勾）

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { AddAgentPopover } from "../../src/renderer/src/components/AddAgentPopover.js";
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

const ws = (...ids: [string, string][]) => ({
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "home",
  agents: ids.map(([id, name]) => agent(id, name)),
} as unknown as WorkspaceSnapshot);

const WS = ws(["admin", "管理员"], ["a_1", "运营"], ["a_2", "开发"], ["a_3", "投放"]);

const open = async () => userEvent.click(screen.getByRole("button", { name: "添加智能体" }));

describe("AddAgentPopover（#1280）", () => {
  it("只列不在群里的；「还能加 N 只」算出来", async () => {
    render(<AddAgentPopover ws={WS} current={["admin", "a_1"]} onConfirm={vi.fn()} />);
    await open();
    expect(screen.getByRole("checkbox", { name: "开发" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "投放" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "管理员" })).toBeNull();
    expect(screen.getByText("还能加 4 只")).toBeInTheDocument();
  });

  it("一只都没勾时按不动", async () => {
    render(<AddAgentPopover ws={WS} current={["admin"]} onConfirm={vi.fn()} />);
    await open();
    expect(screen.getByRole("button", { name: "拉进来" })).toBeDisabled();
  });

  it("回调收到的是变动之后的完整名单（现有 + 勾的），顺序跟名册走", async () => {
    const onConfirm = vi.fn();
    render(<AddAgentPopover ws={WS} current={["a_1"]} onConfirm={onConfirm} />);
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: "投放" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "管理员" }));
    await userEvent.click(screen.getByRole("button", { name: "拉进来" }));
    expect(onConfirm).toHaveBeenCalledWith(["admin", "a_1", "a_3"]);
  });

  it("超出上限的那几只勾不动：勾得上就等于给一颗点了必然被拒的钮", async () => {
    render(<AddAgentPopover ws={ws(...[
      ["admin", "管理员"], ["a_1", "运营"], ["a_2", "开发"], ["a_3", "投放"],
      ["a_4", "客服"], ["a_5", "财务"], ["a_6", "法务"],
    ] as [string, string][])} current={["admin", "a_1", "a_2", "a_3", "a_4"]} onConfirm={vi.fn()} />);
    await open();
    expect(screen.getByText("还能加 1 只")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "财务" }));
    expect(screen.getByRole("checkbox", { name: "法务" })).toBeDisabled();
    // 勾上的那只照样取消得了，否则勾错一只就没法改
    expect(screen.getByRole("checkbox", { name: "财务" })).toBeEnabled();
  });

  it("满员：整颗钮按不动，并说清为什么", async () => {
    render(<AddAgentPopover ws={ws(...[
      ["admin", "管理员"], ["a_1", "运营"], ["a_2", "开发"], ["a_3", "投放"],
      ["a_4", "客服"], ["a_5", "财务"], ["a_6", "法务"],
    ] as [string, string][])} current={["admin", "a_1", "a_2", "a_3", "a_4", "a_5"]} onConfirm={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "添加智能体" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("title", "群里已经有六只了");
  });

  it("名册里一只都不剩时也按不动——没有可加的人", async () => {
    render(<AddAgentPopover ws={ws(["admin", "管理员"])} current={["admin"]} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: "添加智能体" })).toBeDisabled();
  });
});
