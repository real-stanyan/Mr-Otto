import { describe, expect, it } from "vitest";
import {
  KNOWN_EVENT_TYPES,
  type ChatRosterChangedEvent,
  type SessionCreatedEvent,
} from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const roster: ChatRosterChangedEvent = {
  sessionId: "s",
  seq: 1,
  ts: 1,
  type: "chat_roster_changed",
  agents: [{ agentId: "admin", name: "管理员" }],
  ignorable: true,
};

describe("chat_roster_changed 的登记（#1280）", () => {
  it("是已知事件类型：旧版本读到它不会当成残缺会话", () => {
    expect(KNOWN_EVENT_TYPES.has("chat_roster_changed")).toBe(true);
  });
  it("分享包里剥掉：它是那条聊天的控制面状态，不是对话内容（同 voice_call_changed）", () => {
    expect(PRIVACY_VERDICTS.chat_roster_changed).toBe("strip");
  });
  it("要握笔才落得了：只有 runtime 写它", () => {
    expect(PEN_VERDICTS.chat_roster_changed).toBe("executor");
  });
  // 「模型不可见」的判据在 deriveMessages 不在 agentView：这条事件没有 agentId，
  // projectForAgent 的早退路径一律放行（同 voice_call_changed），那张穷尽表对它够不着。
  it("模型不可见：名单经 agent_briefed.roster 到模型那里，投影不为它多出任何一条消息", () => {
    const created = {
      sessionId: "s",
      seq: 0,
      ts: 0,
      type: "session_created",
      workspace: "/work",
      cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true },
    } satisfies SessionCreatedEvent;
    const withRoster = deriveMessages([created, roster]);
    expect(withRoster).toEqual(deriveMessages([created]));
    expect(JSON.stringify(withRoster)).not.toContain("管理员");
  });
});
