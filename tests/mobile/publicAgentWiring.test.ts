// 公开智能体（#1533）在手机端的接线。判据在 shared 真跑（publicAgent.test），这里读源码钉住：
// ① 「我」页一行「公开智能体」，存走 setPublicAgent、读走 profile.publicAgentId；
// ② 私聊页进来顺手读 TA 的公开智能体；@ 名单里先列它；第一次 @ 走 ensurePeerLane 再 sayToPeerLane；
// ③ 电话钮弹两项，给智能体那一项 = ensurePeerLane → 以 guest 把 ChatScreen 开在那条车道上、autoCall；
// ④ ensurePeerLane 发的是 onBehalf 的 create（朝向 both、名单 [公开智能体]），publicAgent 为空时不发；
// ⑤ ChatScreen 的客人快照退到 peerLaneGuestChat（这条车道不在 teams.guests 里）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("「我」页", () => {
  const src = read("mobile/src/tabs/MeScreen.tsx");
  it("一行「公开智能体」，值读 profile.publicAgentId，存走 setPublicAgent；挑一只或不设（min 0、max 1）", () => {
    expect(src).toMatch(/label="公开智能体"/);
    expect(src).toMatch(/await setPublicAgent\(supabase, profile\.id, picked\[0\] \?\? null\);/);
    expect(src).toMatch(/min=\{0\}\s+max=\{1\}/);
  });
});

describe("peerLane：替朋友开车道", () => {
  const src = read("mobile/src/friends/peerLane.ts");
  it("进页面顺手读公开智能体；ensurePeerLane 发 onBehalf 的 create（both、[公开智能体]）；没设就不发", () => {
    expect(src).toMatch(/Promise\.all\(\[findSharedLaneFrom\(supabase, friendUid, me\), fetchPublicAgentOf\(supabase, friendUid\)\]\)/);
    expect(src).toMatch(/peerClient\.create\(pub\.workspaceId, \{ kind: "pair", peerUid: me, facing: "both", agentIds: \[pub\.agentId\], onBehalf: true \}\)/);
    expect(src).toMatch(/if \(pub === null\) return \{ ok: false, message: "TA 还没有设定公开智能体。" \};/);
  });
  it("给它打电话要的客人快照从这里拼（assembleGuestChat），群主是朋友、客人是我", () => {
    expect(src).toMatch(/export function peerLaneGuestChat\(sessionId: string\): GuestChat \| null/);
    expect(src).toMatch(/owner: \{ uid: lane\.friendUid, name: lane\.friend\.name, avatarUrl: lane\.friend\.avatarUrl \}/);
  });
});

describe("FriendChatScreen", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("电话钮弹两项；给智能体 = ensurePeerLane → guest ChatScreen + autoCall", () => {
    expect(src).toMatch(/<HeaderIconButton label="打电话"/);
    expect(src).toMatch(/navigation\.push\("Chat", \{ kind: "guest", workspaceId: r\.workspaceId, sessionId: r\.sessionId, autoCall: true \}\)/);
    expect(read("mobile/src/friends/CallPickDialog.tsx")).toMatch(/人与人的通话还没做好（#1534）/);
  });
  it("@ 名单里先列公开智能体；第一次 @ 先 ensurePeerLane", () => {
    expect(src).toMatch(/inLane\.push\(\{ agentId: peer\.publicAgent\.agentId, name: peer\.publicAgent\.name \}\)/);
    expect(src).toMatch(/const opened = await ensurePeerLane\(uid\);/);
  });
});

describe("ChatScreen", () => {
  it("客人快照退到 peerLaneGuestChat", () => {
    expect(read("mobile/src/chat/ChatScreen.tsx")).toMatch(/\?\? \(target\.kind === "guest" \? peerLaneGuestChat\(target\.sessionId\) : null\)/);
  });
});
