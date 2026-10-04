// 「今天是」按人的时区算（#1283，spec §6.2）：云 runtime 在 VPS 上是 UTC，上海的早上八点在那儿还是昨天。
import { describe, expect, it } from "vitest";
import { dayOfLastEvent, deriveMessages, systemPromptText, userTzOf } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 2026-10-05 00:30 上海 = 2026-10-04 16:30Z
const TS = Date.UTC(2026, 9, 4, 16, 30);
const created: SessionEvent = { seq: 1, sessionId: "s", ts: TS, type: "session_created", workspace: "/w", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } };

describe("今天是：按最近一条 user_message.tz", () => {
  it("没有 tz：逐字节 = 老投影（进程时区），括号写「本机时区」", () => {
    const plain: SessionEvent = { seq: 2, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [] };
    expect(userTzOf([created, plain])).toBeUndefined();
    const content = (deriveMessages([created, plain])[0] as { content: string }).content;
    expect(content).toBe(systemPromptText("/w", dayOfLastEvent([created, plain]), undefined, undefined, created.cloud));
    expect(content).toContain("（本机时区）");
  });
  it("有 tz：日期按那个时区，括号写时区名；最近一条胜出", () => {
    const sh: SessionEvent = { seq: 2, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [], tz: "Asia/Shanghai" };
    expect(userTzOf([created, sh])).toBe("Asia/Shanghai");
    expect(dayOfLastEvent([created, sh])).toBe("2026-10-05");
    const content = (deriveMessages([created, sh])[0] as { content: string }).content;
    expect(content).toContain("今天是 2026-10-05（Asia/Shanghai）");
    const la: SessionEvent = { seq: 3, sessionId: "s", ts: TS, type: "user_message", content: "hi", fromUid: "u", mentions: [], tz: "America/Los_Angeles" };
    expect(dayOfLastEvent([created, sh, la])).toBe("2026-10-04");
  });
});
