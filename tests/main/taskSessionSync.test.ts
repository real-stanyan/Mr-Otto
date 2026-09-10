// 复制器的核心路径（#1223）：推、拉（muted）、笔、离线、detached、附件。假 api 在内存里照 0036 的规矩行事
// （seq CAS、executor 类事件要笔、建行发笔），所以这里测的是「复制器 + RPC 语义」合起来对不对。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import { createTaskSessionSync, type TaskSessionSync, type TaskSessionSyncDeps } from "../../src/main/taskSessionSync.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi, type TaskSyncErrorCode } from "../../src/main/taskSessionsApi.js";
import type { TaskSyncFile } from "../../src/main/taskSyncStore.js";
import { HUMAN_EVENT_TYPES } from "../../src/shared/taskSync.js";
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
      if (!entry) {
        if (expected !== 0) throw new TaskSyncError("no_session", "no_session");
        entry = { row: { id, title: "", archived: false, last_seq: -1, pen_holder: holder, pen_until: new Date(now.t + 30_000).toISOString(), updated_at: new Date(now.t).toISOString() }, events: [] };
        rows.set(id, entry);
      }
      if (entry.row.last_seq + 1 !== expected) throw new TaskSyncError("seq_conflict", "seq_conflict");
      let seq = expected;
      for (const e of events) {
        if (e.seq !== seq) throw new TaskSyncError("seq_conflict", "seq_conflict");
        if (!HUMAN_EVENT_TYPES.has(e.type) && !penLive(entry.row, holder)) throw new TaskSyncError("pen_required", "pen_required");
        entry.events.push(e);
        seq++;
      }
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
  it("append 报 forbidden（RPC 判定这批不可重试）：detached + 状态 error，且不再对这条会话重试", async () => {
    // controller ruling（Task 7 复审带入 Task 10）：forbidden（P0012）是终态，不进 30s 重试循环——
    // 一条超限/畸形事件不该把这条会话的推送队列卡死；detached 只挡这一条会话，其余照常同步
    const h = harness();
    h.store.append(created("s1"));
    h.cloud.failAppendOnce("s1", "forbidden", "bad_request: event too large");
    await h.sync.flushNow();
    expect(h.fileRef().sessions["s1"]).toMatchObject({ detached: true });
    expect(h.sync.state().kind).toBe("error");
    const before = h.cloud.calls.filter((c) => c.startsWith("append")).length;
    await h.sync.flushNow();
    expect(h.cloud.calls.filter((c) => c.startsWith("append")).length).toBe(before);
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
});
