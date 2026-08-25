import { describe, it, expect } from "vitest";
import { pendingAttention } from "../../src/renderer/src/store.js";
import type { FriendsSnapshot } from "../../src/shared/friends.js";

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
    })).toBe(0);
  });
});
