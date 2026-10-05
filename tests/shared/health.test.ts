// Apple 健康（#1656）两端共用的那一层：查询 / 结果的校验、给模型读的文本、手机侧应答、聊天里那一行灰字。
import { describe, expect, it } from "vitest";
import {
  answerHealthQuery, formatHealthForModel, healthReadLineText, parseHealthQuery, parseHealthResult,
  HEALTH_RESULT_MAX_BYTES, type HealthQuery,
} from "../../src/shared/health.js";

describe("parseHealthQuery", () => {
  it("合法：去重、保序", () => {
    expect(parseHealthQuery({ metrics: ["sleep", "steps", "sleep"], from: "2026-09-28", to: "2026-10-04" }))
      .toEqual({ metrics: ["sleep", "steps"], from: "2026-09-28", to: "2026-10-04" });
  });
  it("同一天可以", () => {
    expect(parseHealthQuery({ metrics: ["steps"], from: "2026-10-05", to: "2026-10-05" })).not.toBeNull();
  });
  it.each([
    ["空 metrics", { metrics: [], from: "2026-10-01", to: "2026-10-02" }],
    ["未知 metric", { metrics: ["mood"], from: "2026-10-01", to: "2026-10-02" }],
    ["metrics 不是数组", { metrics: "steps", from: "2026-10-01", to: "2026-10-02" }],
    ["坏日期格式", { metrics: ["steps"], from: "2026-1-01", to: "2026-10-02" }],
    ["不存在的日期", { metrics: ["steps"], from: "2026-02-30", to: "2026-03-02" }],
    ["from > to", { metrics: ["steps"], from: "2026-10-03", to: "2026-10-02" }],
    ["跨度 93 天", { metrics: ["steps"], from: "2026-01-01", to: "2026-04-03" }],
    ["不是对象", null],
  ])("拒：%s", (_name, x) => {
    expect(parseHealthQuery(x)).toBeNull();
  });
  it("跨度正好 92 天可以", () => {
    expect(parseHealthQuery({ metrics: ["steps"], from: "2026-01-01", to: "2026-04-02" })).not.toBeNull();
  });
});

describe("parseHealthResult", () => {
  it("ok：只留认识的字段", () => {
    const r = parseHealthResult({
      ok: true,
      days: [{ date: "2026-10-04", steps: 8231, junk: 1, sleep: { asleepMin: 420, deepMin: 65, extra: 3 }, heartRate: { min: 50, avg: 70, max: 140 } }],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410, junk: true }],
    });
    expect(r).toEqual({
      ok: true,
      days: [{ date: "2026-10-04", steps: 8231, sleep: { asleepMin: 420, deepMin: 65 }, heartRate: { min: 50, avg: 70, max: 140 } }],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410 }],
    });
  });
  it("ok:false 带 error", () => {
    expect(parseHealthResult({ ok: false, error: "x" })).toEqual({ ok: false, error: "x" });
  });
  it.each([
    ["day.date 坏", { ok: true, days: [{ date: "10/04" }], workouts: [] }],
    ["数字是字符串", { ok: true, days: [{ date: "2026-10-04", steps: "1" }], workouts: [] }],
    ["NaN", { ok: true, days: [{ date: "2026-10-04", steps: Number.NaN }], workouts: [] }],
    ["heartRate 缺 max", { ok: true, days: [{ date: "2026-10-04", heartRate: { min: 1, avg: 2 } }], workouts: [] }],
    ["workout 缺 type", { ok: true, days: [], workouts: [{ start: "a", end: "b", durationMin: 1 }] }],
    ["没有 days", { ok: true, workouts: [] }],
    ["ok:false 没 error", { ok: false }],
  ])("拒：%s", (_n, x) => {
    expect(parseHealthResult(x)).toBeNull();
  });
  it("超过 64KB 拒", () => {
    const days = Array.from({ length: 2000 }, (_, i) => ({ date: "2026-10-04", steps: i, distanceM: i, activeKcal: i, flights: i, exerciseMin: i }));
    expect(JSON.stringify({ ok: true, days, workouts: [] }).length).toBeGreaterThan(HEALTH_RESULT_MAX_BYTES);
    expect(parseHealthResult({ ok: true, days, workouts: [] })).toBeNull();
  });
});

describe("formatHealthForModel", () => {
  const q: HealthQuery = { metrics: ["steps", "sleep", "heartRate", "spo2", "workouts"], from: "2026-10-03", to: "2026-10-04" };
  it("每天一行只列有值的；训练单列；全空的类别在末尾说明", () => {
    const text = formatHealthForModel(q, {
      ok: true,
      days: [
        { date: "2026-10-03", steps: 5012 },
        { date: "2026-10-04", steps: 8231, sleep: { asleepMin: 432, deepMin: 65, remMin: 100, coreMin: 267, awakeMin: 18 }, heartRate: { min: 52, avg: 71, max: 148 } },
      ],
      workouts: [{ start: "2026-10-04T08:02:00+08:00", end: "2026-10-04T08:41:00+08:00", type: "running", durationMin: 39, distanceM: 6200, activeKcal: 410 }],
    });
    expect(text).toBe([
      "Apple 健康 · 2026-10-03 至 2026-10-04（用户手机本地日历，按天汇总）",
      "2026-10-03：步数 5012",
      "2026-10-04：步数 8231；睡眠 7小时12分（深睡 1小时5分 · REM 1小时40分 · 核心 4小时27分 · 清醒 18分）；心率 52–148（平均 71）",
      "训练：",
      "2026-10-04 08:02–08:41 running 39分钟 6.2km 410kcal",
      "以下类别在这段时间没有数据（可能没授权，也可能没记录）：血氧",
    ].join("\n"));
  });
  it("一天都没有：只有表头与说明", () => {
    expect(formatHealthForModel({ metrics: ["bodyMass"], from: "2026-10-04", to: "2026-10-04" }, { ok: true, days: [], workouts: [] }))
      .toBe("Apple 健康 · 2026-10-04 至 2026-10-04（用户手机本地日历，按天汇总）\n以下类别在这段时间没有数据（可能没授权，也可能没记录）：体重");
  });
});

describe("answerHealthQuery", () => {
  const q: HealthQuery = { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" };
  it("开关关着：不读，回 ok:false", async () => {
    let read = 0;
    const r = await answerHealthQuery(q, { enabled: () => false, read: async () => { read++; return {}; } });
    expect(r).toEqual({ ok: false, error: "用户在手机上关掉了 Apple 健康" });
    expect(read).toBe(0);
  });
  it("读到：过一遍 parseHealthResult", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => ({ days: [{ date: "2026-10-04", steps: 3 }], workouts: [] }) });
    expect(r).toEqual({ ok: true, days: [{ date: "2026-10-04", steps: 3 }], workouts: [] });
  });
  it("原生给的形状不对", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => ({ days: "x" }) });
    expect(r).toEqual({ ok: false, error: "手机读出来的数据格式不对" });
  });
  it("原生抛错", async () => {
    const r = await answerHealthQuery(q, { enabled: () => true, read: async () => { throw new Error("boom"); } });
    expect(r).toEqual({ ok: false, error: "手机读健康数据出错：boom" });
  });
});

describe("healthReadLineText", () => {
  it("类别按组去重、日期写成几月几日", () => {
    expect(healthReadLineText({ metrics: ["sleep", "heartRate", "hrv"], from: "2026-09-28", to: "2026-10-04" }, "ok"))
      .toBe("读取了健康数据：睡眠、心脏 · 9月28日–10月4日");
  });
  it("同一天只写一次", () => {
    expect(healthReadLineText({ metrics: ["steps", "workouts"], from: "2026-10-04", to: "2026-10-04" }, "ok"))
      .toBe("读取了健康数据：活动、体能训练 · 10月4日");
  });
  it("参数读不懂也给一句", () => {
    expect(healthReadLineText("garbage", "ok")).toBe("读取了健康数据");
  });
  it("失败", () => {
    expect(healthReadLineText({ metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" }, "error")).toBe("没读到健康数据");
  });
});
