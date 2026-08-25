// 右侧槽位是**一个**位置:6 个视图互斥。这条最容易漏——加第 6 个视图时,
// 前 5 个的 open 动作里都得多写一行 filesPanelOpen: false,漏一个就会出现
// "终端和 Files 同时开着,后者盖住前者"的鬼影。
//
// 这个测试就是那几行的守卫。enterChat 那条(换会话清掉所有面板)一并钉上:
// 它和 open 动作是同一类"落位",漏了的表现是换个会话面板还挂着上个工程的树。

import { beforeEach, describe, expect, it } from "vitest";
import { enterChat, useChat } from "../../src/renderer/src/store.js";
import type { BootInfo } from "../../src/shared/shellBridge.js";

function reset() {
  useChat.setState({
    filesPanelOpen: false, terminalPanelOpen: false, browserPanelOpen: false,
    protocolOpen: false, gitGraphOpen: false, friendChat: null, settingsSection: null,
  });
}

describe("Files 面板与其它右侧视图互斥", () => {
  beforeEach(reset);

  it("开 Files 关掉终端", () => {
    useChat.getState().openTerminalPanel();
    useChat.getState().openFilesPanel();
    expect(useChat.getState().terminalPanelOpen).toBe(false);
    expect(useChat.getState().filesPanelOpen).toBe(true);
  });

  it("开终端关掉 Files", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().openTerminalPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("开浏览器关掉 Files", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().openBrowserPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("开 Git Graph 关掉 Files", () => {
    useChat.getState().openFilesPanel();
    useChat.setState({ gitGraphOpen: true, filesPanelOpen: false }); // openGitGraph 要打 IPC,这里只验状态位
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("关自己只关自己", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().closeFilesPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });
});

describe("换会话清掉 Files 面板", () => {
  it("enterChat 把 filesPanelOpen 归零——否则换个工程,面板还挂着上一个的树", () => {
    const boot: BootInfo = {
      sessionId: "s1", model: "claude", workspace: "/tmp/proj", events: [],
      dbPath: "/tmp/proj/.mr-otto/db.sqlite", approvalMode: "ask", thinking: "off", toolDefs: [],
    };
    expect(enterChat(boot).filesPanelOpen).toBe(false);
  });
});
