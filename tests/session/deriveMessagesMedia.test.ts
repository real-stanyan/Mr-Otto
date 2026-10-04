// 云会话里发的图 / 视频怎么进模型（#1491）：chat_message 也会带 attachments（群里随手发的图，没 @ 谁），
// 视频只有封面进 image_ref、正文后面拼一行「发了一段 N 秒的视频」。没带的老事件投影逐字节不变。
import { describe, expect, it } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const id = (c: string): string => "sha256:" + c.repeat(64);

describe("chat_message 带附件的投影", () => {
  it("带 attachments → parts:[text, image_ref]，正文仍是 `[名字]: 正文`", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "chat_message", fromUid: "u1", label: "阿峰", content: "看这张", mention: false,
        attachments: [{ id: id("a"), mediaType: "image/jpeg", bytes: 10, width: 640, height: 480 }],
      },
    ];
    expect(deriveMessages(events)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[阿峰]: 看这张" },
          { type: "image_ref", id: id("a"), mediaType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("没带附件的 chat_message 还是一个字符串（老日志逐字节不变）", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "chat_message", fromUid: "u1", label: "阿峰", content: "在吗", mention: false },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "[阿峰]: 在吗" }]);
  });
});

describe("视频的投影：封面进 image_ref，正文后面一行说明", () => {
  it("user_message 带视频 + 封面", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "[阿峰]: [视频]", fromUid: "u1", mentions: ["admin"],
        attachments: [{ id: id("c"), mediaType: "image/jpeg", bytes: 10, name: "视频封面", width: 1280, height: 720 }],
        videos: [{ id: id("b"), mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000, poster: id("c") }],
      },
    ];
    expect(deriveMessages(events)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[阿峰]: [视频]\n[发了一段 0:12 的视频，上面那张图是它的封面]" },
          { type: "image_ref", id: id("c"), mediaType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("没封面的视频：没有 image_ref，只剩那一行说明，content 仍是字符串", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "chat_message", fromUid: "u1", label: "阿峰", content: "[视频]", mention: false,
        videos: [{ id: id("b"), mediaType: "video/quicktime", bytes: 5_000_000, width: 0, height: 0, durationMs: 65_000 }],
      },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "[阿峰]: [视频]\n[发了一段 1:05 的视频，没有封面可看]" }]);
  });
});
