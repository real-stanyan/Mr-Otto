import { describe, it, expect, vi } from "vitest";
import {
  toFriendProfile, buildSnapshot, FriendsManager,
  type FriendsApi, type FriendshipRow, type ProfileRow,
} from "../../src/main/friends.js";

const P = (id: string, email = `${id}@x.com`): ProfileRow =>
  ({ id, email, name: id.toUpperCase(), avatar_url: null });

describe("toFriendProfile", () => {
  it("snake_case 归一 camelCase,null 补空串", () => {
    expect(toFriendProfile({ id: "u1", email: "a@x.com", name: null, avatar_url: null }))
      .toEqual({ id: "u1", email: "a@x.com", name: "", avatarUrl: "" });
  });
});

describe("buildSnapshot", () => {
  const me = "me";
  const rows: FriendshipRow[] = [
    { id: "f1", requester: "me", addressee: "a", status: "accepted" },
    { id: "f2", requester: "b", addressee: "me", status: "accepted" },
    { id: "f3", requester: "me", addressee: "c", status: "pending" },
    { id: "f4", requester: "d", addressee: "me", status: "pending" },
  ];
  const profiles = new Map(["a", "b", "c", "d"].map((id) => [id, P(id)]));

  it("按 status+方向分三组,profile 取对方", () => {
    const s = buildSnapshot(me, rows, profiles);
    expect(s.friends.map((e) => e.profile.id).sort()).toEqual(["a", "b"]);
    expect(s.outgoing).toHaveLength(1);
    expect(s.outgoing[0]).toMatchObject({ friendshipId: "f3", direction: "outgoing", profile: { id: "c" } });
    expect(s.incoming[0]).toMatchObject({ friendshipId: "f4", direction: "incoming", profile: { id: "d" } });
  });

  it("profile 缺席的行丢弃(数据不完整别渲染幽灵)", () => {
    const s = buildSnapshot(me, rows, new Map([["a", P("a")]]));
    expect(s.friends).toHaveLength(1);
    expect(s.incoming).toHaveLength(0);
  });
});

function fakeApi(over: Partial<FriendsApi> = {}): FriendsApi {
  return {
    getUserId: vi.fn(async () => "me"),
    findProfileByEmail: vi.fn(async () => null),
    insertFriendship: vi.fn(async () => {}),
    acceptFriendship: vi.fn(async () => {}),
    deleteFriendship: vi.fn(async () => {}),
    listFriendships: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    insertMessage: vi.fn(async () => {}),
    listMessages: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    ...over,
  };
}
const noPush = { friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn() };

describe("FriendsManager 关系链", () => {
  it("search:邮箱命中回 FriendProfile", async () => {
    const api = fakeApi({ findProfileByEmail: vi.fn(async () => P("u2", "hit@x.com")) });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.search("hit@x.com")).toEqual({
      ok: true, value: { id: "u2", email: "hit@x.com", name: "U2", avatarUrl: "" },
    });
  });

  it("search:查无此人 = ok:true value:null(不是错误)", async () => {
    const m = new FriendsManager({ api: fakeApi(), push: noPush });
    expect(await m.search("none@x.com")).toEqual({ ok: true, value: null });
  });

  it("未登录:一律 ok:false", async () => {
    const api = fakeApi({ getUserId: vi.fn(async () => null) });
    const m = new FriendsManager({ api, push: noPush });
    const r = await m.search("a@x.com");
    expect(r.ok).toBe(false);
  });

  it("sendRequest 成功后推新快照", async () => {
    const api = fakeApi({
      listFriendships: vi.fn(async () => [
        { id: "f9", requester: "me", addressee: "u2", status: "pending" } as FriendshipRow,
      ]),
      listProfiles: vi.fn(async () => [P("u2")]),
    });
    const push = { ...noPush, friendsChanged: vi.fn() };
    const m = new FriendsManager({ api, push });
    expect(await m.sendRequest("u2")).toEqual({ ok: true, value: null });
    expect(api.insertFriendship).toHaveBeenCalledWith("me", "u2");
    expect(push.friendsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ outgoing: [expect.objectContaining({ friendshipId: "f9" })] })
    );
  });

  it("sendRequest:唯一索引冲突映射成人话", async () => {
    const api = fakeApi({
      insertFriendship: vi.fn(async () => { throw Object.assign(new Error("dup"), { code: "23505" }); }),
    });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.sendRequest("u2")).toEqual({ ok: false, message: "已发过请求或已是好友" });
  });

  it("respond accept=true 走 acceptFriendship,false 走 deleteFriendship", async () => {
    const api = fakeApi();
    const m = new FriendsManager({ api, push: noPush });
    await m.respond("f1", true);
    expect(api.acceptFriendship).toHaveBeenCalledWith("f1");
    await m.respond("f2", false);
    expect(api.deleteFriendship).toHaveBeenCalledWith("f2");
  });

  it("api throw 普通错误 → ok:false 带 message,不向上炸", async () => {
    const api = fakeApi({ listFriendships: vi.fn(async () => { throw new Error("网断了"); }) });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.list()).toEqual({ ok: false, message: "网断了" });
  });

  it("sendMessage 委托 insertMessage(sender=自己)", async () => {
    const api = fakeApi();
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.sendMessage("u2", "hi")).toEqual({ ok: true, value: null });
    expect(api.insertMessage).toHaveBeenCalledWith("me", "u2", "hi");
  });

  it("listMessages 行归一成 DirectMessage", async () => {
    const api = fakeApi({
      listMessages: vi.fn(async () => [
        { id: 7, sender: "u2", recipient: "me", body: "yo", created_at: "2026-08-18T00:00:00Z" },
      ]),
    });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.listMessages("u2")).toEqual({
      ok: true,
      value: [{ id: 7, sender: "u2", recipient: "me", body: "yo", createdAt: "2026-08-18T00:00:00Z" }],
    });
  });
});
