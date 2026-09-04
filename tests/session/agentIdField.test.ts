import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import { tempDir } from "../helpers/tempDir.js";

describe("事件的 agentId 字段（#928 切片 1a）", () => {
  it("带 agentId 落盘后原样读得回来", () => {
    const store = new EventStore(join(tempDir("mrotto-agentid-"), "s.db"));
    store.append({
      sessionId: "s1",
      ts: 1,
      type: "assistant_message",
      content: "查了，下滑 12%",
      model: "m",
      agentId: "ops",
    });
    const [e] = store.load("s1");
    expect(e).toMatchObject({ type: "assistant_message", agentId: "ops" });
  });

  it("不带 agentId 照常落盘——缺席就是单 agent 会话，全部旧日志都在这一档", () => {
    const store = new EventStore(join(tempDir("mrotto-agentid-"), "s.db"));
    store.append({ sessionId: "s1", ts: 1, type: "assistant_message", content: "hi", model: "m" });
    const [e] = store.load("s1");
    expect(e).toBeDefined();
    if (e) {
      expect(e).toMatchObject({ type: "assistant_message" });
      expect("agentId" in e).toBe(false);
    }
  });
});
