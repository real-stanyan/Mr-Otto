// 名片（#1524）：编 / 解 / 画三件纯逻辑。解是严格的——名片是别人发来的字，要拿去建智能体 / 发好友请求，一格不对整张不认；
// 编不下（提示词把 4000 字的 body 撑爆）就拒，不截断。
import { describe, expect, it } from "vitest";
import {
  CARD_TOO_BIG, CONTACT_CARD_KIND, contactCardPreview, contactCardView, decodeContactCard, encodeContactCard, type AgentCard, type PersonCard,
} from "../../src/shared/contactCard.js";
import { decodeEnvelope } from "../../src/shared/sessionPackageCodec.js";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

const person: PersonCard = { kind: "person", uid: THIRD, name: "阿杰", avatarUrl: "https://x/a.png", email: "aj@example.com" };
const agent: AgentCard = {
  kind: "agent", agentId: "a_0123456789ab", name: "翻译", description: "中英互译", instructions: "你是翻译。", avatarSlot: 3, voice: "warm",
  from: { uid: PEER, name: "小红" },
};

describe("encode / decode", () => {
  it("联系人名片来回一致；uid 归一成小写", () => {
    const body = encodeContactCard({ ...person, uid: THIRD.toUpperCase() });
    expect(JSON.parse(body)).toMatchObject({ otto: CONTACT_CARD_KIND, v: 1 });
    expect(decodeContactCard(body)).toEqual(person);
  });
  it("智能体名片来回一致；没挑过声音就没有那一格", () => {
    expect(decodeContactCard(encodeContactCard(agent))).toEqual(agent);
    const { voice: _v, ...noVoice } = agent;
    void _v;
    expect(decodeContactCard(encodeContactCard(noVoice))).toEqual(noVoice);
  });
  it("不是名片的一律 null：普通话、分享会话的信封、别的 otto、v 不对；反过来分享会话那边也不认名片", () => {
    expect(decodeContactCard("周末去哪")).toBeNull();
    expect(decodeContactCard("{\"otto\":\"otto.session-share\",\"v\":1,\"bucket\":\"b\",\"prefix\":\"p\"}")).toBeNull();
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 2, card: person }))).toBeNull();
    expect(decodeEnvelope(encodeContactCard(person))).toBeNull();
  });
  it("严格：uid 不像 uid、agentId 形状不对、名字空、from 缺一格，整张不认", () => {
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...person, uid: "nope" } }))).toBeNull();
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...agent, agentId: "x_1" } }))).toBeNull();
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...agent, name: "  " } }))).toBeNull();
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...agent, from: { uid: PEER } } }))).toBeNull();
    expect(decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...agent, instructions: 7 } }))).toBeNull();
  });
  it("脸的坑位：null / 缺席 / 负数 / 小数 → null；非负整数原样", () => {
    const of = (avatarSlot: unknown) => (decodeContactCard(JSON.stringify({ otto: CONTACT_CARD_KIND, v: 1, card: { ...agent, avatarSlot } })) as AgentCard | null)?.avatarSlot;
    expect(of(null)).toBeNull();
    expect(of(undefined)).toBeNull();
    expect(of(-1)).toBeNull();
    expect(of(1.5)).toBeNull();
    expect(of(7)).toBe(7);
  });
  it("装不下就拒（提示词把 body 撑过 4000 字），不截断", () => {
    expect(() => encodeContactCard({ ...agent, instructions: "字".repeat(3990) })).toThrow(CARD_TOO_BIG);
    expect((decodeContactCard(encodeContactCard({ ...agent, instructions: "字".repeat(3000) })) as AgentCard | null)?.instructions.length).toBe(3000);
  });
});

describe("contactCardPreview：列表 / 推送 / 信封里的一行", () => {
  it("不摊开 JSON", () => {
    expect(contactCardPreview(person)).toBe("[名片] 阿杰");
    expect(contactCardPreview(agent)).toBe("[智能体名片] 翻译");
  });
});

describe("contactCardView：我屏幕上这张卡", () => {
  it("联系人：别人推的——不是朋友给「加为朋友」、已是朋友给「发消息」、是我自己不给钮；自己发的不给钮", () => {
    const base = { mine: false, fromName: "小红", selfUid: ME, friendUids: [PEER] };
    expect(contactCardView(person, base)).toMatchObject({ heading: "小红 推荐了一位联系人", title: "阿杰", subtitle: "aj@example.com", action: { kind: "add_friend" } });
    expect(contactCardView(person, { ...base, friendUids: [PEER, THIRD] }).action.kind).toBe("open_chat");
    expect(contactCardView({ ...person, uid: ME }, base).action.kind).toBe("none");
    expect(contactCardView(person, { ...base, mine: true })).toMatchObject({ heading: "你推荐了一位联系人", action: { kind: "none" } });
  });
  it("智能体：别人发的给「接受」、刚接受过写「已保存」、自己发的不给钮；职责空就写「X 的智能体」", () => {
    const base = { mine: false, fromName: "小红", selfUid: ME, friendUids: [PEER] };
    expect(contactCardView(agent, base)).toMatchObject({ heading: "小红 分享了一只智能体", title: "翻译", subtitle: "中英互译", action: { kind: "accept_agent", label: "接受" } });
    expect(contactCardView(agent, { ...base, accepted: true }).action).toEqual({ kind: "none", label: "已保存到我的智能体" });
    expect(contactCardView(agent, { ...base, mine: true }).action.kind).toBe("none");
    expect(contactCardView({ ...agent, description: " " }, base).subtitle).toBe("小红 的智能体");
  });
  it("发送方没名字时抬头写「对方」", () => {
    expect(contactCardView(person, { mine: false, fromName: " ", selfUid: ME, friendUids: [] }).heading).toBe("对方 推荐了一位联系人");
  });
});
