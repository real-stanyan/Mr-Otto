import { describe, expect, it } from "vitest";
import {
  cloudLogFilename,
  collectFullLog,
  eventsJsonl,
  openSessionMatches,
  pagerDeps,
  partialExportText,
  PARTIAL_NO_PROGRESS,
  runChatExport,
  type CollectDeps,
  type CollectResult,
  type PartialChoice,
} from "../../src/shared/chatLogExport.js";

/** 假的一页页往前翻：pages[i] 是第 i 次翻页带来的条数；某一次可以指定失败 */
function fake(pages: number[], opts: { failAt?: number; start?: number } = {}) {
  let count = opts.start ?? 0;
  let i = 0;
  const progress: number[] = [];
  const deps: CollectDeps = {
    hasOlder: () => i < pages.length,
    async loadOlder() {
      if (opts.failAt === i) return { ok: false, message: "没读到更早的消息" };
      count += pages[i]!;
      i += 1;
      return { ok: true };
    },
    count: () => count,
    onProgress: (n) => progress.push(n),
  };
  return { deps, progress, calls: () => i };
}

describe("eventsJsonl / cloudLogFilename", () => {
  it("一行一条原始事件，空列表是空串", () => {
    const evs = [{ seq: 1 }, { seq: 2 }] as never[];
    expect(eventsJsonl(evs)).toBe('{"seq":1}\n{"seq":2}\n');
    expect(eventsJsonl([])).toBe("");
  });
  it("文件名：前 8 位 id + 本地时间戳", () => {
    const ts = new Date(2026, 8, 8, 22, 30, 12).getTime();
    expect(cloudLogFilename("3f9a1c0d-aaaa", ts)).toBe("otto-cloud-3f9a1c0d-20260908-223012.jsonl");
    expect(cloudLogFilename("", ts)).toBe("otto-cloud-session-20260908-223012.jsonl");
  });
});

describe("openSessionMatches", () => {
  const dm = { sessionId: "s1", state: "ready", chat: { kind: "dm", agentIds: ["a1"] } };
  it("按 sessionId 认", () => {
    expect(openSessionMatches({ kind: "session", sessionId: "s1" }, dm)).toBe(true);
    expect(openSessionMatches({ kind: "session", sessionId: "s2" }, dm)).toBe(false);
  });
  it("智能体私聊按名单里那一只认；群聊不算", () => {
    expect(openSessionMatches({ kind: "agent", agentId: "a1" }, dm)).toBe(true);
    expect(openSessionMatches({ kind: "agent", agentId: "a2" }, dm)).toBe(false);
    expect(openSessionMatches({ kind: "agent", agentId: "a1" }, { ...dm, chat: { kind: "group", agentIds: ["a1"] } })).toBe(false);
  });
  it("没连上 / 还混着缓存 / 没开：都不算", () => {
    const t = { kind: "session", sessionId: "s1" } as const;
    expect(openSessionMatches(t, { ...dm, state: "connecting" })).toBe(false);
    expect(openSessionMatches(t, { ...dm, provisional: true })).toBe(false);
    expect(openSessionMatches(t, null)).toBe(false);
  });
});

describe("pagerDeps", () => {
  it("hasOlder 信刚回来那一页自己报的，不等状态推送", async () => {
    let n = 10;
    const deps = pagerDeps({
      loadOlderPage: async () => { n += 5; return { ok: true, hasOlder: false }; },
      storeHasOlder: () => true, // 推送还没到，仍是陈旧的真值
      count: () => n,
    });
    expect(await collectFullLog(deps)).toEqual({ kind: "complete", count: 15 });
  });
  it("失败原样带出 message", async () => {
    const deps = pagerDeps({
      loadOlderPage: async () => ({ ok: false, message: "断了" }),
      storeHasOlder: () => true,
      count: () => 3,
    });
    expect(await collectFullLog(deps)).toEqual({ kind: "partial", count: 3, message: "断了" });
  });
});

describe("runChatExport", () => {
  it("一次翻齐：不问人", async () => {
    let asked = 0;
    await runChatExport({
      collect: async () => ({ kind: "complete", count: 3 }),
      askPartial: async () => { asked += 1; return "export"; },
    });
    expect(asked).toBe(0);
  });
  it("没翻齐：选重试就再翻一轮，选导出就收口", async () => {
    const results: CollectResult[] = [
      { kind: "partial", count: 200, message: "断了" },
      { kind: "partial", count: 400, message: "断了" },
      { kind: "complete", count: 635 },
    ];
    const choices: PartialChoice[] = ["retry", "export"];
    let collected = 0;
    const seen: number[] = [];
    await runChatExport({
      collect: async () => results[collected++]!,
      askPartial: async (r) => { seen.push(r.count); return choices.shift()!; },
    });
    expect(collected).toBe(2);
    expect(seen).toEqual([200, 400]);
  });
  it("提示语", () => {
    expect(partialExportText(400, "断了")).toBe("只读到 400 条，更早的没读到（断了）");
  });
});

describe("collectFullLog", () => {
  it("不用翻页：直接 complete", async () => {
    const { deps, calls } = fake([], { start: 7 });
    expect(await collectFullLog(deps)).toEqual({ kind: "complete", count: 7 });
    expect(calls()).toBe(0);
  });
  it("翻几页直到没有更早的，逐页报进度", async () => {
    const { deps, progress } = fake([200, 200, 35], { start: 200 });
    expect(await collectFullLog(deps)).toEqual({ kind: "complete", count: 635 });
    expect(progress).toEqual([400, 600, 635]);
  });
  it("第二页失败：partial，带那一页的原话，条数是已读到的", async () => {
    const { deps } = fake([200, 200, 200], { failAt: 1, start: 200 });
    expect(await collectFullLog(deps)).toEqual({ kind: "partial", count: 400, message: "没读到更早的消息" });
  });
  it("一页没读到新东西但 hasOlder 仍为真：partial，不空转", async () => {
    let n = 0;
    const deps: CollectDeps = {
      hasOlder: () => true,
      async loadOlder() { n += 1; return { ok: true }; },
      count: () => 5,
    };
    expect(await collectFullLog(deps)).toEqual({ kind: "partial", count: 5, message: PARTIAL_NO_PROGRESS });
    expect(n).toBe(1);
  });
  it("页数封顶：partial", async () => {
    let c = 0;
    const deps: CollectDeps = {
      hasOlder: () => true,
      async loadOlder() { c += 1; return { ok: true }; },
      count: () => c,
      maxPages: 3,
    };
    const r = await collectFullLog(deps);
    expect(r.kind).toBe("partial");
    expect(r.count).toBe(3);
  });
});
