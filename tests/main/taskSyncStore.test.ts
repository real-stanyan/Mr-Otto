import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadTaskSyncFile, normaliseTaskSyncFile, saveTaskSyncFile } from "../../src/main/taskSyncStore.js";
import { tempDir } from "../helpers/tempDir.js";

describe("task-sync.json（#1223）", () => {
  it("没有文件 / 坏 JSON = 空表", () => {
    const dir = tempDir("mrotto-tasksync-");
    expect(loadTaskSyncFile(join(dir, "task-sync.json"))).toEqual({ v: 1, sessions: {}, lastSweepIso: null });
    writeFileSync(join(dir, "bad.json"), "{nope", "utf8");
    expect(loadTaskSyncFile(join(dir, "bad.json"))).toEqual({ v: 1, sessions: {}, lastSweepIso: null });
  });
  it("往返：游标 / detached / offlineRun 原样，非法条目丢掉", () => {
    const dir = tempDir("mrotto-tasksync-");
    const p = join(dir, "task-sync.json");
    saveTaskSyncFile(p, { v: 1, sessions: { a: { pushedUpTo: 4 }, b: { pushedUpTo: -1, detached: true, offlineRun: true } }, lastSweepIso: "2026-09-10T00:00:00.000Z" });
    expect(loadTaskSyncFile(p)).toEqual({ v: 1, sessions: { a: { pushedUpTo: 4 }, b: { pushedUpTo: -1, detached: true, offlineRun: true } }, lastSweepIso: "2026-09-10T00:00:00.000Z" });
    expect(normaliseTaskSyncFile({ v: 1, sessions: { a: { pushedUpTo: "x" }, c: null, d: { pushedUpTo: 2, detached: "yes" } }, lastSweepIso: 5 })).toEqual({ v: 1, sessions: { d: { pushedUpTo: 2 } }, lastSweepIso: null });
  });
});
