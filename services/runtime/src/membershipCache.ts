// 在籍缓存 — workspace 成员查询的 60s 记忆化，fail-closed（ADR-0199）
// 查询抛错 = 拿不到，不代表"不在籍"；但也不写缓存，免得一次网络抖动把人锁 60s。
//
// 两个出口，差别只在**查询抛错那一格**（#957 终审 Critical 1）：
//   · isMember          → false（fail-closed，收帧那条同步路径用；发帧的人在线，
//                         看得见拒绝、能重发）
//   · isMemberOrUnknown → "unknown"（重启补跑那条路径用）。补跑发生在 daemon 刚
//     起来、N 条会话错峰查 Supabase 的那一刻——正是它最不稳的时候。那条路径上
//     "拿不到"被当成"不在籍"的后果是 append-only 的：每条排队消息落一条
//     turn_ended{error:"发起人已不在这个工作区"}，永远关口，用户看到的是"你被移出
//     了工作区"。**"查不到"与"确认不在"必须分得开**，因为两者该做的动作相反：
//     前者留着开场白等下一次重启，后者才写收口。

/** 在籍查询的三态：在籍 / 确认不在籍 / 这一刻查不出来 */
export type Membership = boolean | "unknown";

export interface MembershipCache {
  /** fail-closed：查询抛错→false；60s 内命中缓存 */
  isMember(workspaceId: string, uid: string): Promise<boolean>;
  /** 同 isMember，但查询抛错回 `"unknown"` 而不是 false —— 给"误判成本是
      永久收口"的调用方（重启补跑）用 */
  isMemberOrUnknown(workspaceId: string, uid: string): Promise<Membership>;
  invalidate(workspaceId: string): void;
}

interface Entry {
  at: number;
  members: Set<string>;
}

const DEFAULT_TTL_MS = 60_000;

export function createMembershipCache(
  query: (workspaceId: string) => Promise<Set<string>>, // 抛错 = 拿不到
  opts?: { ttlMs?: number; now?: () => number },
): MembershipCache {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const cache = new Map<string, Entry>();

  /** 两个出口共用的那一段：命中缓存 / 现查 / 查不到。抛错回 "unknown"，
      由调用方决定把它读成 false 还是别的——两个 API 只在这一格上分叉 */
  async function lookup(workspaceId: string, uid: string): Promise<Membership> {
    const entry = cache.get(workspaceId);
    if (entry && now() - entry.at < ttlMs) {
      return entry.members.has(uid);
    }

    let members: Set<string>;
    try {
      members = await query(workspaceId);
    } catch {
      // fail-closed：错误路径不写缓存
      return "unknown";
    }

    cache.set(workspaceId, { at: now(), members });
    return members.has(uid);
  }

  return {
    async isMember(workspaceId: string, uid: string): Promise<boolean> {
      const r = await lookup(workspaceId, uid);
      return r === true;
    },

    isMemberOrUnknown(workspaceId: string, uid: string): Promise<Membership> {
      return lookup(workspaceId, uid);
    },

    invalidate(workspaceId: string): void {
      cache.delete(workspaceId);
    },
  };
}
