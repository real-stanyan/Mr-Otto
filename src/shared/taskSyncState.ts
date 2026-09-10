/** 任务会话云同步的状态（#1223），同 memorySyncState 的形状多一格 reason：
    off 有三种来路（未登录 / 云端还没建表 / 不是任务会话所以没开），设置页那行要分开说 */
export type TaskSyncState =
  | { kind: "off"; reason: string | null }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null }
  /** 有会话停止同步了（终态，落在 task-sync.json 的 frozen 上，#1223 终审 I2）：与 error 分开
      是因为它**不重试**——`taskSyncText` 对 error 一律写「会自动重试」，而 freeze 恰恰不
      scheduleRetry。count = 此刻冻着的会话数（其余照常同步），message = 最近冻的那条的原因 */
  | { kind: "frozen"; count: number; message: string; lastSyncedAt: number | null };
