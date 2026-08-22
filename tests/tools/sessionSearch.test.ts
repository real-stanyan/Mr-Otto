// session_search — 四形态零 LLM 跨会话回忆工具的测试（TDD 红）
import { describe, it, expect } from "vitest";
import { createSessionSearchTool, inferMode, parseSessionSearchResult } from "../../src/tools/sessionSearch.js";
import type { ExecutionWorld, HistoryCapability } from "../../src/world/executionWorld.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(sessionId: string, seq: number, type: "user_message" | "assistant_message", content: string): SessionEvent {
  // ts 按分钟展开（不是 seq 原样）：locator 的时间格式化到分钟粒度，
  // 相邻 seq 若共用同一 ms 时间戳会在断言里区分不出"取的是哪条事件的 ts"
  return { sessionId, seq, ts: seq * 60_000, type, content, model: "m" } as SessionEvent;
}
const sessions: Record<string, SessionEvent[]> = {
  s1: [
    { sessionId: "s1", seq: 0, ts: 0, type: "session_created", workspace: "/w" } as SessionEvent,
    ...Array.from({ length: 12 }, (_, i) => ev("s1", i + 1, i % 2 ? "assistant_message" : "user_message", `第${i + 1}句 ${i === 6 ? "关键词" : ""}`)),
  ],
  s2: [
    { sessionId: "s2", seq: 0, ts: 0, type: "session_created", workspace: "/w" } as SessionEvent,
    ev("s2", 1, "user_message", "另一个会话也有关键词"),
  ],
};
const history: HistoryCapability = {
  search: (q) => (q.includes("关键词")
    ? [{ sessionId: "s1", seq: 7, type: "user_message", text: "第7句 关键词", score: 2 },
       { sessionId: "s1", seq: 7, type: "user_message", text: "重复命中同一条", score: 1.5 },
       { sessionId: "s2", seq: 1, type: "user_message", text: "另一个会话也有关键词", score: 1 }]
    : []),
  window: (id, a, b) => (sessions[id] ?? []).filter((e) => e.seq >= a && e.seq <= b),
  load: (id) => sessions[id] ?? [],
  recent: (n) => [{ sessionId: "s2", title: "另一个会话也有关键词", workspace: "/w", startedTs: 0, lastTs: 5, userTurns: 1 }].slice(0, n),
};
const world = { history } as unknown as ExecutionWorld;
const tool = createSessionSearchTool();
const text = async (args: unknown) => { const r = await tool.run(args, world); return typeof r === "string" ? r : r.output; };

describe("inferMode", () => {
  it.each([
    [{ query: "x" }, "discovery"],
    [{ session_id: "s", around_seq: 3 }, "scroll"],
    [{ session_id: "s" }, "read"],
    [{}, "browse"],
  ])("%j → %s", (args, mode) => { expect(inferMode(args as Record<string, unknown>)).toBe(mode); });
});

describe("session_search", () => {
  it("discovery：按 session 去重、第一名带 ±5 + 首尾 3、其余只给命中；末行机器可读", async () => {
    const out = await text({ query: "关键词" });
    expect(out).toContain("s1");
    expect(out).toContain("第2句");      // 第一名的上下文窗（seq 7 ± 5）
    expect(out).toContain("第12句");     // 尾部 bookend
    expect(out).not.toContain("重复命中"); // 同 session 去重
    const parsed = parseSessionSearchResult(out)!;
    expect(parsed.mode).toBe("discovery");
    expect(parsed.chunks!.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
    expect(parsed.chunks![0]).toMatchObject({ seq: 7, score: 2, locator: expect.stringContaining("#7") });
    // locator 用的是命中事件自己的 ts（seq 7 → 第 7 分钟），不是 session 起始的 ts（seq 0 → 第 0 分钟）。
    // 只钉分钟位，不钉小时位：时区偏移是整小时（本机 Sydney +10/+11），分钟不受影响
    expect(parsed.chunks![0]!.locator).toMatch(/:07 · #7/);
    expect(parsed.chunks![0]!.locator).not.toMatch(/:00 · #7/);
  });
  it("discovery 零命中：人话 + 空 chunks", async () => {
    const out = await text({ query: "没有的词" });
    expect(out).toMatch(/没有找到/);
    expect(parseSessionSearchResult(out)!.chunks).toEqual([]);
  });
  it("scroll：围绕 seq 取窗，window 默认 5", async () => {
    const out = await text({ session_id: "s1", around_seq: 6 });
    expect(out).toContain("第1句");
    expect(out).toContain("第11句");
    expect(out).not.toContain("第12句");
  });
  it("read：COMPACT 投影 + document 元数据（pages = user turn 数）", async () => {
    const out = await text({ session_id: "s1" });
    expect(out).toContain("第1句");
    const parsed = parseSessionSearchResult(out)!;
    expect(parsed.document).toMatchObject({ sessionId: "s1", pages: 6 });
  });
  it("read：未知会话报错", async () => {
    await expect(tool.run({ session_id: "nope" }, world)).rejects.toThrow(/没有/);
  });
  it("browse：最近会话列表", async () => {
    const out = await text({});
    expect(out).toContain("s2");
    expect(out).toContain("另一个会话也有关键词");
  });
  it("world 没有 history 能力 = 人话报错", async () => {
    await expect(tool.run({ query: "x" }, {} as ExecutionWorld)).rejects.toThrow(/历史/);
  });
});
