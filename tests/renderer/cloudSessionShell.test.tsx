// @vitest-environment jsdom
//
// 主区按 `cloudSession.chat` 那一格挑壳（#1301 / #1302）。`agentChatPage.test.tsx`
// 钉的是「给了 chat 之后 CloudSessionPage 画成什么样」——那一层拿到的是算好的结果；
// 这个文件钉的是**算**那一步：三态怎么分叉、名单从哪儿来。
//
// 两条 bug 都长在这一步上，而且方向相反：
// ① welcome 之前 `null` 被读成「团队会话」，于是主场里的聊天头几秒画团队壳——
//    露出一颗点了不生效的「免审批」开关（ADR-0298）+ 内部名「我的智能体」；
// ② welcome 之后那一格不再更新，头部拿着进房那一刻的名单快照，于是改完名单是
//    「新标题 + 旧名单」，「添加智能体」按不动还说「名册里的智能体都在群里了」。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { CloudSessionMain } from "../../src/renderer/src/components/CloudSessionMain.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat, type CloudSessionState } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { CloudSessionListRow } from "../../src/renderer/src/lib/workspaceView.js";

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
  Element.prototype.scrollTo ??= vi.fn() as never;
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
  // 这一屏挂载时会 refreshWorkspaceGroups（别人新建的 agent @ 不到的那条修复）。
  // 没被点名的方法统一变成空操作，同 cloudSessionListStore.test.ts 的办法
  (window as unknown as { otter: unknown }).otter = new Proxy(
    { workspaceList: async () => ({ ok: true, value: [] }) } as Record<string, unknown>,
    {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        return vi.fn(async () => undefined);
      },
    },
  );
});

afterEach(cleanup);

const agent = (agentId: string, name: string, description: string) => ({
  agentId, name, description, instructions: "", models: [], tools: [],
  createdBy: "u1", updatedTs: 0, avatarSlot: null,
});

const HOME: WorkspaceSnapshot = {
  id: "home", name: "我的智能体", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  kind: "home",
  agents: [agent("admin", "管理员", ""), agent("a_000000000001", "客服", "回评价")],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
} as unknown as WorkspaceSnapshot;

const base = { sessionId: "cs1" } as const;
const created: SessionEvent = { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/work" };
const roster = (seq: number, ids: string[]): SessionEvent =>
  ({
    ...base, seq, ts: seq, type: "chat_roster_changed", ignorable: true,
    agents: ids.map((id) => ({ agentId: id, name: id })),
  }) as SessionEvent;

const row = (over: Partial<CloudSessionListRow> = {}): CloudSessionListRow => ({
  id: "cs1", title: "上线冲刺", publisherUid: "u1", archived: false, updatedTs: 1,
  participantUids: [], chatKind: "group", agentIds: ["admin", "a_000000000001"],
  ...over,
});

function renderMain(o: { chat: CloudSessionState["chat"]; events?: SessionEvent[]; rows?: CloudSessionListRow[] }): void {
  useChat.setState({
    cloudSession: {
      workspaceId: "home", sessionId: "cs1", state: "ready", initiatorUid: "u1", ownerUid: "u1", selfUid: "u1",
      modelRoute: null, gapNote: null, hasOlder: false, older: "idle", chat: o.chat,
      events: o.events ?? [created],
    },
    workspaceGroups: [HOME],
    cloudSessionList: { home: o.rows ?? [row()] },
    cloudPendingFirstMessage: null,
    billing: null,
    // 这一屏的 selfUid 取的是 `account.id`（不是 cs.selfUid）。对不上 ownerUid
    // 的话免审那颗开关会退成只读那一档，于是「团队壳照旧画得出开关」那条断言
    // 会因为一个与它无关的理由而失守
    account: { signedIn: true, id: "u1", email: "", name: "Stan", avatarUrl: "" },
  } as never);
  render(
    <TooltipPrimitive.Provider>
      <ConfirmProvider>
        <CloudSessionMain onManage={() => {}} />
      </ConfirmProvider>
    </TooltipPrimitive.Provider>,
  );
}

describe("welcome 之前那一格（#1301）", () => {
  it("undefined = 还不知道：两种壳都不画", () => {
    renderMain({ chat: undefined });
    expect(screen.getByText("正在进入这条会话…")).toBeInTheDocument();
    // 这两样正是这条 bug 的伤口：一颗在主场里点了不生效的开关 + 内部名
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("我的智能体")).toBeNull();
  });

  it("null = 确实是团队会话：团队壳照旧立刻画得出来（不是一律不画）", () => {
    renderMain({ chat: null });
    expect(screen.queryByText("正在进入这条会话…")).toBeNull();
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getByText("我的智能体")).toBeInTheDocument();
  });

  it("有值 = 一条聊天：聊天壳，免审开关与内部名都不在", () => {
    renderMain({ chat: { kind: "group", agentIds: ["admin", "a_000000000001"] } });
    expect(screen.getByText("上线冲刺")).toBeInTheDocument();
    expect(screen.getByText("管理员 · 客服")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("我的智能体")).toBeNull();
  });
});

describe("名单从日志推导（#1302）", () => {
  it("改完名单：头部跟着变，**不是**新标题配旧名单", () => {
    renderMain({
      // welcome 那一刻的快照：两只都在
      chat: { kind: "group", agentIds: ["admin", "a_000000000001"] },
      // 之后广播回来的事实：客服被移出去了
      events: [created, roster(1, ["admin", "a_000000000001"]), roster(2, ["admin"])],
      rows: [row({ title: "上线冲刺" })],
    });
    expect(screen.getByText("上线冲刺")).toBeInTheDocument();
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.queryByText("管理员 · 客服")).toBeNull();
  });

  it("「添加智能体」跟着松开，不再说「名册里的智能体都在群里了」那句假话", () => {
    renderMain({
      chat: { kind: "group", agentIds: ["admin", "a_000000000001"] },
      events: [created, roster(1, ["admin", "a_000000000001"]), roster(2, ["admin"])],
    });
    const add = screen.getByRole("button", { name: "添加智能体" });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAttribute("title", "名册里的智能体都在群里了");
  });

  it("名单一条事件都没加载到（尾巴分页）：退回 welcome 那份快照，不把群画空", () => {
    renderMain({
      chat: { kind: "group", agentIds: ["admin", "a_000000000001"] },
      events: [created],
    });
    expect(screen.getByText("管理员 · 客服")).toBeInTheDocument();
  });
});
