import { describe, expect, it } from "vitest";
import {
  PARTICIPANT_WINDOW_MS,
  advanceParticipants,
  countHumanMessages,
  humanSpeakerOf,
  lastActiveWindowParticipants,
  windowIndexOf,
} from "../../src/shared/sessionParticipants.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造一条群里的人话（chat_message：只跟人说话、没起 turn 的那种） */
function chat(seq: number, ts: number, fromUid: string): SessionEvent {
  return { seq, sessionId: "s", ts, type: "chat_message", fromUid, label: "L", content: "hi", mention: false };
}
/** 造一条起了 turn 的人话（user_message：say() 拼过前缀的那种） */
function user(seq: number, ts: number, fromUid: string, extra: Record<string, unknown> = {}): SessionEvent {
  return { seq, sessionId: "s", ts, type: "user_message", content: "[L]: hi", fromUid, ...extra } as SessionEvent;
}

const W = PARTICIPANT_WINDOW_MS;

describe("windowIndexOf", () => {
  it("按 5 小时切成不重叠的桶，边界归后一个桶", () => {
    expect(windowIndexOf(0)).toBe(0);
    expect(windowIndexOf(W - 1)).toBe(0);
    expect(windowIndexOf(W)).toBe(1);
    expect(windowIndexOf(2 * W + 5)).toBe(2);
  });
});

describe("humanSpeakerOf", () => {
  it("chat_message 与带 fromUid 的 user_message 算人类发言", () => {
    expect(humanSpeakerOf(chat(1, 0, "u1"))).toBe("u1");
    expect(humanSpeakerOf(user(2, 0, "u2"))).toBe("u2");
  });

  it("系统旁白不算 —— fromUid 是保留名 system", () => {
    expect(humanSpeakerOf(chat(1, 0, "system"))).toBeNull();
  });

  it("接力开场白不算：它的 fromUid 是点火那个人，几小时后不该替他重新参与一次", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { relay: { fromAgentId: "a", toAgentId: "b", depth: 1 } }))).toBeNull();
  });

  it("语音通话的招呼开场白同理不算", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { greeting: true }))).toBeNull();
  });

  it("agent 的话没有 fromUid，天然不算", () => {
    const a = { seq: 1, sessionId: "s", ts: 0, type: "assistant_message", content: "x", agentId: "admin" } as SessionEvent;
    expect(humanSpeakerOf(a)).toBeNull();
  });

  it("分类器派活的那条照常算 —— 那就是人自己打出来的话", () => {
    expect(humanSpeakerOf(user(1, 0, "u1", { mentions: ["admin"], dispatch: "auto" }))).toBe("u1");
  });
});

describe("lastActiveWindowParticipants", () => {
  it("一条人类发言都没有 → null", () => {
    expect(lastActiveWindowParticipants([])).toBeNull();
    const onlySystem = [chat(1, 0, "system")];
    expect(lastActiveWindowParticipants(onlySystem)).toBeNull();
  });

  it("只算最后一个有对话的窗，更早那个窗里的人不进名单", () => {
    const events = [chat(1, 0, "u1"), chat(2, W + 10, "u2"), chat(3, W + 20, "u3")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 1, uids: ["u2", "u3"] });
  });

  it("当前时刻早已过期也照样报最后那个有对话的窗（不会变空）", () => {
    const events = [chat(1, 3 * W + 1, "u9")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 3, uids: ["u9"] });
  });

  it("去重，且按首次出现的顺序（叠罗汉画序不因为谁又说了一句而整排跳动）", () => {
    const events = [chat(1, 0, "a"), chat(2, 1, "b"), chat(3, 2, "a"), chat(4, 3, "c")];
    expect(lastActiveWindowParticipants(events)).toEqual({ window: 0, uids: ["a", "b", "c"] });
  });
});

describe("advanceParticipants", () => {
  it("同一个窗里并入新的人", () => {
    const cur = { window: 0, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 10, "b"))).toEqual({ window: 0, uids: ["a", "b"] });
  });

  it("跨进新窗 = 整份换掉，不是并集", () => {
    const cur = { window: 0, uids: ["a", "b"] };
    expect(advanceParticipants(cur, chat(2, W, "c"))).toEqual({ window: 1, uids: ["c"] });
  });

  it("没变就回同一个引用（调用方据此决定要不要打网络）", () => {
    const cur = { window: 0, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 10, "a"))).toBe(cur);
    expect(advanceParticipants(cur, chat(3, 10, "system"))).toBe(cur);
  });

  it("时钟回拨不让窗口倒退", () => {
    const cur = { window: 5, uids: ["a"] };
    expect(advanceParticipants(cur, chat(2, 0, "b"))).toBe(cur);
  });
});

describe("countHumanMessages", () => {
  it("只数人类发言", () => {
    const events = [chat(1, 0, "a"), chat(2, 1, "system"), user(3, 2, "b"), user(4, 3, "c", { greeting: true })];
    expect(countHumanMessages(events)).toBe(2);
  });
});
