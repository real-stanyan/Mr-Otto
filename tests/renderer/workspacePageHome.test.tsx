// @vitest-environment jsdom
//
// 主场的设置页只留四格（#1280）。团队那七格一个不少——这是「团队一字不变」的
// 可执行版。
//
// 摘掉的三格各有各的理由：**会话**与**智能体**的清单就是侧栏那一栏本身（再列
// 一遍是同一件事说两遍）、**成员**在只有一个人的地方没有主语；**解散**更是——
// 解散一个人的主场等于注销这台 app 的一半。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { WorkspacePage } from "../../src/renderer/src/components/WorkspacePage.js";
import { ConfirmProvider } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= NoopResizeObserver as never;
});
afterEach(cleanup);

const snap = (over: Partial<WorkspaceSnapshot>): WorkspaceSnapshot =>
  ({
    id: "w", name: "某处", ownerUid: "me", members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }],
    connectors: [], sessions: [], agents: [], sandboxApproval: null, kind: "team", ...over,
  }) as WorkspaceSnapshot;

function renderPage(ws: WorkspaceSnapshot): void {
  useChat.setState({ workspaceGroups: [ws], workspaceGroupsError: null } as never);
  render(
    <ConfirmProvider>
      <SidebarProvider>
        <WorkspacePage ws={ws} selfUid="me" onBack={() => {}} />
      </SidebarProvider>
    </ConfirmProvider>,
  );
}

describe("WorkspacePage × 个人主场（#1280）", () => {
  it("主场：只有 文件 / 连接器 / 用量 / 记忆 四格，没有解散", () => {
    renderPage(snap({ id: "home", name: "我的智能体", kind: "home" }));
    for (const label of ["文件", "连接器", "用量", "记忆"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ["会话", "智能体", "成员"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByText("解散团队")).toBeNull();
    expect(screen.queryByText("退出团队")).toBeNull();
    expect(screen.getByText(/这里只有你一个人/)).toBeInTheDocument();
  });

  it("团队：七格 + 解散，一个字不变", () => {
    renderPage(snap({}));
    for (const label of ["会话", "智能体", "文件", "连接器", "成员", "用量", "记忆"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("解散团队")).toBeInTheDocument();
    expect(screen.queryByText(/这里只有你一个人/)).toBeNull();
  });

  it("kind 读不到（null）：照团队画——读不到不许当成主场把四格藏起来", () => {
    renderPage(snap({ kind: null }));
    expect(screen.getByText("成员")).toBeInTheDocument();
    expect(screen.getByText("解散团队")).toBeInTheDocument();
  });
});
