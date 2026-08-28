// friends — 好友系统主进程编排层。
// FriendsManager 只依赖窄接口 FriendsApi(真 supabase 组装隔离在
// supabaseFriendsApi.ts,同 account.ts 的 SupabaseLike 模式);单测注入假实现。
// 错误哲学:业务/网络失败 → FriendsResult ok:false(渲染层内联提示),不 throw。
//
// 这一层还负责"推送到底通不通"(ADR-0027):Realtime 是快的那条路,不是唯一那条路。
// 订阅报错/超时 → health 转 degraded → 起轮询兜底(关系链/收件箱),
// 并周期性重建订阅;订阅恢复 → 停轮询。在线状态永远是 presence ∪ 心跳窗口的并集,
// 因为线上 /realtime/v1 经 Kong 返 503(issue #77)时 presence 是空的,而心跳只要 REST 活着就准。

import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, FriendshipEntry,
  FriendWorkspace, RealtimeHealth, WorkspacePresence, WorkspacesSnapshot,
} from "../shared/friends.js";

// email 可空:auth.users.email 本就可为 null(手机/匿名注册),见 docs/adr/0025。
// null 只活到主进程边界为止,toFriendProfile 归一成 ""
export type ProfileRow = { id: string; email: string | null; name: string | null; avatar_url: string | null };
export type FriendshipRow = { id: string; requester: string; addressee: string; status: "pending" | "accepted" };
export type MessageRow = { id: number; sender: string; recipient: string; body: string; created_at: string };
/** 心跳行。repo_key/repo_branch 是 0008 加的列:心跳那条腿顺便把"我在哪"带上(issue #167),
    可选是因为没跑 0008 的库 select 不到这两列——此时只有在线点,没有分支 */
export type LastSeenRow = {
  id: string; last_seen_at: string | null;
  repo_key?: string | null; repo_branch?: string | null;
};

/** Realtime presence 一条:key 即 uid,meta 里可能带工作区 */
export type PresenceEntry = { id: string; workspace: WorkspacePresence | null };

export type FriendsSubscribeHandlers = {
  onFriendshipsChange(): void;
  onMessage(row: MessageRow): void;
  /** presence sync:在线的人 + 各自 track 出来的工作区(没带的为 null) */
  onPresence(entries: PresenceEntry[]): void;
  /** 订阅通道健康度:所有通道全 SUBSCRIBED 才算 live,任一报错/超时/关闭即 degraded */
  onHealth(health: "live" | "degraded"): void;
};

export type FriendsApi = {
  getUserId(): Promise<string | null>;
  /** 用户名/邮箱模糊搜索(ilike 子串匹配),按名字序返回一小页 */
  searchProfiles(query: string): Promise<ProfileRow[]>;
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
  /** 心跳:把自己的 last_seen_at 写成现在,顺带写"我在哪"(null = 不在任何有 origin 的仓库里) */
  touchPresence(uid: string, workspace: WorkspacePresence | null): Promise<void>;
  /** Realtime 那条腿的"我在哪":重新 track 当前 presence 通道的 meta。未订阅时是空操作 */
  trackWorkspace(workspace: WorkspacePresence | null): void;
  /** 读一批人的心跳时间 */
  listLastSeen(ids: string[]): Promise<LastSeenRow[]>;
  subscribe(uid: string, handlers: FriendsSubscribeHandlers): () => void;
};

export type FriendsPush = {
  friendsChanged(snapshot: FriendsSnapshot): void;
  presenceChanged(onlineUserIds: string[]): void;
  /** 我 + 在线好友各自在哪个仓库哪个分支(issue #167) */
  workspacesChanged(snapshot: WorkspacesSnapshot): void;
  directMessage(message: DirectMessage): void;
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

/** 好友在哪 = Realtime meta 优先,没有就取心跳窗口内的 repo_key 列(两条腿,同 presenceUnion)。
    只产出有 repoKey 的人——在线但不在仓库里的不是本功能要画的对象 */
export function workspaceUnion(
  realtime: PresenceEntry[], lastSeen: LastSeenRow[], nowMs: number, windowMs = PRESENCE_WINDOW_MS
): FriendWorkspace[] {
  const out = new Map<string, FriendWorkspace>();
  for (const row of lastSeen) {
    if (!row.last_seen_at || !row.repo_key) continue;
    const at = Date.parse(row.last_seen_at);
    if (Number.isNaN(at) || nowMs - at > windowMs) continue;
    out.set(row.id, { userId: row.id, repoKey: row.repo_key, branch: row.repo_branch ?? null });
  }
  for (const e of realtime) {
    if (!e.workspace) continue; // 老客户端只 track 了 {at},没有工作区:让心跳那条腿说话
    out.set(e.id, { userId: e.id, ...e.workspace });
  }
  return [...out.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** 两个 id 集合是否等价(已排序的全量推送,不等才推——省掉无谓的渲染层重绘) */
export function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameWorkspace(a: WorkspacePresence | null, b: WorkspacePresence | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.repoKey === b.repoKey && a.branch === b.branch;
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
  /** 同上,但带 meta(工作区)。两者来自同一次 sync,拆开存只是因为在线点的消费者不关心 meta */
  private realtimeEntries: PresenceEntry[] = [];
  /** 我此刻在哪。由 setWorkspace 喂进来,心跳和 track 都从这里取 */
  private workspace: WorkspacePresence | null = null;
  /** 上次推出去的工作区快照(序列化后比对,变了才推) */
  private pushedWorkspaces = "";
  /** 最近一拍心跳读到的好友 id 集:Realtime 通道是全站的,工作区只放行好友的 */
  private friendIds = new Set<string>();
  /** 已 start 且拿到 uid:setWorkspace 要立刻补一拍心跳时用 */
  private uid: string | null = null;
  /** 最近一次推给渲染层的那份快照里,**已接受**的好友 uid 集。
      null = 还没推过任何快照(没登录 / 首次快照还没到) —— 这个区别对好友代理是硬要求:
      它把「名单未知」当拒绝处理,拿空集冒充就成了「所有人都不是好友」(issue #665) */
  private acceptedUids: Map<string, string> | null = null;
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

  /** 好友代理的第二道闸读的那份名单(issue #665)。**每一份新鲜快照都顺手更新它**,
      而不是另起一条拉取 —— 两份名单迟早不一样。于是这道闸的新鲜度恰好等于
      用户在界面上看到的那份:Realtime 推、轮询兜底、渲染层拉,三条路都会喂到它 */
  private cacheAccepted(snap: FriendsSnapshot): void {
    // 顺手记下人话名字:好友代理要拿它当代理工具的描述前缀(issue #670)。
    // 同一份快照里取,不另起一条查询 —— 理由同上
    this.acceptedUids = new Map(
      snap.friends.map((e) => [e.profile.id, e.profile.name || e.profile.email])
    );
  }

  /** 变更后重拉快照推给渲染层(本端操作与对端 Realtime 同一条出口) */
  private async pushSnapshot(uid: string): Promise<void> {
    const snap = await this.snapshot(uid);
    this.cacheAccepted(snap);
    this.push.friendsChanged(snap);
  }

  /** 已接受的好友 uid 集;**null = 还没同步好**。好友代理拿它当第二道闸
      (ADR-0151 决策 1:friendships 被删除 = 代理权限跟着死) */
  acceptedFriendUids(): readonly string[] | null {
    return this.acceptedUids === null ? null : [...this.acceptedUids.keys()];
  }

  /** 好友的人话名字(名字为空就退回邮箱)。查不到回空串 —— 调用方自己决定退回什么 */
  friendLabel(uid: string): string {
    return this.acceptedUids?.get(uid) ?? "";
  }

  async search(query: string): Promise<FriendsResult<FriendProfile[]>> {
    return this.withUid(async (uid) => {
      const rows = await this.api.searchProfiles(query);
      // 自己不出现在结果里:对自己"发请求"没有意义,过滤比 UI 特判干净
      return rows.filter((r) => r.id !== uid).map(toFriendProfile);
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
    return this.withUid(async (uid) => {
      const snap = await this.snapshot(uid);
      this.cacheAccepted(snap); // 拉一次也算一次新鲜快照(见 cacheAccepted)
      return snap;
    });
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

  // ── 在线状态:presence ∪ 心跳 ───────────────────────────────────

  /** 并集变了才推。realtime presence 与心跳轮询都汇到这一个出口 */
  private pushPresence(): void {
    const merged = presenceUnion(this.realtimeOnline, this.lastSeen, this.timers.now());
    if (!sameIds(merged, this.pushedOnline)) {
      this.pushedOnline = merged;
      this.push.presenceChanged(merged);
    }
    this.pushWorkspaces();
  }

  /** 工作区快照:我 + 好友。Realtime 通道是全站的,这里按好友集过滤一遍 */
  private pushWorkspaces(): void {
    const friends = workspaceUnion(
      this.realtimeEntries.filter((e) => this.friendIds.has(e.id)),
      this.lastSeen, this.timers.now()
    );
    const snapshot: WorkspacesSnapshot = { mine: this.workspace, friends };
    const key = JSON.stringify(snapshot);
    if (key === this.pushedWorkspaces) return;
    this.pushedWorkspaces = key;
    this.push.workspacesChanged(snapshot);
  }

  /** 渲染层/主进程 watcher 报"我现在在哪"。变了就两条腿都立刻更新:
      track 重写 presence meta,心跳提前一拍把列写掉(不等 30s 的定时器) */
  setWorkspace(workspace: WorkspacePresence | null): void {
    if (sameWorkspace(this.workspace, workspace)) return;
    this.workspace = workspace;
    this.api.trackWorkspace(workspace);
    if (this.uid) void this.beat(this.uid, this.generation);
    this.pushWorkspaces();
  }

  /** 一拍心跳:写自己的 last_seen,读好友的。任一步失败都不该掀翻定时器 */
  private async beat(uid: string, gen: number): Promise<void> {
    try {
      await this.api.touchPresence(uid, this.workspace);
      const rows = await this.api.listFriendships();
      const ids = [...new Set(rows.map((r) => (r.requester === uid ? r.addressee : r.requester)))];
      if (gen !== this.generation) return;
      this.friendIds = new Set(ids);
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

  /** degraded 一拍:关系链 + 收件箱增量。全部尽力而为,错了下一拍再来 */
  private async pollOnce(uid: string, gen: number): Promise<void> {
    try {
      await this.pushSnapshot(uid);
      const fresh = await this.api.listInboxSince(uid, this.inboxWatermark);
      if (gen !== this.generation) return;
      for (const row of fresh) {
        if (row.id > this.inboxWatermark) this.inboxWatermark = row.id;
        this.push.directMessage(toDirectMessage(row));
      }
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

  /** 当前登录用户的 uid,没登录/还没 start 完回 null。
      好友代理要拿它当应用层身份(proxy_req.fromUid / 查白名单,issue #657):
      AccountInfo 里刻意没有 uid(那四个字段是给渲染层看的),而这里本来就缓存着一份 */
  currentUid(): string | null {
    return this.uid;
  }

  /** 登录后调:起 Realtime 订阅 + 心跳 + 推一次初始快照。幂等(重复 start 先 teardown) */
  async start(): Promise<void> {
    this.teardown();
    const gen = ++this.generation;
    const uid = await this.api.getUserId();
    if (gen !== this.generation) return; // stop() 或新 start() 已抢先,自我作废
    if (!uid) return;
    this.uid = uid;
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
  }

  /** 建(或重建) Realtime 通道。旧的先退订,健康度由通道状态驱动 */
  private subscribeNow(uid: string, gen: number): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const unsubscribe = this.api.subscribe(uid, {
      onFriendshipsChange: () => { void this.pushSnapshot(uid).catch(() => {}); },
      onMessage: (row) => {
        if (row.id > this.inboxWatermark) this.inboxWatermark = row.id;
        this.push.directMessage(toDirectMessage(row));
      },
      onPresence: (entries) => {
        this.realtimeEntries = entries;
        this.realtimeOnline = entries.map((e) => e.id).sort();
        this.pushPresence();
      },
      onHealth: (health) => {
        if (gen !== this.generation) return;
        this.setHealth(health);
        if (health === "live") {
          this.stopPolling();
        } else {
          // 掉线时 presence 的 key 集不再可信(它只反映"还连着的人"),
          // 清掉让心跳那条腿独自说话,否则会留下一屋子假在线
          this.realtimeOnline = [];
          this.realtimeEntries = [];
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
    this.uid = null;
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
    this.realtimeEntries = [];
    this.lastSeen = [];
    this.pushedOnline = [];
    this.pushedWorkspaces = "";
    this.friendIds = new Set();
    // 退回「还不知道」而不是「一个好友都没有」:登出/重连期间代理该拒,
    // 但拒的理由是「名单没同步好」,不是「你们不是好友了」
    this.acceptedUids = null;
  }

  /** 登出时调:退订 + 推空快照/空在线集(UI 立即清) */
  stop(): void {
    this.teardown();
    this.health = "connecting";
    this.push.friendsChanged({ friends: [], incoming: [], outgoing: [] });
    this.push.presenceChanged([]);
    // 自己在哪不随登出清(那是本机事实),好友那半清空
    this.push.workspacesChanged({ mine: this.workspace, friends: [] });
    this.push.healthChanged("connecting");
  }
}
