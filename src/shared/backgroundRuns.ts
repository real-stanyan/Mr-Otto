// 后台任务面板的投影（issue #452 / ADR-0109）——纯函数，无 IO，不读时钟。
//
// 面板画的是「日志的投影」而不是主进程另开的一路推送，这是硬规则要的：
// 任何投影（模型上下文/UI）必须可从日志推导。所以起点也落了事件
// （background_task_started），elapsed 从事件的 ts 算，不用另存 startedAt。
//
// 日志推不出的只有一件事：started 没配上 completed 的那些，进程到底还活着，
// 还是随上一次 app 退出一起死了。这个判据只有主进程手里那张 live map 有
// （BackgroundTasks.live()），所以由调用方传进来。

import type { SessionEvent } from "../session/events.js";

export type BackgroundRunState =
  /** 还在跑 */
  | "running"
  /** 跑完了 exit 0，但结果还没注回对话（turn 在跑时会攒在 pendingBg） */
  | "ready"
  /** 跑完了 exit 非 0，同样还没注回 */
  | "failed";

export interface BackgroundRun {
  id: string;
  /** 命令原文，就是面板上那行标题 */
  cmd: string;
  state: BackgroundRunState;
  /** background_task_started 的 ts */
  startedAt: number;
  /** 完成才有 */
  exitCode?: number;
}

/** 事件流 + 「谁还真的活着」→ 面板要画的行（起始时间升序）。
    摘掉一行的判据是**结果真的进了对话**（回注那条 user_message 驮着 id），
    不是「任务完成了」——两者之间隔着一整个 turn。 */
export function projectBackgroundRuns(
  events: readonly SessionEvent[],
  liveIds: ReadonlySet<string>
): BackgroundRun[] {
  const runs = new Map<string, BackgroundRun>();
  for (const e of events) {
    switch (e.type) {
      case "background_task_started":
        // 覆盖而不是跳过：bg-N 的计数器随 agent 装配重建（backgroundTasks.ts 的
        // this.n），同一个会话重开后又从 bg-1 开始，重放整份日志时会撞号。
        // 撞上时后来的那次才是现在这个进程，先前那条必然已经死了
        runs.set(e.taskId, { id: e.taskId, cmd: e.cmd, state: "running", startedAt: e.ts });
        break;
      case "background_task_completed": {
        // 配不上 started 的完成事件来自 ADR-0109 之前的日志——那些任务早就
        // 结束了，凭空造一行「刚跑完」是假的
        const run = runs.get(e.taskId);
        if (!run) break;
        run.state = e.exitCode === 0 ? "ready" : "failed";
        run.exitCode = e.exitCode;
        break;
      }
      case "user_message":
        // 只认事件上的 id，不看正文。人自己打出 `[后台任务 bg-1 完成]` 这几个字
        // 不该摘掉任何一行——ADR-0103 已经把「靠前缀反解」那条路否掉过一次
        for (const id of e.backgroundTaskIds ?? []) runs.delete(id);
        break;
      default:
        break;
    }
  }
  return [...runs.values()]
    // 还挂着 running 但不在 live 里 = 进程随上一次 app 退出一起没了。
    // 画成「还在跑」是撒谎，不如不画
    .filter((r) => r.state !== "running" || liveIds.has(r.id))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** 已跑多久。不满一分钟按秒（「4 秒」），之后按 分:秒，过一小时带上小时。
    时钟往回跳按 0 处理——机器时钟偏一点是常事，显示负数只会让人以为是 bug
    （同 formatRelativeTime 的立场）。 */
export function formatElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (total < 60) return `${total} 秒`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
