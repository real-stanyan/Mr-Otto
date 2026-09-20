// @vitest-environment jsdom
//
// 新群聊弹窗（#1280 A4）。每条断言对着一个具体的失败：
// ① 不到两只建不了——一只的「群」就是私聊，而私聊那条路另有唯一索引管着
// ② 私聊头部那颗「拉人」带着那一只进来，它已经勾上（那是这颗钮的全部意思）
// ③ 群名留空用成员名顶上——侧栏那一行不能是一格空白（同 sessionTitle 的兜底）
// ④ 建失败那句话留在弹窗里、弹窗不关：关掉就等于把「没建成」说成「建成了」
// ⑤ 六只封顶，第七只勾不动
// ⑥ 「要和别人一起用？建一个团队」：这一栏建不出团队，得给一条出去的路

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { NewGroupDialog } from "../../src/renderer/src/components/NewGroupDialog.js";
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
  agents: [
    agent("admin", "管理员", "帮你建智能体，接没人对口的活"),
    agent("a_000000000001", "运营", "盯店铺数据、写周报"),
    agent("a_000000000002", "开发", "写代码、改 bug"),
  ],
} as unknown as WorkspaceSnapshot;

function seed(over: Record<string, unknown> = {}): void {
  useChat.setState({
    workspaceGroups: [HOME], cloudSessionList: { home: [] },
    newGroupOpen: true, newGroupPreset: [],
    createGroupChat: vi.fn(async () => ({ ok: true as const })),
    closeNewGroup: vi.fn(),
    ...over,
  } as never);
}

const box = (name: string | RegExp) => screen.getByRole("checkbox", { name });

describe("NewGroupDialog（#1280）", () => {
  it("不到两只时建不了；选够了才亮", async () => {
    seed();
    render(<NewGroupDialog onNewTeam={() => {}} />);
    expect(screen.getByRole("button", { name: "建群" })).toBeDisabled();
    expect(screen.getByText("至少选两只")).toBeInTheDocument();
    await userEvent.click(box(/管理员/));
    await userEvent.click(box(/运营/));
    expect(screen.getByText("已选 2 只")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "建群" })).toBeEnabled();
  });

  it("私聊「拉人」带着那一只进来：它已经勾上了", () => {
    seed({ newGroupPreset: ["a_000000000001"] });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    expect(box(/运营/)).toBeChecked();
    expect(box(/管理员/)).not.toBeChecked();
  });

  it("群名留空用成员名顶上（按名册顺序，不按勾选顺序）", async () => {
    const createGroupChat = vi.fn(async () => ({ ok: true as const }));
    seed({ createGroupChat });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    await userEvent.click(box(/运营/));
    await userEvent.click(box(/管理员/));
    await userEvent.click(screen.getByRole("button", { name: "建群" }));
    expect(createGroupChat).toHaveBeenCalledWith("管理员、运营", ["admin", "a_000000000001"]);
  });

  it("起了名字就用那个名字", async () => {
    const createGroupChat = vi.fn(async () => ({ ok: true as const }));
    seed({ createGroupChat });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    await userEvent.type(screen.getByLabelText("群名"), "  上线冲刺  ");
    await userEvent.click(box(/管理员/));
    await userEvent.click(box(/运营/));
    await userEvent.click(screen.getByRole("button", { name: "建群" }));
    expect(createGroupChat).toHaveBeenCalledWith("上线冲刺", ["admin", "a_000000000001"]);
  });

  it("建失败：那句话留在弹窗里，弹窗不关", async () => {
    const closeNewGroup = vi.fn();
    seed({
      createGroupChat: vi.fn(async () => ({ ok: false as const, message: "群聊至少要两只智能体" })),
      closeNewGroup,
    });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    await userEvent.click(box(/管理员/));
    await userEvent.click(box(/运营/));
    await userEvent.click(screen.getByRole("button", { name: "建群" }));
    expect(await screen.findByText("群聊至少要两只智能体")).toBeInTheDocument();
    expect(closeNewGroup).not.toHaveBeenCalled();
  });

  // 上限是 runtime 与库两边都认的那个数：勾得上第七只的话，那颗「建群」按下去
  // 必然拿到一句服务端拒绝——与其那样，不如当场就按不动，并说清还能选几只
  it("六只封顶：满了之后没勾的那几只按不动", async () => {
    const many = {
      ...HOME,
      agents: [
        ...HOME.agents,
        agent("a_000000000003", "投放", ""), agent("a_000000000004", "客服", ""),
        agent("a_000000000005", "财务", ""), agent("a_000000000006", "法务", ""),
      ],
    } as unknown as WorkspaceSnapshot;
    seed({
      workspaceGroups: [many],
      newGroupPreset: ["admin", "a_000000000001", "a_000000000002", "a_000000000003", "a_000000000004", "a_000000000005"],
    });
    render(<NewGroupDialog onNewTeam={() => {}} />);
    expect(screen.getByText("最多六只")).toBeInTheDocument();
    expect(box(/法务/)).toBeDisabled();
    // 已经勾上的那几只照样点得动——否则满员之后就再也改不了名单了
    expect(box(/财务/)).toBeEnabled();
  });

  it("「建一个团队」：关掉这扇窗，把人交给团队那条路", async () => {
    const onNewTeam = vi.fn();
    const closeNewGroup = vi.fn();
    seed({ closeNewGroup });
    render(<NewGroupDialog onNewTeam={onNewTeam} />);
    await userEvent.click(screen.getByRole("button", { name: /建一个团队/ }));
    expect(onNewTeam).toHaveBeenCalled();
    expect(closeNewGroup).toHaveBeenCalled();
  });

  it("没有主场时整扇窗不画：没有地方可建", () => {
    seed({ workspaceGroups: [] });
    const { container } = render(<NewGroupDialog onNewTeam={() => {}} />);
    expect(container.querySelector("[data-slot='dialog-content']")).toBeNull();
  });
});
