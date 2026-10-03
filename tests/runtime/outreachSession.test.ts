import { describe, expect, it } from "vitest";
import {
  blockedMessage, countAgentOutreach, ensureOutreachSession, openOriginRoom, outreachSeedEvents,
  type EnsureOutreachDeps, type OutreachSessionRow,
} from "../../services/runtime/src/outreachSession.js";
import type { SessionEvent } from "../../src/session/events.js";

const agent = { agentId: "a1", name: "小助" };
const peer = { uid: "p1", name: "小红" };
const args = { workspaceId: "w1", ownerUid: "o1", ownerName: "老王", agent, peer };

function fakeDeps(over: Partial<EnsureOutreachDeps<string>> = {}) {
  const calls: string[] = [];
  const appended: unknown[] = [];
  const inserted: OutreachSessionRow[] = [];
  const deps: EnsureOutreachDeps<string> = {
    find: async () => null,
    insert: async (row) => (inserted.push(row), null),
    append: (e) => void appended.push(e),
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
    const f = fakeDeps({ find: async () => "old", active: (id) => `live:${id}` });
    expect(await ensureOutreachSession(f.deps, args)).toBe("live:old");
    expect(f.inserted).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
    expect(f.calls).toEqual([]);
  });

  it("已有现成的但房间没开：开房，仍不落事件", async () => {
    const f = fakeDeps({ find: async () => "old" });
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:old");
    expect(f.appended).toHaveLength(0);
  });

  it("撞唯一索引（23505）：再查一次回抢先建好的那条，不落事件", async () => {
    let n = 0;
    const f = fakeDeps({ find: async () => (n++ === 0 ? null : "raced"), insert: async () => ({ code: "23505", message: "dup" }) });
    expect(await ensureOutreachSession(f.deps, args)).toBe("room:raced");
    expect(f.appended).toHaveLength(0);
  });

  it("其他 insert 错误（如 0048 没跑、列不存在）：抛，不退回别的聊天形状，也不落事件", async () => {
    const f = fakeDeps({ insert: async () => ({ code: "42703", message: "column peer_uid does not exist" }) });
    await expect(ensureOutreachSession(f.deps, args)).rejects.toThrow(/peer_uid/);
    expect(f.appended).toHaveLength(0);
    expect(f.calls).toEqual([]);
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
    const got = await openOriginRoom({ active: () => r, row: async () => { throw new Error("不该查"); }, open: async () => r }, "w1", "s");
    expect(got).toBe(r);
  });
  it("没开：按行里的发布者开房", async () => {
    const r = room();
    let opened = "";
    const got = await openOriginRoom(
      { active: () => null, row: async () => ({ workspace_id: "w1", archived: false, publisherUid: "pub" }), open: async (_w, _s, pub) => ((opened = pub), r) },
      "w1", "s",
    );
    expect(got).toBe(r);
    expect(opened).toBe("pub");
  });
  it("行没了 / 已归档 / 属于别的团队：null", async () => {
    const mk = (row: { workspace_id: string; archived: boolean; publisherUid: string } | null) =>
      openOriginRoom({ active: () => null, row: async () => row, open: async () => room() }, "w1", "s");
    expect(await mk(null)).toBeNull();
    expect(await mk({ workspace_id: "w1", archived: true, publisherUid: "p" })).toBeNull();
    expect(await mk({ workspace_id: "w2", archived: false, publisherUid: "p" })).toBeNull();
  });
  it("开出来的房间日志里已经归档：null", async () => {
    expect(await openOriginRoom({ active: () => null, row: async () => ({ workspace_id: "w1", archived: false, publisherUid: "p" }), open: async () => room(true) }, "w1", "s")).toBeNull();
  });
});
