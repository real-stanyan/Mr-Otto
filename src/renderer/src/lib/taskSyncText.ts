import type { TaskSyncState } from "../../../shared/taskSyncState.js";

/** 账号页那一行写什么（#1223）。off 分两种：没登录 vs 云端还没建表——后者不许说成前者（ADR-0248 的措辞纪律） */
export function taskSyncStatusText(s: TaskSyncState): string {
  switch (s.kind) {
    case "off":
      return s.reason === null ? "任务会话只在这台电脑上\uFF08登录后会跟账号同步\uFF09" : `任务会话云同步关着\uFF1A${s.reason}`;
    case "idle":
      return "任务会话已与账号同步";
    case "syncing":
      return "任务会话同步中\u2026";
    case "error":
      return "任务会话同步失败\uFF0C会自动重试";
    case "frozen":
      // 「会自动重试」这句话对冻结是假的（freeze 不 scheduleRetry），所以它自己一档：
      // 先说清有几条停了、其余照常，再把最近那条的原因原样带出来（#1223 终审 I2）
      return `任务会话有 ${s.count} 条已停止同步\uFF08其余照常同步\uFF09\uFF1A${s.message}`;
  }
}
