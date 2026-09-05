import { describe, it, expect } from "vitest";
import { CS_PROTOCOL_VERSION, encodeCs, decodeCsUp, decodeCsDown } from "../../src/shared/remote/cloudSession.js";

/** 帧走 base64（encodeCs 的格式），不是裸 JSON。畸形用例编不出来，手工造一条 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

describe("cs_say 的 mentions（#928 切片 1a）", () => {
  it("带 mentions 解得出来", () => {
    const frame = encodeCs({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
    expect(decodeCsUp(frame)).toEqual({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
  });

  it("不带 mentions 照常解 —— 手机端和旧桌面还在发布尔那一版", () => {
    expect(decodeCsUp(encodeCs({ t: "say", text: "在吗", mention: true })))
      .toEqual({ t: "say", text: "在吗", mention: true });
  });

  it("mentions 不是字符串数组就整帧拒掉,不是悄悄丢字段", () => {
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: [1, 2] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: "ops" }))).toBeNull();
  });
});

describe("cs 协议 6（#957 第三批：stop 帧与 say/approve/stop 回执）", () => {
  it("CS_PROTOCOL_VERSION === 6", () => {
    expect(CS_PROTOCOL_VERSION).toBe(6);
  });

  it("stop 上行往返", () => {
    expect(decodeCsUp(encodeCs({ t: "stop" }))).toEqual({ t: "stop" });
  });

  it("say_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "say_result", ok: true }))).toEqual({ t: "say_result", ok: true });
    expect(decodeCsDown(encodeCs({ t: "say_result", ok: false, message: "限速了，稍等" }))).toEqual({
      t: "say_result",
      ok: false,
      message: "限速了，稍等",
    });
  });

  it("approve_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "approve_result", callId: "c1", ok: true }))).toEqual({
      t: "approve_result",
      callId: "c1",
      ok: true,
    });
    expect(
      decodeCsDown(encodeCs({ t: "approve_result", callId: "c1", ok: false, message: "这一条已经过期" }))
    ).toEqual({ t: "approve_result", callId: "c1", ok: false, message: "这一条已经过期" });
  });

  it("stop_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "stop_result", ok: true }))).toEqual({ t: "stop_result", ok: true });
    expect(decodeCsDown(encodeCs({ t: "stop_result", ok: false, message: "此刻没有正在跑的 turn" }))).toEqual({
      t: "stop_result",
      ok: false,
      message: "此刻没有正在跑的 turn",
    });
  });

  it("decodeCsDown 对形状不对的 approve_result.callId 回 null", () => {
    expect(decodeCsDown(b64({ t: "approve_result", ok: true }))).toBeNull();
    expect(decodeCsDown(b64({ t: "approve_result", callId: 1, ok: true }))).toBeNull();
  });
});
