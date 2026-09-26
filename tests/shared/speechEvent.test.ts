// speechEventOf（#1176；#1356 A4 抽进 shared）：识别那一侧吐来的一条事件 → SpeechEvent。桌面 helper 一行
// JSON（speechBridge 先 JSON.parse）与手机原生模块递来的对象走同一份验形；形状不对一律 null。
import { describe, expect, it } from "vitest";
import { speechEventOf } from "../../src/shared/speechEvent.js";

describe("speechEventOf", () => {
  it("status：两道授权必须是认得的四档之一；onDevice / locale / aec 缺席或类型不对 → null 那一格", () => {
    expect(speechEventOf({ type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: false })).toEqual({
      type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: false,
    });
    expect(speechEventOf({ type: "status", speech: "authorized", mic: "authorized" })).toEqual({
      type: "status", speech: "authorized", mic: "authorized", onDevice: null, locale: null, aec: null,
    });
    expect(speechEventOf({ type: "status", speech: "maybe", mic: "authorized" })).toBeNull();
  });
  it("partial / final 要 text；level 要有限的数；played 要 id；playError 要 id + message", () => {
    expect(speechEventOf({ type: "final", text: "帮我看下" })).toEqual({ type: "final", text: "帮我看下" });
    expect(speechEventOf({ type: "partial" })).toBeNull();
    expect(speechEventOf({ type: "level", value: 0.4, active: true })).toEqual({ type: "level", value: 0.4, active: true });
    expect(speechEventOf({ type: "level", value: Number.NaN })).toBeNull();
    expect(speechEventOf({ type: "played", id: "v1" })).toEqual({ type: "played", id: "v1" });
    expect(speechEventOf({ type: "played" })).toBeNull();
    expect(speechEventOf({ type: "playError", id: "v1", message: "音频解不开" })).toEqual({ type: "playError", id: "v1", message: "音频解不开" });
    expect(speechEventOf({ type: "playError", id: "v1" })).toBeNull();
  });
  it("不认得的 type、null、原始值 → null", () => {
    expect(speechEventOf({ type: "teleport" })).toBeNull();
    expect(speechEventOf(null)).toBeNull();
    expect(speechEventOf("final")).toBeNull();
    expect(speechEventOf(42)).toBeNull();
  });
});
