// 好友三档权限的手机接线（#1494，ADR-0350）。手机代码依赖 react-native 进不了 vitest，这里读源码钉住：
// ① 读好友带两列档位、没跑 0054 退回；发请求 / 接受只定自己那一边；改档位改的是自己那一列；
// ② 三处入口：加好友时选、接受时选、资料页三行（我给 TA 的可改、TA 给我的只读、实际生效）；
// ③ 私聊里「带上我的智能体」按生效档藏。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("friendsApi", () => {
  const src = read("mobile/src/friends/friendsApi.ts");
  it("读好友带两列档位，42703 / PGRST204 退回不带", () => {
    expect(src).toMatch(/"id,requester,addressee,status,requester_tier,addressee_tier"/);
    expect(src).toMatch(/missingTierColumn\(res\.error\)/);
    expect(src).toMatch(/tiers: tiersOf\(r, uid\)/);
  });
  it("发请求只定 requester_tier；接受只定 addressee_tier；改档位按方向挑自己那一列", () => {
    expect(src).toMatch(/\.\.\.\(tierColumns \? \{ requester_tier: tier \} : \{\}\)/);
    expect(src).toMatch(/\.\.\.\(tierColumns \? \{ addressee_tier: tier \} : \{\}\)/);
    expect(src).toMatch(/const column = direction === "outgoing" \? "requester_tier" : "addressee_tier"/);
  });
});

describe("入口", () => {
  it("加好友：三个档位的 chip，默认 chat，递给 addFriend", () => {
    const src = read("mobile/src/friends/AddFriendDialog.tsx");
    expect(src).toMatch(/useState<FriendTier>\(REQUEST_DEFAULT_TIER\)/);
    expect(src).toMatch(/FRIEND_TIERS\.map\(\(t\) =>/);
    expect(src).toMatch(/await addFriend\(p\.id, tier\)/);
  });
  it("接受：先弹 TierPickDialog，选完才 accept(id, tier)", () => {
    const src = read("mobile/src/friends/RequestsScreen.tsx");
    expect(src).toMatch(/<TierPickDialog/);
    expect(src).toMatch(/accept\(r\.friendshipId, tier\)/);
  });
  it("权限那一组是一个组件：我给 TA 的（可改）、TA 给我的（只读）、实际生效；改走 setTier(id, direction, tier)", () => {
    const src = read("mobile/src/friends/FriendTierRows.tsx");
    expect(src).toMatch(/label="我给 TA 的权限" value=\{TIER_LABEL\[row\.tiers\.mine\]\} chevron onPress/);
    expect(src).toMatch(/label="TA 给我的权限" value=\{TIER_LABEL\[row\.tiers\.theirs\]\} \/>/);
    expect(src).toMatch(/label="实际生效" value=\{TIER_LABEL\[row\.tiers\.effective\]\} \/>/);
    expect(src).toMatch(/await setTier\(row\.friendshipId, row\.direction, tier\)/);
  });
  it("资料页与朋友私聊的「聊天信息」页都挂那一组（维护者 2026-10-04：聊天信息页也要能改）", () => {
    expect(read("mobile/src/friends/FriendScreen.tsx")).toMatch(/\{accepted \? <FriendTierRows row=\{row\} \/> : null\}/);
    expect(read("mobile/src/chat/ChatInfoScreen.tsx")).toMatch(/\{row\.status === "accepted" \? <FriendTierRows row=\{row\} \/> : null\}/);
  });
  it("私聊里「带上我的智能体」按生效档藏", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toMatch(/\(row === null \|\| allowsPair\(row\.tiers\.effective\)\)/);
  });
  it("选档的那张单子说清「生效取两边最小值」", () => {
    const src = read("mobile/src/friends/TierPickDialog.tsx");
    expect(src).toMatch(/真正生效的是你们俩里低的那一档/);
  });
});
