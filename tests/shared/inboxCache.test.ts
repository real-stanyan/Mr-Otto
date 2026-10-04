// inboxCache —— 聊天列表的本机快照（#1471）：往返相同、账号 / 版本对不上不用、朋友最近消息封顶。
import { describe, expect, it } from "vitest";
import { RECENT_MAX, decodeInboxCache, encodeInboxCache, inboxCacheKey, type InboxCacheData } from "../../src/shared/inboxCache.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws = { id: "w1", name: "我的智能体", ownerUid: "u1", members: [], connectors: [], sessions: [], agents: [], sandboxApproval: null } as WorkspaceSnapshot;
const data: InboxCacheData<{ id: string }> = {
  home: { home: ws, chats: [], lasts: new Map([["s1", { ts: 5, excerpt: "好了", from: "agent:admin" }]]) as never },
  teams: { teams: [{ ws, sessions: [], lasts: new Map() }], guests: [], mentions: [] },
  friends: { rows: [{ id: "f1" }], recent: [{ id: 1, sender: "a", recipient: "u1", body: "hi", createdAt: "2026-10-04T00:00:00Z" }] },
};

describe("inboxCache", () => {
  it("往返：Map 还原成 Map，其余原样", () => {
    const back = decodeInboxCache<{ id: string }>(encodeInboxCache("u1", data, 1), "u1")!;
    expect(back.home!.lasts.get("s1")).toEqual({ ts: 5, excerpt: "好了", from: "agent:admin" });
    expect(back.home!.home).toEqual(ws);
    expect(back.teams!.teams[0]!.lasts).toBeInstanceOf(Map);
    expect(back.friends).toEqual(data.friends);
  });
  it("三份都可以缺（null）", () => {
    const back = decodeInboxCache(encodeInboxCache("u1", { home: null, teams: null, friends: null }, 1), "u1");
    expect(back).toEqual({ home: null, teams: null, friends: null });
  });
  it("别的账号 / 读不出 / 空：null", () => {
    expect(decodeInboxCache(encodeInboxCache("u1", data, 1), "u2")).toBeNull();
    expect(decodeInboxCache("{nope", "u1")).toBeNull();
    expect(decodeInboxCache(null, "u1")).toBeNull();
    expect(decodeInboxCache(JSON.stringify({ v: 999, uid: "u1" }), "u1")).toBeNull();
  });
  it("形状不对：null（不画半份）", () => {
    const raw = JSON.parse(encodeInboxCache("u1", data, 1)) as Record<string, unknown>;
    raw.home = { home: null, chats: "x", lasts: [] };
    expect(decodeInboxCache(JSON.stringify(raw), "u1")).toBeNull();
  });
  it("朋友最近消息只留最新的 RECENT_MAX 条", () => {
    const recent = Array.from({ length: RECENT_MAX + 50 }, (_, i) => ({ id: i, sender: "a", recipient: "u1", body: "x", createdAt: "2026-10-04T00:00:00Z" }));
    const back = decodeInboxCache(encodeInboxCache("u1", { home: null, teams: null, friends: { rows: [], recent } }, 1), "u1")!;
    expect(back.friends!.recent).toHaveLength(RECENT_MAX);
    expect(Math.min(...back.friends!.recent.map((m) => m.id))).toBe(50);
  });
  it("键按账号分", () => {
    expect(inboxCacheKey("u1")).not.toBe(inboxCacheKey("u2"));
  });
});
