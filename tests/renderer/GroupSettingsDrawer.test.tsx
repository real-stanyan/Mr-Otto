// @vitest-environment jsdom
//
// 群设置抽屉（#1280 A4）。四条断言各对着一个具体的失败：
// ① 成员逐行列出、「移出」发的是**变动之后的完整名单**（chat_update 要的是名单
//    不是「摘掉谁」）
// ② **最后一只也移得走**：空群合法（0037 给 group 那条 CHECK 写的是 0..6），
//    删一只智能体不该连坐删掉它待过的群
// ③ 改名只发名字那一格——把名单一起发过去等于替用户声明「那一格我也确认是这个值」
// ④ 这个群查不到（刚被解散 / 还没拉到清单）时整扇抽屉不画：`open` 的判据是
//    **查得到的那一行**不是 `groupSettingsFor`，所以解散之后不用另写善后

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { GroupSettingsDrawer } from "../../src/renderer/src/components/GroupSettingsDrawer.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
  // 抽屉那层是 vaul，它在每次 pointerdown 上调 setPointerCapture 想接管拖拽手势，
  // 而 jsdom 没实现这一对——**它抛出来是未捕获异常，整个文件的退出码是 1**（用例
  // 却全绿，门禁读的是退出码）。装两个空实现，同 navStack.test.tsx 那份桩
  for (const m of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
    Object.defineProperty(HTMLElement.prototype, m, { configurable: true, value: () => false });
  }
});
afterEach(cleanup);

const agent = (agentId: string, name: string) => ({
  agentId, name, description: "", instructions: "", models: [], tools: [],
  createdBy: "me", updatedTs: 0, avatarSlot: null,
});

const HOME = {
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "home",
  agents: [agent("admin", "管理员"), agent("a_1", "运营")],
} as unknown as WorkspaceSnapshot;

const chat = (agentIds: string[]) => ({
  id: "g-1", title: "上线冲刺", chatKind: "group" as const, agentIds, updatedTs: 1, archived: false,
});

const updateGroupChat = vi.fn(async () => ({ ok: true as const }));
const dissolveGroupChat = vi.fn(async () => ({ ok: true as const }));

function seed(over: Record<string, unknown> = {}): void {
  updateGroupChat.mockClear();
  dissolveGroupChat.mockClear();
  useChat.setState({
    workspaceGroups: [HOME],
    cloudSessionList: { home: [chat(["admin", "a_1"])] },
    groupSettingsFor: "g-1",
    updateGroupChat, dissolveGroupChat,
    closeGroupSettings: vi.fn(),
    ...over,
  } as never);
}

const draw = () => render(<ConfirmProvider><GroupSettingsDrawer /></ConfirmProvider>);

describe("GroupSettingsDrawer（#1280）", () => {
  it("成员逐行列出；「移出」发的是变动之后的完整名单", async () => {
    seed();
    draw();
    expect(screen.getByText("运营")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "移出" })[1]!);
    expect(updateGroupChat).toHaveBeenCalledWith("g-1", { agentIds: ["admin"] });
  });

  it("最后一只也移得走：空名单发得出去，群还在", async () => {
    seed({ cloudSessionList: { home: [chat(["a_1"])] } });
    draw();
    await userEvent.click(screen.getByRole("button", { name: "移出" }));
    expect(updateGroupChat).toHaveBeenCalledWith("g-1", { agentIds: [] });
  });

  it("空群：说清「说了也没人接」，不画成坏掉了", () => {
    seed({ cloudSessionList: { home: [chat([])] } });
    draw();
    expect(screen.getByText("这个群里没有智能体了")).toBeInTheDocument();
  });

  it("改名只发名字那一格", async () => {
    seed();
    draw();
    const input = screen.getByLabelText("群名");
    await userEvent.clear(input);
    await userEvent.type(input, "收尾周");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(updateGroupChat).toHaveBeenCalledWith("g-1", { name: "收尾周" });
  });

  it("名字没改过时「保存」按不动", () => {
    seed();
    draw();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("查不到这个群（刚解散 / 清单还没到）：整扇抽屉不画", () => {
    seed({ cloudSessionList: { home: [] } });
    draw();
    expect(screen.queryByRole("button", { name: "解散群聊" })).toBeNull();
  });

  it("改名失败：那句话画在抽屉里", async () => {
    seed({ updateGroupChat: vi.fn(async () => ({ ok: false as const, message: "只有群聊能改名" })) });
    draw();
    const input = screen.getByLabelText("群名");
    await userEvent.type(input, "x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("只有群聊能改名")).toBeInTheDocument();
  });
});
