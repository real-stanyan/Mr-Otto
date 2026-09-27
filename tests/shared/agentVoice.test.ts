// 每只 agent 用哪个 MiniMax 音色（#1163）：缺省按 agent_id 派生（管理员固定、其余哈希、按名单顺序解撞）；
// #1372 起可以挑（workspace_agents.voice 存六档之一的键），挑过的先占、派生的让开——
// 群语音里靠声音分人，同一只在两台机器、两次刷新上必须是同一个声音。
import { describe, expect, it } from "vitest";
import {
  ADMIN_VOICE_ID, AGENT_VOICES, AGENT_VOICE_CHOICES, VOICE_KEY_RE, agentVoiceId, agentVoiceIds, voiceChoiceOf,
} from "../../src/shared/agentVoice.js";
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

describe("AGENT_VOICE_CHOICES（#1372，#1356 A4b）", () => {
  it("六档，键唯一且合 0042 的形状；每档的音色都在派生池里（挑过的才占得了位）", () => {
    expect(AGENT_VOICE_CHOICES.map((c) => c.key)).toEqual(["qing", "wen", "chen", "gan", "shao", "bo"]);
    for (const c of AGENT_VOICE_CHOICES) {
      expect(VOICE_KEY_RE.test(c.key)).toBe(true);
      expect(AGENT_VOICES.some((v) => v.id === c.voiceId)).toBe(true);
    }
    expect(new Set(AGENT_VOICE_CHOICES.map((c) => c.voiceId)).size).toBe(AGENT_VOICE_CHOICES.length);
  });

  it("对应钉死（维护者 2026-09-27 定的默认对应；改这张表 = 改所有挑过这一档的智能体的声音）", () => {
    expect(Object.fromEntries(AGENT_VOICE_CHOICES.map((c) => [c.key, c.voiceId]))).toEqual({
      qing: "Chinese (Mandarin)_Warm_Bestie",
      wen: "female-chengshu",
      chen: "Chinese (Mandarin)_Gentleman",
      gan: "male-qn-jingying",
      shao: "male-qn-daxuesheng",
      bo: "Chinese (Mandarin)_Radio_Host",
    });
    expect(AGENT_VOICE_CHOICES.map((c) => c.label)).toEqual(["清亮", "温和", "沉稳", "干脆", "少年", "播音"]);
  });

  it("voiceChoiceOf：null / 缺席 / 认不出的键（旧客户端读到新键）都回 null", () => {
    expect(voiceChoiceOf("gan")?.label).toBe("干脆");
    expect(voiceChoiceOf(null)).toBeNull();
    expect(voiceChoiceOf(undefined)).toBeNull();
    expect(voiceChoiceOf("zzz")).toBeNull();
  });
});

describe("agentVoiceIds：挑过的先占（#1372）", () => {
  it("挑过的用它挑的那一档；管理员挑了也照它挑的", () => {
    const ids = agentVoiceIds([{ agentId: "admin", voice: "bo" }, { agentId: "a_1", voice: "gan" }]);
    expect(ids.get("admin")).toBe(voiceChoiceOf("bo")!.voiceId);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
  });

  it("只有 id 的旧写法与「没挑过」的条目同义；认不出的键当没挑过", () => {
    expect([...agentVoiceIds(["admin", "a_1", "a_2"])]).toEqual([
      ...agentVoiceIds([{ agentId: "admin" }, { agentId: "a_1" }, { agentId: "a_2", voice: "zzz" }]),
    ]);
  });

  it("没挑过的派生时让开挑过的：它的天然位被别人挑走了，就往后挪到别的音色上", () => {
    // 找一只天然位恰好落在六档之一上的 id，再让另一只把那一档挑走
    const id = Array.from({ length: 500 }, (_, i) => `x_${i}`).find((x) =>
      AGENT_VOICE_CHOICES.some((c) => c.voiceId === agentVoiceId(x, [x])))!;
    const natural = AGENT_VOICE_CHOICES.find((c) => c.voiceId === agentVoiceId(id, [id]))!;
    const ids = agentVoiceIds([{ agentId: "y_1", voice: natural.key }, id]);
    expect(ids.get("y_1")).toBe(natural.voiceId);
    expect(ids.get(id)).not.toBe(natural.voiceId);
    expect(AGENT_VOICES.some((v) => v.id === ids.get(id))).toBe(true);
  });

  it("挑过的排在名单后面也先占：先建的那只派生时照样让开", () => {
    const id = Array.from({ length: 500 }, (_, i) => `x_${i}`).find((x) =>
      AGENT_VOICE_CHOICES.some((c) => c.voiceId === agentVoiceId(x, [x])))!;
    const natural = AGENT_VOICE_CHOICES.find((c) => c.voiceId === agentVoiceId(id, [id]))!;
    const ids = agentVoiceIds([id, { agentId: "y_1", voice: natural.key }]);
    expect(ids.get("y_1")).toBe(natural.voiceId);
    expect(ids.get(id)).not.toBe(natural.voiceId);
  });

  it("两只挑了同一档：两只都照挑的（人自己负责）", () => {
    const ids = agentVoiceIds([{ agentId: "a_1", voice: "gan" }, { agentId: "a_2", voice: "gan" }]);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
    expect(ids.get("a_2")).toBe(voiceChoiceOf("gan")!.voiceId);
  });

  it("名单里重复出现的 id 只认第一次", () => {
    const ids = agentVoiceIds([{ agentId: "a_1", voice: "gan" }, { agentId: "a_1", voice: "bo" }]);
    expect(ids.get("a_1")).toBe(voiceChoiceOf("gan")!.voiceId);
  });
});
