// 新建的智能体先开口（#1356 A2，spec §7.2 第 2 步）的编排。daemon.ts 进不了 vitest（一 import 就连
// docker / Supabase），所以「抢那一格 → 抢到才落开场白、抢不到或出错一律照旧」这段判断住在这里，
// daemon 只接线（同 chatCreate.ts 的纪律）。
//
// **先抢再落**（spec §7.2 原文是先落再改，ADR-0319 决定 2）：一条条件更新 'greet' → 'role' 是原子的，
// 两个进程抢同一格只有一边抢得到；两种失败的结局里先抢的这一种更好收拾——抢到之后落盘失败 = 这只
// 不先开口（与今天相同），先落再改而改失败 = 它开过口、职责却永远写不进去（第 3 步只认 'role'）。

export interface GreetOnCreateDeps {
  /** agentRegistry 的 claimGreeting：回 true = 抢到了。出错就抛（列不存在 / Supabase 抖了） */
  claimGreeting(workspaceId: string, agentId: string): Promise<boolean>;
  log(message: string): void;
}

/**
 * **只在建出一条新私聊时调**（找回已有的那条不调：那只要么早就开过口，要么是桌面那侧的老智能体）。
 * 回 true = 这一次替建的人落了开场白。抢那一格出错一律当没抢到：行为退回今天，只记一行。
 * `greet` 同步落盘并入队（CloudSession.greetNewAgent）；它抛了就往上抛——那是本地日志写不进去，
 * 那一刻整条会话都已经写不进去了，不该吞掉。
 */
export async function greetOnCreate(
  deps: GreetOnCreateDeps,
  workspaceId: string,
  agentId: string,
  greet: () => void,
): Promise<boolean> {
  let claimed: boolean;
  try {
    claimed = await deps.claimGreeting(workspaceId, agentId);
  } catch (err) {
    deps.log(
      `「先开口」那一格抢不到，这只不先开口（workspace=${workspaceId} agent=${agentId}）：${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (!claimed) return false;
  greet();
  return true;
}
