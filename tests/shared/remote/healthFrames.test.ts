// Apple 健康的三种帧（协议 29，#1656）：形状不对整帧拒（解回 null），对的原样往返。
import { describe, expect, it } from "vitest";
import { CS_PROTOCOL_VERSION, decodeCsDown, decodeCsUp, encodeCs } from "../../../src/shared/remote/cloudSession.js";

describe("health 帧", () => {
  it("协议号 31（#1682 群座位帧之后；健康三帧是 29）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(31);
  });
  it("caps 往返；health 不是布尔就拒", () => {
    expect(decodeCsUp(encodeCs({ t: "caps", health: true }))).toEqual({ t: "caps", health: true });
    expect(decodeCsUp(encodeCs({ t: "caps", health: "yes" } as never))).toBeNull();
  });
  it("health_query 往返；query 不合法就拒", () => {
    const ok = { t: "health_query" as const, reqId: "r1", query: { metrics: ["steps" as const], from: "2026-10-04", to: "2026-10-04" } };
    expect(decodeCsDown(encodeCs(ok))).toEqual(ok);
    expect(decodeCsDown(encodeCs({ ...ok, query: { metrics: [], from: "2026-10-04", to: "2026-10-04" } } as never))).toBeNull();
    expect(decodeCsDown(encodeCs({ ...ok, reqId: 3 } as never))).toBeNull();
  });
  it("health_result 往返（ok 与失败）；result 不合法就拒；reqId 太长就拒", () => {
    const ok = { t: "health_result" as const, reqId: "r1", result: { ok: true as const, days: [{ date: "2026-10-04", steps: 1 }], workouts: [] } };
    expect(decodeCsUp(encodeCs(ok))).toEqual(ok);
    const fail = { t: "health_result" as const, reqId: "r1", result: { ok: false as const, error: "手机断开了" } };
    expect(decodeCsUp(encodeCs(fail))).toEqual(fail);
    expect(decodeCsUp(encodeCs({ ...ok, result: { ok: true, days: "x", workouts: [] } } as never))).toBeNull();
    expect(decodeCsUp(encodeCs({ ...ok, reqId: "x".repeat(65) }))).toBeNull();
  });
});
