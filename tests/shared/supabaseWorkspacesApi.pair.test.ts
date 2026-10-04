// findPairLane / fetchPairPresence（#1461 P1）。这一层薄到本来不单测，例外的理由：
// 「0053 没跑 / 查询抖了」与「确实没有」在手机上画法不同——前者不许说成「还没带智能体」（人会再带一次，
// 撞上一条其实存在的车道），后者才画「带上」。在场提示读不到一律不画（null），不拿 0 冒充。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPairPresence, findPairLane } from "../../src/shared/supabaseWorkspacesApi.js";

type Call = { op: string; arg: unknown };
const PEER = "22222222-2222-4222-8222-222222222222";

function fakeClient(calls: Call[], result: { data: unknown; error: { message: string; code?: string } | null }): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push({ op: "select", arg: cols }); return builder; },
    eq: (col: string, v: unknown) => { calls.push({ op: "eq", arg: `${col}=${String(v)}` }); return builder; },
    maybeSingle: () => builder,
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(result).then(res, rej),
  };
  return {
    from: (t: string) => { calls.push({ op: "from", arg: t }); return builder; },
    rpc: (fn: string, args: unknown) => { calls.push({ op: "rpc", arg: [fn, args] }); return builder; },
  } as unknown as SupabaseClient;
}

describe("findPairLane", () => {
  it("按主场 + 朋友 + self 找那一条；名单只收 agent id 字符串", async () => {
    const calls: Call[] = [];
    const lane = await findPairLane(fakeClient(calls, { data: { id: "s1", agent_ids: ["admin", 3] }, error: null }), "home", PEER);
    expect(lane).toEqual({ sessionId: "s1", agentIds: ["admin"] });
    expect(calls).toContainEqual({ op: "eq", arg: "chat_kind=pair" });
    expect(calls).toContainEqual({ op: "eq", arg: `peer_uid=${PEER}` });
    expect(calls).toContainEqual({ op: "eq", arg: "facing=self" });
    expect(calls).toContainEqual({ op: "eq", arg: "workspace_id=home" });
  });
  it("没有 → null；查询出错 → 抛（不说成「还没带」）", async () => {
    expect(await findPairLane(fakeClient([], { data: null, error: null }), "home", PEER)).toBeNull();
    await expect(findPairLane(fakeClient([], { data: null, error: { message: "column facing does not exist", code: "42703" } }), "home", PEER)).rejects.toThrow();
  });
});

describe("fetchPairPresence", () => {
  it("调 pair_presence，回一个数", async () => {
    const calls: Call[] = [];
    expect(await fetchPairPresence(fakeClient(calls, { data: 2, error: null }), PEER)).toBe(2);
    expect(calls).toContainEqual({ op: "rpc", arg: ["pair_presence", { p_owner: PEER }] });
  });
  it("读不到（0053 没跑 / 抖了 / 形状不对）→ null，不拿 0 冒充", async () => {
    expect(await fetchPairPresence(fakeClient([], { data: null, error: { message: "function does not exist" } }), PEER)).toBeNull();
    expect(await fetchPairPresence(fakeClient([], { data: "x", error: null }), PEER)).toBeNull();
  });
});
