import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { tempDir } from "../helpers/tempDir.js";

describe("user_message 的群聊字段（#932 坑 ②）", () => {
  it("fromUid / mentions 落盘后原样读回", () => {
    const store = new EventStore(join(tempDir("mrotto-um-"), "s.db"));
    store.append({
      sessionId: "s1", ts: 1, type: "user_message",
      content: "[alice]: @运营 看下销量", fromUid: "u1", mentions: ["ops"],
    });
    const [e] = store.load("s1");
    expect(e).toMatchObject({ type: "user_message", fromUid: "u1", mentions: ["ops"] });
    store.close();
  });

  it("模型投影读都不读它们 —— 有没有这两个字段，投影逐字节相同", () => {
    const a = { sessionId: "s1", ts: 1, seq: 0, type: "user_message" as const, content: "[alice]: 在吗" };
    const b = { ...a, fromUid: "u1", mentions: ["ops"] };
    expect(deriveMessages([b])).toEqual(deriveMessages([a]));
  });
});
