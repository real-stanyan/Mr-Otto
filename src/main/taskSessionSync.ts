// 任务会话云端日志的桌面复制器（#1223，spec §3.6）。同 memorySync 的形状：本地写完 → 推；
// realtime / 登录 / 唤醒 / 聚焦 / 60 s sweep → 拉。云端那份是事实，本机 sqlite 是它的前缀副本。
//
// 三条纪律：
//  1. 拉进来的事件 muted：观察者跳过它们，游标直接推到那个 seq——否则拉下来又推回去。
//  2. 推 executor 类事件之前先拿笔（同 holder 再调 = 续期，幂等）；笔被别人握着就留在脏集合等
//     realtime 推来「笔空了」。人话免笔，照推。
//  3. 本地永远不因为云端行消失而删数据：no_session → detached、停止同步、照样可读；之后本地再有
//     事件就从 seq 0 整份重推 = 重新建行。
// 冲突（seq_conflict）在 reconcile：重叠段逐条相等只是游标陈旧；真分歧按「云端赢、纯人为动作重放、
// 含 turn 痕迹分叉」处理（spec §3.6，tests/main/taskSessionSync.conflict.test.ts）。
import type { SessionEvent } from "../session/events.js";
import type { EventStore, NewSessionEvent } from "../session/store.js";
import { newSessionId } from "../shared/sessionId.js";
import { retargetForImport } from "../shared/sessionPackage.js";
import {
  attachmentRefsOf, divergence, holderKindOf, isTaskSessionCreated, PEN_RENEW_MS, PEN_TTL_S, PEN_VERDICTS, PULL_PAGE,
  sliceBatches, TASK_EVENT_MAX_BYTES, type ExecutorKind, type HolderKind,
} from "../shared/taskSync.js";
import type { TaskSyncState } from "../shared/taskSyncState.js";
import { TaskSyncError, type TaskSessionRow, type TaskSessionsApi } from "./taskSessionsApi.js";
import type { TaskSyncFile } from "./taskSyncStore.js";

export type { TaskSyncState } from "../shared/taskSyncState.js";

export type PenOutcome =
  | { kind: "acquired" }
  | { kind: "held"; by: string; holderKind: HolderKind | null }
  | { kind: "offline" }
  | { kind: "off" };

export interface TaskSessionSyncDeps {
  store: Pick<EventStore, "load" | "append" | "lastSeq" | "has" | "sessions" | "purge">;
  api: TaskSessionsApi;
  uid: () => string | null;
  /** 笔的持有人标识：desktop:<deviceId> */
  holder: string;
  /** 这台设备的人话名，落进 executor_changed.label */
  label: string;
  file: { load(): TaskSyncFile; save(f: TaskSyncFile): void };
  /** 附件字节：read 未命中回 null（不抛）；save 内容寻址落盘 */
  attachments: { read(id: string): Uint8Array | null; save(bytes: Uint8Array): { id: string } };
  /** turn 在跑的会话不做 purge/重拉那种动本地日志的事，留到收口后 */
  isRunning: (sessionId: string) => boolean;
  /** 拉进来的事件（已带本地 seq）：主进程推给渲染层、刷 fleet、看要不要起 turn */
  onPulled: (sessionId: string, events: SessionEvent[]) => void;
  /** 本地日志被整份换成云端那份之后（冲突处理）：渲染层要重载 */
  onReplaced: (sessionId: string) => void;
  onPenChanged?: (sessionId: string, holder: string | null) => void;
  /** 续期失败 = 笔已在别人手上：主进程该把正在跑的 turn 以 interrupted 停掉 */
  onPenLost?: (sessionId: string) => void;
  onExecutorSwitch?: (sessionId: string, to: ExecutorKind) => void;
  onState?: (s: TaskSyncState) => void;
  now?: () => number;
  debounceMs?: number;
  retryMs?: number;
  sweepMs?: number;
}

export interface TaskSessionSync {
  touched(event: SessionEvent): void;
  acquirePen(sessionId: string): Promise<PenOutcome>;
  releasePen(sessionId: string): Promise<void>;
  holdsPen(sessionId: string): boolean;
  pullNow(): Promise<void>;
  pullSession(sessionId: string, cloudLastSeq?: number): Promise<void>;
  flushNow(): Promise<void>;
  backfill(): void;
  deleted(sessionId: string): Promise<void>;
  markOfflineRun(sessionId: string): void;
  state(): TaskSyncState;
  start(): void;
  stop(): void;
  dispose(): void;
}

const HEX_OF = (ref: string): string => ref.slice("sha256:".length);
const MAX_FLUSH_ROUNDS = 3;

export function createTaskSessionSync(deps: TaskSessionSyncDeps): TaskSessionSync {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? 200;
  const retryMs = deps.retryMs ?? 30_000;
  const sweepMs = deps.sweepMs ?? 60_000;

  const file = deps.file.load();
  const save = (): void => deps.file.save(file);
  const dirty = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  const taskCache = new Map<string, boolean>();
  const pens = new Map<string, ReturnType<typeof setInterval>>();
  /** 建行那一批 RPC 顺手发给我们的笔（还没起续期定时器）：holdsPen / releasePen 都要认它 */
  const granted = new Set<string>();
  const uploaded = new Set<string>();
  const missingAttachments = new Map<string, Set<string>>();
  let muted = false;
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let flushing: Promise<void> | null = null;
  let lastSyncedAt: number | null = null;
  let current: TaskSyncState = { kind: "off", reason: null };

  const setState = (s: TaskSyncState): void => {
    current = s;
    deps.onState?.(s);
  };
  const ensure = (id: string) => (file.sessions[id] ??= { pushedUpTo: -1 });
  const isTask = (id: string): boolean => {
    const cached = taskCache.get(id);
    if (cached !== undefined) return cached;
    const first = deps.store.load(id, { untilSeq: 0 })[0];
    const v = isTaskSessionCreated(first);
    if (first !== undefined) taskCache.set(id, v);
    return v;
  };
  /** 同一条会话的推 / 拉 / 对账串行（同 frameHandler 按 cid 串行的做法）：前一件抛了也接着跑下一件 */
  const serialize = (id: string, fn: () => Promise<void>): Promise<void> => {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    });
    chains.set(id, next);
    return next;
  };
  const scheduleRetry = (): void => {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, retryMs);
  };
  const fail = (err: unknown): void => {
    if (err instanceof TaskSyncError && err.code === "missing_schema") {
      setState({ kind: "off", reason: "云端还没有任务会话表（migration 0036 未执行）" });
      return;
    }
    setState({ kind: "error", message: err instanceof Error ? err.message : String(err), lastSyncedAt });
    scheduleRetry();
  };

  // ── 笔 ──
  const holdsPen = (id: string): boolean => pens.has(id) || granted.has(id);
  const stopRenew = (id: string): void => {
    const t = pens.get(id);
    if (t !== undefined) {
      clearInterval(t);
      pens.delete(id);
    }
  };
  const renew = async (id: string): Promise<void> => {
    try {
      const r = await deps.api.acquirePen(id, deps.holder, PEN_TTL_S);
      if (!r.ok) {
        stopRenew(id);
        deps.onPenLost?.(id);
      }
    } catch (err) {
      // 断网续不上不算丢：笔到期前回网就续上了；真过期了下一次推会撞 pen_required 再重拿
      if (err instanceof TaskSyncError && (err.code === "network" || err.code === "missing_schema")) return;
      stopRenew(id);
      deps.onPenLost?.(id);
    }
  };
  const startRenew = (id: string): void => {
    if (pens.has(id)) return;
    const t = setInterval(() => void renew(id), PEN_RENEW_MS);
    t.unref?.(); // 别让一支还握着的笔拖住进程退出（before-quit 会 stop()）
    pens.set(id, t);
  };
  async function acquirePen(id: string): Promise<PenOutcome> {
    if (disposed || !deps.uid() || !isTask(id)) return { kind: "off" };
    try {
      const r = await deps.api.acquirePen(id, deps.holder, PEN_TTL_S);
      if (r.ok) {
        startRenew(id);
        return { kind: "acquired" };
      }
      return { kind: "held", by: r.holder ?? "", holderKind: holderKindOf(r.holder) };
    } catch (err) {
      if (err instanceof TaskSyncError) {
        // 云端还没这条会话（刚建 / 离线建的）：建行那一批 RPC 会把笔发给创建者
        if (err.code === "no_session") return { kind: "acquired" };
        if (err.code === "network" || err.code === "missing_schema") return { kind: "offline" };
      }
      throw err;
    }
  }
  async function releasePen(id: string): Promise<void> {
    if (!pens.has(id) && !granted.has(id)) return;
    stopRenew(id);
    granted.delete(id);
    try {
      await deps.api.releasePen(id, deps.holder);
    } catch {
      // 放不掉就让它过期（30 s）：对面最多多等半分钟，不值得为此报错
    }
  }

  // ── 推 ──
  const scheduleFlush = (): void => {
    if (flushTimer !== null || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, debounceMs);
  };
  function touched(event: SessionEvent): void {
    if (disposed || muted) return;
    const id = event.sessionId;
    if (!isTask(id)) return;
    const st = ensure(id);
    if (st.detached) {
      // 云端行没了之后本地又续聊：从 seq 0 整份重推 = 重新建行
      delete st.detached;
      st.pushedUpTo = -1;
      save();
    }
    dirty.add(id);
    scheduleFlush();
  }
  async function uploadRef(uid: string, ref: string): Promise<void> {
    const hex = HEX_OF(ref);
    if (uploaded.has(hex)) return;
    const bytes = deps.attachments.read(ref);
    if (bytes === null) return; // 本机没有这份字节（旧库 / 另一台机器建的）：引用照推，拉的那头画占位
    await deps.api.uploadAttachment(uid, hex, bytes);
    uploaded.add(hex);
  }
  async function pushSession(uid: string, id: string): Promise<void> {
    const st = ensure(id);
    if (st.detached) return;
    const tail = deps.store.load(id, { afterSeq: st.pushedUpTo });
    if (tail.length === 0) return;
    for (const e of tail) for (const ref of attachmentRefsOf(e)) await uploadRef(uid, ref);
    // 建行那一批（pushedUpTo === -1）不用先拿笔：RPC 建行时把笔发给创建者
    const needsPen = st.pushedUpTo >= 0 && tail.some((e) => PEN_VERDICTS[e.type] === "executor");
    if (needsPen && !holdsPen(id)) {
      const pen = await acquirePen(id);
      if (pen.kind !== "acquired") {
        dirty.add(id); // 笔被占 / 离线：留着，realtime 推来笔空了或回网时再推
        return;
      }
    }
    for (const batch of sliceBatches(tail, TASK_EVENT_MAX_BYTES)) {
      const expected = batch[0]!.seq;
      const done = (last: number): void => {
        st.pushedUpTo = last;
        save();
        if (expected === 0) granted.add(id); // 建行那一批：RPC 把笔发给了我们（spec 实施偏差 3）
      };
      try {
        done(await deps.api.append(id, expected, deps.holder, batch));
      } catch (err) {
        if (!(err instanceof TaskSyncError)) throw err;
        if (err.code === "seq_conflict") {
          await reconcile(uid, id);
          return;
        }
        if (err.code === "pen_required") {
          const again = await acquirePen(id);
          if (again.kind !== "acquired") {
            deps.onPenLost?.(id);
            dirty.add(id);
            return;
          }
          done(await deps.api.append(id, expected, deps.holder, batch));
          continue;
        }
        if (err.code === "no_session") {
          st.detached = true;
          save();
          return;
        }
        if (err.code === "forbidden") {
          // controller ruling（Task 7 复审带入 Task 10）：RPC 判定这批不可重试（畸形 / 超限 / 不是
          // 我们的会话）——终态，不进 30s 重试循环，别让一条超限事件卡死这条会话的推送队列；
          // detached 只挡这一条会话，其余会话照常同步
          st.detached = true;
          save();
          setState({ kind: "error", message: `会话 ${id} 的云端副本已停止同步：${err.message}`, lastSyncedAt });
          return;
        }
        throw err;
      }
    }
  }
  async function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      const uid = deps.uid();
      if (!uid) {
        setState({ kind: "off", reason: "未登录" });
        return;
      }
      if (dirty.size === 0) return;
      setState({ kind: "syncing" });
      try {
        // 按轮推：一轮拿一份快照，处理中被重新标脏的（对账后还有尾巴要推）留到下一轮。
        // 封顶三轮——turn 在跑 / 笔被占那种「每次都把自己标回脏」的会话不能把这个循环变成死循环，
        // 剩下的由 scheduleRetry / realtime 再来
        for (let round = 0; round < MAX_FLUSH_ROUNDS && dirty.size > 0; round++) {
          const batch = [...dirty];
          dirty.clear();
          for (const id of batch) {
            try {
              await serialize(id, () => pushSession(uid, id));
            } catch (err) {
              dirty.add(id);
              throw err;
            }
          }
        }
        lastSyncedAt = now();
        // forbidden 分支已经把状态钉成了 error（终态、不重试）——这里不能无条件覆盖成 idle，
        // 否则 controller ruling 要的「状态保持 error」在同一次 flush 收尾时就被抹掉了；
        // 没有会话触发那条分支时 current 仍是这次 flush 开头设的 syncing，照常转 idle
        if (current.kind !== "error") setState({ kind: "idle", lastSyncedAt });
      } catch (err) {
        fail(err);
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  // ── 拉 ──
  async function fetchAttachments(uid: string, id: string, events: readonly SessionEvent[]): Promise<void> {
    for (const e of events) {
      for (const ref of attachmentRefsOf(e)) {
        if (deps.attachments.read(ref) !== null) continue;
        try {
          const bytes = await deps.api.downloadAttachment(uid, HEX_OF(ref));
          if (bytes !== null) {
            deps.attachments.save(bytes);
            continue;
          }
        } catch {
          // 落到下面记 missing
        }
        (missingAttachments.get(id) ?? missingAttachments.set(id, new Set()).get(id)!).add(ref);
      }
    }
  }
  async function retryMissingAttachments(uid: string): Promise<void> {
    for (const [id, refs] of missingAttachments) {
      for (const ref of [...refs]) {
        if (deps.attachments.read(ref) !== null) {
          refs.delete(ref);
          continue;
        }
        try {
          const bytes = await deps.api.downloadAttachment(uid, HEX_OF(ref));
          if (bytes !== null) {
            deps.attachments.save(bytes);
            refs.delete(ref);
          }
        } catch {
          // 下次再试
        }
      }
      if (refs.size === 0) missingAttachments.delete(id);
    }
  }
  /** 把云端事件（带云端 seq）muted 追加进本地，断言本地分到同一个 seq */
  function appendPulled(id: string, events: readonly SessionEvent[]): SessionEvent[] {
    const appended: SessionEvent[] = [];
    muted = true;
    try {
      for (const e of events) {
        const { seq: _seq, ...rest } = e;
        const got = deps.store.append(rest as NewSessionEvent);
        if (got.seq !== e.seq) throw new TaskSyncError("other", `拉取时 seq 对不上：本地 ${got.seq} 云端 ${e.seq}`);
        appended.push(got);
      }
    } finally {
      muted = false;
    }
    return appended;
  }
  async function pullInner(uid: string, id: string, cloudLast?: number): Promise<void> {
    const st = ensure(id);
    if (st.detached) return;
    let local = deps.store.has(id) ? deps.store.lastSeq(id) : -1;
    if (cloudLast !== undefined && cloudLast <= local) {
      if (cloudLast < local) {
        dirty.add(id); // 本地领先：走推的路（撞 seq_conflict 就对账）
        scheduleFlush();
      }
      return;
    }
    for (;;) {
      const page = await deps.api.pullEvents(uid, id, local, PULL_PAGE);
      const fresh: SessionEvent[] = [];
      for (const e of page) {
        if (e.seq <= local) continue;
        if (e.seq !== local + 1) break; // 有洞：等下一次
        fresh.push(e);
        local = e.seq;
      }
      if (fresh.length === 0) break;
      const appended = appendPulled(id, fresh);
      st.pushedUpTo = Math.max(st.pushedUpTo, local);
      save();
      await fetchAttachments(uid, id, appended);
      for (const e of appended) if (e.type === "executor_changed") deps.onExecutorSwitch?.(id, e.executor);
      deps.onPulled(id, appended);
      if (page.length < PULL_PAGE) break;
    }
  }
  async function pullSession(id: string, cloudLast?: number): Promise<void> {
    const uid = deps.uid();
    if (!uid || disposed) return;
    await serialize(id, () => pullInner(uid, id, cloudLast));
  }
  async function handleRow(uid: string, row: TaskSessionRow): Promise<void> {
    deps.onPenChanged?.(row.id, row.pen_holder);
    const local = deps.store.has(row.id) ? deps.store.lastSeq(row.id) : -1;
    if (row.last_seq > local) await serialize(row.id, () => pullInner(uid, row.id, row.last_seq));
    else if (row.last_seq < local) {
      dirty.add(row.id);
      scheduleFlush();
    }
  }
  async function pullNow(): Promise<void> {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) {
      setState({ kind: "off", reason: "未登录" });
      return;
    }
    setState({ kind: "syncing" });
    try {
      const rows = await deps.api.listChanged(uid, file.lastSweepIso);
      let latest = file.lastSweepIso;
      for (const row of rows) {
        await handleRow(uid, row);
        if (latest === null || row.updated_at > latest) latest = row.updated_at;
      }
      file.lastSweepIso = latest;
      save();
      await retryMissingAttachments(uid);
      lastSyncedAt = now();
      setState({ kind: "idle", lastSyncedAt });
    } catch (err) {
      fail(err);
    }
  }

  // ── 冲突：云端赢，本机不丢（spec §3.6） ──
  async function pullAll(uid: string, id: string, afterSeq: number): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let after = afterSeq;
    for (;;) {
      const page = await deps.api.pullEvents(uid, id, after, PULL_PAGE);
      out.push(...page);
      if (page.length < PULL_PAGE) return out;
      after = page.at(-1)!.seq;
    }
  }
  function replaceWithCloud(id: string, cloudFull: readonly SessionEvent[]): void {
    muted = true;
    try {
      deps.store.purge(id);
      taskCache.delete(id);
      for (const e of cloudFull) {
        const { seq: _seq, ...rest } = e;
        deps.store.append(rest as NewSessionEvent);
      }
    } finally {
      muted = false;
    }
  }
  /** 本地那截含 turn 痕迹的分歧：整份复制成一条独立会话（不是 store.fork 的引用式——引用式会让
      接下来的 purge 被拒），标题带「（本机未同步的分支）」，让它自己作为新会话上云 */
  function forkCopy(localFull: readonly SessionEvent[], title: string | null): void {
    const forkId = newSessionId();
    muted = true;
    try {
      for (const e of retargetForImport(localFull, forkId)) deps.store.append(e as NewSessionEvent);
      deps.store.append({ sessionId: forkId, ts: now(), type: "session_renamed", title: `${title ?? "会话"}（本机未同步的分支）` });
    } finally {
      muted = false;
    }
    file.sessions[forkId] = { pushedUpTo: -1 };
    dirty.add(forkId);
    save();
  }
  async function reconcile(uid: string, id: string): Promise<void> {
    const st = ensure(id);
    if (deps.isRunning(id)) {
      dirty.add(id); // turn 在跑不动本地日志，收口后再对账
      scheduleRetry();
      return;
    }
    const row = await deps.api.getSession(uid, id);
    if (row === null) {
      st.detached = true;
      save();
      return;
    }
    const cloudTail = await pullAll(uid, id, st.pushedUpTo);
    const localTail = deps.store.load(id, { afterSeq: st.pushedUpTo });
    const d = divergence(localTail, cloudTail);
    if (d.kind === "none") {
      // 游标陈旧：重叠段已经在云端了。谁长谁短决定接下来推还是拉
      const overlap = Math.min(localTail.length, cloudTail.length);
      st.pushedUpTo += overlap;
      save();
      if (cloudTail.length > overlap) {
        const appended = appendPulled(id, cloudTail.slice(overlap));
        st.pushedUpTo = appended.at(-1)?.seq ?? st.pushedUpTo;
        save();
        await fetchAttachments(uid, id, appended);
        deps.onPulled(id, appended);
      } else if (localTail.length > overlap) {
        dirty.add(id);
        scheduleFlush();
      }
      return;
    }
    const localFull = deps.store.load(id);
    const title = deps.store.sessions().find((s) => s.sessionId === id)?.title ?? null;
    const cloudFull = await pullAll(uid, id, -1);
    try {
      if (d.kind === "has_executor") forkCopy(localFull, title);
      replaceWithCloud(id, cloudFull);
    } catch (err) {
      // purge 被拒（这条会话有真正的引用式分支）：停止同步、本地照读，不硬来
      st.detached = true;
      save();
      throw err;
    }
    st.pushedUpTo = cloudFull.at(-1)?.seq ?? -1;
    save();
    deps.onReplaced(id);
    if (d.kind === "human_only") {
      // 纯人为动作重放到云端日志之后：不 muted，走观察者 → 脏 → 正常推
      for (const e of localTail.filter((x) => x.seq >= d.at)) {
        const { seq: _seq, ...rest } = e;
        deps.store.append(rest as NewSessionEvent);
      }
    }
  }

  // ── 生命周期 ──
  function backfill(): void {
    // 未归档先推、归档的排后面（Set 按插入序），一条一条来
    const rows = [...deps.store.sessions()].sort((a, b) => Number(a.archived) - Number(b.archived));
    for (const s of rows) {
      if (s.spawnedFrom !== null || !isTask(s.sessionId)) continue;
      if (file.sessions[s.sessionId] === undefined) dirty.add(s.sessionId);
    }
    if (dirty.size > 0) scheduleFlush();
  }
  function start(): void {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) return;
    stop();
    backfill();
    void pullNow();
    unsub = deps.api.subscribe(uid, (row) => {
      void handleRow(uid, row).catch((err) => fail(err));
    });
    sweepTimer = setInterval(() => void pullNow(), sweepMs);
    sweepTimer.unref?.();
  }
  function stop(): void {
    unsub?.();
    unsub = null;
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const id of new Set([...pens.keys(), ...granted])) void releasePen(id);
  }

  return {
    touched,
    acquirePen,
    releasePen,
    holdsPen,
    pullNow,
    pullSession,
    flushNow: () => flush(),
    backfill,
    async deleted(id) {
      stopRenew(id);
      granted.delete(id);
      delete file.sessions[id];
      dirty.delete(id);
      taskCache.delete(id);
      save();
      const uid = deps.uid();
      if (!uid) return;
      try {
        await deps.api.deleteSession(uid, id);
      } catch (err) {
        fail(err);
      }
    },
    markOfflineRun(id) {
      ensure(id).offlineRun = true;
      save();
    },
    state: () => current,
    start,
    stop,
    dispose() {
      disposed = true;
      stop();
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    },
  };
}
