import { describe, expect, it } from "vitest";

import { outgoingFrom } from "../../src/renderer/src/lib/resendPayload.js";
import type { UserMessageEvent } from "../../src/session/events.js";

function msg(extra: Partial<UserMessageEvent> = {}): UserMessageEvent {
  return {
    sessionId: "s",
    seq: 1,
    ts: 1,
    type: "user_message",
    content: "收到这个文件说一个字「收」就行",
    ...extra,
  };
}

describe("outgoingFrom —— 重试要重发的附件清单", () => {
  it("没附件就是空清单", () => {
    expect(outgoingFrom(msg())).toEqual([]);
  });

  it("图片原样带 ref —— 本体在附件库里，内容寻址，不用重新读盘", () => {
    const ref = { id: "sha256:abc", mediaType: "image/png", bytes: 10, name: "a.png" };
    expect(outgoingFrom(msg({ attachments: [ref] }))).toEqual([{ kind: "image", ref }]);
  });

  it("文本文件带全文快照 —— 原文件后来改没改都不影响这一次重发", () => {
    const files = [{ name: "a.json", content: "{}", bytes: 2 }];
    expect(outgoingFrom(msg({ textFiles: files }))).toEqual([
      { kind: "text", name: "a.json", content: "{}" },
    ]);
  });

  it("图片在前、文件在后，一条消息带两样都不能漏（这是它存在的理由）", () => {
    const ref = { id: "sha256:abc", mediaType: "image/png", bytes: 10 };
    const out = outgoingFrom(
      msg({ attachments: [ref], textFiles: [{ name: "a.json", content: "{}", bytes: 2 }] }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "image", ref });
    expect(out[1]).toEqual({ kind: "text", name: "a.json", content: "{}" });
  });
});
