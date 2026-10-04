// notifier —— 推不推的最后一道闸（#1442）：开关、免打扰、读不到就不推、30 秒缓存。
import { describe, expect, it } from "vitest";
import { NOTIFY_CACHE_MS, createNotifier, withGroupTitle, type NotifyStore } from "../../services/runtime/src/notifier.js";
import { DEFAULT_NOTIFY_PREFS, type AlertPush, type NotifyPrefs } from "../../src/shared/notifyPrefs.js";

const DM: AlertPush = { title: "开发", body: "好了", target: { kind: "cloud", chat: "dm", workspaceId: "w", sessionId: "s", agentId: "dev" } };
const FRIEND: AlertPush = { title: "小红", body: "在吗", target: { kind: "friend", uid: "u2" } };

function rig(o: { prefs?: NotifyPrefs; mutes?: string[]; fail?: boolean } = {}) {
  let reads = 0;
  const store: NotifyStore = {
    async prefs() {
      reads += 1;
      if (o.fail === true) throw new Error("boom");
      return o.prefs ?? DEFAULT_NOTIFY_PREFS;
    },
    async mutes() {
      return new Set(o.mutes ?? []);
    },
  };
  const sent: [string, AlertPush][] = [];
  const logs: string[] = [];
  let t = 0;
  const n = createNotifier({ store, push: async (uid, p) => { sent.push([uid, p]); return 1; }, now: () => t, log: (m) => logs.push(m) });
  return { n, sent, logs, reads: () => reads, tick: (ms: number) => { t += ms; } };
}

describe("createNotifier", () => {
  it("全开：推", async () => {
    const r = rig();
    await r.n.send("u1", "agent_reply", DM);
    expect(r.sent).toEqual([["u1", DM]]);
  });
  it("那一类关了：不推", async () => {
    const r = rig({ prefs: { ...DEFAULT_NOTIFY_PREFS, friends: false } });
    await r.n.send("u1", "friend", FRIEND);
    await r.n.send("u1", "agent_reply", DM);
    expect(r.sent.map(([, p]) => p.title)).toEqual(["开发"]);
  });
  it("这条聊天免打扰：不推（键与列表键相同）", async () => {
    const r = rig({ mutes: ["a:dev", "f:u2"] });
    await r.n.send("u1", "agent_reply", DM);
    await r.n.send("u1", "friend", FRIEND);
    expect(r.sent).toEqual([]);
  });
  it("开关读不到：不推，记一行", async () => {
    const r = rig({ fail: true });
    await r.n.send("u1", "agent_reply", DM);
    expect(r.sent).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/读不到/);
  });
  it("30 秒内复用读数，过了再读", async () => {
    const r = rig();
    await r.n.send("u1", "agent_reply", DM);
    await r.n.send("u1", "agent_reply", DM);
    expect(r.reads()).toBe(1);
    r.tick(NOTIFY_CACHE_MS);
    await r.n.send("u1", "agent_reply", DM);
    expect(r.reads()).toBe(2);
  });
  it("APNs 那一层抛错：不往外抛，记一行", async () => {
    const store: NotifyStore = { prefs: async () => DEFAULT_NOTIFY_PREFS, mutes: async () => new Set() };
    const logs: string[] = [];
    const n = createNotifier({ store, push: async () => { throw new Error("db down"); }, log: (m) => logs.push(m) });
    await expect(n.send("u1", "mention", DM)).resolves.toBeUndefined();
    expect(logs.join("\n")).toMatch(/推送失败/);
  });
});

describe("withGroupTitle：群里的推送换上真群名", () => {
  const group: AlertPush = { title: "群聊", subtitle: "开发", body: "x", target: { kind: "cloud", chat: "group", workspaceId: "w", sessionId: "s9", agentId: "" } };
  it("查得到就换", async () => {
    expect((await withGroupTitle(group, async (id) => (id === "s9" ? "周末摆摊" : null))).title).toBe("周末摆摊");
  });
  it("查不到 / 抛：留原来的", async () => {
    expect((await withGroupTitle(group, async () => null)).title).toBe("群聊");
    expect((await withGroupTitle(group, async () => { throw new Error("x"); })).title).toBe("群聊");
  });
  it("私聊 / 朋友私聊不查", async () => {
    let asked = 0;
    const q = async () => { asked += 1; return "x"; };
    await withGroupTitle(DM, q);
    await withGroupTitle(FRIEND, q);
    expect(asked).toBe(0);
  });
});
