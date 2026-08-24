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
    // 区间查询下推到 SQL（store.window）：原来全量 load 再 filter，
    // 长会话为 11 条事件付整份 JSON.parse
    window: (sessionId, fromSeq, toSeq) => store.window(sessionId, fromSeq, toSeq),
    load: (sessionId) => store.load(sessionId),
    recent: (limit) => {
      const list = store
        .sessions()
        .filter((s) => s.spawnedFrom === null && s.sessionId !== currentSessionId())
        .slice(0, limit);
      // 逐会话 load() 整段事件只为数 user_message 条数是 N+1：会话一多、
      // 日志一长就是白白读一遍全量 payload。一条 SQL 批量数完（store.ts）
      const counts = store.userTurnCounts(list.map((s) => s.sessionId));
      return list.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        workspace: s.workspace,
        startedTs: s.startedTs,
        lastTs: s.lastTs,
        userTurns: counts.get(s.sessionId) ?? 0,
      }));
    },
  };
}
