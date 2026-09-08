import { describe, it, expect } from "vitest";
import { pendingAttention } from "../../src/renderer/src/store.js";
import type { FriendsSnapshot } from "../../src/shared/friends.js";
import type { WorkspaceMentionRow } from "../../src/shared/workspaceMentions.js";

const MENTION = (seq: number, read: boolean): WorkspaceMentionRow => ({
  workspaceId: "w1", sessionId: "s1", seq, uid: "me", fromUid: "u2",
  fromLabel: "小红", excerpt: "看一下", createdTs: seq, read,
});

const PROFILE = (id: string) => ({ id, email: `${id}@x.com`, name: id, avatarUrl: "" });
const SNAP = (incoming: number): FriendsSnapshot => ({
  friends: [], outgoing: [],
  incoming: Array.from({ length: incoming }, (_, i) => ({
    friendshipId: `f${i}`, profile: PROFILE(`u${i}`),
    status: "pending" as const, direction: "incoming" as const,
  })),
});

describe("pendingAttention(dock 角标)", () => {
  it("未读 DM 与待处理请求相加", () => {
    expect(pendingAttention({
      unreadByFriend: { a: 2, b: 1 },
      friendsSnapshot: SNAP(1),
      workspaceMentions: [],
    })).toBe(4);
  });

  it("自己发出去的请求不算'有人在等你'", () => {
    expect(pendingAttention({
      unreadByFriend: {},
      friendsSnapshot: {
        friends: [], incoming: [],
        outgoing: [{
          friendshipId: "f1", profile: PROFILE("u2"),
          status: "pending", direction: "outgoing",
        }],
      },
      workspaceMentions: [],
    })).toBe(0);
  });

  it("工作区里 @ 我的未读也算，已读那些不算（#1064）", () => {
    expect(pendingAttention({
      unreadByFriend: {},
      friendsSnapshot: SNAP(0),
      workspaceMentions: [MENTION(1, false), MENTION(2, true), MENTION(3, false)],
    })).toBe(2);
  });
});
