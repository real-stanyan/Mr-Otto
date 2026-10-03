import { describe, expect, it } from "vitest";
import {
  agentOutreachActive, blockedMessage, countAgentOutreach, ensureOutreachSession, openOriginRoom, outreachSeedEvents,
  type EnsureOutreachDeps, type OutreachSessionRow,
} from "../../services/runtime/src/outreachSession.js";
import type { SessionEvent } from "../../src/session/events.js";

const agent = { agentId: "a1", name: "小助" };
const peer = { uid: "p1", name: "小红" };
const args = { workspaceId: "w1", ownerUid: "o1", ownerName: "老王", agent, peer };

function fakeDeps(over: Partial<EnsureOutreachDeps<string>> = {}) {
  const calls: string[] = [];
  const appended: { type: string }[] = [];
  const inserted: OutreachSessionRow[] = [];
  const deps: EnsureOutreachDeps<string> = {
    find: async () => null,
    insert: async (row) => (inserted.push(row), null),
    append: (e) => void appended.push(e as { type: string }),
    hasSeed: () => appended.some((e) => e.type === "session_created"),
    active: () => null,
    open: (id) => (calls.push(`open:${id}`), `room:${id}`),
    syncGuests: async (id, humans, by) => void calls.push(`sync:${id}:${humans.map((h) => h.uid)}:${by}`),
    newId: () => "new-1",
    now: () => 123,
    workdir: "/work",
    ...over,
  };
  return { deps, calls, appended, inserted };
}

describe("outreachSeedEvents", () => {
  it("恰好两条：session_created（带 outreach 与 home）与 chat_roster_changed（agent + 好友）", () => {
    const [a, b] = outreachSeedEvents({ sessionId: "s", workspaceId: "w1", workdir: "/work", ownerName: "老王", agent, peer, ts: 5 });
    expect(a).toEqual({
      sessionId: "s", ts: 5, type: "session_created", workspace: "/work",
      cloud: { workspaceId: "w1", home: true, chat: { kind: "outreach" }, outreach: { ownerName: "老王", peerUid: "p1", peerName: "小红" } },
    });
    expect(b).toEqual({
      sessionId: "s", ts: 5, type: "chat_roster_changed",
      agents: [{ agentId: "a1", name: "小助" }], humans: [{ uid: "p1", name: "小红" }], ignorable: true,
    });
  });
});

describe("ensureOutreachSession", () => {
  it("没有现成的：insert 带 chat_kind / peer_uid / publisher，先落两条事件再开房、最后写客人名单", async () => {
    const f = fakeDeps();
    const r = await ensureOutreachSession(f.deps, args);
    expect(r).toBe("room:new-1");
    expect(f.inserted).toEqual([{
      id: "new-1", workspace_id: "w1", publisher_uid: "o1", kind: "cloud", title: "", pkg_id: null,
      chat_kind: "outreach", agent_ids: ["a1"], peer_uid: "p1",
    }]);
    expect(f.appended).toHaveLength(2);
    expect(f.calls).toEqual(["open:new-1", "sync:new-1:p1:o1"]);
  });

  it("已有现成的且房间开着：回那间房，不 insert 不落事件", async () => {
    const f = fakeDeps({ find: async () => "old", active: (id) => `live:${id}`, hasSeed: () => true });
    expect(await ensureOutreachSession(f.deps, args)).toBe("live:old");
    expect(f.inserted).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
    expect(f.calls).toEqual(["sync:old:p1:o1"]); // 客人名单每次对齐（幂等）
  });

  it("已有现成的但房间没开：开房，仍不落事件", async () => {
    const f = fakeDeps({ find: async () => "old", hasSeed: () => true });
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:old");
    expect(f.appended).toHaveLength(0);
  });

  it("撞唯一索引（23505）：再查一次回抢先建好的那条，不落事件", async () => {
    let n = 0;
    const f = fakeDeps({ find: async () => (n++ === 0 ? null : "raced"), insert: async () => ({ code: "23505", message: "dup" }), hasSeed: () => true });
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:raced");
    expect(f.appended).toHaveLength(0);
  });

  it("其他 insert 错误（如 0048 没跑、列不存在）：抛，不退回别的聊天形状，也不落事件", async () => {
    const f = fakeDeps({ insert: async () => ({ code: "42703", message: "column peer_uid does not exist" }) });
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow(/peer_uid/);
    expect(f.appended).toHaveLength(0);
    expect(f.calls).toEqual([]);
  });

  it("撞 23505 时对方的种子还没落：输家先补种子再开房（房不会装配自没有种子的日志）", async () => {
    let n = 0;
    const f = fakeDeps({ find: async () => (n++ === 0 ? null : "raced"), insert: async () => ({ code: "23505", message: "dup" }) });
    await ensureOutreachSession(f.deps, args);
    expect(f.appended.map((e) => e.type)).toEqual(["session_created", "chat_roster_changed"]);
    expect(f.calls[0]).toBe("open:raced");
  });

  it("23505 却再查不到：当错误抛", async () => {
    const f = fakeDeps({ insert: async () => ({ code: "23505", message: "dup" }) });
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow(/insert 失败/);
  });

  it("查询失败原样往上抛", async () => {
    const f = fakeDeps({ find: async () => { throw new Error("db down"); } });
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow("db down");
  });
});

describe("ensureOutreachSession：部分失败后的修复（#1441 fix 1-3）", () => {
  const seedTypes = (f: { appended: { type: string }[] }): string[] => f.appended.map((e) => e.type);

  it("insert 成功、append 抛：下一次 ensure 找到行、补种子、再开房并返回可用的房", async () => {
    let rows = 0;
    let boom = true;
    const f = fakeDeps({
      find: async () => (rows > 0 ? "new-1" : null),
      insert: async () => ((rows++), null),
    });
    const realAppend = f.deps.append;
    f.deps.append = (e) => {
      if (boom) throw new Error("log down");
      realAppend(e);
    };
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow("log down");
    expect(seedTypes(f)).toEqual([]);
    boom = false;
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:new-1");
    expect(seedTypes(f)).toEqual(["session_created", "chat_roster_changed"]);
    expect(rows).toBe(1); // 没有再 insert 一行
  });

  it("insert 成功、open 抛：下一次不重复种子（恰好一条 session_created、一条 chat_roster_changed）", async () => {
    let rows = 0;
    let boom = true;
    const f = fakeDeps({
      find: async () => (rows > 0 ? "new-1" : null),
      insert: async () => ((rows = 1), null),
    });
    const realOpen = f.deps.open;
    f.deps.open = (id) => {
      if (boom) throw new Error("open failed");
      return realOpen(id);
    };
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow("open failed");
    boom = false;
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:new-1");
    expect(seedTypes(f)).toEqual(["session_created", "chat_roster_changed"]);
  });

  it("第一次客人名单写库失败：下一次 ensure（走已有行那条路）再对齐一遍", async () => {
    let rows = 0;
    let failSync = true;
    const f = fakeDeps({ find: async () => (rows > 0 ? "new-1" : null), insert: async () => ((rows = 1), null) });
    const realSync = f.deps.syncGuests;
    f.deps.syncGuests = async (id, h, by) => {
      if (failSync) throw new Error("sync failed");
      return realSync(id, h, by);
    };
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow("sync failed");
    failSync = false;
    await ensureOutreachSession(f.deps, args);
    expect(f.calls).toContain("sync:new-1:p1:o1");
  });

  it("同一 (workspace, agent, peer) 两通并发：一次 insert、一份种子、一次 open，两边拿到同一个房", async () => {
    const rowsMade: string[] = [];
    const opened: string[] = [];
    const live = new Map<string, string>();
    const f = fakeDeps({
      find: async () => rowsMade[0] ?? null,
      insert: async (row) => {
        await new Promise((r) => setTimeout(r, 5));
        rowsMade.push(row.id);
        return null;
      },
      active: (id) => live.get(id) ?? null,
      open: (id) => {
        opened.push(id);
        const room = `room:${id}`;
        live.set(id, room);
        return room;
      },
    });
    const [x, y] = await Promise.all([ensureOutreachSession(f.deps, args), ensureOutreachSession(f.deps, args)]);
    expect(x).toBe(y);
    expect(rowsMade).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(seedTypes(f)).toEqual(["session_created", "chat_roster_changed"]);
  });
});

describe("countAgentOutreach", () => {
  const ev = (sid: string, id: string, ts: number): SessionEvent =>
    ({ seq: 0, sessionId: sid, ts, type: "outreach", outreachId: id, phase: "started", fromAgentId: "a1", peerUid: "p", peerName: "n", ignorable: true }) as SessionEvent;
  it("把这只的每条外联会话各折叠一遍求和，只数 since 之后的", async () => {
    const logs: Record<string, SessionEvent[]> = {
      s1: [ev("s1", "x", 100), ev("s1", "y", 10)],
      s2: [ev("s2", "z", 200)],
    };
    const n = await countAgentOutreach({ sessionIds: async () => ["s1", "s2"], outreachEvents: (id) => logs[id]! }, "w1", "a1", 50);
    expect(n).toBe(2);
  });
  it("没有外联会话 = 0", async () => {
    expect(await countAgentOutreach({ sessionIds: async () => [], outreachEvents: () => [] }, "w", "a", 0)).toBe(0);
  });
});

describe("agentOutreachActive（终审 M2）", () => {
  const ev = (sid: string, id: string, phase: "started" | "ended", agentId = "a1"): SessionEvent =>
    ({ seq: 0, sessionId: sid, ts: 1, type: "outreach", outreachId: id, phase, fromAgentId: agentId, peerUid: "p", peerName: "n", ignorable: true, ...(phase === "ended" ? { outcome: "completed" } : {}) }) as SessionEvent;
  it("任一条外联会话里这只有一通没收尾：true；都收了：false", async () => {
    const logs: Record<string, SessionEvent[]> = { s1: [ev("s1", "x", "started"), ev("s1", "x", "ended")], s2: [ev("s2", "y", "started")] };
    const d = { sessionIds: async () => ["s1", "s2"], outreachEvents: (id: string) => logs[id]! };
    expect(await agentOutreachActive(d, "w1", "a1")).toBe(true);
    logs.s2!.push(ev("s2", "y", "ended"));
    expect(await agentOutreachActive(d, "w1", "a1")).toBe(false);
  });
  it("没有外联会话：false；查询失败照抛", async () => {
    expect(await agentOutreachActive({ sessionIds: async () => [], outreachEvents: () => [] }, "w", "a")).toBe(false);
    await expect(agentOutreachActive({ sessionIds: async () => { throw new Error("db"); }, outreachEvents: () => [] }, "w", "a")).rejects.toThrow("db");
  });
});

describe("blockedMessage", () => {
  it("只有 blocked 回它的话；hosted / 探不到放行", () => {
    expect(blockedMessage({ kind: "blocked", reason: "额度用完了" })).toBe("额度用完了");
    expect(blockedMessage({ kind: "hosted" })).toBeNull();
    expect(blockedMessage(null)).toBeNull();
  });
});

describe("openOriginRoom", () => {
  const room = (archived = false) => ({ isArchived: () => archived });
  it("房间开着：直接用，不查库", async () => {
    const r = room();
    const got = await openOriginRoom({ active: () => r, row: async () => { throw new Error("不该查"); }, open: async () => r, discard: () => {} }, "w1", "s");
    expect(got).toBe(r);
  });
  it("没开：按行里的发布者开房", async () => {
    const r = room();
    let opened = "";
    const got = await openOriginRoom(
      { active: () => null, row: async () => ({ workspace_id: "w1", archived: false, publisherUid: "pub" }), open: async (_w, _s, pub) => ((opened = pub), r), discard: () => {} },
      "w1", "s",
    );
    expect(got).toBe(r);
    expect(opened).toBe("pub");
  });
  it("行没了 / 已归档 / 属于别的团队：null", async () => {
    const mk = (row: { workspace_id: string; archived: boolean; publisherUid: string } | null) =>
      openOriginRoom({ active: () => null, row: async () => row, open: async () => room(), discard: () => {} }, "w1", "s");
    expect(await mk(null)).toBeNull();
    expect(await mk({ workspace_id: "w1", archived: true, publisherUid: "p" })).toBeNull();
    expect(await mk({ workspace_id: "w2", archived: false, publisherUid: "p" })).toBeNull();
  });
  it("开出来的房间日志里已经归档：null，并把刚注册的房摘掉", async () => {
    const discarded: string[] = [];
    expect(await openOriginRoom({ active: () => null, row: async () => ({ workspace_id: "w1", archived: false, publisherUid: "p" }), open: async () => room(true), discard: (id) => discarded.push(id) }, "w1", "s")).toBeNull();
    expect(discarded).toEqual(["s"]);
  });
});
