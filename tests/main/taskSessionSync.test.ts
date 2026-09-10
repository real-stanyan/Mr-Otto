// 复制器的核心路径（#1223）：推、拉（muted）、笔、离线、detached、附件。假 api 在内存里照 0036 的规矩行事
// （seq CAS、executor 类事件要笔、建行发笔），所以这里测的是「复制器 + RPC 语义」合起来对不对。
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import { createTaskSessionSync, type TaskSessionSync, type TaskSessionSyncDeps } from "../../src/main/taskSessionSync.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi, type TaskSyncErrorCode } from "../../src/main/taskSessionsApi.js";
import type { TaskSyncFile } from "../../src/main/taskSyncStore.js";
import { HUMAN_EVENT_TYPES, PEN_RENEW_MS } from "../../src/shared/taskSync.js";
import { tempDir } from "../helpers/tempDir.js";

export interface FakeCloud {
  api: TaskSessionsApi;
  rows: Map<string, { row: TaskSessionRow; events: SessionEvent[] }>;
  calls: string[];
  blobs: Map<string, Uint8Array>;
  setOffline(v: boolean): void;
  emitRow(id: string): void; // 假装 realtime 推了这一行
  now: { t: number };
  /** 让下一次对这条会话的 append 抛一次指定错误（一次性，用完自动清）——
      controller ruling 补的 forbidden 分支需要在真接口以外的地方触发这条终态 */
  failAppendOnce(sessionId: string, code: TaskSyncErrorCode, message: string): void;
}

export function fakeCloud(uid = "u1"): FakeCloud {
  const rows = new Map<string, { row: TaskSessionRow; events: SessionEvent[] }>();
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const now = { t: 1_000_000 };
  let offline = false;
  let listener: ((row: TaskSessionRow) => void) | null = null;
  const failOnce = new Map<string, { code: TaskSyncErrorCode; message: string }>();
  const net = () => { if (offline) throw new TaskSyncError("network", "fetch failed"); };
  const penLive = (r: TaskSessionRow, holder: string) => r.pen_holder === holder && r.pen_until !== null && Date.parse(r.pen_until) > now.t;
  const api: TaskSessionsApi = {
    async listChanged(_u, since) { net(); calls.push("list"); return [...rows.values()].map((x) => x.row).filter((r) => since === null || r.updated_at > since); },
    async getSession(_u, id) { net(); return rows.get(id)?.row ?? null; },
    async pullEvents(_u, id, after, limit) { net(); calls.push(`pull ${id} >${after}`); return (rows.get(id)?.events ?? []).filter((e) => e.seq > after).slice(0, limit); },
    async append(id, expected, holder, events) {
      net();
      calls.push(`append ${id} @${expected} x${events.length}`);
      const forced = failOnce.get(id);
      if (forced) {
        failOnce.delete(id);
        throw new TaskSyncError(forced.code, forced.message);
      }
      let entry = rows.get(id);
      const isNewRow = entry === undefined;
      if (!entry) {
        if (expected !== 0) throw new TaskSyncError("no_session", "no_session");
        entry = { row: { id, title: "", archived: false, last_seq: -1, pen_holder: holder, pen_until: new Date(now.t + 30_000).toISOString(), updated_at: new Date(now.t).toISOString() }, events: [] };
      }
      if (entry.row.last_seq + 1 !== expected) throw new TaskSyncError("seq_conflict", "seq_conflict");
      // 先整批验（seq 连续 + 笔），一条不过整批不落——真 RPC 那一批是一个事务，
      // 半批落盘会让「拒绝了」和「落了一半」在云端行上长得一模一样
      let seq = expected;
      for (const e of events) {
        if (e.seq !== seq) throw new TaskSyncError("seq_conflict", "seq_conflict");
        if (!HUMAN_EVENT_TYPES.has(e.type) && !penLive(entry.row, holder)) throw new TaskSyncError("pen_required", "pen_required");
        seq++;
      }
      if (isNewRow) rows.set(id, entry);
      entry.events.push(...events);
      entry.row.last_seq = seq - 1;
      entry.row.updated_at = new Date(++now.t).toISOString();
      return seq - 1;
    },
    async acquirePen(id, holder, ttl) {
      net();
      const entry = rows.get(id);
      if (!entry) throw new TaskSyncError("no_session", "no_session");
      const r = entry.row;
      if (r.pen_holder === null || r.pen_until === null || Date.parse(r.pen_until) <= now.t || r.pen_holder === holder) {
        r.pen_holder = holder; r.pen_until = new Date(now.t + ttl * 1000).toISOString(); r.updated_at = new Date(++now.t).toISOString();
        return { ok: true, holder, until: Date.parse(r.pen_until) };
      }
      return { ok: false, holder: r.pen_holder, until: Date.parse(r.pen_until) };
    },
    async releasePen(id, holder) { net(); const r = rows.get(id)?.row; if (r && r.pen_holder === holder) { r.pen_holder = null; r.pen_until = null; } },
    async deleteSession(_u, id) { net(); calls.push(`delete ${id}`); rows.delete(id); },
    async uploadAttachment(_u, hex, bytes) { net(); calls.push(`upload ${hex.slice(0, 6)}`); blobs.set(hex, bytes); },
    async downloadAttachment(_u, hex) { net(); return blobs.get(hex) ?? null; },
    subscribe(_u, onRow) { listener = onRow; return () => { listener = null; }; },
  };
  return {
    api, rows, calls, blobs, now,
    setOffline: (v) => { offline = v; },
    emitRow: (id) => { const r = rows.get(id)?.row; if (r && listener) listener({ ...r }); },
    failAppendOnce: (id, code, message) => { failOnce.set(id, { code, message }); },
  };
}

export function harness(opts: { cloud?: FakeCloud; holder?: string; running?: () => boolean } = {}) {
  const cloud = opts.cloud ?? fakeCloud();
  const dir = tempDir("mrotto-tasksync-");
  const pulled: { id: string; events: SessionEvent[] }[] = [];
  const replaced: string[] = [];
  const penLost: string[] = [];
  let file: TaskSyncFile = { v: 1, sessions: {}, lastSweepIso: null };
  const attachments = new Map<string, Uint8Array>();
  let sync!: TaskSessionSync;
  const store = new EventStore(join(dir, "s.db"), { onAppend: (e) => sync.touched(e) });
  const deps: TaskSessionSyncDeps = {
    store,
    api: cloud.api,
    uid: () => "u1",
    holder: opts.holder ?? "desktop:A",
    label: "A",
    file: { load: () => file, save: (f) => { file = f; } },
    attachments: {
      read: (id) => attachments.get(id) ?? null,
      save: (bytes) => { const id = `sha256:${"e".repeat(64)}`; attachments.set(id, bytes); return { id }; },
    },
    isRunning: opts.running ?? (() => false),
    onPulled: (id, events) => pulled.push({ id, events }),
    onReplaced: (id) => replaced.push(id),
    onPenLost: (id) => penLost.push(id),
    now: () => cloud.now.t,
    debounceMs: 1,
    retryMs: 1_000_000,
    sweepMs: 1_000_000,
  };
  sync = createTaskSessionSync(deps);
  return { sync, store, cloud, pulled, replaced, penLost, attachments, fileRef: () => file };
}

const created = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, ts: 1, type: "session_created", workspace: `/D/${sessionId}`, workspaceKind: "default", ...extra }) as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("taskSessionSync：推（#1223）", () => {
  it("任务会话的 append 按序推上云；建行那一批带 executor 类事件也过（RPC 发笔）；项目会话不推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "memory_loaded", memory: "m", user: "u" });
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "hi" });
    h.store.append({ sessionId: "p1", ts: 1, type: "session_created", workspace: "/repo" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.cloud.rows.has("p1")).toBe(false);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
    expect(h.sync.state().kind).toBe("idle");
  });
  it("后续 executor 类事件推之前先拿笔（建行时发的那支还在，同 holder 续期即可）", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    h.store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "a", model: "m" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
    expect(h.sync.holdsPen("s1")).toBe(true);
    await h.sync.releasePen("s1");
    expect(h.sync.holdsPen("s1")).toBe(false);
  });
  it("笔被别人握着：executor 类事件先不推、会话留在脏集合；笔空了（realtime 推行）再推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    // 另一台拿走笔
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    h.store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "a", model: "m" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
    await h.cloud.api.releasePen("s1", "cloud");
    h.cloud.emitRow("s1");
    await sleep(20);
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
  });
  it("人话免笔：别人握着笔也照推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "还在吗" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
  });
  it("离线：状态 error、脏集合留着；回网 flushNow 推出去", async () => {
    const h = harness();
    h.cloud.setOffline(true);
    h.store.append(created("s1"));
    await h.sync.flushNow();
    expect(h.sync.state().kind).toBe("error");
    expect(h.cloud.rows.has("s1")).toBe(false);
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
    expect(h.sync.state().kind).toBe("idle");
  });
  it("云端行被别的设备删了：no_session → detached、本地不动；之后本地再有事件 → 从 seq 0 整份重推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    h.cloud.rows.delete("s1");
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "x" });
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ detached: true });
    expect(h.store.load("s1")).toHaveLength(2);
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "y" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
  });
  it("append 报 forbidden（RPC 判定这批不可重试）：frozen 终态 + 状态 error，之后再写也不重试", async () => {
    // controller ruling（Task 7 复审带入 Task 10）：forbidden（P0012）是终态，不进 30s 重试循环——
    // 一条超限/畸形事件不该把这条会话的推送队列卡死，其余会话照常同步。
    // 记号必须是 frozen 不能是 detached：后者会被下一条 touched 清掉（那是「重新建行」的信号），
    // 于是每写一条就整份重推一遍再被拒一次——一条超限事件变成每条事件一次全量往返
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow(); // 先把行建上：要测的是「行已经在了、后续那一批被拒」
    h.cloud.failAppendOnce("s1", "forbidden", "bad_request: event too large");
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "超长" });
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ frozen: "forbidden" });
    expect(h.fileRef().sessions["s1"]!.detached).toBeUndefined();
    expect(h.sync.state().kind).toBe("error");
    const before = h.cloud.calls.filter((c) => c.startsWith("append s1")).length;
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "再说一句" });
    await h.sync.flushNow();
    expect(h.cloud.calls.filter((c) => c.startsWith("append s1")).length).toBe(before);
    expect(h.sync.state().kind).toBe("error");
  });
  it("一条会话推挂了不甩下同一批里剩下的：两条都留在脏集合，回网一起推出去", async () => {
    // 脏集合一进循环就 clear 了；挂在第一条上时只把它放回去，后面那些连一次尝试都没有就没了——
    // 离线时同一批全军覆没，而它们要等到各自的下一条本地事件才会被想起来
    const h = harness();
    h.store.append(created("s1"));
    h.store.append(created("s2"));
    h.cloud.setOffline(true);
    await h.sync.flushNow();
    expect(h.cloud.rows.size).toBe(0);
    expect(h.sync.state().kind).toBe("error");
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.cloud.rows.has("s1")).toBe(true);
    expect(h.cloud.rows.has("s2")).toBe(true);
  });
  it("封顶三轮之后还有脏的：安排一次重试（不等下一条本地事件 / realtime）", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.store.append(created("s1"));
      await h.sync.flushNow();
      await h.sync.releasePen("s1");
      await h.cloud.api.acquirePen("s1", "cloud", 30);
      h.store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "a", model: "m" });
      await h.sync.flushNow(); // 笔被占：三轮都推不出去，留在脏集合（没有抛错，所以 fail() 不会安排重试）
      expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000); // 先烧掉 debounce 那一发（笔还被占）
      expect(h.cloud.rows.get("s1")!.events).toHaveLength(1);
      await h.cloud.api.releasePen("s1", "cloud");
      await vi.advanceTimersByTimeAsync(1_000_001); // retryMs
      expect(h.cloud.rows.get("s1")!.events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("建行那一批 RPC 发下来的笔也要起续期定时器", async () => {
    // 只记 granted 的话 holdsPen 永远说「握着」，而云端那支 30 s 就过期了：
    // 一条长 turn 写到一半，下一条 executor 事件撞 pen_required，而那支笔可能已经被别人拿走
    vi.useFakeTimers();
    try {
      const h = harness();
      h.store.append(created("s1"));
      await h.sync.flushNow();
      expect(h.sync.holdsPen("s1")).toBe(true);
      const before = h.cloud.rows.get("s1")!.row.pen_until;
      await vi.advanceTimersByTimeAsync(PEN_RENEW_MS + 1);
      expect(h.cloud.rows.get("s1")!.row.pen_until).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
  it("backfill 补陈旧游标：条目在、没冻结，但本地日志比游标长（上次没推完就退了）", async () => {
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第二条" });
    await h.sync.flushNow();
    // 把云端与游标都退回「只推了第 0 条」那一刻：脏集合此时是空的（上一轮推完清掉了），
    // 光靠 touched 再也回不来——只有 backfill 能救它
    h.fileRef().sessions["s1"]!.pushedUpTo = 0;
    h.cloud.rows.get("s1")!.events.length = 1;
    h.cloud.rows.get("s1")!.row.last_seq = 0;
    h.sync.backfill();
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1]);
  });
  it("附件先传后推；本机没有那份字节时引用照推", async () => {
    const h = harness();
    const id = `sha256:${"a".repeat(64)}`;
    h.attachments.set(id, new Uint8Array([1, 2, 3]));
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "看图", attachments: [{ id, mediaType: "image/png", bytes: 3 }] });
    await h.sync.flushNow();
    const up = h.cloud.calls.findIndex((c) => c.startsWith("upload"));
    const ap = h.cloud.calls.findIndex((c) => c.startsWith("append s1 @0"));
    expect(up).toBeGreaterThanOrEqual(0);
    expect(up).toBeLessThan(ap);
    expect(h.cloud.blobs.get("a".repeat(64))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("taskSessionSync：拉", () => {
  it("云端多出来的尾巴 muted append 进本地、seq 一致、onPulled 收到、不回推", async () => {
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    // 另一台设备写了两条（人话 + 它握笔写的回复）
    await h.cloud.api.releasePen("s1", "desktop:A");
    await h.cloud.api.append("s1", 1, "desktop:B", [{ seq: 1, sessionId: "s1", ts: 5, type: "user_message", content: "from B" }]);
    await h.cloud.api.acquirePen("s1", "desktop:B", 30);
    await h.cloud.api.append("s1", 2, "desktop:B", [{ seq: 2, sessionId: "s1", ts: 6, type: "assistant_message", content: "B 答", model: "m" }]);
    const appendsBefore = h.cloud.calls.filter((c) => c.startsWith("append")).length;
    await h.sync.pullSession("s1", 2);
    expect(h.store.load("s1").map((e) => [e.seq, e.type])).toEqual([[0, "session_created"], [1, "user_message"], [2, "assistant_message"]]);
    expect(h.pulled).toEqual([{ id: "s1", events: expect.arrayContaining([expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })]) }]);
    await h.sync.flushNow();
    expect(h.cloud.calls.filter((c) => c.startsWith("append")).length).toBe(appendsBefore);
    expect(h.fileRef().sessions["s1"]).toEqual({ pushedUpTo: 2 });
  });
  it("sweep 领养本地没有的会话（手机 / 另一台电脑建的），从 seq 0 整份拉", async () => {
    const h = harness();
    await h.cloud.api.append("s9", 0, "desktop:B", [{ seq: 0, ...created("s9") } as SessionEvent, { seq: 1, sessionId: "s9", ts: 2, type: "user_message", content: "新" }]);
    await h.sync.pullNow();
    expect(h.store.has("s9")).toBe(true);
    expect(h.store.load("s9")).toHaveLength(2);
    expect(h.sync.state().kind).toBe("idle");
  });
  it("拉到带附件的事件：下载进本地库；下载不到留到下一次 sweep 再试", async () => {
    const h = harness();
    const hex = "b".repeat(64);
    await h.cloud.api.append("s9", 0, "desktop:B", [{ seq: 0, ...created("s9") } as SessionEvent, { seq: 1, sessionId: "s9", ts: 2, type: "user_message", content: "图", attachments: [{ id: `sha256:${hex}`, mediaType: "image/png", bytes: 2 }] }]);
    await h.sync.pullNow();
    expect(h.attachments.size).toBe(0);
    h.cloud.blobs.set(hex, new Uint8Array([7, 7]));
    await h.sync.pullNow();
    expect([...h.attachments.values()]).toEqual([new Uint8Array([7, 7])]);
  });
  it("云端那份含这个版本不认识的事件类型：落到那条为止 + frozen needs_upgrade；backfill 再给一次机会", async () => {
    // 另一台设备是新版本，写了这个版本的 persistencePolicy 没表过态的类型——store.append 对它抛
    // 裸 Error。不接住的话这一页整个 reject，而前面几条已经落盘了：本地既停不住也说不出为什么
    const h = harness();
    await h.cloud.api.append("s9", 0, "desktop:B", [
      { seq: 0, ...created("s9") } as SessionEvent,
      { seq: 1, sessionId: "s9", ts: 2, type: "user_message", content: "认得这条" },
      { seq: 2, sessionId: "s9", ts: 3, type: "from_the_future", payload: 1 } as unknown as SessionEvent,
      { seq: 3, sessionId: "s9", ts: 4, type: "user_message", content: "这条落不下来" },
    ]);
    await h.sync.pullNow();
    expect(h.store.load("s9").map((e) => e.seq)).toEqual([0, 1]); // 前缀留住了
    expect(h.fileRef().sessions["s9"]).toMatchObject({ pushedUpTo: 1, frozen: "needs_upgrade" });
    expect(h.sync.state().kind).toBe("error");
    // 冻着的时候再 sweep 一次也不动它（否则每 60 s 白跑一遍还把状态刷成 idle）
    await h.sync.pullNow();
    expect(h.store.load("s9").map((e) => e.seq)).toEqual([0, 1]);
    // 换个版本重开 app：needs_upgrade 是唯一会解冻的原因
    h.sync.backfill();
    expect(h.fileRef().sessions["s9"]!.frozen).toBeUndefined();
  });
  it("拉取时 store.append 因不相干的原因抛错（比如 SQLITE_BUSY）：TaskSyncError code=other，不当成 unknownType 冻结", async () => {
    // appendPulled 原来的 catch 把「不是 TaskSyncError 的抛错」一律当成「这个版本不认识的类型」——
    // 而 SQLITE_BUSY 这类瞬时故障和「类型不认识」是两回事，前者不该被冻成需要升级的终态。
    // session_created 是这个版本认得的类型（shouldPersist 对它返回 true），却因为不相干的
    // 原因（这里模拟 SQLITE_BUSY）抛了——这时该把原因原样抛出去，不该说「升级一下就好了」
    const h = harness();
    await h.cloud.api.append("s9", 0, "desktop:B", [{ seq: 0, ...created("s9") } as SessionEvent]);
    vi.spyOn(h.store, "append").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    await h.sync.pullNow();
    expect(h.sync.state()).toMatchObject({ kind: "error", message: "SQLITE_BUSY" });
    expect(h.fileRef().sessions["s9"]?.frozen).toBeUndefined();
  });
});

describe("taskSessionSync：冲突", () => {
  it("这条会话派过子智能体：分歧时冻结、绝不 purge（purge 会级联删掉子会话的日志）", async () => {
    // store.purge 按 session_created.spawnedBy 级联删子会话（ADR-0047），而子会话从来不上云——
    // 云端那份里没有它们。离线跑过一轮派活的 turn，一撞冲突就把子日志静默抹了
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    h.store.append(created("s1c", { spawnedBy: { sessionId: "s1", toolCallId: "t1", agent: "researcher" } }));
    h.store.append({ sessionId: "s1c", ts: 2, type: "user_message", content: "子会话干的活" });
    // 云端与本机在 seq 1 上各写了一条：真分歧
    await h.cloud.api.append("s1", 1, "desktop:A", [{ seq: 1, sessionId: "s1", ts: 5, type: "user_message", content: "云端那条" }]);
    h.store.append({ sessionId: "s1", ts: 6, type: "assistant_message", content: "本机那条", model: "m" });
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ frozen: "has_children_conflict" });
    expect(h.sync.state().kind).toBe("error");
    expect(h.store.load("s1c")).toHaveLength(2); // 子会话的日志一条没少
    expect(h.store.load("s1").map((e) => e.seq)).toEqual([0, 1]); // 本机那条也还在
    expect(h.replaced).toEqual([]);
  });
  it("云端那份含不认识的事件类型：先验再换——不 purge，本地那份原样留着", async () => {
    // replaceWithCloud 不是原子的：purge 先把本地抹了，再一条条灌云端那份。中间撞上这个版本
    // 读不懂的类型时 store.append 抛，于是本地留下一截半截日志——比停止同步坏得多
    const h = harness();
    h.store.append(created("s1"));
    await h.sync.flushNow();
    await h.cloud.api.append("s1", 1, "desktop:A", [{ seq: 1, sessionId: "s1", ts: 5, type: "from_the_future", payload: 1 } as unknown as SessionEvent]);
    h.store.append({ sessionId: "s1", ts: 6, type: "assistant_message", content: "本机那条", model: "m" });
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ frozen: "needs_upgrade" });
    expect(h.store.load("s1").map((e) => e.type)).toEqual(["session_created", "assistant_message"]);
    expect(h.replaced).toEqual([]);
  });
  it("purge 被真正的引用式分支拒绝：冻结成 purge_rejected（不是 detached），本地日志原地不动", async () => {
    // has_executor 分歧要把本地这段整份复制走再 purge 原会话——但如果这条会话本身是别的会话
    // store.fork() 出来的引用起点（issue #352 的零拷贝分支），store.purge 会拒绝：
    // 删父等于把分支的历史前缀连根抽走。冻结成终态，不能悄悄改成 detached（那会被下一条
    // 本地事件清掉，于是每写一条就整份重推一遍再被拒一次）
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    // 云端另一台设备写一条人话 + 一轮回复
    await h.cloud.api.append("s1", 2, "desktop:B", [{ seq: 2, sessionId: "s1", ts: 9, type: "user_message", content: "B 说" }]);
    await h.cloud.api.acquirePen("s1", "desktop:B", 30);
    await h.cloud.api.append("s1", 3, "desktop:B", [
      { seq: 3, sessionId: "s1", ts: 10, type: "assistant_message", content: "B 答", model: "m" },
      { seq: 4, sessionId: "s1", ts: 11, type: "turn_ended", outcome: "completed" },
    ]);
    await h.cloud.api.releasePen("s1", "desktop:B");
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "离线问" });
    h.store.append({ sessionId: "s1", ts: 4, type: "assistant_message", content: "离线答", model: "m" });
    h.store.append({ sessionId: "s1", ts: 5, type: "turn_ended", outcome: "completed" });
    // 真正的引用式分支，挂在本地这条 turn_ended（seq 4）上——不是 forkCopy 那种整份拷贝
    h.store.fork("s1", 4, "s1fork", 20);
    await h.sync.flushNow(); // 离线，推不出去
    h.cloud.setOffline(false);
    const before = h.store.load("s1");
    await h.sync.flushNow(); // 撞 seq_conflict → reconcile → has_executor → forkCopy 之后 purge 被 s1fork 拒绝
    expect(h.fileRef().sessions["s1"]).toMatchObject({ frozen: "purge_rejected" });
    expect(h.fileRef().sessions["s1"]!.detached).toBeUndefined();
    expect(h.sync.state().kind).toBe("error");
    expect(h.store.load("s1")).toEqual(before); // purge 从没成功过，原地不动
    expect(h.replaced).toEqual([]);
  });
});

describe("taskSessionSync：笔", () => {
  it("acquirePen：拿到 / 被占 / 离线 / 不是任务会话", async () => {
    const h = harness();
    h.store.append(created("s1"));
    h.store.append({ sessionId: "p1", ts: 1, type: "session_created", workspace: "/repo" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "acquired" });
    expect(h.sync.holdsPen("s1")).toBe(true);
    await h.sync.releasePen("s1");
    await h.cloud.api.acquirePen("s1", "cloud", 30);
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "held", by: "cloud", holderKind: "cloud" });
    h.cloud.setOffline(true);
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "offline" });
    h.cloud.setOffline(false);
    expect(await h.sync.acquirePen("p1")).toEqual({ kind: "off" });
  });
  it("云端还没有这条会话（刚建、还没推）：acquirePen 当拿到——建行那一批会发笔", async () => {
    const h = harness();
    h.store.append(created("s1"));
    expect(await h.sync.acquirePen("s1")).toEqual({ kind: "acquired" });
  });
  it("续期失败（笔已经在别人手上）：granted 也要清掉，不然 holdsPen 会一直说「握着」一支已经丢的笔", async () => {
    // 建行那一批 RPC 把笔发给我们，走的是 granted 这条路（不是 pens 那条），且顺手起了续期定时器。
    // renew() 撞上「续不上」时如果只 stopRenew 不清 granted，holdsPen 会永远报 true
    vi.useFakeTimers();
    try {
      const h = harness();
      h.store.append(created("s1"));
      await h.sync.flushNow();
      expect(h.sync.holdsPen("s1")).toBe(true);
      h.cloud.now.t += 40_000; // 过了 30 s TTL，我们那支笔到期
      await h.cloud.api.acquirePen("s1", "cloud", 30); // 另一台设备拿走
      await vi.advanceTimersByTimeAsync(PEN_RENEW_MS); // 触发下一次续期，撞见笔已经不是我们的了
      expect(h.sync.holdsPen("s1")).toBe(false);
      expect(h.penLost).toContain("s1");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("taskSessionSync：删除", () => {
  it("从没同步过的会话（项目会话 / 子会话）：deleted 不打云端 delete、状态不动；同步过的会话照常删", async () => {
    // file.sessions[id] 是唯一的证人：本地 purge 已经把日志抹了，isTask(id) 读不到 session_created
    // 了（#1223 复审）。"never-synced" 这个 id 从没被 touched() 过，游标里自然没有它的条目
    const h = harness();
    const stateBefore = h.sync.state();
    await h.sync.deleted("never-synced");
    expect(h.cloud.calls).not.toContain("delete never-synced");
    expect(h.sync.state()).toEqual(stateBefore);

    h.store.append(created("s1"));
    await h.sync.flushNow(); // 推过一轮：file.sessions["s1"] 有游标条目了
    await h.sync.deleted("s1");
    expect(h.cloud.calls).toContain("delete s1");
    expect(h.fileRef().sessions["s1"]).toBeUndefined();
  });
});
