import { describe, expect, it } from "vitest";
import {
  inboxKeyOf, liveLastOf, mergeRecentDm, newerLast, openInboxKey, restoreSeen, seenStorageKey, RECENT_DM_CAP,
} from "../../src/renderer/src/lib/wxInbox.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { DirectMessage } from "../../src/shared/friends.js";
import type { GuestChat } from "../../src/shared/chatGuests.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const home = { id: "home-1", kind: "home" } as WorkspaceSnapshot;
const guest = (sessionId: string): GuestChat =>
  ({ ws: { id: "their-home" }, session: { id: sessionId }, last: null }) as unknown as GuestChat;

describe("inboxKeyOf（同 InboxRow.key 的前缀约定）", () => {
  it("五种各有各的前缀", () => {
    expect(inboxKeyOf({ kind: "agent", agentId: "a1" })).toBe("a:a1");
    expect(inboxKeyOf({ kind: "group", sessionId: "s1" })).toBe("g:s1");
    expect(inboxKeyOf({ kind: "team", workspaceId: "w", sessionId: "s2" })).toBe("t:s2");
    expect(inboxKeyOf({ kind: "guest", workspaceId: "w", sessionId: "s3" })).toBe("j:s3");
    expect(inboxKeyOf({ kind: "friend", uid: "u1" })).toBe("f:u1");
  });
});

describe("openInboxKey：此刻开着的是列表里哪一行", () => {
  const base = { friendUid: null, draft: null, cloud: null, home, homeChats: [], guests: [] } as const;

  it("什么都没开 = null", () => {
    expect(openInboxKey(base)).toBeNull();
  });

  it("朋友私聊优先（桌面同一时刻只画一条）", () => {
    expect(openInboxKey({ ...base, friendUid: "u9", cloud: { workspaceId: "home-1", sessionId: "s" } })).toBe("f:u9");
  });

  it("私聊草稿按 agentId 记——列表那一行的键就是 a:<agentId>", () => {
    expect(openInboxKey({ ...base, draft: { workspaceId: "home-1", chat: { kind: "dm", agentId: "a7" } } })).toBe("a:a7");
    expect(openInboxKey({ ...base, draft: { workspaceId: "home-1", chat: null } })).toBeNull();
  });

  it("主场里的私聊回到 agentId，不拿 sessionId 拼一个 a:（否则已读游标记错格）", () => {
    const homeChats = [{ id: "dm-1", chatKind: "dm" as const, agentIds: ["a1"] }, { id: "g-1", chatKind: "group" as const, agentIds: ["a1", "a2"] }];
    expect(openInboxKey({ ...base, homeChats, cloud: { workspaceId: "home-1", sessionId: "dm-1" } })).toBe("a:a1");
    expect(openInboxKey({ ...base, homeChats, cloud: { workspaceId: "home-1", sessionId: "g-1" } })).toBe("g:g-1");
  });

  it("别人拉我进的群是 j:，其余是团队群 t:", () => {
    expect(openInboxKey({ ...base, guests: [guest("x1")], cloud: { workspaceId: "their-home", sessionId: "x1" } })).toBe("j:x1");
    expect(openInboxKey({ ...base, cloud: { workspaceId: "team-1", sessionId: "t1" } })).toBe("t:t1");
  });
});

describe("liveLastOf / newerLast：开着的那条列表行不落后于时间线", () => {
  const ev = (e: Partial<SessionEvent> & { type: string; seq: number; ts: number }): SessionEvent =>
    ({ sessionId: "s", ...e }) as unknown as SessionEvent;

  it("倒着找第一条算得上「最后一句」的：中间步骤、旁白不算", () => {
    const events = [
      ev({ type: "user_message", seq: 1, ts: 100, content: "[小明]: 帮我查下订单", fromUid: "u1" } as never),
      ev({ type: "assistant_message", seq: 2, ts: 200, content: "好的，查到了。", agentId: "a1" } as never),
      ev({ type: "assistant_message", seq: 3, ts: 300, content: "", agentId: "a1", toolCalls: [{ id: "c", name: "bash", args: {} }] } as never),
    ];
    expect(liveLastOf(events)).toEqual({ ts: 200, excerpt: "好的，查到了。", from: "agent:a1" });
    expect(liveLastOf([])).toBeNull();
  });

  it("库里那一格与现算的取更晚的；两边都缺是 undefined", () => {
    const db = { ts: 500, excerpt: "库里", from: "agent:a1" };
    const live = { ts: 400, excerpt: "日志", from: "agent:a1" };
    expect(newerLast(db, live)).toBe(db);
    expect(newerLast({ ...db, ts: 300 }, live)).toBe(live);
    expect(newerLast(undefined, live)).toBe(live);
    expect(newerLast(db, null)).toBe(db);
    expect(newerLast(undefined, null)).toBeUndefined();
  });
});

describe("mergeRecentDm", () => {
  const m = (id: number): DirectMessage => ({ id, sender: "a", recipient: "b", body: `m${id}`, createdAt: "t" });

  it("按 id 去重、新→旧", () => {
    expect(mergeRecentDm([m(3), m(1)], m(2)).map((x) => x.id)).toEqual([3, 2, 1]);
    expect(mergeRecentDm([m(3)], m(3)).map((x) => x.id)).toEqual([3]);
  });

  it("乐观占位（负数 id）不进列表：它还不是一条真消息", () => {
    expect(mergeRecentDm([m(1)], m(-4)).map((x) => x.id)).toEqual([1]);
  });

  it("封顶，丢最旧的", () => {
    const full = Array.from({ length: RECENT_DM_CAP }, (_, i) => m(RECENT_DM_CAP - i));
    const next = mergeRecentDm(full, m(RECENT_DM_CAP + 1));
    expect(next).toHaveLength(RECENT_DM_CAP);
    expect(next[0]!.id).toBe(RECENT_DM_CAP + 1);
    expect(next.at(-1)!.id).toBe(2);
  });
});

describe("已读游标的读回", () => {
  it("键带 uid", () => {
    expect(seenStorageKey("u1")).toBe("otto.wx.seen.u1");
  });

  it("没写过 / 写坏了 → 此刻当 baseline，并要求马上写一次", () => {
    expect(restoreSeen(null, 1000)).toEqual({ seen: { baselineTs: 1000, marks: new Map() }, fresh: true });
    expect(restoreSeen("{oops", 1000).fresh).toBe(true);
  });

  it("读得回来就原样用", () => {
    const r = restoreSeen(JSON.stringify({ baselineTs: 5, marks: { "a:x": 9 } }), 1000);
    expect(r.fresh).toBe(false);
    expect(r.seen.baselineTs).toBe(5);
    expect(r.seen.marks.get("a:x")).toBe(9);
  });
});
