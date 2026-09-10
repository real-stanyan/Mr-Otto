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
//
// detached 与 frozen 是**两种**停止同步（#1223 复审）：detached 是「云端那行没了」，下一条本地事件
// 把它清掉、从 seq 0 重新建行；frozen 是终态，任何本地事件都不清它——因为它记的正是「再试一次也
// 一样」（RPC 拒收这批 / 冲突不敢动本地日志 / 这个版本读不懂云端那份）。只有 needs_upgrade 会在
// backfill（换了个版本重开 app）时解冻一次。
import type { SessionEvent } from "../session/events.js";
import { shouldPersist } from "../session/persistencePolicy.js";
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
  store: Pick<EventStore, "load" | "append" | "lastSeq" | "has" | "sessions" | "purge" | "forkOrigin">;
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

/** 停止同步的四种终态原因（落进 task-sync.json 的 frozen 字段）。只有 needs_upgrade 会被 backfill
    解冻——换个版本重开 app 之后这个版本可能就认得那条事件了；另外三条要人介入 */
type FreezeReason = "forbidden" | "has_children_conflict" | "needs_upgrade" | "purge_rejected";
/** 四种原因各自的人话。**不许出现「重试」字样**（#1223 终审 I2）：freeze 恰恰不 scheduleRetry，
    只有 needs_upgrade 会在下次 backfill 时自己解冻，所以只有它说得出「会自动恢复」 */
const FREEZE_MESSAGE: Record<FreezeReason, (id: string, detail: string) => string> = {
  forbidden: (id, detail) => `会话 ${id} 的云端副本已停止同步：${detail}`,
  has_children_conflict: (id) => `会话 ${id} 有子智能体会话，云端与本机分歧未自动处理，已停止同步`,
  needs_upgrade: (id) => `会话 ${id} 含这个版本不认识的事件类型；升级 Mr Otto 后会自动恢复`,
  purge_rejected: (id) => `会话 ${id} 有引用式分支，云端与本机分歧未自动处理，已停止同步`,
};

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
  let sweeping: Promise<void> | null = null;
  let lastSyncedAt: number | null = null;
  let current: TaskSyncState = { kind: "off", reason: null };

  /** 最近一次 freeze 的会话（本进程内）。重启后没有这份记忆，退回「file.sessions 里最后一条冻着的」 */
  let lastFrozenId: string | null = null;
  const freezeMessageOf = (id: string): string => {
    const st = file.sessions[id];
    const fn = FREEZE_MESSAGE[st?.frozen as FreezeReason] as ((id: string, detail: string) => string) | undefined;
    return fn ? fn(id, st?.frozenDetail ?? "") : `会话 ${id} 的云端副本已停止同步`;
  };
  const frozenSummary = (): { count: number; message: string } | null => {
    let count = 0;
    let lastInFile: string | null = null;
    let preferred: string | null = null;
    for (const [id, st] of Object.entries(file.sessions)) {
      if (st.frozen === undefined) continue;
      count++;
      lastInFile = id;
      if (id === lastFrozenId) preferred = id;
    }
    const pick = preferred ?? lastInFile;
    return pick === null ? null : { count, message: freezeMessageOf(pick) };
  };
  /** 发布 / 读取前过一层（#1223 终审 I2）：冻结是**持久**事实（task-sync.json 的 frozen），而
      idle/syncing 是这一轮的瞬态——不叠上去的话，下一轮 flush 开头那句 syncing 就把「这条会话已
      停止同步」抹掉了，收尾再写一句「任务会话已与账号同步」。
      error 照发（瞬态失败仍要看得见，过了自然回 frozen）；off 照发（未登录 / 没建表是整体关着，
      不是某几条会话的事） */
  const visible = (s: TaskSyncState): TaskSyncState => {
    if (s.kind === "off" || s.kind === "error") return s;
    const f = frozenSummary();
    return f === null ? s : { kind: "frozen", count: f.count, message: f.message, lastSyncedAt };
  };
  const setState = (s: TaskSyncState): void => {
    current = s;
    deps.onState?.(visible(s));
  };
  const ensure = (id: string) => (file.sessions[id] ??= { pushedUpTo: -1 });
  const isTask = (id: string): boolean => {
    const cached = taskCache.get(id);
    if (cached !== undefined) return cached;
    // 引用式分支（「回到这一步」，store.fork 的零拷贝那种）不上云（#1223 终审 C2）：它自己的第一条
    // 原始行是 session_created{forkedFrom, seq = endSeq+1}，而 load() 扁平化后前缀是父会话的
    // 0..endSeq——推上去的流里于是有**两条** session_created（seq 0 与 endSeq+1），0036 的
    // 「session_created only at seq 0」判它 P0012 → freeze(forbidden)，这条会话永久冻结。
    // 判在 isTask 里 = touched / backfill / deleted 一律当它不是任务会话（代价：任务会话的
    // 「回到这一步」分支只在本机，spec §7）
    if (deps.store.forkOrigin(id) !== null) {
      taskCache.set(id, false);
      return false;
    }
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
  /** 这条会话停止同步，终态（#1223 复审 I6）：落盘一个原因，而不是像 detached 那样被下一条本地
      事件清掉。不 scheduleRetry——「再试一次也一样」正是它记的那件事；别的会话照常同步 */
  const frozenOf = (id: string): string | undefined => file.sessions[id]?.frozen;
  const freeze = (id: string, reason: FreezeReason, detail?: string): void => {
    const st = ensure(id);
    st.frozen = reason;
    // 原话跟着落盘（#1223 终审 I2）：重启之后账号页那行仍然说得出「为什么停了」
    if (detail !== undefined && detail !== "") st.frozenDetail = detail;
    else delete st.frozenDetail;
    save();
    lastFrozenId = id;
    // 发 frozen 不发 error：error 那句文案写着「会自动重试」，而这条恰恰不 scheduleRetry
    const f = frozenSummary() ?? { count: 1, message: freezeMessageOf(id) };
    setState({ kind: "frozen", count: f.count, message: f.message, lastSyncedAt });
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
        granted.delete(id); // 笔已经不是我们的了：holdsPen 不能再报 true（#1223 复审）
        deps.onPenLost?.(id);
      }
    } catch (err) {
      // 断网续不上不算丢：笔到期前回网就续上了；真过期了下一次推会撞 pen_required 再重拿
      if (err instanceof TaskSyncError && (err.code === "network" || err.code === "missing_schema")) return;
      stopRenew(id);
      granted.delete(id);
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
    if (st.frozen !== undefined) return; // 终态：本地照写照读，只是不再往云上推（detached 会被清、它不会）
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
    if (st.detached || st.frozen !== undefined) return;
    const tail = deps.store.load(id, { afterSeq: st.pushedUpTo });
    if (tail.length === 0) return;
    for (const e of tail) for (const ref of attachmentRefsOf(e)) await uploadRef(uid, ref);
    // 推送方为了落这一批 executor 事件临时拿到的笔（自己 acquire 的、或建行那一批 RPC 发下来的）：
    // 推完就放（#1223 终审 C1）。三处 releasePen 调用点全在 index.ts 的 driveTurn 里，只服务
    // 「turn 的笔」——这两支没人放的话，一次 backfill + flush 之后每条任务会话都被本机永久握笔、
    // 各起一个 10 s 的续期定时器，第二台电脑永远看到「另一台电脑正在回复」
    let borrowedPen = false;
    try {
      // 建行那一批（pushedUpTo === -1）不用先拿笔：RPC 建行时把笔发给创建者
      const needsPen = st.pushedUpTo >= 0 && tail.some((e) => PEN_VERDICTS[e.type] === "executor");
      if (needsPen && !holdsPen(id)) {
        const pen = await acquirePen(id);
        if (pen.kind !== "acquired") {
          dirty.add(id); // 笔被占 / 离线：留着，realtime 推来笔空了或回网时再推
          return;
        }
        borrowedPen = true;
      }
      const batches = sliceBatches(tail, TASK_EVENT_MAX_BYTES);
      // i 只在这一批真推上去之后才 ++：pen_required 重拿笔之后要走**同一套**分类重跑这一批，
      // 而不是在 catch 里裸 await 一次 append（那一次的失败没有任何人分类，直接冒出去成了整轮的错）
      let retriedPenAt = -1;
      for (let i = 0; i < batches.length; ) {
        const batch = batches[i]!;
        const expected = batch[0]!.seq;
        const done = (last: number): void => {
          st.pushedUpTo = last;
          save();
          if (expected === 0) {
            // 建行那一批：RPC 把笔发给了我们（spec 实施偏差 3）。**同时起续期**——只记 granted 的话
            // holdsPen 永远说「握着」，而云端那支 30 s 就过期了，下一条 executor 事件撞 pen_required
            granted.add(id);
            startRenew(id);
            borrowedPen = true;
          }
        };
        try {
          done(await deps.api.append(id, expected, deps.holder, batch));
          i++;
        } catch (err) {
          if (!(err instanceof TaskSyncError)) throw err;
          if (err.code === "seq_conflict") {
            await reconcile(uid, id);
            return;
          }
          if (err.code === "pen_required") {
            if (retriedPenAt === i) {
              // 这一批已经重拿过一次笔了还是不行：别原地打转，留给下一轮
              deps.onPenLost?.(id);
              dirty.add(id);
              return;
            }
            retriedPenAt = i;
            const again = await acquirePen(id);
            if (again.kind !== "acquired") {
              deps.onPenLost?.(id);
              dirty.add(id);
              return;
            }
            borrowedPen = true;
            continue; // i 不动：同一批重来一次，成败照样过上面那套分类
          }
          if (err.code === "no_session") {
            st.detached = true;
            save();
            return;
          }
          if (err.code === "forbidden") {
            // controller ruling（Task 7 复审带入 Task 10）：RPC 判定这批不可重试（畸形 / 超限 / 不是
            // 我们的会话）——终态，不进 30s 重试循环，别让一条超限事件卡死这条会话的推送队列。
            // 用 frozen 不用 detached：detached 会被下一条本地事件清掉（那是「重新建行」的信号），
            // 于是每写一条就重新整份推一遍、再被拒一次——一条超限事件变成每条事件一次全量往返
            freeze(id, "forbidden", err.message);
            return;
          }
          throw err;
        }
      }
    } finally {
      // turn 在跑（isRunning）时不放：那支笔是 turn 的，由 driveTurn 收口时放。准入那条路
      // （index.ts 的 needsPen && !holdsPen）会自己再拿一次——多一次 RPC 换「没在跑就不占笔」
      if (borrowedPen && !deps.isRunning(id)) await releasePen(id);
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
          for (let i = 0; i < batch.length; i++) {
            try {
              await serialize(batch[i]!, () => pushSession(uid, batch[i]!));
            } catch (err) {
              // 挂掉的那条**和这一批里还没轮到的那些**一起放回脏集合：只放回挂掉的那条，
              // 后面那些就随 dirty.clear() 一起没了——一条会话推挂了，同批的其余会话
              // 到下一次本地写事件之前谁也不会再推它们（离线时同批全军覆没）
              for (const rest of batch.slice(i)) dirty.add(rest);
              throw err;
            }
          }
        }
        // 封顶三轮之后还有脏的（笔被占 / turn 在跑那种「每轮把自己标回脏」的）：安排一次重试。
        // 不安排的话它要等到下一次本地事件或 realtime 推行才动——而这两件事都可能不再发生
        if (dirty.size > 0) scheduleRetry();
        lastSyncedAt = now();
        // 这一轮冻过会话的话，这句 idle 会被 visible() 叠回 frozen（#1223 终审 I2：冻结是持久事实，
        // 不能被下一句瞬态状态抹掉）。error 那道守卫留着：瞬态失败仍要看得见，别被收尾这句盖掉
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
  /** 把云端事件（带云端 seq）muted 追加进本地，断言本地分到同一个 seq。
      unknownType = 撞上这个版本不认识的事件类型（persistencePolicy 的 assertNever 抛的是裸 Error）：
      停在那一条，已经落下的仍然是云端那份的一段合法**前缀**，由调用方冻结这条会话 */
  function appendPulled(id: string, events: readonly SessionEvent[]): { appended: SessionEvent[]; unknownType: boolean } {
    const appended: SessionEvent[] = [];
    muted = true;
    try {
      for (const e of events) {
        const { seq: _seq, ...rest } = e;
        let got: SessionEvent;
        try {
          got = deps.store.append(rest as NewSessionEvent);
        } catch (err) {
          if (err instanceof TaskSyncError) throw err;
          // 只有「这个版本真不认得这个类型」才算 unknownType（冻成 needs_upgrade）；别的抛错
          // （SQLITE_BUSY 之类的瞬时故障）不该被当成需要升级——那会把一次可以重试的故障
          // 错误地冻成终态。shouldPersist 本身对陌生类型也抛裸 Error，一并接住当「不认识」
          let known = false;
          try {
            known = shouldPersist(e.type);
          } catch {
            known = false;
          }
          if (!known) return { appended, unknownType: true };
          throw new TaskSyncError("other", err instanceof Error ? err.message : String(err));
        }
        if (got.seq !== e.seq) throw new TaskSyncError("other", `拉取时 seq 对不上：本地 ${got.seq} 云端 ${e.seq}`);
        appended.push(got);
      }
    } finally {
      muted = false;
    }
    return { appended, unknownType: false };
  }
  async function pullInner(uid: string, id: string, cloudLast?: number): Promise<void> {
    const st = ensure(id);
    if (st.detached || st.frozen !== undefined) return;
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
      let next = local;
      for (const e of page) {
        if (e.seq <= next) continue;
        if (e.seq !== next + 1) break; // 有洞：等下一次
        fresh.push(e);
        next = e.seq;
      }
      if (fresh.length === 0) break;
      const { appended, unknownType } = appendPulled(id, fresh);
      // 游标只推到**真落下来**的那一条：撞上不认识的类型时 next 已经跑到整页末尾了
      local = appended.at(-1)?.seq ?? local;
      st.pushedUpTo = Math.max(st.pushedUpTo, local);
      save();
      await fetchAttachments(uid, id, appended);
      for (const e of appended) if (e.type === "executor_changed") deps.onExecutorSwitch?.(id, e.executor);
      if (appended.length > 0) deps.onPulled(id, appended);
      if (unknownType) {
        // 别的设备是新版本，写了这个版本读不懂的事件：本地留住前缀，停在这里等升级
        freeze(id, "needs_upgrade");
        return;
      }
      if (page.length < PULL_PAGE) break;
    }
  }
  async function pullSession(id: string, cloudLast?: number): Promise<void> {
    const uid = deps.uid();
    if (!uid || disposed) return;
    await serialize(id, () => pullInner(uid, id, cloudLast));
  }
  async function handleRow(uid: string, row: TaskSessionRow): Promise<void> {
    if (frozenOf(row.id) !== undefined) return; // 终态：realtime 推来的行也不再动它
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
    // 同 flushing：sweep 定时器 / realtime / 聚焦可能同时叫它，两轮并着跑会对同一批行重复处理，
    // 还会把 lastSweepIso 写成两边交叉的值
    if (sweeping) return sweeping;
    sweeping = (async () => {
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
        // 同 flush 末尾那条：冻结由 visible() 叠在 idle 上（终审 I2），error 那道守卫留着
        if (current.kind !== "error") setState({ kind: "idle", lastSyncedAt });
      } catch (err) {
        fail(err);
      }
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
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
    // 这份分叉是 muted 造出来的，观察者一条都没看见——不自己安排一次推的话它只是躺在本地
    scheduleFlush();
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
        const { appended, unknownType } = appendPulled(id, cloudTail.slice(overlap));
        st.pushedUpTo = appended.at(-1)?.seq ?? st.pushedUpTo;
        save();
        await fetchAttachments(uid, id, appended);
        // 与 pullInner 同一条：拉进来的改道事件要通知主进程，不然「云端接手了」这件事只有
        // 走 pullInner 那条路时才说得出口，走对账这条路就静默了
        for (const e of appended) if (e.type === "executor_changed") deps.onExecutorSwitch?.(id, e.executor);
        if (appended.length > 0) deps.onPulled(id, appended);
        if (unknownType) {
          freeze(id, "needs_upgrade");
          return;
        }
      } else if (localTail.length > overlap) {
        dirty.add(id);
        scheduleFlush();
      }
      return;
    }
    // 真分歧了。接下来这条路会 purge 本地这条会话——而 purge **级联删掉它派出去的子会话**
    // （store.purge 按 session_created.spawnedBy 找，ADR-0047），子会话从来不上云、云端那份
    // 里没有它们，于是一次冲突处理会静默抹掉离线跑那轮派出去的全部子日志。有子会话就不碰，
    // 冻结并说清（#1223 复审 C1）
    if (deps.store.sessions().some((row) => row.spawnedFrom === id)) {
      freeze(id, "has_children_conflict");
      return;
    }
    const localFull = deps.store.load(id);
    const title = deps.store.sessions().find((s) => s.sessionId === id)?.title ?? null;
    const cloudFull = await pullAll(uid, id, -1);
    // 先验再换（#1223 复审 I7）：云端那份可能是新版本写的，含这个版本不认识的事件类型——
    // 而 store.append 对这种类型会抛（persistencePolicy 的 assertNever）。purge 之后才发现
    // 就是半截日志：本地那份已经没了，云端那份只灌进去一部分
    for (const e of cloudFull) {
      let ok = false;
      try {
        ok = shouldPersist(e.type);
      } catch {
        ok = false;
      }
      if (!ok) {
        freeze(id, "needs_upgrade");
        return;
      }
    }
    try {
      if (d.kind === "has_executor") forkCopy(localFull, title);
      replaceWithCloud(id, cloudFull);
    } catch {
      // purge 被拒（这条会话有真正的引用式分支，store.fork 的零拷贝那种）：冻结终态、本地
      // 照读，不硬来。不能用 detached——那会被下一条本地事件清掉（「重新建行」的信号），
      // 于是每写一条就整份重推一遍再被拒一次
      freeze(id, "purge_rejected");
      return;
    }
    st.pushedUpTo = cloudFull.at(-1)?.seq ?? -1;
    save();
    deps.onReplaced(id);
    if (d.kind === "human_only") {
      // 纯人为动作重放到云端日志之后：不 muted，走观察者 → 脏 → 正常推
      // 分歧在 seq 0 时这一截的头一条就是本地那条 session_created——重放它等于给这条会话
      // 追加第二条「会话已创建」，投影层从此读到两个开头
      for (const e of localTail.filter((x) => x.seq >= d.at && x.type !== "session_created")) {
        const { seq: _seq, ...rest } = e;
        deps.store.append(rest as NewSessionEvent);
      }
    }
  }

  // ── 生命周期 ──
  function backfill(): void {
    // backfill 跑在装配 / 登录那一刻 = 「这个版本重新开始」：needs_upgrade 冻的那些再给一次机会
    // （这个版本可能就认得那条事件了）。另外两种原因不解冻——再试一次的结果一样
    for (const [id, st] of Object.entries(file.sessions)) {
      if (st.frozen === "needs_upgrade") {
        delete st.frozen;
        save();
        dirty.add(id);
      }
    }
    // 未归档先推、归档的排后面（Set 按插入序），一条一条来
    const rows = [...deps.store.sessions()].sort((a, b) => Number(a.archived) - Number(b.archived));
    for (const s of rows) {
      if (s.spawnedFrom !== null || !isTask(s.sessionId)) continue;
      const st = file.sessions[s.sessionId];
      if (st === undefined) {
        dirty.add(s.sessionId);
        continue;
      }
      // 游标比本地日志短 = 上次推到一半就退出了（观察者那条 touched 只活在内存里）。
      // 不补的话这条会话要等下一次本地写事件才会被想起来，而它可能再也不会有下一条
      if (!st.detached && st.frozen === undefined && st.pushedUpTo < deps.store.lastSeq(s.sessionId)) dirty.add(s.sessionId);
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
      // 从没同步过（项目会话 / 子会话——isTask 从没让 touched 给它 ensure 过 file.sessions[id]）：
      // 云端压根没有这一行，不打 delete。这里已经在本地 purge 之后，isTask(id) 读不到日志了，
      // 只有游标文件能作证（#1223 复审）
      if (file.sessions[id] === undefined) return;
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
    state: () => visible(current),
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
