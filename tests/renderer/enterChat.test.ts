import { describe, expect, it } from "vitest";

import { enterChat } from "../../src/renderer/src/store.js";
import type { BootInfo } from "../../src/shared/shellBridge.js";

function boot(overrides: Partial<BootInfo> = {}): BootInfo {
  return {
    sessionId: "session-a",
    model: "claude",
    workspace: "/tmp/proj",
    events: [],
    dbPath: "/tmp/proj/.mr-otto/db.sqlite",
    approvalMode: "ask",
    thinking: "off",
    toolDefs: [],
    isPackaged: true,
    ...overrides,
  };
}

describe("enterChat(换会话的状态落位)", () => {
  it("清掉 mcpPromptForm——旧会话填到一半的 MCP prompt 参数卡不该跟着新会话露出来(review finding 2)", () => {
    expect(enterChat(boot()).mcpPromptForm).toBeNull();
  });

  it("跟它的七个同伴一起清:settingsSection/protocolOpen/gitGraphOpen/friendChat/terminalPanelOpen/browserPanelOpen/workTree", () => {
    const next = enterChat(boot());
    expect(next.settingsSection).toBeNull();
    expect(next.protocolOpen).toBe(false);
    expect(next.gitGraphOpen).toBe(false);
    expect(next.friendChat).toBeNull();
    expect(next.terminalPanelOpen).toBe(false);
    expect(next.browserPanelOpen).toBe(false);
    expect(next.workTree).toBeNull();
  });

  it("清掉引用暂存(issue #881):引用指的是**那条会话里**的某段话,带进另一条会话就是让这条消息说一件没发生过的事", () => {
    expect(enterChat(boot()).quotes).toEqual([]);
  });

  it("sessionId 落成新会话的那一个", () => {
    expect(enterChat(boot({ sessionId: "session-b" })).sessionId).toBe("session-b");
  });
});

describe("enterChat(残留清单落位, issue #759)", () => {
  it("BootInfo.pendingResidue 落成 bootResidue 一次性 latch；liveResidue 换会话清零", () => {
    const next = enterChat(
      boot({
        pendingResidue: [
          { detector: "ports", id: "port:9999", label: "python3:9999", confidence: "owned", cleanupHint: "kill 进程组 1" },
        ],
      })
    );
    expect(next.bootResidue).toHaveLength(1);
    expect(next.liveResidue).toEqual([]);
  });

  it("没有 pendingResidue 时 bootResidue 是空数组，不是 undefined", () => {
    expect(enterChat(boot()).bootResidue).toEqual([]);
  });

  // #780 M6：主进程的 residueReported 闸让 pendingResidue 只出现在**第一份** BootInfo 上，
  // 所以后面每一次切会话「没带」的含义是「这次没有新消息」，不是「清空了」。
  // 原来写的是 `?? []`，于是用户没处理完就切一次会话，那张清单本次运行内再也回不来——
  // 而它多半装着端口/模拟器那类只在归档那一刻算得出的条目
  const ITEM = { detector: "ports" as const, id: "port:9999", label: "python3:9999", confidence: "owned" as const, cleanupHint: "kill 进程组 1" };

  it("这次 boot 没带 pendingResidue：留着手上那份，不抹掉用户还没处理的条目（#780 M6）", () => {
    const next = enterChat(boot({ sessionId: "session-b" }), {}, [ITEM]);
    expect(next.bootResidue).toEqual([ITEM]);
    // 但弹窗不重开：「有没有新消息」与「手上还剩什么」是两件事
    expect(next.bootResidueOpen).toBe(false);
  });

  it("这次 boot 带了：换成新的那份（不是往上堆），弹窗照开", () => {
    const fresh = { ...ITEM, id: "port:8080" };
    const next = enterChat(boot({ pendingResidue: [fresh] }), {}, [ITEM]);
    expect(next.bootResidue).toEqual([fresh]);
    expect(next.bootResidueOpen).toBe(true);
  });
});

describe("enterChat(每会话的右侧面板记忆,issue #578)", () => {
  it("这个会话上次开着哪块,就还原哪块——切走再切回来面板还在", () => {
    const next = enterChat(boot({ sessionId: "session-b" }), { "session-b": "files" });
    expect(next.filesPanelOpen).toBe(true);
    // 互斥仍然成立:还原一块不等于把别的也点亮
    expect(next.terminalPanelOpen).toBe(false);
    expect(next.bgPanelOpen).toBe(false);
  });

  it("记忆是按会话分的:别的会话开着的面板不该跟到这个会话头上", () => {
    const next = enterChat(boot({ sessionId: "session-b" }), { "session-a": "terminal" });
    expect(next.terminalPanelOpen).toBe(false);
  });

  it("设置模式 / DM 照旧让位,不进记忆——它们不是「在这个会话里干活的姿势」", () => {
    const next = enterChat(boot({ sessionId: "session-b" }), { "session-b": "git" });
    expect(next.gitGraphOpen).toBe(true);
    expect(next.settingsSection).toBeNull();
    expect(next.friendChat).toBeNull();
  });
});
