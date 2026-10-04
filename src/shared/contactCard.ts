// 名片（#1524）：像微信一样，在朋友私聊里把一位联系人、或把自己的一只智能体当名片发给对方。
//
// 形状沿 sessionPackageCodec 的「信封」做法：DM body **整段**是一段 JSON（`otto: "otto.contact-card"`），接收方认出就画成卡，
// 认不出（老客户端）看到的是一坨 JSON——与分享会话那张卡同一条代价，这里不另发明一种夹在正文里的记号。
// 两种名片：
//   · 联系人（person）：某位朋友的 uid + 名字 / 头像 / 邮箱**快照**——收到的人点「加为朋友」走现成的好友请求（#1494 的档位照旧选）。
//     推别人的联系人不问被推的人（微信同款）。
//   · 智能体（agent）：我的一只智能体**可带走的定义**——名字、职责、提示词、脸、声音；收到的人点「接受」就在**自己主场**里
//     复制出一只（新 id、由接受者的电脑跑、花接受者的额度），与原主人那只从此各管各的——不是共享同一只（共享是 #1461 的车道）。
//     记忆、连接器白名单、型号不带：那些是主人的东西或主人电脑上的事实。
// 大小：messages.body 的 CHECK 是 4000 字，而提示词本身就能到 4000（AGENT_INSTRUCTIONS_MAX），所以**编不下就拒**，
// 不截断——截掉一半的提示词是另一只智能体。
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "./createAgentDraft.js";
import { AGENT_NAME_MAX } from "./workspaceAgents.js";

export const CONTACT_CARD_KIND = "otto.contact-card";
/** messages.body 的上限（0001 的 CHECK） */
export const DM_BODY_MAX = 4000;
export const CARD_TOO_BIG = "这只智能体的提示词太长，名片装不下。";

export interface PersonCard {
  kind: "person";
  uid: string;
  name: string;
  avatarUrl: string;
  email: string;
}

export interface AgentCard {
  kind: "agent";
  /** 原主人那边的 id：只用来认「同一张名片」，接受时另铸一个 */
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  /** 挑过的脸；null = 没挑过（接受方按新 id 派生） */
  avatarSlot: number | null;
  /** 声音的键（AGENT_VOICE_CHOICES）；缺席 = 没挑过 */
  voice?: string;
  /** 谁的智能体（发名片那一刻的快照） */
  from: { uid: string; name: string };
}

export type ContactCard = PersonCard | AgentCard;

export interface ContactCardEnvelope {
  otto: typeof CONTACT_CARD_KIND;
  v: 1;
  card: ContactCard;
}

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^(a_[0-9a-f]{12}|admin|default)$/;

/** 编名片：body 字符串。装不下抛 CARD_TOO_BIG（调用方把它说给人听，不发） */
export function encodeContactCard(card: ContactCard): string {
  const env: ContactCardEnvelope = { otto: CONTACT_CARD_KIND, v: 1, card };
  const body = JSON.stringify(env);
  if (body.length > DM_BODY_MAX) throw new Error(CARD_TOO_BIG);
  return body;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** 解名片：认得出就回结构化的卡，认不出（普通私信 / 分享会话的信封 / 形状不对）回 null。
    **严格**：名片是别人发来的字，要拿去建智能体 / 发好友请求，一格不对整张不认，不「修好了再用」 */
export function decodeContactCard(body: string): ContactCard | null {
  if (body.length > DM_BODY_MAX || !body.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const e = o as Partial<ContactCardEnvelope>;
  if (e.otto !== CONTACT_CARD_KIND || e.v !== 1 || typeof e.card !== "object" || e.card === null) return null;
  const c = e.card as unknown as Record<string, unknown>;
  if (c.kind === "person") {
    const uid = str(c.uid, 64);
    const name = str(c.name, 200);
    if (uid === null || !UID_RE.test(uid) || name === null) return null;
    return { kind: "person", uid: uid.toLowerCase(), name, avatarUrl: str(c.avatarUrl, 2000) ?? "", email: str(c.email, 320) ?? "" };
  }
  if (c.kind === "agent") {
    const agentId = str(c.agentId, 32);
    const name = str(c.name, AGENT_NAME_MAX);
    const description = str(c.description, AGENT_DESCRIPTION_MAX);
    const instructions = str(c.instructions, AGENT_INSTRUCTIONS_MAX);
    const from = c.from as Record<string, unknown> | null | undefined;
    const fromUid = from !== null && typeof from === "object" ? str(from.uid, 64) : null;
    const fromName = from !== null && typeof from === "object" ? str(from.name, 200) : null;
    if (agentId === null || !AGENT_ID_RE.test(agentId) || name === null || name.trim() === "" || description === null || instructions === null) return null;
    if (fromUid === null || !UID_RE.test(fromUid) || fromName === null) return null;
    const slot = c.avatarSlot;
    const avatarSlot = slot === null || slot === undefined ? null : Number.isInteger(slot) && (slot as number) >= 0 ? (slot as number) : null;
    const voice = str(c.voice, 64);
    return {
      kind: "agent", agentId, name, description, instructions, avatarSlot,
      ...(voice !== null && voice !== "" ? { voice } : {}),
      from: { uid: fromUid.toLowerCase(), name: fromName },
    };
  }
  return null;
}

/** 列表第二行 / 推送 / 车道信封里怎么写这一条：不摊开 JSON */
export function contactCardPreview(card: ContactCard): string {
  return card.kind === "person" ? `[名片] ${card.name}` : `[智能体名片] ${card.name}`;
}

export interface ContactCardView {
  /** 抬头：谁发的、发的是什么 */
  heading: string;
  /** 卡上的大字：名字 */
  title: string;
  /** 名字底下一行：联系人写邮箱；智能体写职责（没有就写「X 的智能体」） */
  subtitle: string;
  /** 接收方能做什么。none = 不画钮（自己发的那条 / 已经是朋友且是自己 / 已接受过） */
  action: { kind: "add_friend" | "open_chat" | "accept_agent" | "none"; label: string };
}

/** 这张卡在**我**的屏幕上画成什么。判据全在这里：自己发的不给钮；联系人已经是朋友 → 「发消息」，是我自己 → 不给钮；
    智能体名片自己发的不给钮，别人发的给「接受」；`accepted` = 这一次会话里刚接受过（本机状态，刷新就没了） */
export function contactCardView(
  card: ContactCard,
  o: { mine: boolean; fromName: string; selfUid: string; friendUids: readonly string[]; accepted?: boolean },
): ContactCardView {
  const who = o.fromName.trim() === "" ? "对方" : o.fromName.trim();
  if (card.kind === "person") {
    const isSelf = card.uid === o.selfUid;
    const isFriend = o.friendUids.includes(card.uid);
    return {
      heading: o.mine ? "你推荐了一位联系人" : `${who} 推荐了一位联系人`,
      title: card.name,
      subtitle: card.email,
      action: o.mine || isSelf
        ? { kind: "none", label: "" }
        : isFriend
          ? { kind: "open_chat", label: "发消息" }
          : { kind: "add_friend", label: "加为朋友" },
    };
  }
  return {
    heading: o.mine ? "你分享了一只智能体" : `${who} 分享了一只智能体`,
    title: card.name,
    subtitle: card.description.trim() !== "" ? card.description.trim() : `${card.from.name} 的智能体`,
    action: o.mine ? { kind: "none", label: "" } : o.accepted === true ? { kind: "none", label: "已保存到我的智能体" } : { kind: "accept_agent", label: "接受" },
  };
}
