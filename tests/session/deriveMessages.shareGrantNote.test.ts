import { describe, expect, it } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 导入连带借来服务的会话包时焊进模型视野的注记（issue #788）。
// 走 project_instructions 同一条通道：焊进围栏 system、compact 免疫、
// 没有围栏时退回 user 消息。钉的就是这三件事。

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const NOTE = "【会话来源】历史里的 `mcp__square__*` 在本机对应 `mcp__square_32c6716a__*`";

const created: SessionEvent = { ...base(1), type: "session_created", workspace: "/w" };
const note: SessionEvent = {
  ...base(2), type: "share_grant_note",
  note: NOTE, friendUid: "32c6716a-x", servers: ["square"],
};
const userMsg: SessionEvent = { ...base(3), type: "user_message", content: "继续" };
const compacted: SessionEvent = { ...base(4), type: "context_compacted", summary: "摘要", model: "m" };

describe("share_grant_note 焊进围栏 system（issue #788）", () => {
  it("注记进 system，不自成一条消息", () => {
    const msgs = deriveMessages([created, note, userMsg]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain(NOTE);
    expect(msgs).toHaveLength(2);
  });

  it("compact 之后仍在：对应关系不是历史，是每轮都该在的事实", () => {
    const msgs = deriveMessages([created, note, userMsg, compacted]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain(NOTE);
  });

  it("没有围栏 system 时退回 user 消息，不整份丢掉", () => {
    const msgs = deriveMessages([note, userMsg]);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe(NOTE);
  });
});
