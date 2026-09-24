// mobileRoster —— 手机名册那一列（#1356 A1，spec §5.2）。

import { describe, expect, it } from "vitest";
import {
  FIRST_WORD_HINT, GROUP_FACES_WIDTH, filterRosterItems, groupFaceOffsets, rosterItems, rosterTimeLabel,
} from "../../src/shared/mobileRoster.js";
import type { CloudSessionRow } from "../../src/shared/supabaseWorkspacesApi.js";
import type { SessionLast } from "../../src/shared/sessionLast.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string, o: Partial<WorkspaceAgentRow> = {}): WorkspaceAgentRow => ({
  agentId, name, description: "", instructions: "", models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null, ...o,
});
const HOME: WorkspaceSnapshot = {
  id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
  members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [],
  agents: [
    agent("admin", "管理员", { description: "帮你建智能体", createdTs: 500 }),
    agent("a_000000000001", "开发", { description: "写代码", createdTs: 1000, avatarSlot: 5 }),
    agent("a_000000000002", "运维", { description: "部署与监控", createdTs: 2000 }),
  ],
};
const row = (id: string, o: Partial<CloudSessionRow>): CloudSessionRow => ({
  id, title: "", publisherUid: "me", archived: false, updatedTs: 0, participantUids: [], chatKind: null, agentIds: [], ...o,
});
const last = (ts: number, excerpt: string, from: string): SessionLast => ({ ts, excerpt, from });

describe("rosterItems", () => {
  const chats = [
    row("dm-dev", { chatKind: "dm", agentIds: ["a_000000000001"], updatedTs: 3000 }),
    row("g1", { chatKind: "group", agentIds: ["a_000000000002", "a_000000000001"], title: "发版组", updatedTs: 100 }),
  ];
  it("单只与群混在一起，按最近一次动静降序：last_ts → 那一行的 updated_at → 智能体自己的 created_at", () => {
    const lasts = new Map([["dm-dev", last(5000, "门禁绿了", "agent:a_000000000001")], ["g1", last(7000, "edge 部完了", "agent:a_000000000002")]]);
    const items = rosterItems({ home: HOME, chats, lasts, selfUid: "me" });
    expect(items.map((i) => i.key)).toEqual(["group:g1", "agent:a_000000000001", "agent:a_000000000002", "agent:admin"]);
  });
  it("没有 last 时退回那一行的 updated_at（0040 没跑 / 还没人说过话）", () => {
    const items = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" });
    // dm-dev 3000 > 运维 created 2000 > 管理员 created 500 > g1 updated 100
    expect(items.map((i) => i.key)).toEqual(["agent:a_000000000001", "agent:a_000000000002", "agent:admin", "group:g1"]);
  });
  it("同分按名册顺序（单只在前、按名册；群在后）", () => {
    const flat = { ...HOME, agents: HOME.agents.map((a) => ({ ...a, createdTs: 0 })) };
    const items = rosterItems({ home: flat, chats: [row("g1", { chatKind: "group", agentIds: ["admin", "a_000000000001"], updatedTs: 0 })], lasts: new Map(), selfUid: "me" });
    expect(items.map((i) => i.key)).toEqual(["agent:admin", "agent:a_000000000001", "agent:a_000000000002", "group:g1"]);
  });
  it("缺 createdTs 的智能体按 0 排（旧快照），不报错", () => {
    const old = { ...HOME, agents: [agent("admin", "管理员")] };
    expect(rosterItems({ home: old, chats: [], lasts: new Map(), selfUid: "me" })[0]).toMatchObject({ activityTs: 0, timeTs: null });
  });
  it("单只那一行：聊过 = 名字后面小字写职责、第二行写最后一句（不带前缀）、时间是那句话的时刻", () => {
    const lasts = new Map([["dm-dev", last(5000, "门禁绿了", "agent:a_000000000001")]]);
    const dev = rosterItems({ home: HOME, chats, lasts, selfUid: "me" }).find((i) => i.key === "agent:a_000000000001")!;
    expect(dev).toMatchObject({
      kind: "agent", name: "开发", description: "写代码", sessionId: "dm-dev",
      sub: "写代码", line2: "门禁绿了", lastText: "门禁绿了", timeTs: 5000, slot: 5,
    });
  });
  it("没聊过 = 第二行写提示、不画时间", () => {
    const items = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" });
    expect(items.find((i) => i.key === "agent:a_000000000002")).toMatchObject({
      sessionId: null, sub: "部署与监控", line2: FIRST_WORD_HINT, lastText: null, timeTs: null,
    });
    expect(items.find((i) => i.key === "agent:admin")).toMatchObject({ isAdmin: true });
  });
  it("聊过但读不到最后一句（0040 没跑 / 没部署）：职责挪到第二行、第一行不重复写（spec §10 第 9 条），时间退回 updated_at", () => {
    const dev = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "agent:a_000000000001")!;
    expect(dev).toMatchObject({ sub: "", line2: "写代码", lastText: null, timeTs: 3000 });
    const bare = { ...HOME, agents: HOME.agents.map((a) => ({ ...a, description: "" })) };
    expect(rosterItems({ home: bare, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "agent:a_000000000001"))
      .toMatchObject({ sub: "", line2: null });
  });
  it("群那一行：成员名按名册顺序拼、最后一句带「名字：」前缀；人说的写「我」", () => {
    const byAgent = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "edge 部完了", "agent:a_000000000002")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(byAgent).toMatchObject({ kind: "group", name: "发版组", memberNames: "开发、运维", sub: "开发、运维", line2: "运维：edge 部完了", lastText: "运维：edge 部完了", timeTs: 9 });
    const byMe = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "大家看下", "human:me")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(byMe).toMatchObject({ line2: "我：大家看下" });
    const unknown = rosterItems({ home: HOME, chats, lasts: new Map([["g1", last(9, "…", "")]]), selfUid: "me" })
      .find((i) => i.key === "group:g1")!;
    expect(unknown).toMatchObject({ line2: "…" });
  });
  it("群的脸与名字同一个顺序（跟名册走，不跟那一列的写入顺序走）", () => {
    const g = rosterItems({ home: HOME, chats, lasts: new Map(), selfUid: "me" }).find((i) => i.key === "group:g1")!;
    expect(g.kind === "group" && g.agentIds).toEqual(["a_000000000001", "a_000000000002"]);
    expect(g.kind === "group" && g.slots[0]).toBe(5); // 开发挑过坑位 5
  });
});

describe("filterRosterItems", () => {
  const lasts = new Map([["dm-dev", last(5000, "推到 claude/pricing 了", "agent:a_000000000001")]]);
  const items = rosterItems({
    home: HOME,
    chats: [
      row("dm-dev", { chatKind: "dm", agentIds: ["a_000000000001"], updatedTs: 3000 }),
      row("g1", { chatKind: "group", agentIds: ["a_000000000002", "admin"], title: "奶茶店", updatedTs: 1 }),
    ],
    lasts,
    selfUid: "me",
  });
  it("空查询原样返回", () => {
    expect(filterRosterItems(items, "  ")).toHaveLength(items.length);
  });
  it("按名字 / 职责 / 最后一句过滤，拉丁字母不分大小写", () => {
    expect(filterRosterItems(items, "开发").map((i) => i.key)).toEqual(["agent:a_000000000001"]);
    expect(filterRosterItems(items, "部署").map((i) => i.key)).toEqual(["agent:a_000000000002"]);
    expect(filterRosterItems(items, "PRICING").map((i) => i.key)).toEqual(["agent:a_000000000001"]);
  });
  it("群按群名与成员名命中", () => {
    expect(filterRosterItems(items, "奶茶").map((i) => i.key)).toEqual(["group:g1"]);
    expect(filterRosterItems(items, "管理员").map((i) => i.key)).toEqual(expect.arrayContaining(["agent:admin", "group:g1"]));
  });
  it("「点进去跟它说第一句」那句提示不是内容，搜不到", () => {
    expect(filterRosterItems(items, "第一句")).toEqual([]);
  });
});

describe("rosterTimeLabel", () => {
  const now = new Date(2026, 8, 23, 15, 30).getTime(); // 2026-09-23 周三 15:30（本地时间）
  it("一分钟之内写「刚刚」；未来的时间戳（时钟快）也写「刚刚」", () => {
    expect(rosterTimeLabel(now - 30_000, now)).toBe("刚刚");
    expect(rosterTimeLabel(now + 120_000, now)).toBe("刚刚");
  });
  it("同一个自然日写时刻（24 小时制、补零）", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 23, 9, 5).getTime(), now)).toBe("09:05");
  });
  it("往前按自然日：昨天 / 周几 / 几月几日", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 22, 23, 50).getTime(), now)).toBe("昨天");
    expect(rosterTimeLabel(new Date(2026, 8, 20, 10, 0).getTime(), now)).toBe("周日");
    expect(rosterTimeLabel(new Date(2026, 8, 3, 10, 0).getTime(), now)).toBe("9 月 3 日");
  });
});

describe("groupFaceOffsets", () => {
  it("总宽钉死 = m 档单只的宽，左边缘是一条直线；后一张压前一张", () => {
    expect(GROUP_FACES_WIDTH).toBe(59);
    expect(groupFaceOffsets(0)).toEqual([]);
    expect(groupFaceOffsets(1)).toEqual([14.75]);
    expect(groupFaceOffsets(2)).toEqual([0, 29.5]);
    expect(groupFaceOffsets(3)).toEqual([0, 14.75, 29.5]);
    const six = groupFaceOffsets(6);
    expect(six[0]).toBe(0);
    expect(six[5]).toBeCloseTo(29.5);
  });
});
