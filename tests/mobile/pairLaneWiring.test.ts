// 私密车道（#1461 P1）在手机端抢那一条云会话连接时的三件安静出错的事（复审 M1 / M2）。
// 手机代码依赖 react-native 进不了 vitest：判据能抽成纯函数的抽进 shared 真跑，接线读源码钉住。
// ① 草稿私聊只认「这只智能体的私聊」（screenOwnsSession），不认朋友私聊页挂着的车道；
// ② openChat 顶掉另一条会话时先照 closeChat 那样收口（语音停麦、缓存写回）——不收的话通话里说完的一句会发进新房间；
// ③ 朋友私聊页离开时只关自己那一条（closeChatIf），不把接手的群聊页刚接上的连接断掉；
// ④ 反过来也一样（车道卡在「连接中」）：智能体私聊页卸载得晚，不许断掉朋友私聊页刚开上的车道；
//    车道连接没了而朋友私聊页还在前台时自己接回来。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mayCloseConnection, screenOwnsSession } from "../../src/shared/mobileChat.js";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("screenOwnsSession（M2）", () => {
  const lane = { sessionId: "lane", chat: { kind: "pair" as const, agentIds: ["a_000000000001"], humans: [] } };
  const dm = { sessionId: "dm1", chat: { kind: "dm" as const, agentIds: ["a_000000000001"], humans: [] } };
  it("有 sessionId 的页只认自己那一条", () => {
    expect(screenOwnsSession({ pageSessionId: "g1", draftAgentId: null, current: { sessionId: "g1" } })).toBe(true);
    expect(screenOwnsSession({ pageSessionId: "g1", draftAgentId: null, current: lane })).toBe(false);
  });
  it("草稿不认车道（哪怕车道里正好带着这只），只认这只智能体的私聊", () => {
    expect(screenOwnsSession({ pageSessionId: null, draftAgentId: "a_000000000001", current: lane })).toBe(false);
    expect(screenOwnsSession({ pageSessionId: null, draftAgentId: "a_000000000001", current: dm })).toBe(true);
    expect(screenOwnsSession({ pageSessionId: null, draftAgentId: "a_000000000002", current: dm })).toBe(false);
    expect(screenOwnsSession({ pageSessionId: null, draftAgentId: "a_000000000001", current: null })).toBe(false);
  });
});

describe("mayCloseConnection（车道卡在「连接中」）", () => {
  const lane = { sessionId: "lane", chat: { kind: "pair" as const, agentIds: ["a_000000000001"], humans: [] } };
  const dm = { sessionId: "dm1", chat: { kind: "dm" as const, agentIds: ["a_000000000001"], humans: [] } };
  const page = (pageSessionId: string | null, draftAgentId: string | null) => (s: { sessionId: string; chat?: typeof lane.chat | typeof dm.chat | null | undefined }) =>
    screenOwnsSession({ pageSessionId, draftAgentId, current: s });
  it("真机那一拍：智能体私聊页卸载时车道正在开 / 已开着——不断", () => {
    expect(mayCloseConnection({ pending: lane, current: null, owns: page("dm1", null) })).toBe(false);
    expect(mayCloseConnection({ pending: null, current: lane, owns: page("dm1", null) })).toBe(false);
    expect(mayCloseConnection({ pending: lane, current: dm, owns: page("dm1", null) })).toBe(false);
  });
  it("开着的是自己那条：断；谁都不占着：断（顺手掐掉草稿还在路上的 startDm）", () => {
    expect(mayCloseConnection({ pending: null, current: dm, owns: page("dm1", null) })).toBe(true);
    expect(mayCloseConnection({ pending: dm, current: null, owns: page("dm1", null) })).toBe(true);
    expect(mayCloseConnection({ pending: null, current: null, owns: page("dm1", null) })).toBe(true);
  });
  it("草稿页认自己建出来的那条私聊，不认车道", () => {
    expect(mayCloseConnection({ pending: dm, current: null, owns: page(null, "a_000000000001") })).toBe(true);
    expect(mayCloseConnection({ pending: null, current: lane, owns: page(null, "a_000000000001") })).toBe(false);
  });
});

describe("chatStore（M1）", () => {
  const src = read("mobile/src/cloud/chatStore.ts");
  const inner = src.slice(src.indexOf("async function openChatInner"), src.indexOf("export async function startDm"));
  it("openChat 顶掉另一条时先收口，且排在换缓存主人与 join 之前", () => {
    const retire = inner.indexOf("if (prev !== null && prev.sessionId !== sessionId) retireSession();");
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(inner.indexOf("cacheOwner = uid;"));
    expect(retire).toBeLessThan(inner.indexOf("cloudClient.join("));
  });
  it("排着队的那一句轮到时再核一次会话没换，换了就不发（不落进别的房间）", () => {
    const send = src.slice(src.indexOf("export async function sendText"), src.indexOf("export async function resendUnsent"));
    expect(send).toMatch(/sendQueue\.run\(\(\) =>\s+store\.get\(\)\.session\?\.sessionId === sid\s+\? say\(/);
  });
  it("收口只有一份：closeChat 也走它，它里面有语音那一层的 closed()", () => {
    const retireFn = src.slice(src.indexOf("function retireSession"), src.indexOf("export function closeChat("));
    expect(retireFn).toContain("activity?.closed();");
    const close = src.slice(src.indexOf("export function closeChat("));
    expect(close).toMatch(/^export function closeChat\(\): void \{\n\s+retireSession\(\);/);
  });
});

describe("页面接线", () => {
  it("ChatScreen 认会话走 screenOwnsSession", () => {
    expect(read("mobile/src/chat/ChatScreen.tsx")).toMatch(/screenOwnsSession\(\{/);
  });
  it("ChatScreen 离开时只断归自己的（closeChatOwned + screenOwnsSession），不直接 closeChat", () => {
    const src = read("mobile/src/chat/ChatScreen.tsx");
    expect(src).toMatch(/closeChatOwned\(\(s\) => screenOwnsSession\(\{/);
    expect(src).not.toMatch(/\bcloseChat\(\)/);
  });
  it("closeChatIf 与 closeChatOwned 共用 mayCloseConnection 一份判据", () => {
    const src = read("mobile/src/cloud/chatStore.ts");
    expect(src).toMatch(/export function closeChatIf\(sessionId: string\): void \{\n\s+closeChatOwned\(/);
    expect(src).toMatch(/if \(!mayCloseConnection\(\{ pending: pendingOpen, current: store\.get\(\)\.session, owns \}\)\) return;/);
  });
  it("FriendChatScreen：车道连接没了、页面在前台、上次没报错 → 自己接回来", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toContain("const laneDropped = chat.session === null && chat.error === null;");
    expect(src).toMatch(/if \(!focused \|\| homeId === null \|\| laneSid === null \|\| !laneDropped\) return;\n\s+void openChat\(homeId, laneSid,/);
  });
  it("FriendChatScreen 离开时只关自己那条（closeChatIf），不直接 closeChat", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toContain("closeChatIf(laneRef.current)");
    expect(src).not.toMatch(/\bcloseChat\(\)/);
  });
});
