// @vitest-environment jsdom
//
// 侧栏里的工作区一节（issue #917 搬进侧栏，#919 长成工程组的样子）。
//
// 四条断言各自对着一个具体的失败：
// ① 组头那颗 ＋ **只开开局卡，不建任何东西**——这是「和本地会话一致」的全部内容
//    （本地那颗 ＋ 也只是把主区换成 composer）。改回「点一下就建一条空会话」的话
//    这条会红，而那正是 #919 要消灭的形态
// ② 归档的云会话不进侧栏——同本地：归档的会话在「已归档会话」那一屏，不在工程组里
// ③ 收起来的组不画会话行，但报条数——不报的话收起来就等于把这个工作区藏了
// ④ 一条工作区都没有 + 没有错误 = 整节不渲染；有错误就要出（空列表 + 有错 =
//    「读不到」，不是「没有」，这两件事该做的动作相反）
// ⑤ 还没发过话的云会话（title 是空串，不是 null）显示「新会话」——真机上它长成
//    一格空白，一行看不出是什么也看不出能不能点（#925）

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspacesSidebarSection } from "../../src/renderer/src/components/WorkspacesSidebarSection.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS: WorkspaceSnapshot = {
  id: "w1",
  name: "奶茶店",
  ownerUid: "u-me",
  members: [
    { uid: "u-me", role: "owner", label: "我" },
    { uid: "u2", role: "member", label: "小红" },
  ],
  connectors: [],
  sessions: [],
  agents: [],
};

function seed(over: Partial<Parameters<typeof useChat.setState>[0]> = {}): {
  startCloudDraft: ReturnType<typeof vi.fn>;
  openCloudSession: ReturnType<typeof vi.fn>;
} {
  const startCloudDraft = vi.fn();
  const openCloudSession = vi.fn(async () => {});
  useChat.setState({
    workspaceGroups: [WS],
    workspaceGroupsError: null,
    cloudDraftWorkspaceId: null,
    cloudSession: null,
    cloudSessionList: {
      w1: [
        { id: "cs-live", title: "周报自动化", publisherUid: "u2", archived: false, updatedTs: 2 },
        { id: "cs-old", title: "上个月的爬虫", publisherUid: "u2", archived: true, updatedTs: 1 },
      ],
    },
    refreshCloudSessions: async () => {},
    startCloudDraft,
    openCloudSession,
    ...over,
  });
  return { startCloudDraft, openCloudSession };
}

function draw(collapsed: string[] = []): void {
  render(
    <SidebarProvider>
      <WorkspacesSidebarSection collapsed={new Set(collapsed)} onToggle={() => {}} onManage={() => {}} />
    </SidebarProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspacesSidebarSection（#917 / #919）", () => {
  it("组头那颗 ＋ 只开开局卡，不建会话", async () => {
    const { startCloudDraft, openCloudSession } = seed();
    draw();
    await userEvent.click(screen.getByTitle("在 奶茶店 里开新会话"));
    expect(startCloudDraft).toHaveBeenCalledWith("w1");
    // 关键的一半：这一步**不能**碰云会话的创建。点一下就建一条空会话正是 #919
    // 要消灭的形态（本地那颗 ＋ 也只是把主区换成 composer）
    expect(openCloudSession).not.toHaveBeenCalled();
  });

  it("归档的云会话不进侧栏（它们在工作区设置页底部，同本地的「已归档会话」）", () => {
    seed();
    draw();
    expect(screen.getByText("周报自动化")).toBeInTheDocument();
    expect(screen.queryByText("上个月的爬虫")).not.toBeInTheDocument();
  });

  it("收起来的组不画会话行，但把条数报出来", () => {
    seed();
    draw(["w1"]);
    expect(screen.queryByText("周报自动化")).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // 归档那条不算进去
  });

  it("还没发过话的云会话显示「新会话」，不是一格空白（#925）", () => {
    seed({
      cloudSessionList: {
        // 云会话那张表的 title 是 string 不是 string | null：没标题时落库的是
        // 空串，只挡 null 的兜底挡不住它
        w1: [{ id: "cs-new", title: "", publisherUid: "u-me", archived: false, updatedTs: 3 }],
      },
    });
    draw();
    expect(screen.getByText("新会话")).toBeInTheDocument();
  });

  it("一条工作区都没有：没错误 = 整节不出；有错误 = 要出（「读不到」≠「没有」）", () => {
    seed({ workspaceGroups: [] });
    const { container } = render(
      <SidebarProvider>
        <WorkspacesSidebarSection collapsed={new Set()} onToggle={() => {}} onManage={() => {}} />
      </SidebarProvider>
    );
    expect(container.textContent).toBe("");
    cleanup();

    seed({ workspaceGroups: [], workspaceGroupsError: "读不到工作区：网络超时" });
    draw();
    expect(screen.getByText("读不到工作区：网络超时")).toBeInTheDocument();
  });
});
