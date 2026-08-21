import { describe, it, expect } from "vitest";
import { createSupabaseFriendsApi, isMissingColumn, mergeChannelHealth, presenceStateToEntries, presenceStateToIds } from "../../src/main/supabaseFriendsApi.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("presenceStateToIds", () => {
  it("state 的 key 即在线 uid,排序输出", () => {
    expect(presenceStateToIds({ b: [{}], a: [{}, {}] })).toEqual(["a", "b"]);
  });
  it("空 state → 空数组", () => {
    expect(presenceStateToIds({})).toEqual([]);
  });
});

describe("mergeChannelHealth", () => {
  it("四条通道全 SUBSCRIBED 才算 live", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED"])).toBe("live");
  });

  // 只有 messages 哑掉时,好友列表照常刷新,聊天却静悄悄——最难察觉的那种坏。
  // 整体判 degraded 让轮询兜住,宁可多轮询也别装作正常
  it("任一条没通就整体 degraded", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED", "SUBSCRIBED"])).toBe("degraded");
    expect(mergeChannelHealth(["SUBSCRIBED", "TIMED_OUT", "SUBSCRIBED", "SUBSCRIBED"])).toBe("degraded");
    expect(mergeChannelHealth(["CONNECTING", "CONNECTING", "CONNECTING", "CONNECTING"])).toBe("degraded");
  });
});

describe("presenceStateToEntries", () => {
  it("meta 里的 repoKey/branch 捞出来;老客户端只有 {at} → workspace null", () => {
    expect(presenceStateToEntries({
      b: [{ at: 1 }],
      a: [{ at: 1, repoKey: "k", branch: "main" }],
    })).toEqual([
      { id: "a", workspace: { repoKey: "k", branch: "main" } },
      { id: "b", workspace: null },
    ]);
  });

  it("多窗口:取第一个带 repoKey 的 meta;branch 不是字符串当 null", () => {
    expect(presenceStateToEntries({
      a: [{ at: 1 }, { at: 2, repoKey: "k", branch: 42 }, { at: 3, repoKey: "k2", branch: "x" }],
    })).toEqual([{ id: "a", workspace: { repoKey: "k", branch: null } }]);
  });

  it("形状不对的 meta 一律当没有(对端不可信)", () => {
    expect(presenceStateToEntries({ a: [null, "str", { repoKey: "" }, { repoKey: 7 }] }))
      .toEqual([{ id: "a", workspace: null }]);
  });
});

describe("isMissingColumn", () => {
  it("PGRST204(update 未知列)与 42703(select 未知列)算;别的不算", () => {
    expect(isMissingColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingColumn({ code: "42703" })).toBe(true);
    expect(isMissingColumn({ code: "23505" })).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});

describe("心跳在没跑 0008 的库上退化", () => {
  /** 假 client:profiles 的 update/select 按"有没有带新列"决定报不报缺列 */
  function fakeClient(hasColumns: boolean) {
    const calls: { op: string; payload: unknown }[] = [];
    const missing = { message: "column does not exist", code: "PGRST204" };
    const from = () => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          calls.push({ op: "update", payload });
          const touchesNew = "repo_key" in payload;
          return { data: null, error: !hasColumns && touchesNew ? missing : null };
        },
      }),
      select: (cols: string) => ({
        in: async () => {
          calls.push({ op: "select", payload: cols });
          const touchesNew = cols.includes("repo_key");
          return { data: [{ id: "u2", last_seen_at: "t" }], error: !hasColumns && touchesNew ? { ...missing, code: "42703" } : null };
        },
      }),
    });
    return { client: { from } as unknown as SupabaseClient, calls };
  }

  it("有列:一次写成,带 repo_key/repo_branch", async () => {
    const { client, calls } = fakeClient(true);
    const api = createSupabaseFriendsApi(client);
    await api.touchPresence("me", { repoKey: "k", branch: "main" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({ repo_key: "k", repo_branch: "main" });
  });

  it("缺列:第一拍退回只写 last_seen_at,之后记住不再试;读同理", async () => {
    const { client, calls } = fakeClient(false);
    const api = createSupabaseFriendsApi(client);
    await api.touchPresence("me", { repoKey: "k", branch: "main" });
    expect(calls.map((c) => c.op)).toEqual(["update", "update"]);
    expect(calls[1]!.payload).toEqual({ last_seen_at: expect.any(String) });
    await api.touchPresence("me", null);
    expect(calls).toHaveLength(3); // 记住了:不再先试新列
    const rows = await api.listLastSeen(["u2"]);
    expect(calls[3]!.payload).toBe("id,last_seen_at");
    expect(rows).toEqual([{ id: "u2", last_seen_at: "t" }]);
  });

  it("别的错误照样上抛,不吞", async () => {
    const client = { from: () => ({ update: () => ({ eq: async () => ({ data: null, error: { message: "rls", code: "42501" } }) }) }) } as unknown as SupabaseClient;
    await expect(createSupabaseFriendsApi(client).touchPresence("me", null)).rejects.toMatchObject({ code: "42501" });
  });
});
