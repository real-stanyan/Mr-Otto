// outreach 的登记（#1441）：新事件类型在每一张穷举表里都要表态，这几条钉的是「表的是什么态」
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type SessionEvent } from "../../src/session/events.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";

const ev: SessionEvent = {
  seq: 1, sessionId: "s", ts: 1, type: "outreach", outreachId: "o1", phase: "started",
  fromAgentId: "a", peerUid: "u2", peerName: "小红", ignorable: true,
};

describe("outreach 事件", () => {
  it("是已知类型", () => expect(KNOWN_EVENT_TYPES.has("outreach")).toBe(true));
  it("不进模型视野", () => {
    const msgs = deriveMessages([{ seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" }, ev]);
    expect(JSON.stringify(msgs)).not.toContain("小红");
  });
  it("分享时剥掉（带着别人的 uid 与对话）", () => expect(PRIVACY_VERDICTS.outreach).toBe("strip"));
  it("桌面云时间线不画", () => expect(hiddenFromCloudTimeline(ev)).toBe(true));
});
