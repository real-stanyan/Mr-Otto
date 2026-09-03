export type MemorySyncState =
  | { kind: "off" }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null };
