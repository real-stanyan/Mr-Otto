// @vitest-environment jsdom
//
// 侧栏第三栏「智能体」（#1280，ADR-0297）。断言各自对着一个具体的失败：
// ① 一只一行、顺序跟名册走、点了进它的私聊——这是这一栏存在的全部理由
// ② 还没查到订阅时画骨架、**不劝订阅**（同 workspaceAccess 的 unknown 不许并进
//    no_subscription：那会劝一个已经付过钱的人再付一次）
// ③ 档位不够与没订阅**各说各的出路**（Portal 换档 vs checkout，ADR-0203 决定 18）
// ④ 建主场失败：原因说出来 + 一颗重试钮，**不自己反复重试**
// ⑤ 已经有主场的人降了档照样进得去（闸卡建不卡参与，同 ADR-0217）
// ⑥ 主场那一行不出现在团队那一节里

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { AgentsSidebarSection } from "../../src/renderer/src/components/AgentsSidebarSection.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(<ConfirmProvider><SidebarProvider>{ui}</SidebarProvider></ConfirmProvider>);

// Radix Avatar 在 jsdom 里判不出「图已加载」（naturalWidth 恒为 0，光派 load 事件
// 仍然判成 error）——照 tests/renderer/voiceCallCard.test.tsx 打同一个桩，#1068
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
  agents: [agent("admin", "管理员", "帮你建智能体，接没人对口的活"), agent("a_000000000001", "运营", "盯店铺数据、写周报")],
} as unknown as WorkspaceSnapshot;

const TEAM = {
  id: "t1", name: "奶茶店", ownerUid: "me", members: [], connectors: [], sessions: [],
  sandboxApproval: null, kind: "team", agents: [],
} as unknown as WorkspaceSnapshot;

const plan = (id: string, workspace: boolean) => ({ id, capabilities: { workspace } });
const ACTIVE_PRO = { me: { status: "active", plan: "pro", plans: [plan("pro", true)] } };
const ACTIVE_LITE = { me: { status: "active", plan: "lite", plans: [plan("lite", false), plan("pro", true)] } };

const openAgentChat = vi.fn(async () => {});
const ensureHome = vi.fn(async () => {});
const refreshCloudSessions = vi.fn(async () => {});
const openSettings = vi.fn(async () => {});

function seed(over: Record<string, unknown> = {}): void {
  useChat.setState({
    workspaceGroups: [HOME], cloudSessionList: { home: [] }, cloudSession: null,
    cloudDraftChat: null, cloudDraftWorkspaceId: null, workspaceGroupsError: null, workspaceMentions: [],
    homeEnsure: "idle", homeError: null,
    account: { ...useChat.getState().account, signedIn: true, id: "me" },
    billing: ACTIVE_PRO,
    openAgentChat, ensureHome, refreshCloudSessions, openSettings,
    ...over,
  } as never);
}

beforeEach(() => {
  openAgentChat.mockClear();
  ensureHome.mockClear();
  refreshCloudSessions.mockClear();
  openSettings.mockClear();
  seed();
});

const props = { collapsed: new Set<string>(), onToggle: () => {}, onManage: () => {} };

describe("AgentsSidebarSection（#1280）", () => {
  it("一只一行：名字 + 职责，顺序跟名册走；点了进它的私聊", async () => {
    render(<AgentsSidebarSection {...props} />);
    const rows = screen.getAllByRole("button", { name: /管理员|运营/ });
    expect(rows.map((r) => within(r).getByText(/^管理员$|^运营$/).textContent)).toEqual(["管理员", "运营"]);
    expect(screen.getByText("盯店铺数据、写周报")).toBeInTheDocument();
    await userEvent.click(rows[1]!);
    expect(openAgentChat).toHaveBeenCalledWith("a_000000000001");
  });

  it("还没查到订阅：画骨架，不画空态也不劝订阅，也不去建主场", () => {
    seed({ workspaceGroups: [], billing: null });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.queryByText(/订阅之后/)).toBeNull();
    expect(screen.queryByText(/要 Pro 或 Max/)).toBeNull();
    expect(ensureHome).not.toHaveBeenCalled();
  });

  it("档位带、还没有主场：自己去建一次", () => {
    seed({ workspaceGroups: [] });
    render(<AgentsSidebarSection {...props} />);
    expect(ensureHome).toHaveBeenCalledTimes(1);
  });

  it("档位不够：说清要哪一档，给一条去换档的路；不去建", async () => {
    seed({ workspaceGroups: [], billing: ACTIVE_LITE });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText("智能体要 Pro 或 Max")).toBeInTheDocument();
    expect(ensureHome).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "去换档" }));
    expect(openSettings).toHaveBeenCalledWith("account");
  });

  it("没订阅：说的是另一句话，且不写「填自己的 key」", () => {
    seed({ workspaceGroups: [], billing: { me: null } });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText("订阅之后才有智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "看看订阅" })).toBeInTheDocument();
    expect(screen.queryByText(/自己的 key 也行|填.*key/)).toBeNull();
  });

  it("没登录：一句话，不劝订阅（连问都问不了）", () => {
    seed({ workspaceGroups: [], account: { ...useChat.getState().account, signedIn: false, id: "" } });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText("登录之后才有智能体。")).toBeInTheDocument();
    expect(ensureHome).not.toHaveBeenCalled();
  });

  it("建失败：原因说出来，给重试；不自己反复重试", async () => {
    seed({ workspaceGroups: [], homeEnsure: "failed", homeError: "数据库比这个版本旧" });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText(/数据库比这个版本旧/)).toBeInTheDocument();
    expect(ensureHome).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(ensureHome).toHaveBeenCalledTimes(1);
  });

  it("降了档但已经有主场：照样进得去（闸卡建不卡参与）", () => {
    seed({ billing: ACTIVE_LITE });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText("运营")).toBeInTheDocument();
    expect(screen.queryByText("智能体要 Pro 或 Max")).toBeNull();
  });

  it("主场那一行不出现在团队那一节里", () => {
    seed({ workspaceGroups: [HOME, TEAM], cloudSessionList: { home: [], t1: [] } });
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText("奶茶店")).toBeInTheDocument();
    // 「我的智能体」是主场那一行的 name，它只该出现在设置抽屉里，不在侧栏上
    expect(screen.queryByText("我的智能体")).toBeNull();
  });

  it("群聊：没有时说一句为什么会有它；「新群聊」那颗 ＋ 在 onNewGroup 缺席时不画", () => {
    render(<AgentsSidebarSection {...props} />);
    expect(screen.getByText(/还没有群聊/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新群聊" })).toBeNull();
  });

  it("群聊：有群时一行一个，成员名在第二行", () => {
    seed({
      cloudSessionList: {
        home: [{
          id: "g-1", title: "上线冲刺", publisherUid: "me", archived: false, updatedTs: 9,
          participantUids: [], chatKind: "group", agentIds: ["admin", "a_000000000001"],
        }],
      },
    });
    render(<AgentsSidebarSection {...props} onNewGroup={() => {}} />);
    expect(screen.getByText("上线冲刺")).toBeInTheDocument();
    expect(screen.getByText("管理员 · 运营")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新群聊" })).toBeInTheDocument();
    expect(screen.queryByText(/还没有群聊/)).toBeNull();
  });

  it("行上不画状态、不画未读（归 #1282）：一行里除了名字、时间、职责没有别的字", () => {
    seed({
      cloudSessionList: {
        home: [{
          id: "dm-1", title: "", publisherUid: "me", archived: false, updatedTs: 0,
          participantUids: [], chatKind: "dm", agentIds: ["a_000000000001"],
        }],
      },
      workspaceMentions: [
        { workspaceId: "home", sessionId: "dm-1", seq: 1, uid: "me", fromUid: "x", fromLabel: "x", excerpt: "e", createdTs: 1, read: false },
      ],
    });
    render(<AgentsSidebarSection {...props} />);
    const row = screen.getByRole("button", { name: /运营/ });
    expect(within(row).queryByText("1")).toBeNull();
    expect(within(row).queryByText(/在跑|空闲/)).toBeNull();
  });
});
