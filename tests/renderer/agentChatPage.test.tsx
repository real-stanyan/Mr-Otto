// @vitest-environment jsdom
//
// 聊天页按 `chat` 换脸 + 摘掉三样（#1280）。CloudSessionPage 很重，这里只断言
// 「画没画」，不碰发送与流式——那些有自己的用例。
//
// 三样为什么摘（每一条对着一个具体的谎）：
// ① 免审开关：主场恒全免（ADR-0298），画一枚永远开着、翻了也没用的开关是撒谎的勾；
// ② 上下文环：上下文由系统自己管，画一个用户既压不动也不必压的环只会让他以为该做点什么；
// ③ 私聊的 @ 钮：名单里只有它一只，@ 谁都是它。
// 团队会话那一支**三样都在**——这是「团队一字不变」的可执行版。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { CloudSessionPage } from "../../src/renderer/src/components/CloudSessionPage.js";
import type { ChatView } from "../../src/shared/agentRoster.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

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
  // Radix Avatar 在 jsdom 里判不出「图已加载」（#1068）
  Object.defineProperty(Image.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(Image.prototype, "naturalWidth", { configurable: true, get: () => 128 });
});

afterEach(cleanup);

const agent = (agentId: string, name: string, description: string) => ({
  agentId, name, description, instructions: "", models: [], tools: [],
  createdBy: "u1", updatedTs: 0, avatarSlot: null,
});

const WS: WorkspaceSnapshot = {
  id: "home", name: "我的智能体", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
  kind: "home",
  agents: [agent("admin", "管理员", ""), agent("a_000000000001", "运营", "盯店铺数据、写周报")],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
};

const base = { sessionId: "cs1" } as const;
const chatMsg = (seq: number, ts: number, content = "你好"): SessionEvent => ({
  ...base, seq, ts, type: "chat_message", fromUid: "u1", label: "Stan", content, mention: false,
});

function renderPage(o: { chat?: ChatView; events?: SessionEvent[] } = {}): void {
  const events: SessionEvent[] = o.events ?? [
    { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/work" },
    chatMsg(1, 1),
  ];
  useChat.setState({
    cloudSession: {
      workspaceId: "home", sessionId: "cs1", state: "ready", initiatorUid: "u1", ownerUid: "u1", selfUid: "u1",
      modelRoute: null, gapNote: null, chat: null, events,
    },
    workspaceGroups: [WS],
    billing: null,
  } as never);
  render(
    <TooltipPrimitive.Provider>
      <ConfirmProvider>
        <CloudSessionPage ws={WS} selfUid="u1" onSettings={() => {}} {...(o.chat === undefined ? {} : { chat: o.chat })} />
      </ConfirmProvider>
    </TooltipPrimitive.Provider>,
  );
}

/** 上下文环只在**跑过一轮、查得到窗口**时才画得出来（binding.window 非 null）。
    要断言「聊天里不画它」，喂的那份日志必须是团队会话里画得出来的那一份，
    否则两边都不画、那条断言什么都没守住 */
function teamEventsWithUsage(): SessionEvent[] {
  return [
    { ...base, seq: 0, ts: 1, type: "session_created", workspace: "/work" },
    chatMsg(1, 1),
    // 型号取目录里窗口已知的那一款：窗口查不到时整枚环不画（#193），那样
    // 「聊天里没有环」那条断言就什么都没守住
    {
      ...base, seq: 2, ts: 2, type: "assistant_message", content: "好", model: "deepseek-flash",
      agentId: "a_000000000001", usage: { promptTokens: 100, completionTokens: 10 },
    },
  ];
}

const DM: ChatView = { kind: "dm", agentIds: ["a_000000000001"], title: "运营" };
const GROUP: ChatView = { kind: "group", agentIds: ["admin", "a_000000000001"], title: "上线冲刺" };

describe("CloudSessionPage 的 chat 属性（#1280）", () => {
  it("私聊：头部是智能体的名字与职责；没有免审批开关、没有上下文环、没有 @ 钮", () => {
    renderPage({ chat: DM, events: teamEventsWithUsage() });
    expect(screen.getByText("运营")).toBeInTheDocument();
    expect(screen.getByText("盯店铺数据、写周报")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("cloud-context-ring")).toBeNull();
    expect(screen.queryByRole("button", { name: "@ 智能体或成员" })).toBeNull();
    expect(screen.getByPlaceholderText("跟运营说点什么")).toBeInTheDocument();
    // 团队名不再是这一行的主语
    expect(screen.queryByText("我的智能体")).toBeNull();
  });

  it("群聊：头部写群名与成员；@ 钮在；免审批开关与上下文环照样不在", () => {
    renderPage({ chat: GROUP, events: teamEventsWithUsage() });
    expect(screen.getByText("上线冲刺")).toBeInTheDocument();
    expect(screen.getByText("管理员 · 运营")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "@ 智能体或成员" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("cloud-context-ring")).toBeNull();
    expect(screen.getByPlaceholderText("输入 @ 点名；不 @ 的话，谁的活谁接")).toBeInTheDocument();
  });

  it("团队会话（不带 chat）一字不变：免审开关、上下文环、团队名、原来的 placeholder 都在", () => {
    renderPage({ events: teamEventsWithUsage() });
    expect(screen.getByRole("switch")).toBeInTheDocument();
    // 正向那一半：不断言它真画得出来的话，上面两条「聊天里没有环」永远为真
    expect(screen.getByTestId("cloud-context-ring")).toBeInTheDocument();
    expect(screen.getByText("我的智能体")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入 @ 点名智能体或成员；不 @ 的话，谁的活谁接")).toBeInTheDocument();
  });

  it("日期分隔条只在聊天里画", () => {
    const now = Date.now();
    const events: SessionEvent[] = [
      { ...base, seq: 0, ts: now - 26 * 3600_000, type: "session_created", workspace: "/work" },
      chatMsg(1, now - 26 * 3600_000, "昨天说的"),
      chatMsg(2, now, "今天说的"),
    ];
    renderPage({ chat: DM, events });
    expect(screen.getByText("昨天")).toBeInTheDocument();
    expect(screen.getByText("今天")).toBeInTheDocument();
    cleanup();
    renderPage({ events });
    expect(screen.queryByText("昨天")).toBeNull();
  });

  it("同一天的两条只插一条分隔条", () => {
    const now = Date.now();
    const events: SessionEvent[] = [
      { ...base, seq: 0, ts: now, type: "session_created", workspace: "/work" },
      chatMsg(1, now - 1000, "一"),
      chatMsg(2, now, "二"),
    ];
    renderPage({ chat: DM, events });
    expect(screen.getAllByText("今天")).toHaveLength(1);
  });

  it("压缩事件不上聊天的时间线，也不顶出一条空的分隔条", () => {
    const now = Date.now();
    const events: SessionEvent[] = [
      { ...base, seq: 0, ts: now - 48 * 3600_000, type: "session_created", workspace: "/work" },
      // 前天只有一条压缩事件：不画它，也不该为它画一条「前天」
      { ...base, seq: 1, ts: now - 48 * 3600_000, type: "context_compacted", summary: "摘要", model: "m", agentId: "a_000000000001" },
      chatMsg(2, now, "今天说的"),
    ];
    renderPage({ chat: DM, events });
    expect(screen.getAllByText("今天")).toHaveLength(1);
    expect(screen.queryByText("摘要")).toBeNull();
  });

  // 刚建好的群里已经躺着 session_created 与 chat_roster_changed 两条，两条都是藏
  // 起来的——照 `cloudEmptyState`（只看 events.length）判的话这一屏是一片空白。
  // 判据因此挂在**真正会画出来的行数**上
  it("刚建好的群：说清谁在这儿、接下来干什么，不是一片空白也不说「还没有消息」", () => {
    renderPage({
      chat: GROUP,
      events: [
        { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/work" },
        { ...base, seq: 1, ts: 1, type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: "管理员" }] } as SessionEvent,
      ],
    });
    expect(screen.getByText("管理员、运营都在。说第一句话就开始了。")).toBeInTheDocument();
    expect(screen.queryByText("还没有消息。")).toBeNull();
  });

  it("团队会话里那句「还没有消息。」一个字不变", () => {
    renderPage({ events: [] });
    expect(screen.getByText("还没有消息。")).toBeInTheDocument();
  });
});
