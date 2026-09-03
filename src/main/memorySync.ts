// 记忆跟账号走（#852，ADR-0206）：本地 memories/** 是缓存，云端 memory_docs 是账号级副本。
// 两个触发点——本地写完（memoryFiles.onWrite / LocalWorld.onConfigWrite）→ 防抖上传；
// 登录恢复 → 全量对账（planReconcile）。刻意不做定时轮询（同 pxAuditSync）。
// 离线/未登录：pending 留着不打网络，会话照常开始——「先落盘再喂模型」的节奏不变。
// 从云端写本地那一刻 muted：否则写本地 → touched → 再推回去，死循环。
import { planReconcile } from "../shared/memoryReconcile.js";
import type { MemoryDocsApi } from "./memoryDocsApi.js";
import type { MemoryFiles } from "./memoryFiles.js";

export type MemorySyncState =
  | { kind: "off" }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null };

export interface MemorySyncDeps {
  files: Pick<MemoryFiles, "walk" | "read" | "write" | "remove">;
  api: MemoryDocsApi;
  uid: () => string | null;
  debounceMs?: number;
  retryMs?: number;
  now?: () => number;
  onState?: (s: MemorySyncState) => void;
}

export interface MemorySync {
  touched(rel: string): void;
  pullNow(): Promise<"synced" | "skipped" | "failed">;
  flushNow(): Promise<void>;
  state(): MemorySyncState;
  dispose(): void;
}

export function createMemorySync(deps: MemorySyncDeps): MemorySync {
  const debounceMs = deps.debounceMs ?? 800;
  const retryMs = deps.retryMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let muted = false;
  let disposed = false;
  let lastSyncedAt: number | null = null;
  let current: MemorySyncState = { kind: "off" };
  const setState = (s: MemorySyncState) => {
    current = s;
    deps.onState?.(s);
  };
  const fail = (err: unknown) => {
    setState({ kind: "error", message: err instanceof Error ? err.message : String(err), lastSyncedAt });
    if (retry !== null) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      void flush();
    }, retryMs);
  };

  async function flush(): Promise<void> {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) {
      setState({ kind: "off" });
      return;
    }
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    setState({ kind: "syncing" });
    try {
      for (const rel of batch) {
        const content = await deps.files.read(rel);
        if (content === "") await deps.api.remove(uid, rel);
        else await deps.api.upsert(uid, rel, content, new Date(now()).toISOString());
      }
      lastSyncedAt = now();
      setState({ kind: "idle", lastSyncedAt });
    } catch (err) {
      for (const rel of batch) pending.add(rel);
      fail(err);
    }
  }

  return {
    touched(rel) {
      if (disposed || muted) return;
      pending.add(rel);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    async pullNow() {
      if (disposed) return "skipped";
      const uid = deps.uid();
      if (!uid) {
        setState({ kind: "off" });
        return "skipped";
      }
      setState({ kind: "syncing" });
      try {
        const cloud = (await deps.api.listAll(uid)).map((r) => ({
          key: r.key,
          content: r.content,
          updatedAtMs: Date.parse(r.updated_at),
        }));
        const local = (await deps.files.walk()).map((d) => ({ key: d.rel, content: d.content, mtimeMs: d.mtimeMs }));
        const plan = planReconcile(local, cloud);
        muted = true;
        try {
          for (const c of plan.pull) await deps.files.write(c.key, c.content);
        } finally {
          muted = false;
        }
        for (const l of plan.push) await deps.api.upsert(uid, l.key, l.content, new Date(l.mtimeMs).toISOString());
        lastSyncedAt = now();
        setState({ kind: "idle", lastSyncedAt });
        // 对账期间攒下的 pending 顺手推掉
        if (pending.size > 0) await flush();
        return "synced";
      } catch (err) {
        fail(err);
        return "failed";
      }
    },
    flushNow: () => flush(),
    state: () => current,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
    },
  };
}
