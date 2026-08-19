import { describe, expect, it } from "vitest";
import { seatIdentity, seatPosition } from "../../src/renderer/src/lib/pokerSeat.js";
import type { FriendshipEntry } from "../../src/shared/friends.js";

describe("seatPosition", () => {
  it("我永远在正下方,不管坐几号位", () => {
    for (const meIndex of [0, 1, 2, 3]) {
      const { left, top } = seatPosition(meIndex, meIndex, 4);
      expect(left).toBeCloseTo(50, 5);
      expect(top).toBeCloseTo(92, 5);
    }
  });

  it("单挑时对手在正上方", () => {
    const { left, top } = seatPosition(0, 1, 2);
    expect(left).toBeCloseTo(50, 5);
    expect(top).toBeCloseTo(8, 5);
  });

  it("四人桌其余座位按相对座次排开,彼此错开", () => {
    const spots = [0, 1, 2, 3].map((i) => seatPosition(i, 0, 4));
    const keys = spots.map((p) => `${p.left.toFixed(1)},${p.top.toFixed(1)}`);
    expect(new Set(keys).size).toBe(4);
  });

  it("找不到自己(观战,meIndex=-1)不炸,按 0 号位锚定", () => {
    expect(seatPosition(0, -1, 2)).toEqual(seatPosition(0, 0, 2));
  });
});

describe("seatIdentity", () => {
  const friends: FriendshipEntry[] = [
    {
      friendshipId: "f1",
      direction: "outgoing",
      profile: { id: "u-b", email: "b@x.com", name: "小 B", avatarUrl: "http://a/b.png" },
    } as unknown as FriendshipEntry,
  ];

  it("对手从好友快照里拿真名和头像", () => {
    expect(seatIdentity({ userId: "u-b", isMe: false }, friends, "我", "http://a/me.png")).toEqual({
      name: "小 B",
      avatarUrl: "http://a/b.png",
    });
  });

  it("自己用账号资料", () => {
    expect(seatIdentity({ userId: "u-a", isMe: true }, friends, "我", "http://a/me.png")).toEqual({
      name: "我",
      avatarUrl: "http://a/me.png",
    });
  });

  it("快照没跟上时退回截短 ID,不显示空白", () => {
    expect(seatIdentity({ userId: "0123456789", isMe: false }, [], "", "")).toEqual({
      name: "012345",
      avatarUrl: "",
    });
  });
});
