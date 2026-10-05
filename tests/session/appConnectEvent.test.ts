// app_connect 的登记（#1666）：新事件类型在每一张穷举表里都要表态，这几条钉的是「表的是什么态」
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type SessionEvent } from "../../src/session/events.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { shouldPersist } from "../../src/session/persistencePolicy.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";

const ev: SessionEvent = {
  seq: 1, sessionId: "s", ts: 1, type: "app_connect", connectId: "c1", phase: "offered", fromAgentId: "a",
  catalogId: "supabase", appName: "Supabase", why: "要查一张表", reason: "missing", ignorable: true,
};

describe("app_connect 事件", () => {
  it("是已知类型", () => expect(KNOWN_EVENT_TYPES.has("app_connect")).toBe(true));
  it("必须落盘", () => expect(shouldPersist("app_connect")).toBe(true));
  it("不进模型视野", () => {
    const msgs = deriveMessages([{ seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w" }, ev]);
    expect(JSON.stringify(msgs)).not.toContain("要查一张表");
  });
  it("分享时剥掉", () => expect(PRIVACY_VERDICTS.app_connect).toBe("strip"));
  it("桌面云时间线不画", () => expect(hiddenFromCloudTimeline(ev)).toBe(true));
});
