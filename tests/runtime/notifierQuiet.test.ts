// 推送的免打扰时段（#1569，ADR-0366）：时段里一条不推；时段外照旧；quiet 查不到 / 没接当没开。
import { describe, expect, it } from "vitest";
import { createNotifier, type NotifyStore } from "../../services/runtime/src/notifier.js";
import { DEFAULT_NOTIFY_PREFS, type AlertPush } from "../../src/shared/notifyPrefs.js";

const TZ = "Asia/Shanghai";
const sh = (y: number, mo: number, d: number, hh: number, mm: number): number => Date.UTC(y, mo - 1, d, hh - 8, mm);
const store: NotifyStore = { prefs: async () => ({ ...DEFAULT_NOTIFY_PREFS }), mutes: async () => new Set() };
const push: AlertPush = { title: "小红", body: "在吗", target: { kind: "friend", uid: "u-hong" } };

describe("notifier：免打扰", () => {
  it("时段里不推、时段外推；没接 quiet 的老装配一个字不变", async () => {
    const sent: string[] = [];
    let t = sh(2026, 10, 5, 23, 30);
    const n = createNotifier({ store, quiet: async () => ({ window: { start: "22:00", end: "08:00" }, tz: TZ }), push: async (uid) => (sent.push(uid), 1), now: () => t, log: () => {} });
    await n.send("me", "friend", push);
    expect(sent).toEqual([]);
    t = sh(2026, 10, 6, 9, 0) + 60_000; // 过了缓存的 30 秒窗
    await n.send("me", "friend", push);
    expect(sent).toEqual(["me"]);
    const legacy = createNotifier({ store, push: async (uid) => (sent.push(uid), 1), now: () => sh(2026, 10, 5, 23, 30), log: () => {} });
    await legacy.send("me", "friend", push);
    expect(sent).toEqual(["me", "me"]);
  });
  it("quiet 为 null（没开 / 0062 没跑）照推", async () => {
    const sent: string[] = [];
    const n = createNotifier({ store, quiet: async () => ({ window: null, tz: null }), push: async (uid) => (sent.push(uid), 1), now: () => sh(2026, 10, 5, 23, 30), log: () => {} });
    await n.send("me", "friend", push);
    expect(sent).toEqual(["me"]);
  });
});
