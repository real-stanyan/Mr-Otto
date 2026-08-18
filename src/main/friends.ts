// friends — 好友系统主进程编排层。
// FriendsManager 只依赖窄接口 FriendsApi(真 supabase 组装隔离在
// supabaseFriendsApi.ts,同 account.ts 的 SupabaseLike 模式);单测注入假实现。
// 错误哲学:业务/网络失败 → FriendsResult ok:false(渲染层内联提示),不 throw。

import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, FriendshipEntry,
} from "../shared/friends.js";

export type ProfileRow = { id: string; email: string; name: string | null; avatar_url: string | null };
export type FriendshipRow = { id: string; requester: string; addressee: string; status: "pending" | "accepted" };
export type MessageRow = { id: number; sender: string; recipient: string; body: string; created_at: string };

export type FriendsApi = {
  getUserId(): Promise<string | null>;
  findProfileByEmail(email: string): Promise<ProfileRow | null>;
  insertFriendship(requester: string, addressee: string): Promise<void>;
  acceptFriendship(id: string): Promise<void>;
  deleteFriendship(id: string): Promise<void>;
  listFriendships(): Promise<FriendshipRow[]>;
  listProfiles(ids: string[]): Promise<ProfileRow[]>;
  insertMessage(sender: string, recipient: string, body: string): Promise<void>;
  listMessages(uid: string, friendId: string, beforeId?: number): Promise<MessageRow[]>;
  subscribe(uid: string, handlers: {
    onFriendshipsChange(): void;
    onMessage(row: MessageRow): void;
    onPresence(onlineIds: string[]): void;
  }): () => void;
};

export type FriendsPush = {
  friendsChanged(snapshot: FriendsSnapshot): void;
  presenceChanged(onlineUserIds: string[]): void;
  directMessage(message: DirectMessage): void;
};

export function toFriendProfile(row: ProfileRow): FriendProfile {
  return { id: row.id, email: row.email, name: row.name ?? "", avatarUrl: row.avatar_url ?? "" };
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

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const NOT_SIGNED_IN = "未登录,登录后才能用好友功能";

export class FriendsManager {
  private readonly api: FriendsApi;
  private readonly push: FriendsPush;
  private unsubscribe: (() => void) | null = null;
  // 世代计数:每次 start/teardown 自增。start 内每个 await 之后都核对世代号,
  // 号对不上说明中途被 stop()/新 start() 抢先,当次 start 自我作废(不订阅/不推/
  // 若已 subscribe 则立即退订),防"挂起的 start 在 stop 之后才落地"竞态
  private generation = 0;

  constructor(deps: { api: FriendsApi; push: FriendsPush }) {
    this.api = deps.api;
    this.push = deps.push;
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

  async sendMessage(friendId: string, body: string): Promise<FriendsResult<null>> {
    return this.withUid(async (uid) => {
      await this.api.insertMessage(uid, friendId, body);
      return null;
    });
  }

  async listMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>> {
    return this.withUid(async (uid) =>
      (await this.api.listMessages(uid, friendId, beforeId)).map(toDirectMessage)
    );
  }

  /** 登录后调:起 Realtime 订阅 + 推一次初始快照。幂等(重复 start 先 teardown) */
  async start(): Promise<void> {
    this.teardown();
    const gen = ++this.generation;
    const uid = await this.api.getUserId();
    if (gen !== this.generation) return; // stop() 或新 start() 已抢先,自我作废
    if (!uid) return;
    const unsubscribe = this.api.subscribe(uid, {
      onFriendshipsChange: () => { void this.pushSnapshot(uid).catch(() => {}); },
      onMessage: (row) => this.push.directMessage(toDirectMessage(row)),
      onPresence: (ids) => this.push.presenceChanged(ids),
    });
    if (gen !== this.generation) { unsubscribe(); return; } // 订阅已建立但世代已过期,立即退订别漏
    this.unsubscribe = unsubscribe;
    await this.pushSnapshot(uid).catch(() => {});
  }

  /** 内部:只退订不推。同时使任何挂起中的 start() 作废 */
  private teardown(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 登出时调:退订 + 推空快照/空在线集(UI 立即清) */
  stop(): void {
    this.teardown();
    this.push.friendsChanged({ friends: [], incoming: [], outgoing: [] });
    this.push.presenceChanged([]);
  }
}
