// @vitest-environment jsdom
//
// 侧栏里的团队一节（issue #917 搬进侧栏，#919 长成工程组的样子）。
//
// 四条断言各自对着一个具体的失败：
// ① 组头那颗 ＋ **只开开局卡，不建任何东西**——这是「和本地会话一致」的全部内容
//    （本地那颗 ＋ 也只是把主区换成 composer）。改回「点一下就建一条空会话」的话
//    这条会红，而那正是 #919 要消灭的形态
// ② 归档的云会话不进侧栏——同本地：归档的会话在「已归档会话」那一屏，不在工程组里
// ③ 收起来的组不画会话行，但报条数——不报的话收起来就等于把这个团队藏了
// ④ 一条团队都没有 + 没有错误 = 画空态（#1087 之前是整节不渲染：那时它挂在项目栏
//    顶上，底下就有一段「还没有项目」；独占一栏之后不画就是一片空白）；有错误时出的
//    是错误那句（空列表 + 有错 = 「读不到」，不是「没有」，这两件事该做的动作相反）
// ⑤ 还没发过话的云会话（title 是空串，不是 null）显示「新会话」——真机上它长成
//    一格空白，一行看不出是什么也看不出能不能点（#925）
// ⑥ 未读点名角标（#1064）：组头 + 会话行各一枚，已读的不算，一条未读都没有时
//    一枚都不画（画个 0 就是 #722 那个撒谎的勾）。组头那枚**收起来照画**——
//    条数（rows.length）展开就数得出来所以只在收起时报，未读数展开也数不出来

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspacesSidebarSection } from "../../src/renderer/src/components/WorkspacesSidebarSection.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { WorkspaceMentionRow } from "../../src/shared/workspaceMentions.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";

// 这一屏里有组件调 `useConfirm()`（#1127），缺 provider 会在**渲染那一刻**抛——
// 这是故意的（不回落到 window.confirm），所以测试自己把 provider 包上。
// 换掉 `render` 这个名字而不是逐处改调用：以后这个文件里新写的用例自动带上
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: ConfirmProvider });


const MENTION = (over: Partial<WorkspaceMentionRow> = {}): WorkspaceMentionRow => ({
  workspaceId: "w1", sessionId: "cs-live", seq: 1, uid: "u-me", fromUid: "u2",
  fromLabel: "小红", excerpt: "看一下", createdTs: 1, read: false, ...over,
});

const WS: WorkspaceSnapshot = {
  id: "w1",
  name: "奶茶店",
  ownerUid: "u-me",
  members: [
    { uid: "u-me", role: "owner", label: "我", avatarUrl: "" },
    { uid: "u2", role: "member", label: "小红", avatarUrl: "" },
  ],
  connectors: [],
  sessions: [],
  agents: [],
  sandboxApproval: "ask",
};

// 参与者头像叠罗汉（#1213）多加几个成员，好凑出「超过三个封顶」那条用例——
// 基础的 WS 只有两个人，不够。不改 WS 本身：其余用例不该因为这一节多长出的
// 成员而受影响
const WS_WITH_MORE_MEMBERS: WorkspaceSnapshot = {
  ...WS,
  members: [
    ...WS.members,
    { uid: "u1", role: "member", label: "张三", avatarUrl: "" },
    { uid: "u3", role: "member", label: "李四", avatarUrl: "" },
    { uid: "u4", role: "member", label: "王五", avatarUrl: "" },
    { uid: "u5", role: "member", label: "赵六", avatarUrl: "" },
  ],
};

// 只改 cs-live 这一行的 participantUids，其余字段照抄 seed() 默认那份形状
function seedParticipants(participantUids: string[]): void {
  seed({
    workspaceGroups: [WS_WITH_MORE_MEMBERS],
    cloudSessionList: {
      w1: [{ id: "cs-live", title: "周报自动化", publisherUid: "u2", archived: false, updatedTs: 2, participantUids }],
    },
  });
}

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
        { id: "cs-live", title: "周报自动化", publisherUid: "u2", archived: false, updatedTs: 2, participantUids: [] },
        { id: "cs-old", title: "上个月的爬虫", publisherUid: "u2", archived: true, updatedTs: 1, participantUids: [] },
      ],
    },
    refreshCloudSessions: async () => {},
    // 每条用例都显式清一次（#1064）：漏了的话上一条用例留下的角标会把
    // 「收起来报条数」那条的 getByText("1") 变成两个命中
    workspaceMentions: [],
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

  it("归档的云会话不进侧栏（它们在团队设置页底部，同本地的「已归档会话」）", () => {
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
        w1: [{ id: "cs-new", title: "", publisherUid: "u-me", archived: false, updatedTs: 3, participantUids: [] }],
      },
    });
    draw();
    expect(screen.getByText("新会话")).toBeInTheDocument();
  });

  // ── 未读点名角标（#1064）───────────────────────────────────────────────
  it("组头与会话行各画一枚未读角标，已读那条不算", () => {
    seed({
      workspaceMentions: [
        MENTION({ seq: 1 }),
        MENTION({ seq: 2 }),
        MENTION({ seq: 3, read: true }),
      ],
    });
    draw();
    expect(screen.getByTitle("这个团队里有 2 条 @ 你的消息没看")).toHaveTextContent("2");
    expect(screen.getByTitle("这条会话里有 2 条 @ 你的消息没看")).toHaveTextContent("2");
  });

  // 收起来的时候会话行根本不在屏幕上，只有组头那一格能说话 —— 而条数
  // （rows.length）与未读数是两个东西，前者展开就数得出来所以只在收起时报
  it("组收起来时角标照画（条数只在收起时报，未读数展开也数不出来）", () => {
    seed({ workspaceMentions: [MENTION()] });
    draw(["w1"]);
    expect(screen.queryByText("周报自动化")).not.toBeInTheDocument();
    expect(screen.getByTitle("这个团队里有 1 条 @ 你的消息没看")).toBeInTheDocument();
  });

  it("一条未读都没有 = 一枚角标都不画（不是画个 0）", () => {
    seed({ workspaceMentions: [MENTION({ read: true })] });
    draw();
    expect(screen.queryByTitle(/@ 你的消息没看/)).not.toBeInTheDocument();
  });

  it("一条团队都没有：没错误 = 空态那句话；有错误 = 错误那句（「读不到」≠「没有」）", () => {
    seed({ workspaceGroups: [] });
    draw();
    // 独占一栏之后这一栏里没有别的东西会说话（#1087）：不画空态 = 切过来一片空白，
    // 人分不出「还没建过」和「坏了」
    expect(screen.getByText(/还没有团队/)).toBeInTheDocument();
    cleanup();

    seed({ workspaceGroups: [], workspaceGroupsError: "读不到团队：网络超时" });
    draw();
    expect(screen.getByText("读不到团队：网络超时")).toBeInTheDocument();
    // 「读不到」不许说成「里面是空的」：出了错就不该再劝人去建一个
    expect(screen.queryByText(/还没有团队/)).not.toBeInTheDocument();
  });

  // ── 参与者头像叠罗汉（#1213）───────────────────────────────────────────
  // 侧栏那一行画出「最近 5 小时说过话的人」。三条各对着一个具体的失败：封顶
  // 三枚、第四格画 +N 的算术；空 participantUids 不画任何东西（不是空容器）；
  // 退了群的 uid 照样画——`labelOf` 回 uid 前 8 位，「他当时在场」是已经发生
  // 的事实，不因为他后来退群而没发生
  it("三个人以内逐个画，每枚头像的 title 是那个人的名字", () => {
    seedParticipants(["u1", "u2"]);
    draw();
    const avatars = screen.getAllByTestId("participant-avatar");
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).toHaveAttribute("title", "张三");
    expect(avatars[1]).toHaveAttribute("title", "小红");
  });

  it("超过三个封顶，第四格画 +N（不是又画一枚头像）", () => {
    seedParticipants(["u1", "u2", "u3", "u4", "u5"]);
    draw();
    expect(screen.getAllByTestId("participant-avatar")).toHaveLength(3);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("一个人都没有时整个头像堆不画，不是空容器", () => {
    seedParticipants([]);
    draw();
    expect(screen.queryAllByTestId("participant-avatar")).toHaveLength(0);
    // 连带壳（外层那个带 title 的 <span>）也不该出现——回的是 null 不是空容器
    expect(screen.queryByTitle(/说过话的/)).not.toBeInTheDocument();
  });

  it("退了群的人照样画——labelOf 回 uid 前 8 位，「他当时在场」不因退群而没发生", () => {
    seedParticipants(["u-gone"]);
    draw();
    expect(screen.getByTestId("participant-avatar")).toHaveAttribute("title", "u-gone");
  });

  // ── 参与者投影没有推送通道，回到窗前再拉一次（#1213）─────────────────────
  it("窗口重新聚焦时再拉一次云会话清单", () => {
    const refreshCloudSessions = vi.fn(async () => {});
    seed({ refreshCloudSessions });
    draw();
    expect(refreshCloudSessions).toHaveBeenCalledTimes(1); // 挂载时那一次
    refreshCloudSessions.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(refreshCloudSessions).toHaveBeenCalledWith("w1");
  });

  it("组件卸载后不再监听 focus（监听器已清理，不会内存泄漏）", () => {
    const refreshCloudSessions = vi.fn(async () => {});
    seed({ refreshCloudSessions });
    draw();
    cleanup();
    refreshCloudSessions.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(refreshCloudSessions).not.toHaveBeenCalled();
  });
});
