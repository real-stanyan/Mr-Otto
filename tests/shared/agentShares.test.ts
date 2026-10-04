// 共有的智能体（#1545）的纯逻辑：行怎么认、某一只在我名册上标什么、接受后发的那句。
import { describe, expect, it } from "vitest";
import { acceptedShareText, agentShareBadge, parseAgentShareRow, type AgentShare } from "../../src/shared/agentShares.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const nameOf = (uid: string): string => (uid === A ? "Stan" : uid === B ? "爸爸" : uid === C ? "小红" : uid.slice(0, 8));
const share = (ownerUid: string, agentId: string, withUid: string, copyAgentId: string): AgentShare => ({ ownerUid, agentId, withUid, copyAgentId, name: "峰哥" });

describe("parseAgentShareRow", () => {
  it("四个 id 都是字符串才认；name 缺了给空串", () => {
    expect(parseAgentShareRow({ owner_uid: A, agent_id: "a_1", with_uid: B, copy_agent_id: "a_2", name: "峰哥" })).toEqual(share(A, "a_1", B, "a_2"));
    expect(parseAgentShareRow({ owner_uid: A, agent_id: "a_1", with_uid: B, copy_agent_id: "a_2" })?.name).toBe("");
    expect(parseAgentShareRow({ owner_uid: A, agent_id: "a_1" })).toBeNull();
    expect(parseAgentShareRow(null)).toBeNull();
  });
});

describe("agentShareBadge", () => {
  const shares = [share(A, "a_1", B, "a_2"), share(A, "a_1", C, "a_3")];
  it("接受方看复制出来的那只：「共有 · 来自 X」", () => {
    expect(agentShareBadge("a_2", shares, B, nameOf)).toBe("共有 · 来自 Stan");
  });
  it("分享方看原来那只：「共有 · X、Y 也有一只」；超过三位写「等 N 人」", () => {
    expect(agentShareBadge("a_1", shares, A, nameOf)).toBe("共有 · 爸爸、小红也有一只");
    const many = [...shares, share(A, "a_1", "44444444-4444-4444-8444-444444444444", "a_4"), share(A, "a_1", "55555555-5555-4555-8555-555555555555", "a_5")];
    expect(agentShareBadge("a_1", many, A, nameOf)).toMatch(/^共有 · 爸爸、小红、44444444 等 4 人也有一只$/);
  });
  it("与我无关的那只不标", () => {
    expect(agentShareBadge("a_9", shares, A, nameOf)).toBeNull();
    expect(agentShareBadge("a_1", shares, C, nameOf)).toBeNull();
  });
});

describe("acceptedShareText", () => {
  it("说清接受了哪只、现在俩人都有", () => {
    expect(acceptedShareText("峰哥")).toBe("我接受了你分享的智能体「峰哥」，现在我们俩都有这只。");
  });
});
