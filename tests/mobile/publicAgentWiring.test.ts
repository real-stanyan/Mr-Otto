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
    // 只拉公开的那一只（#1550）：车道里可能带着别的智能体，它们不该一起接
    expect(src).toMatch(/navigation\.push\("Chat", \{ kind: "guest", workspaceId: r\.workspaceId, sessionId: r\.sessionId, autoCall: true, callAgentId: ADMIN_AGENT_ID, callOnly: true \}\)/);
    expect(read("mobile/src/friends/CallPickDialog.tsx")).toMatch(/label="给 TA 的管理员打电话"/);
    expect(src).toMatch(/onAgent=\{\(\) => \{\s*if \(publicAgent === null\) return;/);
    expect(read("mobile/src/friends/CallPickDialog.tsx")).toMatch(/人与人的通话还没做好（#1534）/);
  });
  it("@ 名单里先列公开智能体；第一次 @ 先 ensurePeerLane", () => {
    // 代办入口（#1564）：朋友这一侧只列 TA 的管理员
    expect(src).toMatch(/return \[\{ agentId: ADMIN_AGENT_ID, name: peer\.agents\.find\(\(a\) => a\.agentId === ADMIN_AGENT_ID\)\?\.name \?\? "管理员" \}\];/);
    expect(src).not.toMatch(/inLane\.push\(\{ agentId: peer\.publicAgent\.agentId/);
    expect(src).toMatch(/const opened = await ensurePeerLane\(uid\);/);
  });
});

describe("ChatScreen", () => {
  it("callAgentId 在场：autoCall 只拉它一只；挂断回私聊页（#1550）", () => {
    const src = read("mobile/src/chat/ChatScreen.tsx");
    expect(read("mobile/src/nav/types.ts")).toMatch(/autoCall\?: boolean; callAgentId\?: string;/);
    expect(src).toMatch(/const only = route\.params\.callAgentId;\s*const ids = only !== undefined && agentIds\.includes\(only\) \? \[only\] : dmAgent !== null \? \[dmAgent\] : agentIds;/);
    expect(src).toMatch(/if \(route\.params\.callAgentId === undefined\) return;\s*if \(call !== null\) autoCallLive\.current = true;\s*else if \(autoCallLive\.current\) \{\s*autoCallLive\.current = false;\s*navigation\.goBack\(\);/);
  });
  it("callOnly（#1558）：只画通话——标题是那只的名字、不画时间线 / 输入框 / 信息钮、通话浮层常开、没有缩小", () => {
    const src = read("mobile/src/chat/ChatScreen.tsx");
    expect(read("mobile/src/nav/types.ts")).toMatch(/callAgentId\?: string; callOnly\?: boolean;/);
    expect(src).toMatch(/const callOnly = route\.params\.callOnly === true && route\.params\.callAgentId !== undefined;/);
    expect(src).toMatch(/const callOnlyTitle = callOnly && ws !== null \? agentNameOf\(ws, route\.params\.callAgentId!\) : "通话";/);
    expect(src).toMatch(/headerTitle: \(\) => <ChatTitle title=\{callOnly \? callOnlyTitle : title\} count=\{callOnly \? 0 : count\}/);
    expect(src).toMatch(/infoOk && !callOnly \? \(/);
    expect(src).toMatch(/\{callOnly \? \([\s\S]{0,200}\{call === null && pageNote === null \? <Text[^\n]*\{`正在接通 \$\{callOnlyTitle\}…`\}/);
    expect(src).toMatch(/\) : callOnly \? null : \(\s*<WxComposer/);
    expect(src).toMatch(/visible=\{callOpen \|\| callOnly\}/);
    expect(src).toMatch(/title=\{callOnly \? callOnlyTitle : title\}/);
    expect(src).toMatch(/if \(!callOnly\) setCallOpen\(false\);/);
    expect(src).toMatch(/session !== null && !callOnly \? <CallPill/);
  });
  it("客人快照退到 peerLaneGuestChat", () => {
    expect(read("mobile/src/chat/ChatScreen.tsx")).toMatch(/\?\? \(target\.kind === "guest" \? peerLaneGuestChat\(target\.sessionId\) : null\)/);
  });
});
