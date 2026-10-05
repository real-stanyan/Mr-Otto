// 群聊座位制（#1682，ADR-0376）手机那一半的接线：纯逻辑在 tests/shared/groupSeatsView.test.ts，这里钉页面有没有接上——
// ① 座位制的群不给群通话（runtime 的通话名单只认主场自己的智能体）；② 点头卡 / 策略 / 退群走控制房那三条；
// ③ 新群只拉朋友（agentIds 空、humans 必带）；④ 座位会话不进任何清单。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("ChatScreen：座位制的群", () => {
  const src = read("mobile/src/chat/ChatScreen.tsx");
  it("没有语音通话那一项", () => {
    expect(src).toMatch(/const offerPhone = !isOutreach && !seatMode && phoneOffered\(/);
  });
  it("@ 的候选换成各家管理员；点头卡走 seatDecide；长按头像插 @", () => {
    expect(src).toMatch(/seats !== null \? seatMentionCandidates\(seats\)/);
    expect(src).toMatch(/cloudClient\.seatDecide\(baseWs\.id, sessionId, requestId, decision\)/);
    expect(src).toMatch(/onMentionAvatar: mentionFromAvatar/);
    expect(src).toMatch(/withSeats\(w, labelSeats\)/);
  });
  it("拉人建群只拉朋友", () => {
    expect(src).toMatch(/agentIds: \[\],\n\s+humans: pickedPeople,/);
  });
});

describe("ChatInfoScreen：座位制的群", () => {
  const src = read("mobile/src/chat/ChatInfoScreen.tsx");
  it("退群走 group_leave、策略走 seat_policy", () => {
    expect(src).toMatch(/cloudClient\s*\.groupLeave\(wsId, sessionId\)/);
    expect(src).toMatch(/cloudClient\s*\.seatPolicy\(wsId, sessionId, policy\)/);
  });
});

describe("新群只拉朋友", () => {
  for (const p of ["mobile/src/group/NewGroupDialog.tsx", "mobile/src/friends/GroupsScreen.tsx", "mobile/src/tabs/ChatsScreen.tsx", "mobile/src/chat/ChatInfoScreen.tsx"]) {
    it(p, () => {
      const src = read(p);
      expect(src).toMatch(/agentIds: \[\],\n\s+humans: pickedPeople,/);
      expect(src).not.toMatch(/agentIds: picked,/);
    });
  }
});

describe("座位会话不进清单", () => {
  it("listCloudSessions 摘 seat、listGuestChats 只认群与外联", () => {
    const src = read("src/shared/supabaseWorkspacesApi.ts");
    expect(src).toMatch(/const HIDDEN_CHAT_KINDS: ReadonlySet<string> = new Set\(\["pair", "seat"\]\);/);
    expect(src).toMatch(/r\.chat_kind === "group" \|\| r\.chat_kind === "outreach"/);
  });
});
