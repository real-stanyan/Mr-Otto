// daemon 的带话接线（#1655）：daemon.ts 进不了 vitest，读源码验，正则不依赖换行
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const daemon = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon：带话", () => {
  it("hub 的 ownerDm 找管理员私聊、经 routineRooms 开房；outreachRoom 按 (主场, 那只, 朋友) 找外联会话", () => {
    expect(daemon).toMatch(/ownerDm: async \(w\) => \{[\s\S]{0,200}findDmSession\(w, \[ADMIN_AGENT_ID\]\)[\s\S]{0,300}routineRooms\.room\(w, sid\)/);
    expect(daemon).toMatch(/outreachRoom: async \(w, agentId, peerUid\) => \{[\s\S]{0,200}findOutreachSession\(w, agentId, peerUid\)/);
  });
  it("外联会话的查询提成 findOutreachSession，ensureSession.find 与 outreachRoom 共用", () => {
    expect(daemon).toMatch(/async function findOutreachSession\(w: string, a: string, peerUid: string\): Promise<string \| null> \{[\s\S]{0,400}\.eq\("chat_kind", "outreach"\)[\s\S]{0,200}\.eq\("peer_uid", peerUid\)/);
    expect(daemon).toMatch(/find: \(w, a, peerUid\) => findOutreachSession\(w, a, peerUid\)/);
  });
  it("会话装配：outreachRelay 与 friendReply 走同一个 hub、同一个开关（有 hub 且主场）", () => {
    expect(daemon).toMatch(/outreachRelay: outreachHub === null \|\| !approveAll \? null : \{ toOwner: \(o\) => outreachHub\.relayToOwner\(\{ \.\.\.o, workspaceId, ownerUid \}\) \}/);
    expect(daemon).toMatch(/friendReply: outreachHub === null \|\| !approveAll \? null : \{ send: \(o\) => outreachHub\.replyToFriend\(\{ \.\.\.o, workspaceId, ownerUid \}\) \}/);
  });
});
