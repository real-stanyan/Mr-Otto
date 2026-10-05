// 名片（#1524）在手机端的接线。判据在 shared（contactCard.test）真跑，这里读源码钉住：
// ① 私聊气泡先认名片、再认分享信封、最后正文；② ＋ 里有「名片」，挑的是我的智能体 + 别的朋友（不含当前这位），每张一条、走 sendToFriend；
// ③ 智能体名片带走的只有名字 / 职责 / 提示词 / 脸 / 声音（不带 tools / models / 记忆）；
// ④ 接受 = createAgentChecked 进我主场（新 id），声音另写一笔尽力而为；联系人走 addFriend + 档位。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("FriendChatScreen", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("气泡：先认名片，再认应用分享（#1648），再认分享信封", () => {
    expect(src).toMatch(/const card = decodeContactCard\(m\.body\);[\s\S]{0,120}const appCard = card === null \? decodeAppCard\(m\.body\) : null;\s+(?:\/\/[^\n]*\n\s+)?const invite = appCard !== null \? decodeRoomInvite\(m\.body\) : null;\s+const body = card !== null \? \(\s+<ContactCardBubble card=\{card\} mine=\{mine\} fromName=\{name\} onOpenChat=\{onOpenChat\} \/>\s+\) : appCard !== null \? \(\s+<AppShareBubble[^>]*\/>\s+\) : env !== null \? \(/);
  });
  it("＋ 里「名片」；挑我的智能体 + 别的朋友（不含当前这位）", () => {
    expect(src).toMatch(/\{ key: "card", icon: "user-round", label: "名片"/);
    expect(src).toMatch(/people=\{\(friends\.rows \?\? \[\]\)\.filter\(\(r\) => r\.status === "accepted" && r\.profile\.id !== uid\)/);
  });
  it("智能体名片只带名字 / 职责 / 提示词 / 脸 / 声音 + 谁的；不带 tools / models", () => {
    const block = src.slice(src.indexOf('kind: "agent", agentId: a.agentId'), src.indexOf('from: { uid: selfUid, name: me.name }'));
    expect(block).toContain("instructions: a.instructions");
    expect(block).toContain("avatarSlot: a.avatarSlot");
    expect(block).toContain("a.voice");
    expect(block).not.toMatch(/tools|models/);
  });
  it("每张一条，走 sendToFriend；装不下那句原样说给人", () => {
    expect(src).toMatch(/for \(const card of cards\) await sendToFriend\(uid, encodeContactCard\(card\)\);/);
    expect(src).toContain("CARD_TOO_BIG");
  });
});

describe("ContactCardBubble", () => {
  const src = read("mobile/src/friends/ContactCardBubble.tsx");
  it("接受 = 在我主场建一只：新 id、与「建一只」同一道闸；三格经 acceptedAgentInput（职责只在 description 的那只也有提示词，#1544）", () => {
    expect(src).toMatch(/agentIdFromBytes\(ExpoCrypto\.getRandomBytes\(6\)\)/);
    expect(src).toMatch(/const input = acceptedAgentInput\(card\);/);
    expect(src).toMatch(/name: input\.name, description: input\.description, instructions: input\.instructions, models: \[\], tools: \[\], avatarSlot: card\.avatarSlot,/);
  });
  it("接受过的真相在名单里（#1544）：myAgentNames 来自主场名册", () => {
    expect(src).toMatch(/const myAgentNames = home\.home\?\.agents\.map\(\(a\) => a\.name\) \?\? \[\];/);
    expect(src).toMatch(/contactCardView\(card, \{ mine, fromName, selfUid, friendUids, accepted, myAgentNames \}\)/);
  });
  it("声音另写一笔、尽力而为（认不出 / 列不存在都不挡）", () => {
    expect(src).toMatch(/voiceChoiceOf\(card\.voice\) !== null/);
    expect(src).toMatch(/updateAgentRow\(supabase, ws\.id, agentId, \{ voice: card\.voice \}\)\.catch\(\(\) => \{\}\)/);
  });
  it("联系人：加为朋友走 addFriend + 档位弹窗（默认 REQUEST_DEFAULT_TIER）", () => {
    expect(src).toMatch(/await addFriend\(card\.uid, tier\);/);
    expect(src).toMatch(/initial=\{REQUEST_DEFAULT_TIER\}/);
  });
  it("画法与钮都从 contactCardView 来，不自己再判一遍", () => {
    expect(src).toMatch(/const v = contactCardView\(card, \{ mine, fromName, selfUid, friendUids, accepted, myAgentNames \}\);/);
    expect(src).not.toMatch(/card\.kind === "person" && !friendUids/);
  });
});

describe("只写名字的三处", () => {
  it("列表第二行 / 车道信封 / 桌面都经 contactCardPreview", () => {
    expect(read("src/shared/wechatInbox.ts")).toMatch(/if \(card !== null\) return contactCardPreview\(card\);/);
    expect(read("src/shared/pairChat.ts")).toMatch(/if \(card !== null\) return contactCardPreview\(card\);/);
    expect(read("src/renderer/src/components/FriendChatView.tsx")).toMatch(/cardText\(m\.body\) \?\? m\.body/);
  });
});
