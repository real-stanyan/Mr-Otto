// memory_loaded.topics（第四档，#846）：① 没有 topics 字段的旧日志投影逐字节不变；
// ② 有字段时 system 尾部多主题索引 + 每个非空桶一块；③ 估算与真实请求同一份文案。
import { describe, expect, it } from "vitest";
import { deriveMessages, renderMemoryPrompt } from "../../src/session/deriveMessages.js";
import { contextBreakdown } from "../../src/shared/contextEstimate.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const created: SessionEvent = { ...base(0), type: "session_created", workspace: "/w" };
const user: SessionEvent = { ...base(2), type: "user_message", content: "hi" };
const sys = (events: SessionEvent[]) => (deriveMessages(events)[0] as { content: string }).content;

describe("memory_loaded.topics", () => {
  it("没有 topics 字段（旧日志）：system 与从前逐字节一致，不提 TOPIC", () => {
    const loaded: SessionEvent = { ...base(1), type: "memory_loaded", memory: "m", user: "u" };
    const content = sys([created, loaded, user]);
    expect(content).not.toContain("TOPIC");
    expect(content).not.toContain("主题索引");
    expect(content.endsWith(renderMemoryPrompt("m", "u"))).toBe(true);
  });

  it("有 topics：索引列全部桶（含空种子），块只渲非空桶", () => {
    const loaded: SessionEvent = {
      ...base(1), type: "memory_loaded", memory: "", user: "",
      topics: [
        { slug: "work", label: "工作", content: "" },
        { slug: "hobbies", label: "爱好", content: "改装 WRX\n§\n周末骑车" },
      ],
    };
    const content = sys([created, loaded, user]);
    expect(content).toContain("主题索引");
    expect(content).toContain("work（工作）· 0 条");
    expect(content).toContain("hobbies（爱好）· 2 条");
    expect(content).toContain("TOPIC:爱好 (hobbies)");
    expect(content).not.toContain("TOPIC:工作");
    expect(content).toContain("TOPIC 记"); // 判据句
    expect(content).toContain("/700 chars");
  });

  it("空数组也算「有主题桶能力」：判据句出现，索引为空行", () => {
    const loaded: SessionEvent = { ...base(1), type: "memory_loaded", memory: "", user: "", topics: [] };
    expect(sys([created, loaded, user])).toContain("TOPIC 记");
  });

  it("contextBreakdown 的 system 估算用同一份文案", () => {
    const loaded: SessionEvent = {
      ...base(1), type: "memory_loaded", memory: "", user: "",
      topics: [{ slug: "work", label: "工作", content: "在 X 公司做 Y" }],
    };
    const events = [created, loaded, user];
    const withTopics = contextBreakdown(events).system;
    const without = contextBreakdown([created, { ...loaded, topics: undefined } as unknown as SessionEvent, user]).system;
    expect(withTopics).toBeGreaterThan(without);
  });
});
