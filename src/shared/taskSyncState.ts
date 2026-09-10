/** 任务会话云同步的状态（#1223），同 memorySyncState 的形状多一格 reason：
    off 有三种来路（未登录 / 云端还没建表 / 不是任务会话所以没开），设置页那行要分开说 */
export type TaskSyncState =
  | { kind: "off"; reason: string | null }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null };
