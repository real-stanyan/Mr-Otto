import { describe, it, expect } from "vitest";
import { latestImageRef } from "../../src/session/latestImage.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (seq: number, e: Partial<SessionEvent> & { type: string }): SessionEvent =>
  ({ seq, sessionId: "s", ts: seq, ...e } as SessionEvent);

const ref = (id: string, mediaType = "image/png") => ({ id, mediaType, bytes: 10 });

describe("latestImageRef", () => {
  it("一张都没有时回 null —— 不兜底成任何一张图", () => {
    expect(latestImageRef([ev(1, { type: "user_message", content: "hi" })])).toBeNull();
    expect(latestImageRef([])).toBeNull();
  });

  it("用户贴的图算数", () => {
    const out = latestImageRef([ev(1, { type: "user_message", content: "看这张", attachments: [ref("sha256:a")] })]);
    expect(out?.id).toBe("sha256:a");
  });

  it("工具产出的图也算数 —— 「改上一张」最常见的那张恰恰是生成出来的（ADR-0144）", () => {
    const out = latestImageRef([ev(1, { type: "tool_result", toolCallId: "c", status: "ok", output: "", images: [ref("sha256:b")] })]);
    expect(out?.id).toBe("sha256:b");
  });

  it("取最近的那一张 —— 倒着扫，先撞上谁就是谁", () => {
    const out = latestImageRef([
      ev(1, { type: "user_message", content: "", attachments: [ref("sha256:old")] }),
      ev(2, { type: "tool_result", toolCallId: "c", status: "ok", output: "", images: [ref("sha256:new")] }),
    ]);
    expect(out?.id).toBe("sha256:new");
  });

  it("同一条事件里有好几张时取最后一张", () => {
    const out = latestImageRef([ev(1, { type: "tool_result", toolCallId: "c", status: "ok", output: "", images: [ref("a"), ref("b")] })]);
    expect(out?.id).toBe("b");
  });

  it("非图片附件不算 —— attachments 里将来混进别的 mediaType 时不能把 PDF 当底图发出去", () => {
    const out = latestImageRef([ev(1, { type: "user_message", content: "", attachments: [ref("doc", "application/pdf")] })]);
    expect(out).toBeNull();
  });

  it("失败的工具调用不留图 —— 与 imageIntake 的立场逐字一致（denied/error 的 output 是拒绝文案）", () => {
    const out = latestImageRef([ev(1, { type: "tool_result", toolCallId: "c", status: "error", output: "", images: [ref("x")] })]);
    expect(out).toBeNull();
  });
});
