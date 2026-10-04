// 共享车道（#1523，#1461 P2）在手机端的接线。手机代码依赖 react-native 进不了 vitest：判据在 shared 真跑（pairChat.test），
// 这里读源码钉住接线：
// ① 朋友那条车道走**第二个** cloudSessionClient 实例（peerLane.ts 自己建传输、自己的 sinks），不碰 chatStore / cloudClient 的单连接；
// ② 私聊页进来 / 回来时找朋友公开给我的那条、离开时断掉；@ 了朋友的智能体走 sayToPeerLane，@ 了自己的仍走 sendText；
// ③ 第一次带上先挑智能体、再选给谁看（bringAgents 带 facing）；横幅上那颗标签与聊天信息页都能切（setLaneFacing）；
// ④ 车道气泡认 who = "friend"；朝向从日志里的客人名单推（pairFacingOf + chatHumansNow）；
// ⑤ listGuestChats 把 chat_kind = 'pair' 摘掉——公开给我的车道不当群画。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("peerLane.ts：第二条连接", () => {
  const src = read("mobile/src/friends/peerLane.ts");
  it("自己建一份 cloudSessionClient，不 import chatStore / cloudClient", () => {
    expect(src).toMatch(/const peerClient: CloudSessionClient = createCloudSessionClient\(\{/);
    expect(src).not.toMatch(/from "\.\.\/cloud\/chatStore\.js"/);
    expect(src).not.toMatch(/from "\.\.\/cloud\/cloudClient\.js"/);
  });
  it("找朋友公开给我的那条走 findSharedLaneFrom，名字走 guest_chat_agents；审批钩子接空", () => {
    expect(src).toMatch(/findSharedLaneFrom\(supabase, friendUid, me\)/);
    expect(src).toMatch(/supabase\.rpc\("guest_chat_agents", \{ p_session: sessionId \}\)/);
    expect(src).toMatch(/onApprovalRequest: \(\) => \{\}/);
  });
  it("离开就忘：closePeerLane 走 leave 并清空，不写本机缓存", () => {
    // 换行写成 \r?\n：Windows 检出是 CRLF（读源码的测试别依赖换行，见 mr-otto 的本机约束）
    expect(src).toMatch(/export function closePeerLane\(\): void \{\r?\n\s+gen\+\+;/);
    expect(src).not.toMatch(/chatCache/);
  });
});

describe("FriendChatScreen：两条车道合在一条时间线上", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("进来 / 回来找朋友那条，离开断掉", () => {
    // #1533: openPeerLane now also carries the friend name / avatar (guest snapshot)
    expect(src).toMatch(/if \(friend\) void openPeerLane\(uid, \{ name, avatarUrl: row\?\.profile\.avatarUrl \?\? "" \}\);/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => closePeerLane\(\), \[\]\);/);
  });
  it("@ 了朋友的智能体走 sayToPeerLane；@ 了自己的仍走 sendText；都没有发给朋友", () => {
    expect(src).toMatch(/const laneTargetsOf = \(text: string\)/);
    expect(src).toMatch(/if \(targets !== null && targets\.lane === "peer"\) \{[\s\S]*?sayToPeerLane\(text, targets\.ids\)/);
    expect(src).toMatch(/const r = await sendText\(text, targets\.ids\);/);
    expect(src).toMatch(/await sendToFriend\(uid, text\);/);
  });
  it("第一次带上先挑再选朝向（bringAgents 带 facing）；之后横幅标签 / setLaneFacing 能切", () => {
    expect(src).toMatch(/setFacingPick\(\{ key: Date\.now\(\), visible: true, mode: "create", picked \}\)/);
    expect(src).toMatch(/await bringAgents\(homeWs\.id, uid, facingPick\.picked, facing\)/);
    expect(src).toMatch(/await setLaneFacing\(homeWs\.id, uid, facing\)/);
    expect(src).toMatch(/LANE_FACING_LABEL\[laneFacing\]/);
  });
  it("朝向从日志里的客人名单推；朋友说的话标 friend（laneItemsOf 带 selfUid）", () => {
    expect(src).toMatch(/pairFacingOf\(chatHumansNow\(/);
    expect(src).toMatch(/laneItemsOf\(laneEvents, selfUid\)/);
    expect(src).toMatch(/laneItemsOf\(peerEvents, selfUid\)/);
    expect(src).toMatch(/item\.who === "friend" \? <PersonTile/);
  });
  it("@ 名单合并两边的智能体（#1544 起还列我主场里没带进来的那几只，@ 了先带进来）；语音松手那一刀也按两条车道判", () => {
    expect(src).toMatch(/agentIds=\{\[\.\.\.broughtNames\.map\(\(a\) => a\.agentId\), \.\.\.peerNames\.map\(\(a\) => a\.agentId\), \.\.\.otherMine\.map\(\(a\) => a\.agentId\)\]\}/);
    expect(src).toMatch(/if \(targets !== null && targets\.lane === "bring"\) \{[\s\S]*?bringAgents\(homeWs\.id, uid, \[\.\.\.brought, \.\.\.targets\.ids\], laneFacing\)/);
    expect(src).toMatch(/laneTargetsOf\(trimmed\) === null/);
  });
});

describe("聊天信息页 / 清单", () => {
  it("朋友私聊的「聊天信息」页挂 LaneFacingRows（有车道才画）", () => {
    expect(read("mobile/src/chat/ChatInfoScreen.tsx")).toMatch(/\{row\.status === "accepted" \? <LaneFacingRows row=\{row\} \/> : null\}/);
    expect(read("mobile/src/friends/LaneFacingRows.tsx")).toMatch(/if \(homeId === null \|\| lane\.status !== "ready"\) return null;/);
  });
  it("pairLane：找车道不按朝向、bringAgents 建车道带 facing、setLaneFacing 走 chat_update", () => {
    const src = read("mobile/src/friends/pairLane.ts");
    expect(src).toMatch(/cloudClient\.create\(homeId, \{ kind: "pair", peerUid, facing, agentIds \}\)/);
    expect(src).toMatch(/cloudClient\.chatUpdate\(homeId, lane\.sessionId, \{ facing \}\)/);
  });
  it("listGuestChats 把 pair 摘掉", () => {
    expect(read("src/shared/supabaseWorkspacesApi.ts")).toMatch(/const chats = rows\.filter\(\(r\) => r\.chat_kind !== "pair"\);/);
  });
});
