// 私密车道（#1461 P1）在手机端抢那一条云会话连接时的三件安静出错的事（复审 M1 / M2）。
// 手机代码依赖 react-native 进不了 vitest：判据能抽成纯函数的抽进 shared 真跑，接线读源码钉住。
// ① 草稿私聊只认「这只智能体的私聊」（screenOwnsSession），不认朋友私聊页挂着的车道；
// ② openChat 顶掉另一条会话时先照 closeChat 那样收口（语音停麦、缓存写回）——不收的话通话里说完的一句会发进新房间；
// ③ 朋友私聊页离开时只关自己那一条（closeChatIf），不把接手的群聊页刚接上的连接断掉。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { screenOwnsSession } from "../../src/shared/mobileChat.js";

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

describe("chatStore（M1）", () => {
  const src = read("mobile/src/cloud/chatStore.ts");
  const inner = src.slice(src.indexOf("async function openChatInner"), src.indexOf("export async function startDm"));
  it("openChat 顶掉另一条时先收口，且排在换缓存主人与 join 之前", () => {
    const retire = inner.indexOf("if (prev !== null && prev.sessionId !== sessionId) retireSession();");
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(inner.indexOf("cacheOwner = uid;"));
    expect(retire).toBeLessThan(inner.indexOf("cloudClient.join("));
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
  it("FriendChatScreen 离开时只关自己那条（closeChatIf），不直接 closeChat", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toContain("closeChatIf(laneRef.current)");
    expect(src).not.toMatch(/\bcloseChat\(\)/);
  });
});
