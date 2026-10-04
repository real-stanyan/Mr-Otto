// 双方公开的智能体互相说话（#1542）的纯逻辑：说话人标签、每小时窗口、对面点谁、发成之后回给模型的话。
import { describe, expect, it } from "vitest";
import {
  BRIDGE_PER_HOUR_MAX, BRIDGE_WINDOW_MS, bridgeSentText, bridgeSpeakerLabel, bridgeWindowAllows, pruneBridgeWindow, resolveBridgeTarget,
} from "../../src/shared/laneBridge.js";

describe("bridgeSpeakerLabel", () => {
  it("「X（A 的智能体）」；空名字兜底", () => {
    expect(bridgeSpeakerLabel("管理员", "爸爸")).toBe("管理员（爸爸 的智能体）");
    expect(bridgeSpeakerLabel(" ", "")).toBe("智能体（朋友 的智能体）");
  });
});

describe("每小时窗口", () => {
  it("满了不放；一小时前的那几次不算", () => {
    const now = 10 * BRIDGE_WINDOW_MS;
    const full = Array.from({ length: BRIDGE_PER_HOUR_MAX }, (_, i) => now - i * 1000);
    expect(bridgeWindowAllows(full, now)).toBe(false);
    expect(bridgeWindowAllows(full.slice(1), now)).toBe(true);
    const old = [now - BRIDGE_WINDOW_MS - 1, now - 1];
    expect(pruneBridgeWindow(old, now)).toEqual([now - 1]);
  });
});

describe("resolveBridgeTarget", () => {
  const roster = [{ agentId: "a_1", name: "管理员" }, { agentId: "a_2", name: "翻译" }];
  it("按名字精确；没给名字只有一只就是它、几只就 many；没有就 none 带名单", () => {
    expect(resolveBridgeTarget(roster, "翻译")).toEqual({ kind: "one", agentId: "a_2", name: "翻译" });
    expect(resolveBridgeTarget(roster, undefined)).toEqual({ kind: "many", count: 2 });
    expect(resolveBridgeTarget(roster.slice(0, 1), undefined)).toEqual({ kind: "one", agentId: "a_1", name: "管理员" });
    expect(resolveBridgeTarget(roster, "厨师")).toEqual({ kind: "none", names: ["管理员", "翻译"] });
    expect(resolveBridgeTarget([], undefined)).toEqual({ kind: "none", names: [] });
  });
});

describe("bridgeSentText", () => {
  it("说清发给了谁、回话在哪出现、先回主人", () => {
    const s = bridgeSentText("管理员", "Stan");
    expect(s).toContain("Stan 的智能体「管理员」");
    expect(s).toContain("先回主人一句");
  });
});
