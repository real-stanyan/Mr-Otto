// friends — 好友系统主进程编排层。
// FriendsManager 只依赖窄接口 FriendsApi(真 supabase 组装隔离在
// supabaseFriendsApi.ts,同 account.ts 的 SupabaseLike 模式);单测注入假实现。
// 错误哲学:业务/网络失败 → FriendsResult ok:false(渲染层内联提示),不 throw。
//
// 这一层还负责"推送到底通不通"(ADR-0027):Realtime 是快的那条路,不是唯一那条路。
// 订阅报错/超时 → health 转 degraded → 起轮询兜底(关系链/收件箱/邀请),
// 并周期性重建订阅;订阅恢复 → 停轮询。在线状态永远是 presence ∪ 心跳窗口的并集,
// 因为线上 /realtime/v1 经 Kong 返 503(issue #77)时 presence 是空的,而心跳只要 REST 活着就准。

import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, FriendshipEntry,
  GameInvite, RealtimeHealth,
} from "../shared/friends.js";

// email 可空:auth.users.email 本就可为 null(手机/匿名注册),见 docs/adr/0025。
// null 只活到主进程边界为止,toFriendProfile 归一成 ""
export type ProfileRow = { id: string; email: string | null; name: string | null; avatar_url: string | null };
export type FriendshipRow = { id: string; requester: string; addressee: string; status: "pending" | "accepted" };
export type MessageRow = { id: number; sender: string; recipient: string; body: string; created_at: string };
export type InviteRow = {
  id: string; inviter: string; invitee: string; table_id: string; table_name: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  created_at: string; expires_at: string;
};
export type LastSeenRow = { id: string; last_seen_at: string | null };

export type FriendsSubscribeHandlers = {
  onFriendshipsChange(): void;
  onMessage(row: MessageRow): void;
  onPresence(onlineIds: string[]): void;
  onInvite(row: InviteRow): void;
  /** 订阅通道健康度:四条通道全 SUBSCRIBED 才算 live,任一报错/超时/关闭即 degraded */
  onHealth(health: "live" | "degraded"): void;
};

export type FriendsApi = {
  getUserId(): Promise<string | null>;
  findProfileByEmail(email: string): Promise<ProfileRow | null>;
  insertFriendship(requester: string, addressee: string): Promise<void>;
  acceptFriendship(id: string): Promise<void>;
  deleteFriendship(id: string): Promise<void>;
  listFriendships(): Promise<FriendshipRow[]>;
  listProfiles(ids: string[]): Promise<ProfileRow[]>;
  insertMessage(sender: string, recipient: string, body: string): Promise<MessageRow>;
  listMessages(uid: string, friendId: string, beforeId?: number): Promise<MessageRow[]>;
  /** 收件箱里 id 最大的一条(起订阅时定水位,免得把历史当新消息推一遍) */
  latestInboxId(uid: string): Promise<number>;
  /** 轮询兜底:发给我的、id 大于水位的消息(旧→新) */
  listInboxSince(uid: string, sinceId: number): Promise<MessageRow[]>;
  /** 心跳:把自己的 last_seen_at 写成现在 */
  touchPresence(uid: string): Promise<void>;
  /** 读一批人的心跳时间 */
  listLastSeen(ids: string[]): Promise<LastSeenRow[]>;
  insertInvite(inviter: string, invitee: string, tableId: string, tableName: string): Promise<InviteRow>;
  updateInviteStatus(id: string, status: "accepted" | "declined" | "cancelled"): Promise<void>;
  /** 与我有关的近期邀请(收发两向,含终态——邀请人要看得见"对方拒了") */
  listInvites(uid: string): Promise<InviteRow[]>;
  subscribe(uid: string, handlers: FriendsSubscribeHandlers): () => void;
};

export type FriendsPush = {
  friendsChanged(snapshot: FriendsSnapshot): void;
  presenceChanged(onlineUserIds: string[]): void;
  directMessage(message: DirectMessage): void;
  invitesChanged(invites: GameInvite[]): void;
  healthChanged(health: RealtimeHealth): void;
};

/** 可注入的时钟/定时器(单测不睡真时间) */
export type FriendsTimers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
};

const REAL_TIMERS: FriendsTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** 心跳写入间隔。窗口是它的 3 倍,漏一两拍不该把人判下线 */
export const HEARTBEAT_MS = 30_000;
/** 心跳在线窗口:last_seen 落在这个区间内算在线 */
export const PRESENCE_WINDOW_MS = 90_000;
/** degraded 时的轮询间隔。选 5s:聊天要跟得上说话节奏,又不至于把自托管实例压垮 */
export const DEGRADED_POLL_MS = 5_000;
/** degraded 时重建订阅的间隔(Realtime 修好了要能自己回到 live) */
export const RESUBSCRIBE_MS = 60_000;

export function toFriendProfile(row: ProfileRow): FriendProfile {
  return { id: row.id, email: row.email ?? "", name: row.name ?? "", avatarUrl: row.avatar_url ?? "" };
}

export function toDirectMessage(row: MessageRow): DirectMessage {
  return { id: row.id, sender: row.sender, recipient: row.recipient, body: row.body, createdAt: row.created_at };
}

/** 邀请行 + 对方 profile → 渲染层形态。profile 缺席 = 丢弃(别渲染幽灵,同 buildSnapshot) */
export function toGameInvite(
  uid: string, row: InviteRow, profiles: Map<string, ProfileRow>
): GameInvite | null {
  const incoming = row.invitee === uid;
  const peer = profiles.get(incoming ? row.inviter : row.invitee);
  if (!peer) return null;
  return {
    id: row.id,
    peer: toFriendProfile(peer),
    direction: incoming ? "incoming" : "outgoing",
    tableId: row.table_id,
    tableName: row.table_name,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** 关系行 + 对方 profile → 三组快照。profile 缺席的行丢弃(别渲染幽灵) */
export function buildSnapshot(
  uid: string, rows: FriendshipRow[], profiles: Map<string, ProfileRow>
): FriendsSnapshot {
  const friends: FriendshipEntry[] = [];
  const incoming: FriendshipEntry[] = [];
  const outgoing: FriendshipEntry[] = [];
  for (const row of rows) {
    const otherId = row.requester === uid ? row.addressee : row.requester;
    const other = profiles.get(otherId);
    if (!other) continue;
    const entry: FriendshipEntry = {
      friendshipId: row.id,
      profile: toFriendProfile(other),
      status: row.status,
      direction: row.requester === uid ? "outgoing" : "incoming",
    };
    if (row.status === "accepted") friends.push(entry);
    else (entry.direction === "incoming" ? incoming : outgoing).push(entry);
  }
  return { friends, incoming, outgoing };
}

/** 在线 = Realtime presence ∪ 心跳窗口内。两条腿,断一条还站得住(ADR-0027) */
export function presenceUnion(
  realtimeIds: string[], lastSeen: LastSeenRow[], nowMs: number, windowMs = PRESENCE_WINDOW_MS
): string[] {
  const ids = new Set(realtimeIds);
  for (const row of lastSeen) {
    if (!row.last_seen_at) continue;
    const at = Date.parse(row.last_seen_at);
    if (Number.isNaN(at)) continue;
    if (nowMs - at <= windowMs) ids.add(row.id);
  }
  return [...ids].sort();
}

/** 两个 id 集合是否等价(已排序的全量推送,不等才推——省掉无谓的渲染层重绘) */
export function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const NOT_SIGNED_IN = "未登录,登录后才能用好友功能";

export class FriendsManager {
  private readonly api: FriendsApi;
  private readonly push: FriendsPush;
  private readonly timers: FriendsTimers;
  private unsubscribe: (() => void) | null = null;
  // 世代计数:每次 start/teardown 自增。start 内每个 await 之后都核对世代号,
  // 号对不上说明中途被 stop()/新 start() 抢先,当次 start 自我作废(不订阅/不推/
  // 若已 subscribe 则立即退订),防"挂起的 start 在 stop 之后才落地"竞态
  private generation = 0;
  private health: RealtimeHealth = "connecting";
  /** Realtime presence 报来的在线集(degraded 时为空,靠心跳那条腿撑着) */
  private realtimeOnline: string[] = [];
  /** 上次推给渲染层的并集,只在变化时再推 */
  private pushedOnline: string[] = [];
  /** 最近一次读到的好友心跳时间(在线判断的第二条腿) */
  private lastSeen: LastSeenRow[] = [];
  /** 收件箱水位:只有 id 大于它的消息才算"新消息" */
  private inboxWatermark = 0;
  private heartbeatTimer: unknown = null;
  private pollTimer: unknown = null;
  private resubscribeTimer: unknown = null;

  constructor(deps: { api: FriendsApi; push: FriendsPush; timers?: FriendsTimers }) {
    this.api = deps.api;
    this.push = deps.push;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 所有方法共用的前置:拿 uid,没登录统一 ok:false */
  private async withUid<T>(fn: (uid: string) => Promise<T>): Promise<FriendsResult<T>> {
    try {
      const uid = await this.api.getUserId();
      if (!uid) return { ok: false, message: NOT_SIGNED_IN };
      return { ok: true, value: await fn(uid) };
    } catch (e) {
      return { ok: false, message: message(e) };
    }
  }

  private async snapshot(uid: string): Promise<FriendsSnapshot> {
    const rows = await this.api.listFriendships();
    const ids = [...new Set(rows.map((r) => (r.requester === uid ? r.addressee : r.requester)))];
    const profiles = new Map((await this.api.listProfiles(ids)).map((p) => [p.id, p]));
    return buildSnapshot(uid, rows, profiles);
  }

  /** 变更后重拉快照推给渲染层(本端操作与对端 Realtime 同一条出口) */
  private async pushSnapshot(uid: string): Promise<void> {
    this.push.friendsChanged(await this.snapshot(uid));
  }

  async search(email: string): Promise<FriendsResult<FriendProfile | null>> {
    return this.withUid(async () => {
      const row = await this.api.findProfileByEmail(email);
      return row ? toFriendProfile(row) : null;
    });
  }

  async sendRequest(userId: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      try {
        await this.api.insertFriendship(uid, userId);
      } catch (e) {
        // 无序对唯一索引冲突 = 重复请求/已是好友,给人话不给 SQL 报错
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
          throw new Error("已发过请求或已是好友");
        }
        throw e;
      }
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async respond(friendshipId: string, accept: boolean): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      if (accept) await this.api.acceptFriendship(friendshipId);
      else await this.api.deleteFriendship(friendshipId);
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async remove(friendshipId: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.deleteFriendship(friendshipId);
      await this.pushSnapshot(uid);
      return null;
    });
  }

  async list(): Promise<FriendsResult<FriendsSnapshot>> {
    return this.withUid((uid) => this.snapshot(uid));
  }

  /** 发消息回自己那条真行:渲染层拿真 id/时间戳直接落,不必再拉一整页回显 */
  async sendMessage(friendId: string, body: string): Promise<FriendsResult<DirectMessage>> {
    return this.withUid(async (uid) =>
      toDirectMessage(await this.api.insertMessage(uid, friendId, body))
    );
  }

  async listMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>> {
    return this.withUid(async (uid) =>
      (await this.api.listMessages(uid, friendId, beforeId)).map(toDirectMessage)
    );
  }

  // ── 牌局邀请 ────────────────────────────────────────────────────

  async sendInvite(friendId: string, tableId: string, tableName: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      try {
        await this.api.insertInvite(uid, friendId, tableId, tableName);
      } catch (e) {
        // pending 唯一索引冲突 = 已经邀过还没回应,给人话不给 SQL 报错
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
          throw new Error("已经邀过了,等对方回应");
        }
        throw e;
      }
      await this.pushInvites(uid);
      return null;
    });
  }

  /** 接受/拒绝一条收到的邀请。接受只改状态——买入是花真 token 的动作,
      必须由用户在牌桌页再确认一次(ADR-0021/0027),这里绝不代劳 */
  async respondInvite(inviteId: string, accept: boolean): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.updateInviteStatus(inviteId, accept ? "accepted" : "declined");
      await this.pushInvites(uid);
      return null;
    });
  }

  /** 撤回自己发出的邀请 */
  async cancelInvite(inviteId: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.updateInviteStatus(inviteId, "cancelled");
      await this.pushInvites(uid);
      return null;
    });
  }

  async listInvites(): Promise<FriendsResult<GameInvite[]>> {
    return this.withUid((uid) => this.invites(uid));
  }

  private async invites(uid: string): Promise<GameInvite[]> {
    const rows = await this.api.listInvites(uid);
    const ids = [...new Set(rows.map((r) => (r.invitee === uid ? r.inviter : r.invitee)))];
    const profiles = new Map((await this.api.listProfiles(ids)).map((p) => [p.id, p]));
    return rows
      .map((r) => toGameInvite(uid, r, profiles))
      .filter((x): x is GameInvite => x !== null);
  }

  private async pushInvites(uid: string): Promise<void> {
    this.push.invitesChanged(await this.invites(uid));
  }

  // ── 在线状态:presence ∪ 心跳 ───────────────────────────────────

  /** 并集变了才推。realtime presence 与心跳轮询都汇到这一个出口 */
  private pushPresence(): void {
    const merged = presenceUnion(this.realtimeOnline, this.lastSeen, this.timers.now());
    if (sameIds(merged, this.pushedOnline)) return;
    this.pushedOnline = merged;
    this.push.presenceChanged(merged);
  }

  /** 一拍心跳:写自己的 last_seen,读好友的。任一步失败都不该掀翻定时器 */
  private async beat(uid: string, gen: number): Promise<void> {
    try {
      await this.api.touchPresence(uid);
      const rows = await this.api.listFriendships();
      const ids = [...new Set(rows.map((r) => (r.requester === uid ? r.addressee : r.requester)))];
      const seen = ids.length > 0 ? await this.api.listLastSeen(ids) : [];
      if (gen !== this.generation) return;
      this.lastSeen = seen;
      this.pushPresence();
    } catch {
      // 心跳是尽力而为:一拍没成不改变在线判断(窗口是间隔的 3 倍,留得住)
    }
  }

  // ── 轮询兜底 ────────────────────────────────────────────────────

  private setHealth(health: RealtimeHealth): void {
    if (this.health === health) return;
    this.health = health;
    this.push.healthChanged(health);
  }

  /** degraded 一拍:关系链 + 收件箱增量 + 邀请。全部尽力而为,错了下一拍再来 */
  private async pollOnce(uid: string, gen: number): Promise<void> {
    try {
      await this.pushSnapshot(uid);
      const fresh = await this.api.listInboxSince(uid, this.inboxWatermark);
      if (gen !== this.generation) return;
      for (const row of fresh) {
        if (row.id > this.inboxWatermark) this.inboxWatermark = row.id;
        this.push.directMessage(toDirectMessage(row));
      }
      await this.pushInvites(uid);
    } catch {
      // 网络/RLS 抖动:保持 degraded,下一拍继续试
    }
  }

  private startPolling(uid: string, gen: number): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = this.timers.setInterval(() => {
      if (gen !== this.generation) return;
      void this.pollOnce(uid, gen);
    }, DEGRADED_POLL_MS);
    // 定时器要等第一个间隔才响,而"刚掉线"这一刻恰恰最需要立刻对齐一次
    void this.pollOnce(uid, gen);
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 登录后调:起 Realtime 订阅 + 心跳 + 推一次初始快照。幂等(重复 start 先 teardown) */
  async start(): Promise<void> {
    this.teardown();
    const gen = ++this.generation;
    const uid = await this.api.getUserId();
    if (gen !== this.generation) return; // stop() 或新 start() 已抢先,自我作废
    if (!uid) return;
    this.health = "connecting";
    this.push.healthChanged("connecting");
    // 水位先定在"现在":订阅/轮询只推此刻之后到达的消息,历史归 listMessages 管
    this.inboxWatermark = await this.api.latestInboxId(uid).catch(() => 0);
    if (gen !== this.generation) return;
    this.subscribeNow(uid, gen);
    if (gen !== this.generation) return;
    // 心跳与订阅健康度无关:presence 通不通,自己那一拍都得写(对端可能只有心跳这条腿)
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (gen !== this.generation) return;
      void this.beat(uid, gen);
    }, HEARTBEAT_MS);
    void this.beat(uid, gen);
    // degraded 时定期重建订阅:Realtime 修好了要能自己爬回 live,而不是等下次登录
    this.resubscribeTimer = this.timers.setInterval(() => {
      if (gen !== this.generation || this.health !== "degraded") return;
      this.subscribeNow(uid, gen);
    }, RESUBSCRIBE_MS);
    await this.pushSnapshot(uid).catch(() => {});
    if (gen !== this.generation) return;
    await this.pushInvites(uid).catch(() => {});
  }

  /** 建(或重建)四条 Realtime 通道。旧的先退订,健康度由通道状态驱动 */
  private subscribeNow(uid: string, gen: number): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const unsubscribe = this.api.subscribe(uid, {
      onFriendshipsChange: () => { void this.pushSnapshot(uid).catch(() => {}); },
      onMessage: (row) => {
        if (row.id > this.inboxWatermark) this.inboxWatermark = row.id;
        this.push.directMessage(toDirectMessage(row));
      },
      onPresence: (ids) => {
        this.realtimeOnline = ids;
        this.pushPresence();
      },
      onInvite: () => { void this.pushInvites(uid).catch(() => {}); },
      onHealth: (health) => {
        if (gen !== this.generation) return;
        this.setHealth(health);
        if (health === "live") {
          this.stopPolling();
        } else {
          // 掉线时 presence 的 key 集不再可信(它只反映"还连着的人"),
          // 清掉让心跳那条腿独自说话,否则会留下一屋子假在线
          this.realtimeOnline = [];
          this.pushPresence();
          this.startPolling(uid, gen);
        }
      },
    });
    if (gen !== this.generation) { unsubscribe(); return; } // 订阅已建立但世代已过期,立即退订别漏
    this.unsubscribe = unsubscribe;
  }

  /** 内部:只退订不推。同时使任何挂起中的 start() 作废 */
  private teardown(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPolling();
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.resubscribeTimer !== null) {
      this.timers.clearInterval(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    this.realtimeOnline = [];
    this.lastSeen = [];
    this.pushedOnline = [];
  }

  /** 登出时调:退订 + 推空快照/空在线集(UI 立即清) */
  stop(): void {
    this.teardown();
    this.health = "connecting";
    this.push.friendsChanged({ friends: [], incoming: [], outgoing: [] });
    this.push.presenceChanged([]);
    this.push.invitesChanged([]);
    this.push.healthChanged("connecting");
  }
}
