// 账号页那一行（#1223，spec §3.7）：任务会话云同步此刻的状态。同 MemorySettings 头部那句 syncHint 的做法，
// 但走推送（主进程状态一变就推）而不是挂载时拉一次——拉一次的那行在设置页开着的几分钟里会一直陈旧
import { useChat } from "../store.js";
import { taskSyncStatusText } from "../lib/taskSyncText.js";

export function TaskSyncStatusLine() {
  const state = useChat((s) => s.taskSync);
  return (
    <p
      // frozen 走 warn 色（#1223 终审 I2）：它不是「这一下没成」而是「有几条停了、不会自己回来」，
      // 与 idle/syncing 同一个灰会让这句话读起来像例行状态
      className={state.kind === "frozen" ? "text-xs text-warn" : "text-xs text-muted-foreground"}
      title={state.kind === "error" || state.kind === "frozen" ? state.message : undefined}
      data-testid="task-sync-status"
    >
      {taskSyncStatusText(state)}
    </p>
  );
}
