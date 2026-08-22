// 历史会话查询能力——session_search 工具的世界。工具只认 world.history（硬规则），
// 这里把 EventStore 焊成那个接口；v2 SandboxWorld 可以换成 RPC 到宿主。
import type { EventStore } from "../session/store.js";
import type { HistoryCapability } from "../world/executionWorld.js";

export function createHistoryCapability(
  store: EventStore,
  currentSessionId: () => string
): HistoryCapability {
  return {
    search: (query, opts) =>
      store.searchText(query, {
        ...(opts?.limit ? { limit: opts.limit } : {}),
        excludeSessions: [currentSessionId()],
      }),
    window: (sessionId, fromSeq, toSeq) =>
      store.load(sessionId).filter((e) => e.seq >= fromSeq && e.seq <= toSeq),
    load: (sessionId) => store.load(sessionId),
    recent: (limit) =>
      store
        .sessions()
        .filter((s) => s.spawnedFrom === null && s.sessionId !== currentSessionId())
        .slice(0, limit)
        .map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          workspace: s.workspace,
          startedTs: s.startedTs,
          lastTs: s.lastTs,
          userTurns: store.load(s.sessionId).filter((e) => e.type === "user_message").length,
        })),
  };
}
