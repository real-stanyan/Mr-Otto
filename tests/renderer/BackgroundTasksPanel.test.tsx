// @vitest-environment jsdom
//
// 后台任务面板画的是终端（issue #772 / ADR-0194）。
//
// 纯函数那一层（projectBackgroundRuns）只证明「哪几行该出现」，证明不了
// 「那几行里有没有命令的输出」——而后台任务改画成终端的全部意义就在后者：
// 一个跑三十分钟的构建，用户唯一想问的是它卡住了没有，而那个答案只在输出里。
//
// 四条各盯一处：在跑的画输出不画退出码 / 失败的画红 exit N / 空态 /
// **跨会话不串台**。最后一条是这块设计里唯一真会咬人的地方：taskId 是
// `bg-N`，计数器每个会话各数各的，尾巴要是平铺一层存，A 会话的 bg-1
// 会把 B 会话 bg-1 的输出画出来——而两者都叫 bg-1，看不出错。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { BackgroundTasksPanel } from "../../src/renderer/src/components/BackgroundTasksPanel.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";

const S = "sess-a";
const OTHER = "sess-b";

let seq = 0;
const started = (taskId: string, cmd: string, ts = 1_000): SessionEvent => ({
  seq: seq++,
  sessionId: S,
  ts,
  type: "background_task_started",
  ignorable: true,
  taskId,
  cmd,
});
const completed = (taskId: string, exitCode: number, cmd: string, ts = 9_000): SessionEvent => ({
  seq: seq++,
  sessionId: S,
  ts,
  type: "background_task_completed",
  ignorable: true,
  taskId,
  cmd,
  exitCode,
});

function seed(opts: {
  events: SessionEvent[];
  live?: string[];
  outputs?: Record<string, Record<string, string>>;
}) {
  useChat.setState({
    sessionId: S,
    events: opts.events,
    liveBgIds: opts.live ?? [],
    bgOutputBySession: opts.outputs ?? {},
  });
}

/** 面板头上那颗 SidebarNub 要 SidebarProvider —— app 里它挂在同一棵树下 */
const show = () =>
  render(
    <SidebarProvider>
      <BackgroundTasksPanel />
    </SidebarProvider>
  );

beforeEach(() => {
  seq = 0;
});
afterEach(() => cleanup());

describe("BackgroundTasksPanel", () => {
  it("在跑的任务：命令在头上，直播的输出逐行画出来，没有退出码", () => {
    seed({
      events: [started("bg-1", "npm run build")],
      live: ["bg-1"],
      outputs: { [S]: { "bg-1": "webpack 4.2s\nbuilding…\n" } },
    });
    show();

    expect(screen.getByText("npm run build")).toBeInTheDocument();
    expect(screen.getByText("webpack 4.2s")).toBeInTheDocument();
    expect(screen.getByText("building…")).toBeInTheDocument();
    // 末尾那个换行不该多垫一个空行出来
    expect(screen.queryByText(/^exit /)).not.toBeInTheDocument();
  });

  it("跑完且失败：exit 1 画出来，输出留在原地——「为什么失败」就在里面", () => {
    seed({
      events: [started("bg-2", "pytest -q"), completed("bg-2", 1, "pytest -q")],
      outputs: { [S]: { "bg-2": "E   assert 1 == 2\n1 failed" } },
    });
    show();

    expect(screen.getByText("exit 1")).toBeInTheDocument();
    // 不做空白归一化：终端输出里的缩进是有意义的（whitespace-pre-wrap 那条
    // 本仓改动的可执行版），归一化过的断言看不出它有没有被 HTML 吃掉
    expect(screen.getByText("E   assert 1 == 2", { normalizer: (t) => t })).toBeInTheDocument();
    // 结果还没进对话这件事得说出口，不然这一行为什么还在这儿没人知道
    expect(screen.getByText(/这轮说完就贴进来/)).toBeInTheDocument();
  });

  it("一个任务都没有：说「没有」，不画空终端", () => {
    seed({ events: [] });
    show();
    expect(screen.getByText("现在没有在后台跑的命令")).toBeInTheDocument();
    expect(screen.queryByTestId("bg-task-list")).not.toBeInTheDocument();
  });

  it("别的会话的 bg-1 不会画进这个会话的 bg-1 —— 尾巴按会话分格", () => {
    seed({
      events: [started("bg-1", "npm run build")],
      live: ["bg-1"],
      outputs: { [OTHER]: { "bg-1": "别的会话的输出" } },
    });
    show();

    expect(screen.getByText("npm run build")).toBeInTheDocument();
    expect(screen.queryByText("别的会话的输出")).not.toBeInTheDocument();
  });
});
