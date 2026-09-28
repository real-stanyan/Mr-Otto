import { describe, expect, it, vi } from "vitest";
import { createInMemoryCloudSessionMeta, createSupabaseCloudSessionMeta, resetAgentActivity } from "../../services/runtime/src/cloudSessionMeta.js";

describe("createInMemoryCloudSessionMeta", () => {
  it("记下最后一次写进去的标题与参与者，给断言读", async () => {
    const meta = createInMemoryCloudSessionMeta();
    expect(meta.title).toBeNull();
    await meta.setTitle("奶茶店选址");
    await meta.setParticipants({ window: 3, uids: ["u1", "u2"] });
    expect(meta.title).toBe("奶茶店选址");
    expect(meta.participants).toEqual({ window: 3, uids: ["u1", "u2"] });
  });

  it("记下最后一次写进去的「最后一句」（#1356 A1）", async () => {
    const meta = createInMemoryCloudSessionMeta();
    expect(meta.last).toBeNull();
    await meta.setLast({ ts: 42, excerpt: "门禁绿了", from: "agent:a_000000000001" });
    expect(meta.last).toEqual({ ts: 42, excerpt: "门禁绿了", from: "agent:a_000000000001" });
  });
});

describe("createSupabaseCloudSessionMeta", () => {
  /** 造一个只认 from().update().eq() 的假 client */
  function fakeClient(result: { error: { message: string } | null }) {
    const eq = vi.fn().mockResolvedValue(result);
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    return { client: { from } as never, from, update, eq };
  }

  it("标题写 title 那一列，按 sessionId 定位", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}, "ws-1").setTitle("新名字");
    expect(f.from).toHaveBeenCalledWith("workspace_sessions");
    expect(f.update).toHaveBeenCalledWith({ title: "新名字" });
    expect(f.eq).toHaveBeenCalledWith("id", "sess-1");
  });

  it("参与者两列一起写", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}, "ws-1").setParticipants({ window: 7, uids: ["a"] });
    expect(f.update).toHaveBeenCalledWith({ participants: ["a"], participants_window: 7 });
  });

  it("写失败只记一行日志不抛——这是日志的投影，权威那份已经落盘了", async () => {
    const log = vi.fn();
    const f = fakeClient({ error: { message: "column does not exist" } });
    await expect(createSupabaseCloudSessionMeta(f.client, "s", log, "ws-1").setTitle("x")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("column does not exist");
  });

  it("client 调用本身 reject（网络层，不是 Supabase 回的 {error} 信封）→ 依然 resolve、只记一行日志——" +
     "复审 Critical 2：这一层原来只接住 {error} 信封那一半，网络层 reject（断网/超时）完全没人接，" +
     "会带走整个 daemon 进程（同 daemon.ts:465-471 那条先例）。触发点是这次改动新增的最高频写入：" +
     "云会话里每来一个新说话人都要调一次 setParticipants", async () => {
    const log = vi.fn();
    const eq = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    const client = { from } as never;
    await expect(
      createSupabaseCloudSessionMeta(client, "s", log, "ws-1").setParticipants({ window: 1, uids: ["u1"] }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("fetch failed");
  });

  it("最后一句三列一起写，时间写成 ISO（#1356 A1）", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}, "ws-1").setLast({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "你好", from: "human:u1" });
    expect(f.update).toHaveBeenCalledWith({ last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: "你好", last_from: "human:u1" });
    expect(f.eq).toHaveBeenCalledWith("id", "sess-1");
  });

  it("最后一句写失败（0040 没跑，列不存在）只记一行日志不抛", async () => {
    const log = vi.fn();
    const f = fakeClient({ error: { message: "column last_ts does not exist" } });
    await expect(createSupabaseCloudSessionMeta(f.client, "s", log, "ws-1").setLast({ ts: 1, excerpt: "x", from: "human:u1" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("setActivity（#1282）", () => {
  it("内存版记下每一批", async () => {
    const meta = createInMemoryCloudSessionMeta();
    await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 2 }]);
    expect(meta.activity).toEqual([[{ agentId: "ops", state: "working", since: 1, beat: 2 }]]);
  });

  function upsertClient(result: { error: { message: string; code?: string } | null } | Error) {
    const upsert = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const from = vi.fn().mockReturnValue({ upsert });
    return { client: { from } as never, from, upsert };
  }

  it("真库版：一批 upsert 进 agent_activity，按 (session_id, agent_id) 覆盖，时间写 ISO", async () => {
    const f = upsertClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}, "ws-1").setActivity([
      { agentId: "ops", state: "working", since: Date.parse("2026-09-28T10:00:00.000Z"), beat: Date.parse("2026-09-28T10:01:00.000Z") },
    ]);
    expect(f.from).toHaveBeenCalledWith("agent_activity");
    expect(f.upsert).toHaveBeenCalledWith(
      [{ session_id: "sess-1", agent_id: "ops", workspace_id: "ws-1", state: "working", since: "2026-09-28T10:00:00.000Z", beat: "2026-09-28T10:01:00.000Z" }],
      { onConflict: "session_id,agent_id" },
    );
  });

  it("表还不在（0044 没跑：42P01 / PGRST205）：这条会话只记一行，不刷屏", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const log = vi.fn();
      const f = upsertClient({ error: { message: "relation does not exist", code } });
      const meta = createSupabaseCloudSessionMeta(f.client, "sess-1", log, "ws-1");
      await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]);
      await meta.setActivity([{ agentId: "ops", state: "idle", since: 2, beat: 2 }]);
      expect(log).toHaveBeenCalledTimes(1);
    }
  });

  it("别的错每次都记；网络层 reject 记日志不抛", async () => {
    const log = vi.fn();
    const f = upsertClient({ error: { message: "boom", code: "XX000" } });
    const meta = createSupabaseCloudSessionMeta(f.client, "sess-1", log, "ws-1");
    await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]);
    await meta.setActivity([{ agentId: "ops", state: "idle", since: 2, beat: 2 }]);
    expect(log).toHaveBeenCalledTimes(2);
    const log2 = vi.fn();
    const g = upsertClient(new Error("offline"));
    await expect(
      createSupabaseCloudSessionMeta(g.client, "sess-1", log2, "ws-1").setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]),
    ).resolves.toBeUndefined();
    expect(log2).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});

describe("resetAgentActivity（#1282）", () => {
  it("上一个进程留下的非 idle 行全部写回 idle", async () => {
    const neq = vi.fn(async () => ({ error: null }));
    const update = vi.fn().mockReturnValue({ neq });
    const from = vi.fn().mockReturnValue({ update });
    await resetAgentActivity({ from } as never, () => {}, Date.parse("2026-09-28T10:00:00.000Z"));
    expect(from).toHaveBeenCalledWith("agent_activity");
    expect(update).toHaveBeenCalledWith({ state: "idle", since: "2026-09-28T10:00:00.000Z", beat: "2026-09-28T10:00:00.000Z" });
    expect(neq).toHaveBeenCalledWith("state", "idle");
  });
  it("失败只记日志不抛", async () => {
    const log = vi.fn();
    const neq = vi.fn(async () => ({ error: { message: "boom" } }));
    await resetAgentActivity({ from: () => ({ update: () => ({ neq }) }) } as never, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
