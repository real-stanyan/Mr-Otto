import { describe, expect, it } from "vitest";

import { enterChat } from "../../src/renderer/src/store.js";
import type { BootInfo } from "../../src/shared/shellBridge.js";

function boot(overrides: Partial<BootInfo> = {}): BootInfo {
  return {
    sessionId: "session-a",
    model: "claude",
    workspace: "/tmp/proj",
    events: [],
    dbPath: "/tmp/proj/.otter/db.sqlite",
    approvalMode: "ask",
    thinking: "off",
    toolDefs: [],
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

  it("sessionId 落成新会话的那一个", () => {
    expect(enterChat(boot({ sessionId: "session-b" })).sessionId).toBe("session-b");
  });
});
