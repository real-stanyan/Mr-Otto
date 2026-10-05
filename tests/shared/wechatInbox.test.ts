// wechatInbox —— 手机微信式布局（#1386）「聊天」「通讯录」两个页签的纯逻辑。
// 钉的是：四种会话怎么混排、未读怎么判（点 / 条数 / 游标只往前走）、时间怎么写、九宫格怎么排。

import { describe, expect, it } from "vitest";
import type { AgentActivity } from "../../src/shared/agentActivity.js";
import type { DirectMessage, FriendProfile } from "../../src/shared/friends.js";
import type { SessionLast } from "../../src/shared/sessionLast.js";
import type { CloudSessionRow } from "../../src/shared/supabaseWorkspacesApi.js";
import {
  agentFolderSummary, badgeText, cloudUnread, dmPreview, filterInbox, friendName, friendThreads, gridLayout, groupList, inboxRows,
  inboxUnreadChats, initialOf, isHidden, listTimeLabel, markSeen, needsTimeRow, parseSeen, serializeSeen, sortFriends, splitInbox,
  teamChatTitle, timelineTimeLabel, type InboxRow, type SeenState,
} from "../../src/shared/wechatInbox.js";
import { encodeRoomInvite } from "../../src/shared/appRoom.js";
import type { WorkspaceMentionRow } from "../../src/shared/workspaceMentions.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import { assembleGuestChat } from "../../src/shared/chatGuests.js";

const NOW = new Date(2026, 8, 27, 15, 30).getTime(); // 周日
const MIN = 60_000;
const agent = (agentId: string, name: string, extra: Partial<WorkspaceAgentRow> = {}): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null, ...extra,
});
const HOME: WorkspaceSnapshot = {
  id: "home", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "文案", { description: "写小红书" }), agent("a_000000000002", "客服")],
};
const TEAM: WorkspaceSnapshot = {
  id: "t1", name: "山茶小铺", ownerUid: "u_xh", kind: "team", sandboxApproval: "ask",
  members: [
    { uid: "u_xh", role: "owner", label: "小红", avatarUrl: "data:image/png;base64,AA" },
    { uid: "me", role: "member", label: "Stan", avatarUrl: "" },
  ],
  connectors: [], sessions: [], agents: [agent("admin", "值班")],
};
const row = (o: Partial<CloudSessionRow> & { id: string }): CloudSessionRow => ({
  title: "", publisherUid: "me", archived: false, updatedTs: 0, participantUids: [], chatKind: null, agentIds: [], ...o,
});
const last = (ts: number, from: string, excerpt: string): SessionLast => ({ ts, from, excerpt });
const SEEN: SeenState = { baselineTs: NOW - 60 * MIN, marks: new Map() };
const profile = (id: string, name: string, email = `${id}@x.com`): FriendProfile => ({ id, name, email, avatarUrl: "" });
const msg = (id: number, sender: string, recipient: string, body: string, ts: number): DirectMessage => ({
  id, sender, recipient, body, createdAt: new Date(ts).toISOString(),
});

describe("时间", () => {
  it("列表那格：今天写钟点、昨天、一周内星期几、再早月/日、跨年带年份", () => {
    expect(listTimeLabel(NOW - 10 * MIN, NOW)).toBe("15:20");
    expect(listTimeLabel(NOW - 24 * 60 * MIN, NOW)).toBe("昨天");
    expect(listTimeLabel(new Date(2026, 8, 23, 9, 0).getTime(), NOW)).toBe("星期三");
    expect(listTimeLabel(new Date(2026, 7, 1, 9, 0).getTime(), NOW)).toBe("8/1");
    expect(listTimeLabel(new Date(2025, 11, 31, 9, 0).getTime(), NOW)).toBe("2025/12/31");
    // 未来的时间戳（本机时钟被调过）按今天算
    expect(listTimeLabel(NOW + 5 * MIN, NOW)).toBe("15:35");
  });
  it("时间线那条：今天只写钟点，别的日子加上日子", () => {
    expect(timelineTimeLabel(NOW - 10 * MIN, NOW)).toBe("15:20");
    expect(timelineTimeLabel(new Date(2026, 8, 26, 21, 4).getTime(), NOW)).toBe("昨天 21:04");
  });
  it("隔 5 分钟以上才插一条", () => {
    expect(needsTimeRow(null, NOW)).toBe(true);
    expect(needsTimeRow(NOW, NOW + 5 * MIN)).toBe(false);
    expect(needsTimeRow(NOW, NOW + 5 * MIN + 1)).toBe(true);
  });
});

describe("头像", () => {
  it("九宫格：1 格一列、2~4 两列、5~9 三列；不满的那一行在最上面；超过 9 格只摆 9", () => {
    expect(gridLayout(1, 48).rows).toEqual([1]);
    expect(gridLayout(3, 48).rows).toEqual([1, 2]);
    expect(gridLayout(4, 48).rows).toEqual([2, 2]);
    expect(gridLayout(5, 48).rows).toEqual([2, 3]);
    expect(gridLayout(12, 48).rows).toEqual([3, 3, 3]);
    expect(gridLayout(0, 48).rows).toEqual([]);
    const g = gridLayout(4, 48);
    expect(g.pad * 2 + g.cell * 2 + g.gap).toBeCloseTo(48);
  });
  it("首字：拉丁字母大写、emoji 不劈成两半、空名字给问号", () => {
    expect(initialOf("stan")).toBe("S");
    expect(initialOf(" 小红")).toBe("小");
    expect(initialOf("😀ok")).toBe("😀");
    expect(initialOf("  ")).toBe("?");
  });
  it("角标超过 99 写 99+", () => {
    expect(badgeText(7)).toBe("7");
    expect(badgeText(100)).toBe("99+");
  });
});

describe("inboxRows", () => {
  const chats = [
    row({ id: "dm1", chatKind: "dm", agentIds: ["a_000000000001"], updatedTs: NOW - 300 * MIN }),
    row({ id: "grp1", chatKind: "group", agentIds: ["admin", "a_000000000002"], title: "", updatedTs: NOW - 200 * MIN }),
  ];
  const lasts = new Map([
    ["dm1", last(NOW - 5 * MIN, "agent:a_000000000001", "短的那版改好了")],
    ["grp1", last(NOW - 90 * MIN, "human:me", "周三晚上开卖")],
  ]);
  const teamSessions = [
    row({ id: "ts1", title: "周末摆摊", updatedTs: NOW - 400 * MIN }),
    row({ id: "ts2", title: "旧的", archived: true }),
  ];
  const teamLasts = new Map([["ts1", last(NOW - 30 * MIN, "human:u_xh", "@Stan 帮我看下")]]);
  const base = {
    selfUid: "me",
    home: { ws: HOME, chats, lasts },
    teams: [{ ws: TEAM, sessions: teamSessions, lasts: teamLasts }],
    friends: [
      { profile: profile("u_aj", "阿杰"), last: msg(9, "u_aj", "me", "周末\n我来帮忙", NOW - 10 * MIN), unread: 2 },
      { profile: profile("u_lw", "老王"), last: null, unread: 0 },
    ],
    mentions: [] as WorkspaceMentionRow[],
    seen: SEEN,
    openKey: null,
  };

  it("免打扰（#1442）：未读数换成点、打上 muted；角标只在被 @ 时算它", () => {
    const rows = inboxRows({ ...base, muted: new Set(["f:u_aj", "t:ts1"]) });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("f:u_aj").unread).toEqual({ kind: "dot" });
    expect(by("f:u_aj").muted).toBe(true);
    expect(by("a:a_000000000001").muted).toBeUndefined();
    const plain = inboxRows(base);
    expect(inboxUnreadChats(rows)).toBe(inboxUnreadChats(plain) - [by("f:u_aj"), by("t:ts1")].filter((r) => r.unread !== null).length);
    const mentioned = rows.map((r) => (r.key === "t:ts1" ? { ...r, mention: true } : r));
    expect(inboxUnreadChats(mentioned)).toBe(inboxUnreadChats(rows) + 1);
  });
  it("四种混排、按最近一句降序；没聊过的智能体与没消息的朋友不进来；归档的团队会话不进来", () => {
    const rows = inboxRows(base);
    expect(rows.map((r) => r.key)).toEqual(["a:a_000000000001", "f:u_aj", "t:ts1", "g:grp1"]);
  });
  it("第二行：私聊不带名字；群里别人说的带「名字: 」、我说的不带；朋友私聊压平空白", () => {
    const rows = inboxRows(base);
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("a:a_000000000001").preview).toBe("短的那版改好了");
    expect(by("t:ts1").preview).toBe("小红: @Stan 帮我看下");
    expect(by("g:grp1").preview).toBe("周三晚上开卖");
    expect(by("f:u_aj").preview).toBe("周末 我来帮忙");
  });
  it("标题：群没起名用成员名拼（名册顺序）；团队群用会话标题、没有时退回团队名", () => {
    const rows = inboxRows(base);
    expect(rows.find((r) => r.key === "g:grp1")!.title).toBe("管理员、客服");
    expect(rows.find((r) => r.key === "t:ts1")!.title).toBe("周末摆摊");
    expect(teamChatTitle(TEAM, row({ id: "x", title: "  " }))).toBe("山茶小铺");
  });
  it("未读：云会话一枚点（晚于游标且不是我说的）；朋友私聊是条数；开着的那条不画", () => {
    const rows = inboxRows(base);
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("a:a_000000000001").unread).toEqual({ kind: "dot" });
    expect(by("t:ts1").unread).toEqual({ kind: "dot" });
    expect(by("g:grp1").unread).toBeNull(); // 我说的
    expect(by("f:u_aj").unread).toEqual({ kind: "count", n: 2 });
    const open = inboxRows({ ...base, openKey: "f:u_aj" });
    expect(open.find((r) => r.key === "f:u_aj")!.unread).toBeNull();
    expect(inboxUnreadChats(rows)).toBe(3);
  });
  it("游标还没读出来：一律不画点（说不清就不画）", () => {
    const rows = inboxRows({ ...base, seen: null });
    expect(rows.filter((r) => r.unread?.kind === "dot")).toEqual([]);
  });
  it("@ 了我、还没看：团队群那一行带标记，也算一条有新消息的聊天", () => {
    const mention: WorkspaceMentionRow = {
      workspaceId: "t1", sessionId: "ts1", seq: 3, uid: "me", fromUid: "u_xh", fromLabel: "小红", excerpt: "", createdTs: NOW, read: false,
    };
    const rows = inboxRows({ ...base, mentions: [mention], seen: { baselineTs: NOW, marks: new Map() } });
    expect(rows.find((r) => r.key === "t:ts1")!.mention).toBe(true);
    expect(inboxUnreadChats(rows)).toBe(2); // ts1 的 @ + 阿杰的两条
    expect(inboxRows({ ...base, mentions: [{ ...mention, read: true }] }).find((r) => r.key === "t:ts1")!.mention).toBe(false);
  });
  it("团队群的头像：别的人 + 团队的智能体（我不在拼图里）", () => {
    const rows = inboxRows(base);
    const av = rows.find((r) => r.key === "t:ts1")!.avatar;
    expect(av.kind).toBe("grid");
    expect(av.kind === "grid" ? av.cells.map((c) => (c.kind === "face" ? c.id : c.name)) : []).toEqual(["小红", "admin"]);
  });
  it("搜索：按标题 / 成员名 / 最后一句，不分大小写", () => {
    const rows = inboxRows(base);
    expect(filterInbox(rows, "山茶").map((r) => r.key)).toEqual(["t:ts1"]);
    expect(filterInbox(rows, "小红").map((r) => r.key)).toEqual(["a:a_000000000001", "t:ts1"]); // 文案的职责里也有「小红」
    expect(filterInbox(rows, "客服").map((r) => r.key)).toEqual(["g:grp1"]);
    expect(filterInbox(rows, "  ").length).toBe(rows.length);
    expect(filterInbox(rows, "U_AJ@X").map((r) => r.key)).toEqual(["f:u_aj"]);
  });
  it("状态（#1282）：私聊那格脸带状态、行带 activity；群里每格各带各的、行取最要紧；闲着 / 不知道不带", () => {
    const look = (sid: string, aid: string): AgentActivity | null =>
      sid === "dm1" && aid === "a_000000000001" ? "working"
      : sid === "grp1" && aid === "admin" ? "idle"
      : sid === "grp1" && aid === "a_000000000002" ? "waiting"
      : null;
    const rows = inboxRows({ ...base, activity: look });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("a:a_000000000001").avatar).toMatchObject({ kind: "face", id: "a_000000000001", state: "working" });
    expect(by("a:a_000000000001").activity).toBe("working");
    const grid = by("g:grp1").avatar;
    expect(grid.kind === "grid" ? grid.cells.map((c) => (c.kind === "face" ? c.state ?? "plain" : c.name)) : []).toEqual(["plain", "waiting"]);
    expect(by("g:grp1").activity).toBe("waiting");
    expect(by("t:ts1").activity).toBeUndefined();
    expect("activity" in by("f:u_aj")).toBe(false);
  });
  it("左滑删除（#1566）：删时记下最近一句的时刻，之后没新话就藏着、有新话再冒出来；角标跟着不数它", () => {
    const plain = inboxRows(base);
    const hidden = new Map([["a:a_000000000001", NOW - 5 * MIN], ["f:u_aj", NOW - 30 * MIN]]);
    const rows = inboxRows({ ...base, hidden });
    // 文案那条删时就是最近一句（NOW-5m）→ 藏；阿杰那条删了之后又来了一句（NOW-10m > NOW-30m）→ 冒出来
    expect(rows.map((r) => r.key)).toEqual(["f:u_aj", "t:ts1", "g:grp1"]);
    expect(inboxUnreadChats(rows)).toBe(inboxUnreadChats(plain) - 1);
    expect(isHidden(hidden, "a:a_000000000001", NOW - 5 * MIN)).toBe(true);
    expect(isHidden(hidden, "a:a_000000000001", NOW)).toBe(false);
    expect(isHidden(hidden, "nope", 0)).toBe(false);
  });
  it("splitInbox（#1566）：主页只留人↔人与群；我的智能体一份、别人的智能体（外联）一份；各自保持顺序", () => {
    const rows = inboxRows(base);
    const outreach: InboxRow = { ...rows[0]!, key: "o:x", target: { kind: "outreach", workspaceId: "w", sessionId: "x" }, title: "运维", owner: { kind: "person", name: "小红", url: "" }, ts: NOW - MIN, preview: "周五来吗" };
    const s = splitInbox([outreach, ...rows]);
    expect(s.main.map((r) => r.key)).toEqual(["f:u_aj", "t:ts1", "g:grp1"]);
    expect(s.agents.map((r) => r.key)).toEqual(["a:a_000000000001"]);
    expect(s.others.map((r) => r.key)).toEqual(["o:x"]);
    const sum = agentFolderSummary(s.agents, s.others);
    expect(sum).toEqual({ unread: 2, mention: false, preview: "小红 的 运维: 周五来吗", ts: NOW - MIN });
    expect(agentFolderSummary([], [])).toEqual({ unread: 0, mention: false, preview: "", ts: 0 });
  });
  it("不给查状态的函数：输出与改动前逐字相同（脸上没有 state、行上没有 activity）", () => {
    const rows = inboxRows(base);
    expect(rows.some((r) => "activity" in r)).toBe(false);
    for (const r of rows) {
      const cells = r.avatar.kind === "grid" ? r.avatar.cells : [r.avatar];
      expect(cells.some((c) => "state" in c)).toBe(false);
    }
  });
});

describe("未读游标", () => {
  it("没有游标的按 baseline 算；我说的永远不算", () => {
    expect(cloudUnread(last(NOW, "agent:x", "hi"), "a:x", SEEN, "me")).toBe(true);
    expect(cloudUnread(last(NOW - 90 * MIN, "agent:x", "hi"), "a:x", SEEN, "me")).toBe(false);
    expect(cloudUnread(last(NOW, "human:me", "hi"), "a:x", SEEN, "me")).toBe(false);
    expect(cloudUnread(undefined, "a:x", SEEN, "me")).toBe(false);
  });
  it("看过了只往前走：晚到的旧 ts 不许把游标拨回去", () => {
    const s1 = markSeen(SEEN, "a:x", NOW);
    expect(s1.marks.get("a:x")).toBe(NOW);
    expect(markSeen(s1, "a:x", NOW - MIN)).toBe(s1);
    expect(markSeen(SEEN, "a:x", NOW - 90 * MIN)).toBe(SEEN); // 比 baseline 还早：不写
  });
  it("落盘来回一遍不变；写坏了回 null（调用方拿 now 重新开始）", () => {
    const s = markSeen(SEEN, "f:u", NOW);
    expect(parseSeen(serializeSeen(s))).toEqual(s);
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen("{")).toBeNull();
    expect(parseSeen(JSON.stringify({ marks: {} }))).toBeNull();
    expect(parseSeen(JSON.stringify({ baselineTs: 1, marks: { a: "x", b: 2 } }))!.marks).toEqual(new Map([["b", 2]]));
  });
});

describe("朋友", () => {
  it("称呼：没起名退回邮箱 @ 前面，再没有 uid 前 8 位", () => {
    expect(friendName(profile("u1", "  阿杰 "))).toBe("阿杰");
    expect(friendName(profile("u1", "", "lw@x.com"))).toBe("lw");
    expect(friendName({ id: "abcdefghij", name: "", email: "", avatarUrl: "" })).toBe("abcdefgh");
  });
  it("每位朋友：最后一条是 id 最大的；未读只数对方发来的、晚于游标的；重复的只算一次；不是朋友的不进来", () => {
    const threads = friendThreads({
      selfUid: "me",
      friends: [profile("u_aj", "阿杰"), profile("u_lw", "老王")],
      messages: [
        msg(1, "u_aj", "me", "旧的", NOW - 120 * MIN),
        msg(3, "u_aj", "me", "新的一", NOW - 5 * MIN),
        msg(3, "u_aj", "me", "新的一", NOW - 5 * MIN),
        msg(4, "me", "u_aj", "我回的", NOW - 4 * MIN),
        msg(5, "u_x", "me", "陌生人", NOW),
      ],
      seen: SEEN,
    });
    expect(threads.map((t) => [t.profile.id, t.last?.id ?? null, t.unread])).toEqual([["u_aj", 4, 1], ["u_lw", null, 0]]);
  });
  it("第二行：普通话压平空白；分享会话的信封写成「[会话分享] 标题」，不摊开 JSON（里面有邀请码）", () => {
    expect(dmPreview("周末\n 我来")).toBe("周末 我来");
    const env = JSON.stringify({ otto: "otto.session-share", v: 1, bucket: "b", prefix: "p", message: "", title: "排班", eventCount: 3, invite: "otto-proxy:SECRET" });
    expect(dmPreview(env)).toBe("[会话分享] 排班");
    expect(dmPreview(env)).not.toContain("SECRET");
    // 名片（#1524）：只写名字，不摊开提示词
    const card = JSON.stringify({ otto: "otto.contact-card", v: 1, card: { kind: "agent", agentId: "a_0123456789ab", name: "翻译", description: "", instructions: "秘密提示词", avatarSlot: null, from: { uid: "22222222-2222-4222-8222-222222222222", name: "小红" } } });
    expect(dmPreview(card)).toBe("[智能体名片] 翻译");
    expect(dmPreview(card)).not.toContain("秘密");
  });
  it("邀请卡（#1675）：列表第二行是 [邀请]，不是 [应用]", () => {
    const card = { appId: "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b", version: 1, name: "五子棋", icon: "⚫", slug: "gomoku", description: "", from: { uid: "2819d0bb-933b-499d-be44-2bb51b5a8391", name: "S" } };
    expect(dmPreview(encodeRoomInvite(card, { id: "11111111-2222-4333-8444-555555555555", title: "局" }))).toBe("[邀请] ⚫ 五子棋");
  });
  it("按名字排", () => {
    const list = sortFriends([{ profile: profile("b", "王") }, { profile: profile("a", "阿杰") }]);
    expect(list.map((f) => f.profile.id)).toEqual(["a", "b"]);
  });
});

describe("groupList", () => {
  it("主场的群 + 团队群（归档的不列），成员名拼成一行", () => {
    const list = groupList({
      selfUid: "me",
      home: { ws: HOME, chats: [row({ id: "g1", chatKind: "group", agentIds: ["a_000000000002", "admin"] })], lasts: new Map() },
      teams: [{ ws: TEAM, sessions: [row({ id: "ts1", title: "摆摊" }), row({ id: "ts2", archived: true })], lasts: new Map() }],
    });
    expect(list.map((g) => [g.key, g.title, g.members])).toEqual([
      ["g:g1", "管理员、客服", "管理员、客服"],
      ["t:ts1", "摆摊", "小红、值班"],
    ]);
  });
});

// ── #1393：你的智能体和朋友在同一个群里 ────────────────────────────────────────
describe("有朋友的群（#1393）", () => {
  // 我（me）是客人：小红（u_xh）主场里的一条群，里面还有阿杰（u_aj）和小红的一只智能体
  const guest = assembleGuestChat({
    row: {
      id: "gs1", workspace_id: "home-of-xh", publisher_uid: "u_xh", title: "", archived: false, updated_at: new Date(NOW - 500 * MIN).toISOString(),
      agent_ids: ["a_x1"], last_ts: new Date(NOW - 2 * MIN).toISOString(), last_excerpt: "明早八点出发", last_from: "human:u_aj",
    },
    agents: [agent("a_x1", "向导")],
    humans: [{ uid: "me", name: "Stan", avatarUrl: "" }, { uid: "u_aj", name: "阿杰", avatarUrl: "data:aj" }],
    owner: { uid: "u_xh", name: "小红", avatarUrl: "data:xh" },
  });
  // 我是群主：我主场里的一条群，拉了阿杰
  const mine = row({
    id: "grp2", chatKind: "group", agentIds: ["a_000000000001"], title: "周三开卖", updatedTs: NOW - 100 * MIN,
    humans: [{ uid: "u_aj", name: "阿杰", avatarUrl: "data:aj" }],
  });
  const lasts = new Map([["grp2", last(NOW - 20 * MIN, "human:u_aj", "我来写文案")]]);
  const base = {
    selfUid: "me",
    home: { ws: HOME, chats: [mine], lasts },
    teams: [],
    guests: [guest],
    friends: [],
    mentions: [] as WorkspaceMentionRow[],
    seen: SEEN,
    openKey: null,
  };

  it("别人拉我进去的群：`j:` 一行，去处带群主的主场；拼图是群主 + 别的客人 + 智能体（不含我）", () => {
    const r = inboxRows(base).find((x) => x.key === "j:gs1")!;
    expect(r.target).toEqual({ kind: "guest", workspaceId: "home-of-xh", sessionId: "gs1" });
    expect(r.avatar).toEqual({
      kind: "grid",
      cells: [
        { kind: "person", name: "小红", url: "data:xh" },
        { kind: "person", name: "阿杰", url: "data:aj" },
        { kind: "face", id: "a_x1", slot: expect.any(Number) },
      ],
    });
    // 没起名：智能体的名字、再是人的名字（不含我）
    expect(r.title).toBe("向导、小红、阿杰");
    expect(r.preview).toBe("阿杰: 明早八点出发");
    expect(r.unread).toEqual({ kind: "dot" });
  });

  it("我主场里的群：拉进来的朋友进拼图、「名字: 」认得他、搜得到他", () => {
    const r = inboxRows(base).find((x) => x.key === "g:grp2")!;
    expect(r.avatar).toEqual({
      kind: "grid",
      cells: [{ kind: "person", name: "阿杰", url: "data:aj" }, { kind: "face", id: "a_000000000001", slot: expect.any(Number) }],
    });
    expect(r.preview).toBe("阿杰: 我来写文案");
    expect(filterInbox([r], "阿杰")).toHaveLength(1);
  });

  it("群里有人 @ 了我：客人那一侧照样亮标记；开着的那一条不亮", () => {
    const mentions = [{ sessionId: "gs1", read: false } as WorkspaceMentionRow];
    expect(inboxRows({ ...base, mentions }).find((x) => x.key === "j:gs1")!.mention).toBe(true);
    expect(inboxRows({ ...base, mentions, openKey: "j:gs1" }).find((x) => x.key === "j:gs1")!.mention).toBe(false);
  });

  it("归档了的不列；群聊那一页也有它", () => {
    const archived = { ...guest, session: { ...guest.session, archived: true } };
    expect(inboxRows({ ...base, guests: [archived] }).some((x) => x.key === "j:gs1")).toBe(false);
    const list = groupList({ selfUid: "me", home: { ws: HOME, chats: [mine], lasts }, teams: [], guests: [guest] });
    expect(list.map((g) => [g.key, g.title, g.members])).toEqual([
      ["g:grp2", "周三开卖", "文案、阿杰"],
      ["j:gs1", "向导、小红、阿杰", "小红、阿杰、向导"],
    ]);
  });

  it("不带 guests：列表与改动前逐条相同（缺席 = 没有）", () => {
    const { guests: _g, ...rest } = base;
    expect(inboxRows(rest).map((x) => x.key)).toEqual(["g:grp2"]);
  });
});

describe("外联会话（#1441）", () => {
  // 我（me）是被打电话的朋友：小红（u_xh）主场里的一条外联会话，里面只有她的一只智能体「运维」
  const outreachGuest = {
    ...assembleGuestChat({
      row: {
        id: "os1", workspace_id: "home-of-xh", publisher_uid: "u_xh", title: "", archived: false, updated_at: new Date(NOW - 30 * MIN).toISOString(),
        agent_ids: ["a_x1"], last_ts: new Date(NOW - 5 * MIN).toISOString(), last_excerpt: "周五来吗", last_from: "agent:a_x1",
      },
      agents: [agent("a_x1", "运维", { avatarSlot: 3 })],
      humans: [{ uid: "me", name: "Stan", avatarUrl: "" }],
      owner: { uid: "u_xh", name: "小红", avatarUrl: "data:xh" },
    }),
    outreach: true as const,
  };
  const base = { selfUid: "me", home: null, teams: [], guests: [outreachGuest], friends: [], mentions: [] as WorkspaceMentionRow[], seen: SEEN, openKey: null };

  it("好友那一侧：一行，名字是智能体自己的「运维」、主人另给一枚药丸（#1641），头像是那只的脸，第二行照旧是最后一句", () => {
    const r = inboxRows(base).find((x) => x.key === "o:os1")!;
    expect(r.title).toBe("运维");
    expect(r.owner).toEqual({ kind: "person", name: "小红", url: "data:xh" });
    expect(r.target).toEqual({ kind: "outreach", workspaceId: "home-of-xh", sessionId: "os1" });
    expect(r.avatar).toEqual({ kind: "face", id: "a_x1", slot: expect.any(Number) });
    expect(r.preview).toBe("周五来吗");
    expect(r.unread).toEqual({ kind: "dot" });
    expect(filterInbox([r], "运维")).toHaveLength(1);
    expect(filterInbox([r], "小红")).toHaveLength(1);
  });
  it("不进「群聊」那一页，也不占 j: 的键", () => {
    expect(groupList({ selfUid: "me", home: null, teams: [], guests: [outreachGuest] })).toEqual([]);
    expect(inboxRows(base).some((x) => x.key === "j:os1")).toBe(false);
  });
  it("归档了的不列", () => {
    const archived = { ...outreachGuest, session: { ...outreachGuest.session, archived: true } };
    expect(inboxRows({ ...base, guests: [archived] })).toEqual([]);
  });
  it("主人那一侧：主场清单里那一行 chat_kind 读不成 dm / group，不进列表", () => {
    const owner = {
      ...base, selfUid: "u_xh", guests: [],
      home: { ws: { ...HOME, ownerUid: "u_xh" }, chats: [row({ id: "os1", chatKind: null, agentIds: [] })], lasts: new Map([["os1", last(NOW - MIN, "agent:a_x1", "周五来吗")]]) },
    };
    expect(inboxRows(owner).some((x) => x.key.endsWith("os1"))).toBe(false);
  });
});
