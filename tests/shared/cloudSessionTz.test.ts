// say 帧的可选 tz（#1283，spec §6.1）：合法 IANA 名才进帧 / 才被读；脏值当缺席不拒帧（同 voice 那一格的口径）。
import { describe, expect, it } from "vitest";
import { CS_PROTOCOL_VERSION, decodeCsUp, encodeCs, type CsUp } from "../../src/shared/remote/cloudSession.js";

const say = (extra: Record<string, unknown>): CsUp | null =>
  decodeCsUp(encodeCs({ t: "say", text: "hi", mention: true, ...extra } as unknown as CsUp));

describe("say 帧的 tz", () => {
  it("合法时区原样进帧", () => {
    expect(say({ tz: "Asia/Shanghai" })).toMatchObject({ t: "say", tz: "Asia/Shanghai" });
  });
  it("脏值 / 不是字符串：当缺席，整帧照收", () => {
    expect(say({ tz: "Beijing" })).toEqual({ t: "say", text: "hi", mention: true });
    expect(say({ tz: 8 })).toEqual({ t: "say", text: "hi", mention: true });
  });
  it("协议号不动（可选字段）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(24);
  });
});
