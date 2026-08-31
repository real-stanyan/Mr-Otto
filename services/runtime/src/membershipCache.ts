// 在籍缓存 — workspace 成员查询的 60s 记忆化，fail-closed（ADR-0199）
// 查询抛错 = 拿不到，不代表"不在籍"；但也不写缓存，免得一次网络抖动把人锁 60s。

export interface MembershipCache {
  /** fail-closed：查询抛错→false；60s 内命中缓存 */
  isMember(workspaceId: string, uid: string): Promise<boolean>;
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

  return {
    async isMember(workspaceId: string, uid: string): Promise<boolean> {
      const entry = cache.get(workspaceId);
      if (entry && now() - entry.at < ttlMs) {
        return entry.members.has(uid);
      }

      let members: Set<string>;
      try {
        members = await query(workspaceId);
      } catch {
        // fail-closed：错误路径不写缓存
        return false;
      }

      cache.set(workspaceId, { at: now(), members });
      return members.has(uid);
    },

    invalidate(workspaceId: string): void {
      cache.delete(workspaceId);
    },
  };
}
