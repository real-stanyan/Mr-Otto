// 客人设备上收到的那一份事件（#1655）：主人的团队 wiki 快照不出门，seq 一格不少
import { describe, expect, it } from "vitest";
import { eventForGuest } from "../../src/shared/guestView.js";
import type { RequestEnvelopeEvent, SessionEvent, WorkspaceWikiLoadedEvent } from "../../src/session/events.js";

const wiki: WorkspaceWikiLoadedEvent = {
  sessionId: "s1", seq: 7, ts: 100, type: "workspace_wiki_loaded", agentId: "admin", agentName: "运维",
  index: "- 家里wifi密码.md", pinned: [{ path: "a.md", title: "家", body: "门锁 1234" }], own: "我的页", nudge: "整理一下",
};
const envelope: RequestEnvelopeEvent = {
  sessionId: "s1", seq: 8, ts: 101, type: "request_envelope", ignorable: true, model: "m", system: "…门锁 1234…",
  tools: [{ name: "relay_to_owner", description: "d", parameters: {} }], agentId: "admin",
};

describe("eventForGuest（#1655）", () => {
  it("workspace_wiki_loaded：同 seq / ts / type 的空壳——正文、常驻页、自己那页、提醒全清空", () => {
    const out = eventForGuest(wiki);
    expect(out).toEqual({ ...wiki, index: "", pinned: [], own: null, nudge: null });
    expect(JSON.stringify(out)).not.toContain("1234");
    expect(JSON.stringify(out)).not.toContain("wifi");
  });
  it("request_envelope：system 全文（拼着 wiki 快照）清空，型号与工具表照旧", () => {
    const out = eventForGuest(envelope);
    expect(out).toEqual({ ...envelope, system: "" });
  });
  it("别的事件原样（同一个对象），不复制", () => {
    const msg: SessionEvent = { sessionId: "s1", seq: 9, ts: 102, type: "user_message", content: "在吗", fromUid: "peer" };
    expect(eventForGuest(msg)).toBe(msg);
  });
  it("不改入参：日志里那一条（append-only）一个字节不动", () => {
    const before = JSON.stringify(wiki);
    eventForGuest(wiki);
    expect(JSON.stringify(wiki)).toBe(before);
  });
});
