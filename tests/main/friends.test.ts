import { describe, it, expect, vi } from "vitest";
import {
  toFriendProfile, buildSnapshot, presenceUnion, sameIds, FriendsManager, workspaceUnion,
  DEGRADED_POLL_MS, HEARTBEAT_MS,
  type FriendsApi, type FriendsTimers, type FriendshipRow,
  type MessageRow, type ProfileRow,
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
    searchProfiles: vi.fn(async () => []),
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
    trackWorkspace: vi.fn(),
    listLastSeen: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    ...over,
  };
}

/** 每个用例一份新的 push spy(共享一份会让调用次数跨用例累加) */
function mkPush() {
  return {
    friendsChanged: vi.fn(), presenceChanged: vi.fn(), workspacesChanged: vi.fn(), directMessage: vi.fn(),
    healthChanged: vi.fn(),
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
  it("search:模糊命中回 FriendProfile 列表,自己被过滤(uid=me)", async () => {
    const api = fakeApi({ searchProfiles: vi.fn(async () => [P("me"), P("u2", "hit@x.com")]) });
    const m = new FriendsManager({ api, push: noPush });
    expect(await m.search("hit")).toEqual({
      ok: true, value: [{ id: "u2", email: "hit@x.com", name: "U2", avatarUrl: "" }],
    });
  });

  it("search:没有匹配 = ok:true value:[](不是错误)", async () => {
    const m = new FriendsManager({ api: fakeApi(), push: noPush });
    expect(await m.search("none")).toEqual({ ok: true, value: [] });
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
    captured!.onPresence([{ id: "u2", workspace: null }]);
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

// ── 好友在哪:两条腿并集(issue #167) ─────────────────────────────
describe("workspaceUnion", () => {
  const W = { repoKey: "k1", branch: "feat" };
  const now = 100_000;

  it("Realtime meta 带工作区 → 直接用", () => {
    expect(workspaceUnion([{ id: "u2", workspace: W }], [], now))
      .toEqual([{ userId: "u2", repoKey: "k1", branch: "feat" }]);
  });

  it("Realtime 在线但没 meta(老客户端)→ 退回心跳列", () => {
    const seen = [{ id: "u2", last_seen_at: new Date(now - 1000).toISOString(), repo_key: "k1", repo_branch: "main" }];
    expect(workspaceUnion([{ id: "u2", workspace: null }], seen, now))
      .toEqual([{ userId: "u2", repoKey: "k1", branch: "main" }]);
  });

  it("两腿都有时 Realtime 赢(更新)", () => {
    const seen = [{ id: "u2", last_seen_at: new Date(now).toISOString(), repo_key: "k1", repo_branch: "old" }];
    expect(workspaceUnion([{ id: "u2", workspace: W }], seen, now)[0]!.branch).toBe("feat");
  });

  it("心跳过窗口 / 没 repo_key / 没跑 0008 的库(列缺席)→ 不出现", () => {
    const stale = [{ id: "a", last_seen_at: new Date(now - 200_000).toISOString(), repo_key: "k", repo_branch: "x" }];
    const noRepo = [{ id: "b", last_seen_at: new Date(now).toISOString(), repo_key: null, repo_branch: null }];
    const noCols = [{ id: "c", last_seen_at: new Date(now).toISOString() }];
    expect(workspaceUnion([], [...stale, ...noRepo, ...noCols], now)).toEqual([]);
  });

  it("detached HEAD:branch null 照样报(人在仓库里,只是不在分支上)", () => {
    expect(workspaceUnion([{ id: "u", workspace: { repoKey: "k", branch: null } }], [], now))
      .toEqual([{ userId: "u", repoKey: "k", branch: null }]);
  });

  it("按 userId 排序,输出稳定", () => {
    const r = workspaceUnion([{ id: "b", workspace: W }, { id: "a", workspace: W }], [], now);
    expect(r.map((x) => x.userId)).toEqual(["a", "b"]);
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
    h.handlers().onPresence([{ id: "u2", workspace: null }]);
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

  it("setWorkspace:两条腿立刻更新 —— 重 track + 提前一拍心跳带上工作区,并推 mine", async () => {
    const h = harness();
    await h.m.start();
    await flush();
    expect(h.api.touchPresence).toHaveBeenLastCalledWith("me", null);

    const ws = { repoKey: "k1", branch: "feat" };
    h.m.setWorkspace(ws);
    await flush();
    expect(h.api.trackWorkspace).toHaveBeenLastCalledWith(ws);
    expect(h.api.touchPresence).toHaveBeenCalledTimes(2);
    expect(h.api.touchPresence).toHaveBeenLastCalledWith("me", ws);
    expect(h.push.workspacesChanged).toHaveBeenLastCalledWith({ mine: ws, friends: [] });

    // 同一个工作区再报一次:什么都不发生(watcher 会抖)
    h.m.setWorkspace({ ...ws });
    await flush();
    expect(h.api.touchPresence).toHaveBeenCalledTimes(2);
  });

  it("好友工作区:Realtime 通道是全站的,只放行好友;心跳腿照 listLastSeen 来", async () => {
    const h = harness({
      listFriendships: vi.fn(async () => [
        { id: "f1", requester: "me", addressee: "u2", status: "accepted" } as FriendshipRow,
      ]),
      listProfiles: vi.fn(async () => [P("u2")]),
      listLastSeen: vi.fn(async () => [
        { id: "u2", last_seen_at: new Date(0).toISOString(), repo_key: "k1", repo_branch: "main" },
      ]),
    });
    await h.m.start();
    await flush();
    // 心跳腿:u2 在 k1/main
    expect(h.push.workspacesChanged).toHaveBeenLastCalledWith({
      mine: null, friends: [{ userId: "u2", repoKey: "k1", branch: "main" }],
    });
    // Realtime 报来陌生人 u9 带工作区 → 不放行;u2 的 meta 盖过心跳
    h.handlers().onPresence([
      { id: "u2", workspace: { repoKey: "k1", branch: "feat" } },
      { id: "u9", workspace: { repoKey: "k1", branch: "spy" } },
    ]);
    expect(h.push.workspacesChanged).toHaveBeenLastCalledWith({
      mine: null, friends: [{ userId: "u2", repoKey: "k1", branch: "feat" }],
    });
  });

  it("stop:清掉所有定时器 + 推 connecting", async () => {
    const h = harness();
    await h.m.start();
    await flush();
    h.m.stop();
    h.timers.tick(HEARTBEAT_MS * 3);
    await flush();
    expect(h.api.touchPresence).toHaveBeenCalledTimes(1); // 只有 start 那一拍
    expect(h.push.healthChanged).toHaveBeenLastCalledWith("connecting");
  });
});
