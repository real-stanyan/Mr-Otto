// 群语音里「人说话」那一半的渲染层纯逻辑（#1176，ADR-0273）：helper 事件 → 麦克风状态
// （开着 / 暂停 / 没权限 / 出错 / 实时字幕），final 交给调用方发出去；半双工的判据
// （agent 在说或排着要说 → 闭麦）。零 DOM、零 IPC。
import { describe, expect, it } from "vitest";
import { applySpeechEvent, bargeInOn, isSelfEcho, MIC_OFF, micShouldPause, SPEECH_HINTS_MAX, speechHints, type MicState } from "../../src/renderer/src/lib/voiceMic.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

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
    let r = applySpeechEvent(starting, { type: "status", speech: "denied", mic: "authorized", onDevice: true, locale: "zh-CN", aec: null });
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toContain("语音识别");
    expect(r.state.error).toContain("系统设置");
    r = applySpeechEvent(starting, { type: "status", speech: "authorized", mic: "denied", onDevice: true, locale: "zh-CN", aec: null });
    expect(r.state.status).toBe("denied");
    expect(r.state.error).toContain("麦克风");
    r = applySpeechEvent(starting, { type: "status", speech: "authorized", mic: "authorized", onDevice: false, locale: "zh-CN", aec: null });
    expect(r.state.status).toBe("starting");
    expect(r.state.onDevice).toBe(false);
    expect(r.state.error).toBeNull();
    // notDetermined = 系统正在问，还不是拒绝
    r = applySpeechEvent(starting, { type: "status", speech: "notDetermined", mic: "notDetermined", onDevice: null, locale: null, aec: null });
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
    expect(micShouldPause({ speaking: "a_1", queued: 0, aec: null })).toBe(true);
    expect(micShouldPause({ speaking: null, queued: 2, aec: null })).toBe(true);
    expect(micShouldPause({ speaking: null, queued: 0, aec: null })).toBe(false);
  });
});

// 常开麦 + 打断（#1184）：helper 开着系统回声消除时 agent 说话不闭麦；人一开口就停播放。
describe("回声消除与声浪（#1184）", () => {
  it("status 带 aec → 记下来；level → 声浪与「有人在说话」；listening:off 声浪归零", () => {
    let r = applySpeechEvent(starting, { type: "status", speech: "authorized", mic: "authorized", onDevice: true, locale: "zh-CN", aec: true });
    expect(r.state.aec).toBe(true);
    r = applySpeechEvent(r.state, { type: "level", value: 0.42, active: true });
    expect(r.state).toMatchObject({ level: 0.42, active: true });
    r = applySpeechEvent(r.state, { type: "listening", on: false });
    expect(r.state).toMatchObject({ level: 0, active: false });
  });

  it("micShouldPause：回声消除开着 → 永远不闭麦；开不了 / 不知道 → 照旧半双工", () => {
    expect(micShouldPause({ speaking: "a_1", queued: 0, aec: true })).toBe(false);
    expect(micShouldPause({ speaking: null, queued: 2, aec: true })).toBe(false);
    expect(micShouldPause({ speaking: "a_1", queued: 0, aec: false })).toBe(true);
    expect(micShouldPause({ speaking: "a_1", queued: 0, aec: null })).toBe(true);
    expect(micShouldPause({ speaking: null, queued: 0, aec: null })).toBe(false);
  });
});

describe("bargeInOn：人一开口就停 agent 的播放", () => {
  const playing = { speaking: "a_1", queued: 0 };
  it("agent 在说 + 人的一句够长 → 打断；静默时不算打断（没东西可停）", () => {
    expect(bargeInOn("等一下我想问", playing, "能听到，你说话我这边都收得到")).toBe(true);
    expect(bargeInOn("等一下我想问", { speaking: null, queued: 1 }, "")).toBe(true);
    expect(bargeInOn("等一下我想问", { speaking: null, queued: 0 }, "")).toBe(false);
  });
  it("太短的碎片（嗯 / 啊 / 两个字）不打断——咳嗽和应声不是插话", () => {
    expect(bargeInOn("嗯", playing, "")).toBe(false);
    expect(bargeInOn("好的", playing, "")).toBe(false);
    expect(bargeInOn("好的呀", playing, "")).toBe(true);
    expect(bargeInOn("ok sure", playing, "")).toBe(false);
    expect(bargeInOn("ok sure wait", playing, "")).toBe(true);
  });
  it("像是它自己的话被录回来的（与正在读的那段 token 重叠 ≥ 70%）不打断——回声消除的兜底", () => {
    expect(bargeInOn("能听到你说话", playing, "能听到，你说话我这边都收得到，很清楚。")).toBe(false);
    expect(bargeInOn("能听到你说话，我想问个问题", playing, "能听到，你说话我这边都收得到，很清楚。")).toBe(true);
  });
});

describe("isSelfEcho：token 重叠", () => {
  it("汉字逐字算 token；标点不算；重叠比例按识别出来的那句算", () => {
    expect(isSelfEcho("能听到你说话", "能听到，你说话我这边都收得到")).toBe(true);
    expect(isSelfEcho("我想问个问题", "能听到，你说话我这边都收得到")).toBe(false);
    expect(isSelfEcho("", "能听到")).toBe(false);
    expect(isSelfEcho("能听到", "")).toBe(false);
  });
});

describe("speechHints：喂给识别器的上下文词表（#1196）", () => {
  const ws: WorkspaceSnapshot = {
    id: "w", name: "奶茶店", ownerUid: "u1", connectors: [], sessions: [],
    members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }, { uid: "u2", role: "member", label: "", avatarUrl: "" }],
    agents: [
      { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
      { agentId: "a_1", name: "GitHub", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    ],
    sandboxApproval: "ask",
  };
  it("agent 名 + 成员名 + 团队名在前，开发常用词在后；空串丢掉、去重、封顶", () => {
    const h = speechHints(ws);
    expect(h.slice(0, 4)).toEqual(["管理员", "GitHub", "Stan", "奶茶店"]);
    expect(h).toContain("push");
    expect(h.filter((x) => x === "GitHub")).toHaveLength(1);
    expect(h).not.toContain("");
    expect(h.length).toBeLessThanOrEqual(SPEECH_HINTS_MAX);
  });
  it("没有团队快照：只剩开发常用词", () => {
    expect(speechHints(null)).toContain("GitHub");
  });
});
