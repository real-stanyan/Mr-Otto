// friendPush —— 朋友私聊的推送（#1442）：realtime 送来的行逐格验、推给收信人、称呼查不到也照推。
import { describe, expect, it } from "vitest";
import { createFriendPush, friendMessageOf, friendPushOf } from "../../services/runtime/src/friendPush.js";
import type { Notifier } from "../../services/runtime/src/notifier.js";
import type { AlertPush, NotifyKind } from "../../src/shared/notifyPrefs.js";

describe("friendMessageOf", () => {
  it("正常一行；id 是字符串数字也认（bigint 在线上可能是字符串）", () => {
    expect(friendMessageOf({ id: 7, sender: "a", recipient: "b", body: "hi", created_at: "x" })).toEqual({ id: 7, sender: "a", recipient: "b", body: "hi" });
    expect(friendMessageOf({ id: "7", sender: "a", recipient: "b", body: "hi" })?.id).toBe(7);
  });
  it("缺格 / 自己发给自己：null", () => {
    expect(friendMessageOf(null)).toBeNull();
    expect(friendMessageOf({ id: 1, sender: "a", body: "x" })).toBeNull();
    expect(friendMessageOf({ id: 1, sender: "a", recipient: "a", body: "x" })).toBeNull();
    expect(friendMessageOf({ id: "x1", sender: "a", recipient: "b", body: "x" })).toBeNull();
  });
});

describe("friendPushOf", () => {
  it("标题是称呼，点开去和发信人的私聊", () => {
    expect(friendPushOf({ id: 1, sender: "a", recipient: "b", body: "在吗\n\n今晚" }, "小红")).toEqual({
      title: "小红", body: "在吗 今晚", target: { kind: "friend", uid: "a" },
    });
  });
});

describe("createFriendPush", () => {
  const rig = (nameOf: (uid: string) => Promise<string>) => {
    const sent: [string, NotifyKind, AlertPush][] = [];
    const notifier: Notifier = { send: async (uid, kind, p) => { sent.push([uid, kind, p]); } };
    return { sent, fp: createFriendPush({ notifier, nameOf, log: () => {} }) };
  };
  it("推给收信人、类别是 friend", async () => {
    const r = rig(async () => "小红");
    await r.fp.onInsert({ id: 1, sender: "a", recipient: "b", body: "hi" });
    expect(r.sent).toEqual([["b", "friend", { title: "小红", body: "hi", target: { kind: "friend", uid: "a" } }]]);
  });
  it("称呼查不到：退回 uid 前 8 位照推", async () => {
    const r = rig(async () => { throw new Error("down"); });
    await r.fp.onInsert({ id: 1, sender: "abcdefghijkl", recipient: "b", body: "hi" });
    expect(r.sent[0]![2].title).toBe("abcdefgh");
  });
  it("形状不对：不推", async () => {
    const r = rig(async () => "x");
    await r.fp.onInsert({ nope: true });
    expect(r.sent).toEqual([]);
  });
});
