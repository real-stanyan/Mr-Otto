// 每只 agent 用哪个 MiniMax 音色（#1163）。派生不落库（拍板：音色自动派生），
// 算法逐字照 agentAvatarSlot：管理员固定、其余按 agent_id 哈希、按名单顺序解撞——
// 群语音里靠声音分人，同一只在两台机器、两次刷新上必须是同一个声音。
import { describe, expect, it } from "vitest";
import { ADMIN_VOICE_ID, AGENT_VOICES, agentVoiceId, agentVoiceIds } from "../../src/shared/agentVoice.js";
import { fnv1a } from "../../src/shared/fnv1a.js";

describe("AGENT_VOICES", () => {
  it("音色 id 唯一、非空，且不含管理员那个（它固定，不进轮换池）", () => {
    const ids = AGENT_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(ids).not.toContain(ADMIN_VOICE_ID);
    expect(AGENT_VOICES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("agentVoiceIds", () => {
  it("管理员固定沉稳高管；同一 id 无论名单怎么排都同一个音色", () => {
    expect(agentVoiceId("admin", ["admin"])).toBe(ADMIN_VOICE_ID);
    expect(agentVoiceId("admin", ["a_1", "admin"])).toBe(ADMIN_VOICE_ID);
    expect(agentVoiceId("a_1", ["admin", "a_1"])).toBe(agentVoiceId("a_1", ["a_1"]));
  });

  it("名单顺序解撞：池子装得下时一只一个声音，一个都不重", () => {
    const roster = ["admin", ...Array.from({ length: AGENT_VOICES.length }, (_, i) => `a_${i}`)];
    const ids = agentVoiceIds(roster);
    expect(ids.size).toBe(roster.length);
    expect(new Set(ids.values()).size).toBe(roster.length);
  });

  it("池子装不下时退回天然位（重复不可避免，至少每只自己稳定）；不在名单里的 id 也答得出", () => {
    const roster = Array.from({ length: AGENT_VOICES.length + 5 }, (_, i) => `x_${i}`);
    const ids = agentVoiceIds(roster);
    expect(ids.size).toBe(roster.length);
    for (const id of roster) expect(AGENT_VOICES.some((v) => v.id === ids.get(id))).toBe(true);
    expect(AGENT_VOICES.some((v) => v.id === agentVoiceId("stranger", []))).toBe(true);
  });
});

describe("fnv1a（抽到 shared 让头像与音色共用）", () => {
  it("稳定、32 位、对不同输入不同", () => {
    expect(fnv1a("a")).toBe(fnv1a("a"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("abc")).toBeLessThan(2 ** 32);
  });
});
