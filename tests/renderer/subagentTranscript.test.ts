import { describe, expect, it } from "vitest";
import { subagentTranscript } from "../../src/renderer/src/lib/subagentTranscript.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { sessionId: "c", ts: 0 };
const events = [
  { ...base, seq: 1, type: "user_message", content: "去看看 page.tsx" },
  {
    ...base, seq: 2, type: "assistant_message", content: "", model: "m",
    toolCalls: [
      { id: "t1", name: "read_file", args: { path: "/a/page.tsx" } },
      { id: "t2", name: "bash", args: { command: "ls" } },
    ],
  },
  { ...base, seq: 3, type: "tool_result", toolCallId: "t1", status: "error", output: "ENOENT: no such file\n  at x" },
  { ...base, seq: 4, type: "assistant_message", content: "文件不存在。", model: "m" },
] as unknown as SessionEvent[];

describe("subagentTranscript", () => {
  it("用户 / 模型 / 工具三种行按日志顺序排,工具带结果态", () => {
    const rows = subagentTranscript(events);
    expect(rows.map((r) => r.kind)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(rows[1]).toMatchObject({ name: "read_file", status: "error", note: "ENOENT: no such file" });
    expect(rows[2]).toMatchObject({ name: "bash", status: "running" });
    expect(rows[3]).toMatchObject({ text: "文件不存在。" });
  });
  it("纯工具调用的空正文不单独成行", () => {
    expect(subagentTranscript(events).some((r) => r.kind === "assistant" && r.text === "")).toBe(false);
  });
});
