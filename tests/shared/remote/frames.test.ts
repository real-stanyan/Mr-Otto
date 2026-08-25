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

describe("decodeDownFrame", () => {
  it("解 fleet", () => {
    const f = decodeDownFrame(encodeFrame({ type: "fleet", fleet: IDLE }));
    expect(f).toEqual({ type: "fleet", fleet: IDLE });
  });
  it("解 ping", () => {
    expect(decodeDownFrame('{"type":"ping","ts":17}')).toEqual({ type: "ping", ts: 17 });
  });
  it("上行词汇不能从下行口进来", () => {
    expect(decodeDownFrame('{"type":"approve","sessionId":"s","callId":"c"}')).toBeNull();
  });
});
