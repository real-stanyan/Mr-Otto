// routine_note 与 greeting:"routine" 的登记（#1283）：新事件类型在每一张穷举表里都要表态。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type RoutineNoteEvent, type UserMessageEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const note: RoutineNoteEvent = {
  sessionId: "s", seq: 2, ts: 1, type: "routine_note", routineId: "r1", title: "早报", reason: "missed", plannedAt: 0, tz: "Asia/Shanghai", ignorable: true,
};
const opening: UserMessageEvent = {
  sessionId: "s", seq: 1, ts: 1, type: "user_message", content: "【定时任务到点】…", fromUid: "owner", mentions: ["ops"],
  greeting: "routine", routine: { id: "r1", title: "早报" }, tz: "Asia/Shanghai",
};

describe("routine 事件的登记（#1283）", () => {
  it("routine_note 是已知事件类型、分享包里剥掉、要握笔才落得了、桌面不画", () => {
    expect(KNOWN_EVENT_TYPES.has("routine_note")).toBe(true);
    expect(PRIVACY_VERDICTS.routine_note).toBe("strip");
    expect(PEN_VERDICTS.routine_note).toBe("executor");
    expect(hiddenFromCloudTimeline(note)).toBe(true);
  });
  it("routine 开场白：桌面照 greeting 一族藏；模型照普通 user 消息读（正文原样进上下文）", () => {
    expect(hiddenFromCloudTimeline(opening)).toBe(true);
    const created = { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } } as const;
    const msgs = deriveMessages([created, opening, note]);
    expect(msgs.filter((m) => m.role === "user").map((m) => String(m.content).replace(/\n（此刻：[^）]*（[^）]*））$/, ""))).toEqual(["【定时任务到点】…"]);
    expect(JSON.stringify(msgs)).not.toContain("早报");
    expect(JSON.stringify(msgs)).not.toContain("r1");
  });
});
