import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecord,
  readRecords,
  relativeInWorkspace,
  trimIfNeeded,
} from "../../src/main/coworkLogFile.js";
import { COWORK_LOG_NAME, formatRecord, type CoworkRecord } from "../../src/shared/coworkLog.js";

// 协作记录的落盘（issue #658）：追加要能并发、读失败不能挡住写盘、
// 路径一律折成工作区内的相对路径（换台机器还认得出是同一个文件）。

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-cowork-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const rec = (over: Partial<CoworkRecord> = {}): CoworkRecord => ({
  ts: Date.parse("2026-08-28T10:40:12Z"),
  sessionId: "a7f3c1",
  path: "提案.md",
  reason: "把开头压到三行",
  ...over,
});

describe("relativeInWorkspace", () => {
  it("工作区内的绝对路径 → 相对路径，分隔符统一成 /", () => {
    expect(relativeInWorkspace(ws, join(ws, "稿件", "提案.md"))).toBe("稿件/提案.md");
  });

  it("本来就是相对路径的按工作区内解读", () => {
    expect(relativeInWorkspace(ws, "提案.md")).toBe("提案.md");
  });

  it("工作区之外 → null：围栏外的文件不属于「这个文件夹里的分工」", () => {
    expect(relativeInWorkspace(ws, join(ws, "..", "别处.md"))).toBeNull();
    expect(relativeInWorkspace(ws, "/etc/hosts")).toBeNull();
  });

  it("工作区自己 → null", () => {
    expect(relativeInWorkspace(ws, ws)).toBeNull();
  });
});

describe("appendRecord / readRecords", () => {
  it("第一次写带上给人看的抬头，之后只追行", async () => {
    expect(await appendRecord(ws, rec(), 0)).toBe(true);
    const first = readFileSync(join(ws, COWORK_LOG_NAME), "utf8");
    expect(first).toContain("# Mr Otto 协作记录");
    expect(first).toContain("删掉不会坏事");

    await appendRecord(ws, rec({ ts: rec().ts + 1000, path: "预算.md" }), 0);
    const second = readFileSync(join(ws, COWORK_LOG_NAME), "utf8");
    // 抬头只出现一次
    expect(second.match(/# Mr Otto 协作记录/g)).toHaveLength(1);
    expect(await readRecords(ws)).toHaveLength(2);
  });

  it("追加不读改写 —— 别的进程同时写的那些行一条不丢", async () => {
    // 十条并发追加，模拟两个 app 实例同时干活
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendRecord(ws, rec({ ts: 1000 + i, path: `f${i}.md`, sessionId: `s${i}` }), 0)
      )
    );
    const got = await readRecords(ws);
    expect(got).toHaveLength(10);
    expect(new Set(got.map((r) => r.path)).size).toBe(10);
  });

  it("本子还不存在 → 空列表，不抛：记录是增强，不是前置条件", async () => {
    expect(await readRecords(ws)).toEqual([]);
  });

  it("本子被人写坏了 → 能认的照读，认不出的跳过", async () => {
    writeFileSync(
      join(ws, COWORK_LOG_NAME),
      ["用户手改的一句话", formatRecord(rec(), 0), "- 乱七八糟"].join("\n"),
      "utf8"
    );
    expect(await readRecords(ws)).toHaveLength(1);
  });

  it("写不进去（目录不存在）→ 返回 false，不抛", async () => {
    expect(await appendRecord(join(ws, "没有这个目录"), rec(), 0)).toBe(false);
  });
});

describe("trimIfNeeded", () => {
  it("到两倍上限才裁，裁完留最新的那些", async () => {
    for (let i = 0; i < 9; i++) await appendRecord(ws, rec({ ts: 1000 + i, path: `f${i}.md` }), 0);
    // 上限 4 → 两倍是 8，9 条超了
    await trimIfNeeded(ws, 4);
    const got = await readRecords(ws);
    expect(got).toHaveLength(4);
    expect(got.map((r) => r.path)).toEqual(["f5.md", "f6.md", "f7.md", "f8.md"]);
    // 抬头还在：裁剪不该把给人看的说明一起扔了
    expect(readFileSync(join(ws, COWORK_LOG_NAME), "utf8")).toContain("# Mr Otto 协作记录");
  });

  it("没到两倍上限就一个字不动 —— 重写越少，撞上并发追加的机会越少", async () => {
    for (let i = 0; i < 6; i++) await appendRecord(ws, rec({ ts: 1000 + i, path: `f${i}.md` }), 0);
    const before = readFileSync(join(ws, COWORK_LOG_NAME), "utf8");
    await trimIfNeeded(ws, 4);
    expect(readFileSync(join(ws, COWORK_LOG_NAME), "utf8")).toBe(before);
  });
});
