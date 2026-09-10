// 账号页那一行（#1223，spec §3.7）：任务会话云同步此刻的状态。同 MemorySettings 头部那句 syncHint 的做法，
// 但走推送（主进程状态一变就推）而不是挂载时拉一次——拉一次的那行在设置页开着的几分钟里会一直陈旧
import { useChat } from "../store.js";
import { taskSyncStatusText } from "../lib/taskSyncText.js";

export function TaskSyncStatusLine() {
  const state = useChat((s) => s.taskSync);
  return (
    <p
      className="text-xs text-muted-foreground"
      title={state.kind === "error" ? state.message : undefined}
      data-testid="task-sync-status"
    >
      {taskSyncStatusText(state)}
    </p>
  );
}
