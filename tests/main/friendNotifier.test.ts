import { describe, it, expect, vi } from "vitest";
import {
  createNotifier, dmNotification, friendRequestNotification, inviteNotification,
  newIncomingInvites, newIncomingRequests, truncate, turnCompleteNotification,
} from "../../src/main/friendNotifier.js";
import type { FriendsSnapshot, GameInvite } from "../../src/shared/friends.js";

const PROFILE = (id: string) => ({ id, email: `${id}@x.com`, name: id.toUpperCase(), avatarUrl: "" });
const SNAP = (incomingIds: string[]): FriendsSnapshot => ({
  friends: [], outgoing: [],
  incoming: incomingIds.map((id) => ({
    friendshipId: id, profile: PROFILE(id), status: "pending" as const, direction: "incoming" as const,
  })),
});
const INVITE = (id: string, over: Partial<GameInvite> = {}): GameInvite => ({
  id, peer: PROFILE("u2"), direction: "incoming", tableId: "t1", tableName: "夜场",
  status: "pending", createdAt: "t", expiresAt: "t+", ...over,
});

describe("truncate", () => {
  it("压平空白,超长截断带省略号", () => {
    expect(truncate("a\n\n b")).toBe("a b");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("通知文案", () => {
  it("DM 带上发信人和落点 friendId", () => {
    expect(dmNotification("阿关", "在吗", "u2"))
      .toEqual({ title: "阿关", body: "在吗", target: { kind: "dm", friendId: "u2" } });
  });

  it("没名字的人不留空标题", () => {
    expect(dmNotification("", "hi", "u2").title).toBe("好友");
  });

  it("邀请与好友请求各自落到自己的面板", () => {
    expect(inviteNotification("阿关", "夜场")).toMatchObject({ target: { kind: "invite" } });
    expect(friendRequestNotification("阿关")).toMatchObject({ target: { kind: "friendRequest" } });
  });

  it("任务完成:会话名进标题,任务文本进正文,带提示音,落点是那个会话", () => {
    expect(turnCompleteNotification("重构登录", "把登录页改成 OAuth", "s1")).toEqual({
      title: "重构登录 · 任务完成",
      body: "把登录页改成 OAuth",
      target: { kind: "session", sessionId: "s1" },
      sound: "Glass",
    });
  });

  it("任务完成:没标题不留空,超长标题/正文都截断", () => {
    expect(turnCompleteNotification(null, "hi", "s1").title).toBe("会话 · 任务完成");
    expect(turnCompleteNotification("x".repeat(60), "hi", "s1").title).toBe(`${"x".repeat(39)}… · 任务完成`);
    expect(turnCompleteNotification("t", "y".repeat(200), "s1").body).toBe(`${"y".repeat(119)}…`);
  });

  it("好友类通知不带声音(角标即可,别把静默行为改吵)", () => {
    expect(dmNotification("A", "hi", "u2").sound).toBeUndefined();
    expect(inviteNotification("A", "夜场").sound).toBeUndefined();
    expect(friendRequestNotification("A").sound).toBeUndefined();
  });
});

describe("全量快照的去重", () => {
  // 关系链是全量推送:不做差集,每次刷新都会把同一条待处理请求重新弹一遍
  it("只报新增的请求", () => {
    expect(newIncomingRequests(SNAP(["a"]), SNAP(["a", "b"]))).toEqual(["b"]);
    expect(newIncomingRequests(SNAP(["a"]), SNAP(["a"]))).toEqual([]);
  });

  it("第一份快照是补课不是新事件 → 一条都不弹", () => {
    expect(newIncomingRequests(null, SNAP(["a", "b"]))).toEqual([]);
    expect(newIncomingInvites(null, [INVITE("i1")])).toEqual([]);
  });

  it("邀请只报新到的、还待回应的、收到的那一向", () => {
    expect(newIncomingInvites([], [INVITE("i1")]).map((i) => i.id)).toEqual(["i1"]);
    expect(newIncomingInvites([], [INVITE("i2", { status: "declined" })])).toEqual([]);
    expect(newIncomingInvites([], [INVITE("i3", { direction: "outgoing" })])).toEqual([]);
    expect(newIncomingInvites([INVITE("i1")], [INVITE("i1")])).toEqual([]);
  });
});

describe("createNotifier", () => {
  it("窗口聚焦时不打断(UI 里的角标已经说明问题)", () => {
    const show = vi.fn();
    createNotifier({ isFocused: () => true, show, activate: vi.fn() })(dmNotification("A", "hi", "u2"));
    expect(show).not.toHaveBeenCalled();
  });

  it("没聚焦才发,点击回调把 target 交给 activate", () => {
    const show = vi.fn((_spec, onClick: () => void) => onClick());
    const activate = vi.fn();
    createNotifier({ isFocused: () => false, show, activate })(dmNotification("A", "hi", "u2"));
    expect(activate).toHaveBeenCalledWith({ kind: "dm", friendId: "u2" });
  });
});
