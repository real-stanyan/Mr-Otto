import { describe, it, expect } from "vitest";
import {
  DEFAULT_RELAY_MAX_DEPTH, decideRelay, hopFingerprint, mentionedAgents, normalizeRelayMaxDepth,
  relayCapText, relayChain, relayDepthOf, relayNudgeText, relayOpeningText,
} from "../../src/shared/agentRelay.js";
import type { AgentRelayEvent, SessionEvent, UserMessageEvent } from "../../src/session/events.js";

let seq = 0;
const um = (extra: Partial<UserMessageEvent>): UserMessageEvent => ({ seq: seq++, ts: 1, sessionId: "s", type: "user_message", content: "x", ...extra });
const relay = (from: string, to: string, depth: number): AgentRelayEvent => ({ seq: seq++, ts: 1, sessionId: "s", type: "agent_relay", fromAgentId: from, toAgentId: to, depth });
const ROSTER = [{ agentId: "ops", name: "运营" }, { agentId: "ads", name: "广告" }];

describe("agentRelay 纯逻辑（#950，spec §8）", () => {
  it("relayDepthOf：人说的 0，接力开场白取 relay.depth", () => {
    expect(relayDepthOf(um({}))).toBe(0);
    expect(relayDepthOf(um({ relay: { fromAgentId: "ops", depth: 3 } }))).toBe(3);
  });

  it("relayChain：只算最近一条人点名之后的 agent_relay（人话点火重置）", () => {
    seq = 0;
    const events: SessionEvent[] = [
      um({ mentions: ["ops"] }), relay("ops", "ads", 1), relay("ads", "ops", 2),
      um({ mentions: ["ads"] }),                         // 人又点了一次名 → 新链
      um({ mentions: ["ops"], relay: { fromAgentId: "ads", depth: 1 } }), // 接力开场白不算点火
      relay("ads", "ops", 1),
    ];
    expect(relayChain(events).map((h) => h.seq)).toEqual([5]);
    expect(relayChain([um({})])).toEqual([]);
  });

  it("mentionedAgents：用 parseMentions，去掉自己", () => {
    expect(mentionedAgents("我做完了，@广告 接着投；@运营 自己也别忘", ROSTER, "ops")).toEqual(["ads"]);
    expect(mentionedAgents("没人", ROSTER, "ops")).toEqual([]);
  });

  it("decideRelay：depth = 开场白 depth + 1；超上限回 cap", () => {
    expect(decideRelay({ chain: [], fromAgentId: "ops", toAgentId: "ads", openingDepth: 0, maxDepth: 6 })).toEqual({ kind: "relay", depth: 1, loop: null });
    expect(decideRelay({ chain: [], fromAgentId: "ops", toAgentId: "ads", openingDepth: 6, maxDepth: 6 })).toEqual({ kind: "cap", depth: 7, max: 6 });
  });

  it("decideRelay：周期重复（A→B→A→B）在第 4 棒命中护栏，不停", () => {
    seq = 0;
    const chain = [relay("ops", "ads", 1), relay("ads", "ops", 2), relay("ops", "ads", 3)];
    const d = decideRelay({ chain, fromAgentId: "ads", toAgentId: "ops", openingDepth: 3, maxDepth: 10 });
    expect(d).toEqual({ kind: "relay", depth: 4, loop: { period: 2, repeats: 2 } });
    // 第 3 棒时还没凑够两遍
    expect(decideRelay({ chain: chain.slice(0, 2), fromAgentId: "ops", toAgentId: "ads", openingDepth: 2, maxDepth: 10 })).toMatchObject({ kind: "relay", loop: null });
  });

  it("文案：开场白说明谁 @ 了你、第几棒；护栏说打转；到顶说停在这儿并带最后的话", () => {
    expect(relayOpeningText("运营", "广告", 2)).toContain("「运营」");
    expect(relayOpeningText("运营", "广告", 2)).toContain("第 2 棒");
    expect(relayNudgeText("运营", "广告", { period: 2, repeats: 2 })).toContain("打转");
    const cap = relayCapText("运营", "广告", 7, 6, "还差报表");
    expect(cap).toContain("接力到上限");
    expect(cap).toContain("还差报表");
    expect(cap).toContain("6");
  });

  it("normalizeRelayMaxDepth：整数且 1–20 才认，其余回默认 6", () => {
    expect(DEFAULT_RELAY_MAX_DEPTH).toBe(6);
    expect(normalizeRelayMaxDepth(3)).toBe(3);
    expect(normalizeRelayMaxDepth(0)).toBe(6);
    expect(normalizeRelayMaxDepth(21)).toBe(6);
    expect(normalizeRelayMaxDepth("3")).toBe(6);
    expect(normalizeRelayMaxDepth(2.5)).toBe(6);
    expect(hopFingerprint("a", "b")).toBe("a>b");
  });
});
