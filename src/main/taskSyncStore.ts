// 任务会话云同步的持久化游标（#1223）：accountData/task-sync.json（同 island.json 的落法，按账号抽屉分）。
// 每条会话记 pushedUpTo（本地推到云端的末条 seq）；detached = 云端那行没了、停止同步但本地照读；
// offlineRun = 离线跑过 turn，回网后的冲突是预期内的（只给日志/诊断用，冲突流程不读它）。
// 现读现写：陈旧的游标只会导致一次「已经在了」的重推，CAS 会撞出来再对表——不会丢数据。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TaskSyncSessionState {
  pushedUpTo: number;
  detached?: true;
  offlineRun?: true;
}

export interface TaskSyncFile {
  v: 1;
  sessions: Record<string, TaskSyncSessionState>;
  lastSweepIso: string | null;
}

export function normaliseTaskSyncFile(input: unknown): TaskSyncFile {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sessions: Record<string, TaskSyncSessionState> = {};
  const raw = (obj["sessions"] && typeof obj["sessions"] === "object" ? obj["sessions"] : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    if (typeof s["pushedUpTo"] !== "number" || !Number.isInteger(s["pushedUpTo"])) continue;
    sessions[id] = {
      pushedUpTo: s["pushedUpTo"],
      ...(s["detached"] === true ? { detached: true as const } : {}),
      ...(s["offlineRun"] === true ? { offlineRun: true as const } : {}),
    };
  }
  return { v: 1, sessions, lastSweepIso: typeof obj["lastSweepIso"] === "string" ? obj["lastSweepIso"] : null };
}

export function loadTaskSyncFile(path: string): TaskSyncFile {
  try {
    return normaliseTaskSyncFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { v: 1, sessions: {}, lastSweepIso: null };
  }
}

export function saveTaskSyncFile(path: string, file: TaskSyncFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normaliseTaskSyncFile(file), null, 2), "utf8");
}
