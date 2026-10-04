// 聊天页的行带图 / 视频（#1491 P3）：user_message 与 chat_message 的 attachments / videos 变成 mine / human 行上的 media；
// 没带的行一格都不多（老日志逐字不变）。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { chatRows } from "../../src/shared/mobileChat.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const WS = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }, { uid: "u2", role: "member", label: "阿峰", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [],
} as unknown as WorkspaceSnapshot;
const DAY = new Date(2026, 8, 23, 10, 0).getTime();
let seq = 0;
const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "s1", ts: DAY, ...o }) as unknown as SessionEvent;
const id = (c: string): string => "sha256:" + c.repeat(64);

describe("chatRows 的 media", () => {
  it("我发的图（user_message 带 attachments）→ mine 行带 media，路径在 home1/s1/ 下", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "user_message", content: "[Stan]: [图片]", fromUid: "me", mentions: ["admin"], attachments: [{ id: id("a"), mediaType: "image/jpeg", bytes: 10, width: 640, height: 480 }] })],
      ws: WS, selfUid: "me", now: DAY,
    });
    const mine = rows.find((r) => r.kind === "mine");
    expect(mine).toMatchObject({ kind: "mine", text: "[图片]", media: [{ kind: "image", path: `home1/s1/${"a".repeat(64)}.jpg`, width: 640, height: 480 }] });
  });

  it("别人随手发的（chat_message 带 videos）→ human 行带 media；封面不单独成图", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({
        type: "chat_message", fromUid: "u2", label: "阿峰", content: "[视频]", mention: false,
        attachments: [{ id: id("c"), mediaType: "image/jpeg", bytes: 2, name: "视频封面", width: 1280, height: 720 }],
        videos: [{ id: id("b"), mediaType: "video/mp4", bytes: 100, width: 1280, height: 720, durationMs: 12_000, poster: id("c") }],
      })],
      ws: WS, selfUid: "me", now: DAY,
    });
    const human = rows.find((r) => r.kind === "human");
    expect(human).toMatchObject({ kind: "human", name: "阿峰", media: [{ kind: "video", path: `home1/s1/${"b".repeat(64)}.mp4`, poster: `home1/s1/${"c".repeat(64)}.jpg`, durationMs: 12_000 }] });
    expect((human as { media: unknown[] }).media).toHaveLength(1);
  });

  it("没带附件的行一格都不多", () => {
    seq = 0;
    const rows = chatRows({
      events: [e({ type: "chat_message", fromUid: "u2", label: "阿峰", content: "在吗", mention: false })],
      ws: WS, selfUid: "me", now: DAY,
    });
    const human = rows.find((r) => r.kind === "human");
    expect(human).toEqual({ kind: "human", key: "e0", ts: DAY, uid: "u2", name: "阿峰", text: "在吗" });
  });
});
