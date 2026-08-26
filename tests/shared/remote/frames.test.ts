import { describe, expect, it } from "vitest";
import { decodeDownFrame, decodeUpFrame, encodeFrame } from "../../../src/shared/remote/frames.js";
import type { IslandFleet } from "../../../src/shared/shellBridge.js";

const IDLE: IslandFleet = { agents: [], focusedSessionId: null };

describe("encodeFrame", () => {
  it("一行 JSON，不带换行（换行由传输层决定）", () => {
    const line = encodeFrame({ type: "fleet", fleet: IDLE });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line).type).toBe("fleet");
  });
});

describe("decodeUpFrame", () => {
  it("解 approve", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s","callId":"c"}')).toEqual({
      type: "approve", sessionId: "s", callId: "c",
    });
  });
  it("解 deny", () => {
    expect(decodeUpFrame('{"type":"deny","sessionId":"s","callId":"c"}')).toEqual({
      type: "deny", sessionId: "s", callId: "c",
    });
  });
  it("解 send / watch / unwatch", () => {
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi"}')).toEqual({
      type: "send", sessionId: "s", text: "hi",
    });
    expect(decodeUpFrame('{"type":"watch","sessionId":"s"}')).toEqual({ type: "watch", sessionId: "s" });
    expect(decodeUpFrame('{"type":"unwatch","sessionId":"s"}')).toEqual({ type: "unwatch", sessionId: "s" });
  });

  // ↓ spec 第二节的安全取舍，具名钉死。有人想「顺手开一下」时这两条会红。
  it("approve 带 grant 字段 → 整条丢弃，不是剥掉字段放行", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}')).toBeNull();
  });
  it("approve_always / approve_session 不是合法 type", () => {
    expect(decodeUpFrame('{"type":"approve_always","sessionId":"s","callId":"c"}')).toBeNull();
    expect(decodeUpFrame('{"type":"approve_session","sessionId":"s","callId":"c"}')).toBeNull();
  });
  it("focusSession 是岛的词汇，手机端不认（远程操纵桌面窗口不在范围内）", () => {
    expect(decodeUpFrame('{"type":"focusSession","sessionId":"s"}')).toBeNull();
  });

  it("缺字段 / 类型不对 / 坏 JSON / 未知 type → null", () => {
    expect(decodeUpFrame('{"type":"approve","sessionId":"s"}')).toBeNull();
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":123}')).toBeNull();
    expect(decodeUpFrame("not json")).toBeNull();
    expect(decodeUpFrame('{"type":"wat"}')).toBeNull();
    expect(decodeUpFrame("null")).toBeNull();
  });
});

describe("decodeUpFrame — 附件", () => {
  const chunk = { type: "upload", uploadId: "u1", seq: 0, total: 2, name: "a.png", data: "AAAA" };

  it("解 upload", () => {
    expect(decodeUpFrame(JSON.stringify(chunk))).toEqual(chunk);
  });

  it("send 可以不带 uploads(旧手机),带了就必须是字符串数组", () => {
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi"}'))
      .toEqual({ type: "send", sessionId: "s", text: "hi" });
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi","uploads":["u1"]}'))
      .toEqual({ type: "send", sessionId: "s", text: "hi", uploads: ["u1"] });
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi","uploads":[1]}')).toBeNull();
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi","uploads":"u1"}')).toBeNull();
  });

  it("send 的白名单之外还是整条丢 —— 可选字段不等于开了口子", () => {
    expect(decodeUpFrame('{"type":"send","sessionId":"s","text":"hi","origin":"background"}'))
      .toBeNull();
  });

  it("seq/total 必须是非负整数 —— 小数和 NaN 会让重组器永远对不上而不报错", () => {
    expect(decodeUpFrame(JSON.stringify({ ...chunk, seq: 1.5 }))).toBeNull();
    expect(decodeUpFrame(JSON.stringify({ ...chunk, seq: -1 }))).toBeNull();
    expect(decodeUpFrame('{"type":"upload","uploadId":"u","seq":null,"total":1,"name":"a","data":""}'))
      .toBeNull();
  });

  it("total 至少 1,seq 必须落在 total 之内", () => {
    expect(decodeUpFrame(JSON.stringify({ ...chunk, total: 0 }))).toBeNull();
    expect(decodeUpFrame(JSON.stringify({ ...chunk, seq: 2, total: 2 }))).toBeNull();
  });

  it("upload 缺字段整条丢", () => {
    expect(decodeUpFrame('{"type":"upload","uploadId":"u","seq":0,"total":1,"name":"a"}')).toBeNull();
  });
});

describe("decodeDownFrame", () => {
  it("解 fleet", () => {
    const f = decodeDownFrame(encodeFrame({ type: "fleet", fleet: IDLE }));
    expect(f).toEqual({ type: "fleet", fleet: IDLE });
  });
  it("解 ping", () => {
    expect(decodeDownFrame('{"type":"ping","ts":17}')).toEqual({ type: "ping", ts: 17 });
  });
  it("解 notice", () => {
    expect(decodeDownFrame('{"type":"notice","text":"传不上去"}'))
      .toEqual({ type: "notice", text: "传不上去" });
    expect(decodeDownFrame('{"type":"notice","text":1}')).toBeNull();
  });
  it("upload 是上行词汇,不能从下行口进来", () => {
    expect(decodeDownFrame(JSON.stringify(
      { type: "upload", uploadId: "u", seq: 0, total: 1, name: "a", data: "" },
    ))).toBeNull();
  });
  it("上行词汇不能从下行口进来", () => {
    expect(decodeDownFrame('{"type":"approve","sessionId":"s","callId":"c"}')).toBeNull();
  });
});

describe("stats 帧", () => {
  const stats = {
    now: 1_700_000_000_000,
    activityDays: 181,
    usageDays: 14,
    activity: [{ date: "2026-08-25", count: 3 }],
    sessions: 3,
    models: [
      { label: "DeepSeek V4 Flash", provider: "deepseek", inTokens: 10, outTokens: 2, costUsd: 0.001 },
      { label: "Grok 4", provider: "xai", inTokens: 5, outTokens: 1, costUsd: null },
    ],
    totalCostUsd: null,
  };

  it("上行的 stats 不带任何字段;多一个键就整条丢弃", () => {
    expect(decodeUpFrame(JSON.stringify({ type: "stats" }))).toEqual({ type: "stats" });
    expect(decodeUpFrame(JSON.stringify({ type: "stats", days: 30 }))).toBeNull();
  });

  it("下行的 stats 原样回来", () => {
    expect(decodeDownFrame(JSON.stringify({ type: "stats", stats }))).toEqual({
      type: "stats", stats,
    });
  });

  it("costUsd 的 null 认得住 —— 它和 0 是两件事", () => {
    const one = decodeDownFrame(JSON.stringify({ type: "stats", stats }));
    expect(one?.type === "stats" && one.stats.models[1]!.costUsd).toBeNull();
  });

  it("模型行少一个字段 / 类型不对 → 整条丢弃,不是剥掉那一行", () => {
    const bad = { ...stats, models: [{ label: "x", provider: "y", inTokens: 1, outTokens: 2 }] };
    expect(decodeDownFrame(JSON.stringify({ type: "stats", stats: bad }))).toBeNull();
    const wrong = { ...stats, sessions: "3" };
    expect(decodeDownFrame(JSON.stringify({ type: "stats", stats: wrong }))).toBeNull();
  });

  it("热力图里一条形状不对的天 → 整条丢弃", () => {
    const bad = { ...stats, activity: [{ date: "2026-08-25" }] };
    expect(decodeDownFrame(JSON.stringify({ type: "stats", stats: bad }))).toBeNull();
  });
});
