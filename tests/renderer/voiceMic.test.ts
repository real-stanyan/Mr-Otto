// 群语音里「人说话」那一半的渲染层纯逻辑（#1176，ADR-0273）：helper 事件 → 麦克风状态
// （开着 / 暂停 / 没权限 / 出错 / 实时字幕），final 交给调用方发出去；半双工的判据
// （agent 在说或排着要说 → 闭麦）。零 DOM、零 IPC。
import { describe, expect, it } from "vitest";
import { applySpeechEvent, MIC_OFF, micShouldPause, type MicState } from "../../src/renderer/src/lib/voiceMic.js";

const starting: MicState = { ...MIC_OFF, status: "starting" };

describe("applySpeechEvent", () => {
  it("listening:on → listening；partial 更新字幕；final 清字幕并交出这句", () => {
    let r = applySpeechEvent(starting, { type: "listening", on: true });
    expect(r.state.status).toBe("listening");
    r = applySpeechEvent(r.state, { type: "partial", text: "帮我看" });
    expect(r.state.transcript).toBe("帮我看");
    expect(r.final).toBeUndefined();
    r = applySpeechEvent(r.state, { type: "final", text: "帮我看下投放" });
    expect(r.final).toBe("帮我看下投放");
    expect(r.state.transcript).toBe("");
    expect(r.state.status).toBe("listening");
  });

  it("空的 final 不交出（识别器偶尔吐空串）", () => {
    const r = applySpeechEvent({ ...starting, status: "listening" }, { type: "final", text: "  " });
    expect(r.final).toBeUndefined();
  });

  it("paused / resumed 只翻状态；listening:off → off 并清字幕", () => {
    let r = applySpeechEvent({ ...starting, status: "listening", transcript: "在" }, { type: "paused" });
    expect(r.state.status).toBe("paused");
    r = applySpeechEvent(r.state, { type: "resumed" });
    expect(r.state.status).toBe("listening");
    r = applySpeechEvent(r.state, { type: "listening", on: false });
    expect(r.state).toMatchObject({ status: "off", transcript: "" });
  });

  it("status：哪道权限没过就说清去哪儿勾；都过了记 onDevice 不改状态", () => {
    let r = applySpeechEvent(starting, { type: "status", speech: "denied", mic: "authorized", onDevice: true, locale: "zh-CN" });
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toContain("语音识别");
    expect(r.state.error).toContain("系统设置");
    r = applySpeechEvent(starting, { type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN" });
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toContain("麦克风");
    r = applySpeechEvent(starting, { type: "status", speech: "authorized", mic: "authorized", onDevice: false, locale: "zh-CN" });
    expect(r.state.status).toBe("starting");
    expect(r.state.onDevice).toBe(false);
    expect(r.state.error).toBeNull();
    // notDetermined = 系统正在问，还不是拒绝
    r = applySpeechEvent(starting, { type: "status", speech: "notDetermined", mic: "notDetermined", onDevice: null, locale: null });
    expect(r.state.status).toBe("starting");
  });

  it("error：记那句话；权限类错误之外状态翻成 error；没权限时 status 那条已经说过，error 不覆盖它", () => {
    let r = applySpeechEvent({ ...starting, status: "listening" }, { type: "error", message: "识别中断：x，正在重试" });
    expect(r.state.status).toBe("error");
    expect(r.state.error).toBe("识别中断：x，正在重试");
    r = applySpeechEvent({ ...starting, status: "denied", error: "没有「麦克风」权限：系统设置…" }, { type: "error", message: "没有「麦克风」权限" });
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toContain("系统设置");
  });
});

describe("micShouldPause（半双工）", () => {
  it("agent 在说、或队列里还有段要说 → 闭麦；静默 → 开麦", () => {
    expect(micShouldPause({ speaking: "a_1", queued: 0 })).toBe(true);
    expect(micShouldPause({ speaking: null, queued: 2 })).toBe(true);
    expect(micShouldPause({ speaking: null, queued: 0 })).toBe(false);
  });
});
