// call_ring 的登记（#1411）：新事件类型在每一张穷举表里都要表态，这几条钉的是「表的是什么态」。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type CallRingEvent, type SessionCreatedEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const ring: CallRingEvent = {
  sessionId: "s", seq: 1, ts: 1, type: "call_ring", ringId: "r1", phase: "ringing",
  fromAgentId: "ops", toUid: "u1", reason: "部署完了", expiresTs: 45_001, ignorable: true,
};

describe("call_ring 的登记（#1411）", () => {
  it("是已知事件类型：旧版本读到它不会当成残缺会话", () => {
    expect(KNOWN_EVENT_TYPES.has("call_ring")).toBe(true);
  });
  it("分享包里剥掉：带着接电话那个人的 uid 与一句私人的话", () => {
    expect(PRIVACY_VERDICTS.call_ring).toBe("strip");
  });
  it("要握笔才落得了：只有跑 turn 的那一方写它", () => {
    expect(PEN_VERDICTS.call_ring).toBe("executor");
  });
  it("桌面云会话时间线不画（手机上是一张卡；桌面等 #1403 的微信式布局）", () => {
    expect(hiddenFromCloudTimeline(ring)).toBe(true);
  });
  it("模型不可见：投影不为它多出任何一条消息、不漏那句话", () => {
    const created = {
      sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work",
      cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true },
    } satisfies SessionCreatedEvent;
    const withRing = deriveMessages([created, ring]);
    expect(withRing).toEqual(deriveMessages([created]));
    expect(JSON.stringify(withRing)).not.toContain("部署完了");
  });
});
