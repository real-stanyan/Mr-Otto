// notifyPrefs / replyNotify / readReceipt —— 消息推送与已读回执的纯判据（#1442）。runtime 发推送、
// 手机画开关与收推送共用这几份；这里钉的是两边都依赖、且坏了不会报错的那几条。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  ALERT_BODY_MAX, DEFAULT_NOTIFY_PREFS, MUTE_KEY_RE,
  alertBody, alertKey, alertPayload, alertTargetFromPayload, muteKeyFor, prefsFromRow, prefsToRow, pushAllowed,
} from "../../src/shared/notifyPrefs.js";
import { advanceReplyNotify, createReplyNotifyState, type ReplyNote } from "../../src/shared/replyNotify.js";
import { readUpTo, receiptLabel } from "../../src/shared/readReceipt.js";
import type { DirectMessage } from "../../src/shared/friends.js";
import { readFileSync } from "node:fs";

describe("prefsFromRow：没有那一行 = 全开", () => {
  it("null / 非对象 → 默认", () => {
    expect(prefsFromRow(null)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(prefsFromRow("x")).toEqual(DEFAULT_NOTIFY_PREFS);
  });
  it("逐格读；脏值按开", () => {
    expect(prefsFromRow({ agent_reply: false, mentions: true, friends: "no", read_receipts: false })).toEqual({
      agentReply: false, mentions: true, friends: true, readReceipts: false,
    });
  });
  it("写回去再读回来是同一份", () => {
    const p = { agentReply: false, mentions: false, friends: true, readReceipts: false };
    expect(prefsFromRow(prefsToRow("u1", p))).toEqual(p);
  });
});

describe("pushAllowed", () => {
  it("免打扰压过一切", () => {
    expect(pushAllowed("agent_reply", DEFAULT_NOTIFY_PREFS, true)).toBe(false);
    expect(pushAllowed("friend", DEFAULT_NOTIFY_PREFS, true)).toBe(false);
  });
  it("三类各看各的开关", () => {
    const p = { ...DEFAULT_NOTIFY_PREFS, mentions: false };
    expect(pushAllowed("mention", p, false)).toBe(false);
    expect(pushAllowed("agent_reply", p, false)).toBe(true);
    expect(pushAllowed("friend", { ...DEFAULT_NOTIFY_PREFS, friends: false }, false)).toBe(false);
    expect(pushAllowed("agent_reply", { ...DEFAULT_NOTIFY_PREFS, agentReply: false }, false)).toBe(false);
  });
});

describe("muteKeyFor：与手机列表的键逐字相同", () => {
  it("四种云会话", () => {
    expect(muteKeyFor("dm", "s1", "a_0123456789ab")).toBe("a:a_0123456789ab");
    expect(muteKeyFor("group", "s1", "x")).toBe("g:s1");
    expect(muteKeyFor("team", "s1", "x")).toBe("t:s1");
    expect(muteKeyFor("guest", "s1", "x")).toBe("j:s1");
    expect(muteKeyFor("outreach", "s1", "x")).toBe("o:s1");
  });
  it("与 wechatInbox 的键前缀对得上（源码里那几行就是这样拼的）", () => {
    const src = readFileSync(new URL("../../src/shared/wechatInbox.ts", import.meta.url), "utf8");
    for (const k of ["`a:${r.agentId}`", "`g:${g.sessionId}`", "`j:${g.session.id}`", "`t:${s.id}`", "`f:${f.profile.id}`"]) {
      expect(src).toContain(`const key = ${k}`);
    }
  });
  it("与 0049 的 CHECK 是同一个正则", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/0049_notify_prefs_and_read_receipts.sql", import.meta.url), "utf8");
    expect(sql).toContain(`chat_key ~ '${MUTE_KEY_RE.source}'`);
    const uuid = "6f1d2c3b-aaaa-bbbb-cccc-0123456789ab";
    for (const k of [`a:admin`, `a:a_0123456789ab`, `g:${uuid}`, `t:${uuid}`, `j:${uuid}`, `f:${uuid}`]) expect(MUTE_KEY_RE.test(k)).toBe(true);
    expect(MUTE_KEY_RE.test("o:x")).toBe(false);
  });
});

describe("推送载荷", () => {
  const cloud = { kind: "cloud" as const, chat: "group" as const, workspaceId: "w1", sessionId: "s1", agentId: "" };
  it("thread-id 是列表键；subtitle 空就不带", () => {
    const p = alertPayload({ title: "群", body: "hi", target: cloud });
    expect(p.aps["thread-id"]).toBe("g:s1");
    expect(p.aps.alert).toEqual({ title: "群", body: "hi" });
    expect(alertPayload({ title: "群", subtitle: "开发", body: "hi", target: cloud }).aps.alert.subtitle).toBe("开发");
  });
  it("读回：往返相同", () => {
    expect(alertTargetFromPayload(alertPayload({ title: "t", body: "b", target: cloud }))).toEqual(cloud);
    const f = { kind: "friend" as const, uid: "u2" };
    expect(alertTargetFromPayload(alertPayload({ title: "t", body: "b", target: f }))).toEqual(f);
  });
  it("读回：形状不对一律 null", () => {
    expect(alertTargetFromPayload(null)).toBeNull();
    // 外联（#1655）：推给那位朋友，点开要认得
    expect(alertTargetFromPayload({ otto: { kind: "cloud", chat: "outreach", workspaceId: "w", sessionId: "s" } })).toEqual({ kind: "cloud", chat: "outreach", workspaceId: "w", sessionId: "s", agentId: "" });
    expect(alertTargetFromPayload({ otto: { kind: "cloud", chat: "dm", workspaceId: "w", sessionId: "s" } })).toBeNull();
    expect(alertTargetFromPayload({ otto: { kind: "friend", uid: "" } })).toBeNull();
    expect(alertTargetFromPayload({ otto: { kind: "cloud", chat: "team", workspaceId: "w" } })).toBeNull();
  });
  it("alertKey", () => {
    expect(alertKey({ kind: "friend", uid: "u2" })).toBe("f:u2");
    expect(alertKey({ ...cloud, chat: "dm", agentId: "admin" })).toBe("a:admin");
  });
  it("正文折成一行、封顶", () => {
    expect(alertBody("  a\n\nb  ")).toBe("a b");
    const long = "字".repeat(500);
    const out = alertBody(long);
    expect([...out].length).toBe(ALERT_BODY_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("advanceReplyNotify：这一轮答了谁就推给谁", () => {
  let seq = 0;
  const base = { sessionId: "s1", ts: 1 };
  const say = (uid: string, mentions: string[], extra: Partial<SessionEvent> = {}): SessionEvent =>
    ({ ...base, seq: seq++, type: "user_message", content: "q", fromUid: uid, mentions, ...extra }) as SessionEvent;
  const reply = (agentId: string, content: string): SessionEvent =>
    ({ ...base, seq: seq++, type: "assistant_message", content, model: "m", agentId }) as SessionEvent;
  const end = (agentId: string, outcome: "completed" | "aborted" | "error", readUpToSeq?: number): SessionEvent =>
    ({ ...base, seq: seq++, type: "turn_ended", outcome, agentId, ...(readUpToSeq === undefined ? {} : { readUpToSeq }) }) as SessionEvent;
  const run = (events: SessionEvent[]): ReplyNote[] => {
    const s = createReplyNotifyState();
    return events.map((e) => advanceReplyNotify(s, e)).filter((x): x is ReplyNote => x !== null);
  };

  it("问 → 答 → 收口：推给问的人，内容是最后一段", () => {
    expect(run([say("u1", ["ops"]), reply("ops", "我查一下"), reply("ops", "好了"), end("ops", "completed")])).toEqual([
      { agentId: "ops", text: "好了", uids: ["u1"] },
    ]);
  });
  it("只答到 readUpToSeq 为止：后到的那句留给下一轮", () => {
    seq = 100;
    const a = say("u1", ["ops"]); // 100
    const r = reply("ops", "一"); // 101
    const b = say("u2", ["ops"]); // 102
    const notes = run([a, r, b, end("ops", "completed", 100), reply("ops", "二"), end("ops", "completed", 102)]);
    expect(notes).toEqual([
      { agentId: "ops", text: "一", uids: ["u1"] },
      { agentId: "ops", text: "二", uids: ["u2"] },
    ]);
  });
  it("没说话（纯工具）/ 被停 / 出错：不推，问的人也清掉", () => {
    expect(run([say("u1", ["ops"]), reply("ops", "  "), end("ops", "completed")])).toEqual([]);
    expect(run([say("u1", ["ops"]), reply("ops", "x"), end("ops", "aborted"), reply("ops", "y"), end("ops", "completed")])).toEqual([]);
  });
  it("系统、通话里说的、通话 / 回电招呼：不推", () => {
    expect(run([say("system", ["ops"]), reply("ops", "x"), end("ops", "completed")])).toEqual([]);
    expect(run([say("u1", ["ops"], { voice: true } as Partial<SessionEvent>), reply("ops", "x"), end("ops", "completed")])).toEqual([]);
    for (const g of ["voice_call", "callback", "outreach"]) {
      expect(run([say("u1", ["ops"], { greeting: g } as Partial<SessionEvent>), reply("ops", "x"), end("ops", "completed")])).toEqual([]);
    }
  });
  it("推送正文剥掉段首情绪括注；整条只有记号 = 没话，不推（#1515）", () => {
    expect(run([say("u1", ["ops"]), reply("ops", "（笑）弄好了。\n\n（叹）就是慢。"), end("ops", "completed")])).toEqual([
      { agentId: "ops", text: "弄好了。\n\n就是慢。", uids: ["u1"] },
    ]);
    expect(run([say("u1", ["ops"]), reply("ops", "（笑）"), end("ops", "completed")])).toEqual([]);
  });
  it("接力开场白：不推（点火的人只在他问的那一句被答时收一条）", () => {
    expect(run([say("u1", ["b"], { relay: { fromAgentId: "a", depth: 1 } } as Partial<SessionEvent>), reply("b", "x"), end("b", "completed")])).toEqual([]);
  });
  it("新建的那只先开口、外联回来汇报：照推", () => {
    for (const g of ["new_agent", "outreach_report"]) {
      expect(run([say("u1", ["ops"], { greeting: g } as Partial<SessionEvent>), reply("ops", "x"), end("ops", "completed")])).toHaveLength(1);
    }
  });
  it("一句点了两只：各推各的；两个人问同一只：一条推给两个人", () => {
    const notes = run([say("u1", ["a", "b"]), say("u2", ["a"]), reply("a", "A"), end("a", "completed"), reply("b", "B"), end("b", "completed")]);
    expect(notes).toEqual([
      { agentId: "a", text: "A", uids: ["u1", "u2"] },
      { agentId: "b", text: "B", uids: ["u1"] },
    ]);
  });
});

describe("receiptLabel：只画在我发的最后一条底下", () => {
  const m = (id: number, sender: string): DirectMessage => ({ id, sender, recipient: sender === "me" ? "you" : "me", body: "x", createdAt: "2026-10-04T00:00:00Z" });
  it("对方的 App 不认得 / 关了：不画", () => {
    expect(receiptLabel([m(1, "me")], "me", undefined)).toBeNull();
    expect(receiptLabel([m(1, "me")], "me", null)).toBeNull();
  });
  it("最后一条是对方的：不画", () => {
    expect(receiptLabel([m(1, "me"), m(2, "you")], "me", 0)).toBeNull();
  });
  it("已读 / 未读", () => {
    expect(receiptLabel([m(1, "you"), m(3, "me")], "me", 1)).toEqual({ messageId: 3, read: false });
    expect(receiptLabel([m(3, "me"), m(1, "you")], "me", 3)).toEqual({ messageId: 3, read: true });
  });
  it("readUpTo：对方发来的里最大的 id，没有回 0", () => {
    expect(readUpTo([m(1, "you"), m(5, "me"), m(4, "you")], "you")).toBe(4);
    expect(readUpTo([m(5, "me")], "you")).toBe(0);
  });
});
