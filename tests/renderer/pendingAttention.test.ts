import { describe, it, expect } from "vitest";
import { pendingAttention } from "../../src/renderer/src/store.js";
import type { FriendsSnapshot, GameInvite } from "../../src/shared/friends.js";

const PROFILE = (id: string) => ({ id, email: `${id}@x.com`, name: id, avatarUrl: "" });
const SNAP = (incoming: number): FriendsSnapshot => ({
  friends: [], outgoing: [],
  incoming: Array.from({ length: incoming }, (_, i) => ({
    friendshipId: `f${i}`, profile: PROFILE(`u${i}`),
    status: "pending" as const, direction: "incoming" as const,
  })),
});
const INVITE = (over: Partial<GameInvite> = {}): GameInvite => ({
  id: "i1", peer: PROFILE("u2"), direction: "incoming", tableId: "t1", tableName: "夜场",
  status: "pending", createdAt: "t", expiresAt: "t+", ...over,
});

describe("pendingAttention(dock 角标)", () => {
  it("未读 DM + 待处理请求 + 待回应邀请三项相加", () => {
    expect(pendingAttention({
      unreadByFriend: { a: 2, b: 1 },
      friendsSnapshot: SNAP(1),
      gameInvites: [INVITE()],
    })).toBe(5); // 未读 2+1、请求 1、邀请 1
  });

  it("自己发出去的邀请、已回应的邀请都不算'有人在等你'", () => {
    expect(pendingAttention({
      unreadByFriend: {},
      friendsSnapshot: SNAP(0),
      gameInvites: [INVITE({ direction: "outgoing" }), INVITE({ id: "i2", status: "declined" })],
    })).toBe(0);
  });
});
