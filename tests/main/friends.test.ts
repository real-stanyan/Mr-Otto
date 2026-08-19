import { describe, it, expect, vi } from "vitest";
import {
  toFriendProfile, buildSnapshot, presenceUnion, sameIds, toGameInvite, FriendsManager,
  DEGRADED_POLL_MS, HEARTBEAT_MS,
  type FriendsApi, type FriendsTimers, type FriendshipRow,
  type InviteRow, type MessageRow, type ProfileRow,
} from "../../src/main/friends.js";

const P = (id: string, email = `${id}@x.com`): ProfileRow =>
  ({ id, email, name: id.toUpperCase(), avatar_url: null });

describe("toFriendProfile", () => {
  it("snake_case 归一 camelCase,null 补空串", () => {
    expect(toFriendProfile({ id: "u1", email: "a@x.com", name: null, avatar_url: null }))
      .toEqual({ id: "u1", email: "a@x.com", name: "", avatarUrl: "" });
  });

  // 手机/匿名注册的 auth.users.email 就是 null(ADR-0025),渲染层类型是 string,
  // null 必须在这条边界上归一,否则 UI 会渲出 "null"
  it("email 为 null 时归一成空串", () => {
    expect(toFriendProfile({ id: "u1", email: null, name: "N", avatar_url: null }))
      .toEqual({ id: "u1", email: "", name: "N", avatarUrl: "" });
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
    insertMessage: vi.fn(async (sender: string, recipient: string, body: string): Promise<MessageRow> =>
      ({ id: 1, sender, recipient, body, created_at: "t" })),
    listMessages: vi.fn(async () => []),
    latestInboxId: vi.fn(async () => 0),
    listInboxSince: vi.fn(async () => []),
    touchPresence: vi.fn(async () => {}),
    listLastSeen: vi.fn(async () => []),
    insertInvite: vi.fn(async (inviter: string, invitee: string, tableId: string, tableName: string): Promise<InviteRow> =>
      ({
        id: "i1", inviter, invitee, table_id: tableId, table_name: tableName,
        status: "pending", created_at: "t", expires_at: "t+",
      })),
    updateInviteStatus: vi.fn(async () => {}),
    listInvites: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    ...over,
  };
}

/** 每个用例一份新的 push spy(共享一份会让调用次数跨用例累加) */
function mkPush() {
  return {
    friendsChanged: vi.fn(), presenceChanged: vi.fn(), directMessage: vi.fn(),
    invitesChanged: vi.fn(), healthChanged: vi.fn(),
  };
}
const noPush = mkPush();

/** 手动推进的假定时器:测轮询/心跳不睡真时间 */
function fakeTimers(): FriendsTimers & { tick(ms: number): void } {
  const jobs: { fn: () => void; every: number; due: number }[] = [];
  let now = 0;
  return {
    setInterval(fn, ms) {
      const job = { fn, every: ms, due: now + ms };
      jobs.push(job);
      return job;
    },
    clearInterval(handle) {
      const i = jobs.indexOf(handle as (typeof jobs)[number]);
      if (i >= 0) jobs.splice(i, 1);
    },
    now: () => now,
    tick(ms) {
      now += ms;
      for (const job of [...jobs]) {
        while (job.due <= now) {
          job.due += job.every;
          job.fn();
        }
      }
    },
  };
}

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
    const push = mkPush();
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
    // 回的是落库后的真行:渲染层靠它把乐观气泡换成实条,不必再拉一整页
    expect(await m.sendMessage("u2", "hi")).toEqual({
      ok: true, value: { id: 1, sender: "me", recipient: "u2", body: "hi", createdAt: "t" },
    });
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

describe("FriendsManager 生命周期", () => {
  it("start:订阅 + 推初始快照;handlers 触发时转推", async () => {
    let captured: Parameters<FriendsApi["subscribe"]>[1] | null = null;
    const api = fakeApi({
      subscribe: vi.fn((_uid, handlers) => { captured = handlers; return () => {}; }),
    });
    const push = mkPush();
    const m = new FriendsManager({ api, push });
    await m.start();
    expect(push.friendsChanged).toHaveBeenCalledTimes(1); // 初始快照
    captured!.onPresence(["u2"]);
    expect(push.presenceChanged).toHaveBeenCalledWith(["u2"]);
    captured!.onMessage({ id: 1, sender: "u2", recipient: "me", body: "hi", created_at: "t" });
    expect(push.directMessage).toHaveBeenCalledWith(
      { id: 1, sender: "u2", recipient: "me", body: "hi", createdAt: "t" });
  });

  it("start 时未登录:不订阅不推", async () => {
    const api = fakeApi({ getUserId: vi.fn(async () => null) });
    const push = mkPush();
    await new FriendsManager({ api, push }).start();
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(push.friendsChanged).not.toHaveBeenCalled();
  });

  it("stop:退订 + 推空快照清 UI", async () => {
    const unsub = vi.fn();
    const api = fakeApi({ subscribe: vi.fn(() => unsub) });
    const push = mkPush();
    const m = new FriendsManager({ api, push });
    await m.start();
    m.stop();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(push.friendsChanged).toHaveBeenLastCalledWith({ friends: [], incoming: [], outgoing: [] });
    expect(push.presenceChanged).toHaveBeenLastCalledWith([]);
  });

  it("重复 start 幂等:旧订阅先退", async () => {
    const unsub = vi.fn();
    const api = fakeApi({ subscribe: vi.fn(() => unsub) });
    const m = new FriendsManager({ api, push: mkPush() });
    await m.start();
    await m.start();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(2);
  });

  it("stop 在 start 挂起期间到达:不订阅不推", async () => {
    let resolveUid!: (uid: string | null) => void;
    const uidPromise = new Promise<string | null>((resolve) => { resolveUid = resolve; });
    const api = fakeApi({ getUserId: vi.fn(() => uidPromise) });
    const push = mkPush();
    const m = new FriendsManager({ api, push });

    const startPromise = m.start(); // 挂在 getUserId 上
    m.stop(); // teardown 是 no-op(还没订阅),但世代号已推进
    expect(push.friendsChanged).toHaveBeenCalledTimes(1); // stop() 自己推的空快照
    expect(push.presenceChanged).toHaveBeenCalledTimes(1);

    resolveUid("me"); // start 恢复
    await startPromise;

    expect(api.subscribe).not.toHaveBeenCalled();
    expect(push.friendsChanged).toHaveBeenCalledTimes(1); // start 恢复后没有再推
    expect(push.presenceChanged).toHaveBeenCalledTimes(1);
  });

  it("并发两次 start:只有最后一次的订阅存活", async () => {
    // 卡住 listFriendships,好让第一次 start 停在"已订阅、快照还没推完"的中间态,
    // 这时第二次 start 进来最有代表性:teardown() 立刻退掉第一次的订阅(不是靠世代号 bail)
    let resolveList!: (rows: FriendshipRow[]) => void;
    const listPromise = new Promise<FriendshipRow[]>((resolve) => { resolveList = resolve; });
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    let subscribeCalls = 0;
    const api = fakeApi({
      listFriendships: vi.fn(() => listPromise),
      subscribe: vi.fn(() => (++subscribeCalls === 1 ? unsub1 : unsub2)),
    });
    const push = mkPush();
    const m = new FriendsManager({ api, push });

    const first = m.start();
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 放行微任务:getUserId → latestInboxId → subscribe,卡在 listFriendships 上
    expect(api.subscribe).toHaveBeenCalledTimes(1);

    const second = m.start(); // teardown() 同步调用 unsub1
    expect(unsub1).toHaveBeenCalledTimes(1);

    resolveList([]); // 放开 listFriendships,两边的快照推送都能跑完
    await first;
    await second;

    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(unsub2).not.toHaveBeenCalled(); // 第二次(最后一次)的订阅存活
  });
});

// ── 在线状态:presence ∪ 心跳(ADR-0027) ──────────────────────────
describe("presenceUnion", () => {
  const now = 1_000_000;

  it("Realtime presence 与心跳窗口取并集", () => {
    expect(presenceUnion(["a"], [{ id: "b", last_seen_at: new Date(now - 1000).toISOString() }], now))
      .toEqual(["a", "b"]);
  });

  it("心跳超出窗口 = 不在线", () => {
    expect(presenceUnion([], [{ id: "b", last_seen_at: new Date(now - 200_000).toISOString() }], now))
      .toEqual([]);
  });

  it("从没上过线(null)或时间戳无法解析 → 跳过,不当成在线", () => {
    expect(presenceUnion([], [
      { id: "b", last_seen_at: null },
      { id: "c", last_seen_at: "不是时间" },
    ], now)).toEqual([]);
  });

  it("两边都有同一个人 → 只出现一次", () => {
    expect(presenceUnion(["a"], [{ id: "a", last_seen_at: new Date(now).toISOString() }], now))
      .toEqual(["a"]);
  });
});

describe("sameIds", () => {
  it("同序同元素为真,长度或元素不同为假", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
    expect(sameIds(["a", "b"], ["a", "c"])).toBe(false);
  });
});

// ── 牌局邀请 ────────────────────────────────────────────────────
const INVITE = (over: Partial<InviteRow> = {}): InviteRow => ({
  id: "i1", inviter: "u2", invitee: "me", table_id: "t1", table_name: "夜场",
  status: "pending", created_at: "2026-08-19T00:00:00Z", expires_at: "2026-08-19T00:10:00Z",
  ...over,
});

describe("toGameInvite", () => {
  const profiles = new Map([["u2", P("u2")], ["u3", P("u3")]]);

  it("收到的邀请:peer 是邀请人,direction=incoming", () => {
    expect(toGameInvite("me", INVITE(), profiles)).toMatchObject({
      direction: "incoming", peer: { id: "u2" }, tableId: "t1", tableName: "夜场",
    });
  });

  it("发出的邀请:peer 是被邀请人,direction=outgoing", () => {
    expect(toGameInvite("me", INVITE({ inviter: "me", invitee: "u3" }), profiles))
      .toMatchObject({ direction: "outgoing", peer: { id: "u3" } });
  });

  it("对方 profile 缺席 → null(别渲染幽灵,同 buildSnapshot)", () => {
    expect(toGameInvite("me", INVITE({ inviter: "nobody" }), profiles)).toBeNull();
  });
});

describe("FriendsManager 邀请", () => {
  it("sendInvite 落库后推新的邀请列表", async () => {
    const api = fakeApi({
      listInvites: vi.fn(async () => [INVITE({ inviter: "me", invitee: "u2" })]),
      listProfiles: vi.fn(async () => [P("u2")]),
    });
    const push = mkPush();
    const m = new FriendsManager({ api, push });
    expect(await m.sendInvite("u2", "t1", "夜场")).toEqual({ ok: true, value: null });
    expect(api.insertInvite).toHaveBeenCalledWith("me", "u2", "t1", "夜场");
    expect(push.invitesChanged).toHaveBeenCalledWith([
      expect.objectContaining({ direction: "outgoing", tableId: "t1" }),
    ]);
  });

  it("sendInvite:pending 唯一索引冲突映射成人话", async () => {
    const api = fakeApi({
      insertInvite: vi.fn(async () => { throw Object.assign(new Error("dup"), { code: "23505" }); }),
    });
    const m = new FriendsManager({ api, push: mkPush() });
    expect(await m.sendInvite("u2", "t1", "夜场")).toEqual({ ok: false, message: "已经邀过了,等对方回应" });
  });

  it("respondInvite 只改状态——买入花真 token,由用户在牌桌页再确认(ADR-0027)", async () => {
    const api = fakeApi();
    const m = new FriendsManager({ api, push: mkPush() });
    await m.respondInvite("i1", true);
    expect(api.updateInviteStatus).toHaveBeenCalledWith("i1", "accepted");
    await m.respondInvite("i2", false);
    expect(api.updateInviteStatus).toHaveBeenCalledWith("i2", "declined");
    // FriendsApi 里根本没有买入这种方法:接受邀请不可能顺手把钱花掉
    expect(Object.keys(api)).not.toContain("joinTable");
  });

  it("cancelInvite 走 cancelled", async () => {
    const api = fakeApi();
    await new FriendsManager({ api, push: mkPush() }).cancelInvite("i1");
    expect(api.updateInviteStatus).toHaveBeenCalledWith("i1", "cancelled");
  });
});

// ── 推送健康度与轮询兜底(ADR-0027) ──────────────────────────────
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("FriendsManager 推送兜底", () => {
  function harness(over: Partial<FriendsApi> = {}) {
    let captured: Parameters<FriendsApi["subscribe"]>[1] | null = null;
    const api = fakeApi({
      subscribe: vi.fn((_uid, handlers) => { captured = handlers; return () => {}; }),
      ...over,
    });
    const push = mkPush();
    const timers = fakeTimers();
    const m = new FriendsManager({ api, push, timers });
    return { api, push, timers, m, handlers: () => captured! };
  }

  it("订阅报错 → health degraded,并立刻起一拍轮询把新消息补上", async () => {
    const inbox: MessageRow[] = [{ id: 5, sender: "u2", recipient: "me", body: "hi", created_at: "t" }];
    const h = harness({
      listInboxSince: vi.fn(async (_uid: string, since: number) => inbox.filter((m) => m.id > since)),
    });
    await h.m.start();
    await flush();

    h.handlers().onHealth("degraded");
    await flush();
    expect(h.push.healthChanged).toHaveBeenCalledWith("degraded");
    expect(h.push.directMessage).toHaveBeenCalledWith(
      { id: 5, sender: "u2", recipient: "me", body: "hi", createdAt: "t" });

    // 水位推进:下一拍不该把同一条再推一遍
    h.timers.tick(DEGRADED_POLL_MS);
    await flush();
    expect(h.push.directMessage).toHaveBeenCalledTimes(1);
  });

  it("订阅恢复 → 停轮询(不再打 listInboxSince)", async () => {
    const h = harness();
    await h.m.start();
    await flush();
    h.handlers().onHealth("degraded");
    await flush();
    const polls = (h.api.listInboxSince as ReturnType<typeof vi.fn>).mock.calls.length;

    h.handlers().onHealth("live");
    await flush();
    h.timers.tick(DEGRADED_POLL_MS * 3);
    await flush();
    expect((h.api.listInboxSince as ReturnType<typeof vi.fn>).mock.calls.length).toBe(polls);
    expect(h.push.healthChanged).toHaveBeenLastCalledWith("live");
  });

  it("掉线时清掉 presence 的在线集:连不上的通道报不出谁下线了", async () => {
    const h = harness();
    await h.m.start();
    await flush();
    h.handlers().onPresence(["u2"]);
    expect(h.push.presenceChanged).toHaveBeenLastCalledWith(["u2"]);

    h.handlers().onHealth("degraded");
    await flush();
    expect(h.push.presenceChanged).toHaveBeenLastCalledWith([]);
  });

  it("心跳:start 立刻拍一次,之后每 HEARTBEAT_MS 一拍,并按窗口算在线", async () => {
    const h = harness({
      listFriendships: vi.fn(async () => [
        { id: "f1", requester: "me", addressee: "u2", status: "accepted" } as FriendshipRow,
      ]),
      listProfiles: vi.fn(async () => [P("u2")]),
      listLastSeen: vi.fn(async () => [{ id: "u2", last_seen_at: new Date(0).toISOString() }]),
    });
    await h.m.start();
    await flush();
    expect(h.api.touchPresence).toHaveBeenCalledTimes(1);
    expect(h.push.presenceChanged).toHaveBeenLastCalledWith(["u2"]); // Realtime 没报,心跳报的

    h.timers.tick(HEARTBEAT_MS);
    await flush();
    expect(h.api.touchPresence).toHaveBeenCalledTimes(2);
  });

  it("stop:清掉所有定时器 + 推空邀请与 connecting", async () => {
    const h = harness();
    await h.m.start();
    await flush();
    h.m.stop();
    h.timers.tick(HEARTBEAT_MS * 3);
    await flush();
    expect(h.api.touchPresence).toHaveBeenCalledTimes(1); // 只有 start 那一拍
    expect(h.push.invitesChanged).toHaveBeenLastCalledWith([]);
    expect(h.push.healthChanged).toHaveBeenLastCalledWith("connecting");
  });
});
