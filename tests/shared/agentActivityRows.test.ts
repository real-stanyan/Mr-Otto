// agentActivityRows —— agent_activity 在客户端这一侧（#1282，spec §3.3 / §3.4）：解析、陈旧、取状态、拉取、订阅。
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVITY_STALE_MS } from "../../src/shared/agentActivity.js";
import {
  activityKey, activityRowOf, fetchAgentActivity, liveActivity, sessionAgentActivity, sessionLastOfRow,
  subscribeAgentActivity, workspaceAgentActivity, type ActivityRow,
} from "../../src/shared/agentActivityRows.js";

const T = Date.parse("2026-09-28T10:00:00.000Z");
const raw = (o: Record<string, unknown> = {}) => ({
  session_id: "s1", agent_id: "ops", workspace_id: "w1", state: "working",
  since: "2026-09-28T09:59:00.000Z", beat: "2026-09-28T10:00:00.000Z", ...o,
});
const rowOf = (o: Record<string, unknown> = {}): ActivityRow => activityRowOf(raw(o))!;
const index = (...rows: ActivityRow[]) => new Map(rows.map((r) => [activityKey(r.sessionId, r.agentId), r]));

describe("activityRowOf", () => {
  it("解析一行；时间转毫秒", () => {
    expect(activityRowOf(raw())).toEqual({ sessionId: "s1", agentId: "ops", workspaceId: "w1", state: "working", since: T - 60_000, beat: T });
  });
  it("缺格 / 形状不对 / 时间解析不出 → null", () => {
    expect(activityRowOf(null)).toBeNull();
    expect(activityRowOf(raw({ agent_id: 3 }))).toBeNull();
    expect(activityRowOf(raw({ beat: "garbage" }))).toBeNull();
  });
});

describe("liveActivity（spec §3.3）", () => {
  it("此刻在进行的几档：3 分钟没心跳 = 不知道", () => {
    const r = rowOf();
    expect(liveActivity(r, T + ACTIVITY_STALE_MS)).toBe("working");
    expect(liveActivity(r, T + ACTIVITY_STALE_MS + 1)).toBeNull();
  });
  it("出错 / 额度用完 / 闲着不过期", () => {
    expect(liveActivity(rowOf({ state: "failed" }), T + 10 * ACTIVITY_STALE_MS)).toBe("failed");
    expect(liveActivity(rowOf({ state: "limited" }), T + 10 * ACTIVITY_STALE_MS)).toBe("limited");
    expect(liveActivity(rowOf({ state: "idle" }), T + 10 * ACTIVITY_STALE_MS)).toBe("idle");
  });
  it("认不出的状态（将来 runtime 多了一档）= 不知道", () => {
    expect(liveActivity(rowOf({ state: "dreaming" }), T)).toBeNull();
  });
});

describe("按会话 / 按工作区取", () => {
  const rows = index(
    rowOf({ session_id: "dm", state: "working" }),
    rowOf({ session_id: "g1", state: "waiting" }),
    rowOf({ session_id: "g2", state: "failed" }),
    rowOf({ session_id: "t1", workspace_id: "w2", state: "solving" }),
    rowOf({ session_id: "dm", agent_id: "ads", state: "idle" }),
  );
  it("sessionAgentActivity：有行按行，没行 = null", () => {
    expect(sessionAgentActivity(rows, "dm", "ops", T)).toBe("working");
    expect(sessionAgentActivity(rows, "dm", "nobody", T)).toBeNull();
  });
  it("workspaceAgentActivity：只看这个工作区、取最要紧；一行都不知道 = null；过期的不算", () => {
    expect(workspaceAgentActivity(rows, "w1", "ops", T)).toBe("waiting");
    expect(workspaceAgentActivity(rows, "w2", "ops", T)).toBe("solving");
    expect(workspaceAgentActivity(rows, "w1", "ads", T)).toBe("idle");
    expect(workspaceAgentActivity(rows, "w1", "nobody", T)).toBeNull();
    expect(workspaceAgentActivity(rows, "w1", "ops", T + ACTIVITY_STALE_MS + 1)).toBe("failed");
  });
});

describe("fetchAgentActivity", () => {
  const client = (res: { data?: unknown; error?: unknown }, calls: string[] = []) =>
    ({
      from: (t: string) => {
        calls.push(`from:${t}`);
        return { select: async (c: string) => { calls.push(`select:${c}`); return { data: res.data ?? null, error: res.error ?? null }; } };
      },
    }) as unknown as SupabaseClient;
  it("一条查询全量拉，解析不了的行丢掉", async () => {
    const calls: string[] = [];
    const rows = await fetchAgentActivity(client({ data: [raw(), { junk: true }] }, calls));
    expect(calls).toEqual(["from:agent_activity", "select:session_id,agent_id,workspace_id,state,since,beat"]);
    expect(rows).toEqual([rowOf()]);
  });
  it("读不到（表还不在 / 断网）→ null，不是空数组（读不到 ≠ 没有）", async () => {
    expect(await fetchAgentActivity(client({ error: { message: "relation does not exist", code: "42P01" } }))).toBeNull();
    const throwing = { from: () => { throw new Error("offline"); } } as unknown as SupabaseClient;
    expect(await fetchAgentActivity(throwing)).toBeNull();
  });
});

describe("sessionLastOfRow", () => {
  it("推送里那一行的最后一句（同 fetchCloudLasts 的解析）", () => {
    expect(sessionLastOfRow({ id: "s1", last_ts: "2026-09-28T10:00:00.000Z", last_excerpt: "好了", last_from: "agent:ops" }))
      .toEqual({ sessionId: "s1", last: { ts: T, excerpt: "好了", from: "agent:ops" } });
  });
  it("还没人说过话 / 解析不出 → null；另两格形状不对退回空串", () => {
    expect(sessionLastOfRow({ id: "s1", last_ts: null })).toBeNull();
    expect(sessionLastOfRow({ id: "s1", last_ts: "x" })).toBeNull();
    expect(sessionLastOfRow(null)).toBeNull();
    expect(sessionLastOfRow({ id: "s1", last_ts: "2026-09-28T10:00:00.000Z" })).toEqual({ sessionId: "s1", last: { ts: T, excerpt: "", from: "" } });
  });
});

describe("subscribeAgentActivity", () => {
  it("一条频道订两张表的 INSERT / UPDATE，不订 DELETE；退订 = removeChannel", () => {
    const handlers: { filter: { event: string; table: string }; cb: (p: { new: unknown }) => void }[] = [];
    const channel = {
      on: (_type: string, filter: { event: string; table: string }, cb: (p: { new: unknown }) => void) => {
        handlers.push({ filter, cb });
        return channel;
      },
      subscribe: () => channel,
    };
    const channelFn = vi.fn(() => channel);
    const removeChannel = vi.fn(async () => "ok");
    const client = { channel: channelFn, removeChannel } as unknown as SupabaseClient;
    const onRow = vi.fn();
    const onSession = vi.fn();
    const stop = subscribeAgentActivity(client, "me", { onRow, onSession });
    expect(channelFn).toHaveBeenCalledWith("agent-activity-me");
    expect(handlers.map((h) => `${h.filter.table}:${h.filter.event}`)).toEqual([
      "agent_activity:INSERT", "agent_activity:UPDATE", "workspace_sessions:INSERT", "workspace_sessions:UPDATE",
    ]);
    handlers[1]!.cb({ new: raw({ state: "solving" }) });
    expect(onRow).toHaveBeenCalledWith(rowOf({ state: "solving" }));
    handlers[0]!.cb({ new: { junk: true } });
    expect(onRow).toHaveBeenCalledTimes(1);
    handlers[3]!.cb({ new: { id: "s1" } });
    expect(onSession).toHaveBeenCalledWith({ id: "s1" }, "update");
    stop();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });
});
