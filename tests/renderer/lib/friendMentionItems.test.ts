// @好友 补全条目的两条判定(issue #831):一行显示什么 / 输入的字比对什么。
// 钉住的核心是「显示什么就搜什么」—— 行上摆着邮箱却搜不出来,是界面骗人的一种。

import { describe, it, expect } from "vitest";
import {
  friendMentionItems,
  searchFriendMentions,
} from "../../../src/renderer/src/lib/friendMentionItems.js";
import type { FriendProfile } from "../../../src/shared/friends.js";

const profile = (p: Partial<FriendProfile>): { profile: FriendProfile } => ({
  profile: { id: "u1", email: "a@example.com", name: "Stan Yan", avatarUrl: "", ...p },
});

describe("friendMentionItems", () => {
  it("一行三格:id 用 uid、label 带 @ 前缀、头像与邮箱进 metadata", () => {
    const [item] = friendMentionItems([
      profile({ id: "u7", name: "Mingxuan Zhang", email: "mx@example.com", avatarUrl: "https://x/a.png" }),
    ]);
    expect(item).toEqual({
      id: "u7",
      type: "friend",
      label: "@Mingxuan Zhang",
      metadata: {
        avatar: "https://x/a.png",
        avatarLabel: "Mingxuan Zhang",
        trailing: "mx@example.com",
      },
    });
  });

  it("显示名空着时首字母那一格拿邮箱顶上,不留一个 ?", () => {
    const [item] = friendMentionItems([profile({ name: "", email: "bin@example.com" })]);
    expect(item!.metadata.avatarLabel).toBe("bin@example.com");
  });

  it("头像 URL 为空也照样是「人行」:avatar 键在,组件走首字母兜底", () => {
    const [item] = friendMentionItems([profile({ avatarUrl: "" })]);
    expect(item!.metadata.avatar).toBe("");
  });
});

describe("searchFriendMentions", () => {
  const items = friendMentionItems([
    profile({ id: "u1", name: "Stan Yan", email: "stan@example.com" }),
    profile({ id: "u2", name: "Bin LIU", email: "mx@example.com" }),
  ]);

  it("空串 = 全部(刚打完 @ 那一刻要看到整份名单)", () => {
    expect(searchFriendMentions(items, "")).toHaveLength(2);
    expect(searchFriendMentions(items, "   ")).toHaveLength(2);
  });

  it("按显示名命中,大小写不敏感", () => {
    expect(searchFriendMentions(items, "bin").map((i) => i.id)).toEqual(["u2"]);
  });

  it("按邮箱也命中 —— 行上写着的字必须搜得出来", () => {
    expect(searchFriendMentions(items, "mx@").map((i) => i.id)).toEqual(["u2"]);
  });

  it("都不沾就是空", () => {
    expect(searchFriendMentions(items, "zzz")).toEqual([]);
  });
});
