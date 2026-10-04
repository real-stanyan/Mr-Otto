// presence —— 好友在线点的判据（#1460）：没报过不画、心跳过期算不在线、realtime 送来的行逐格验。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESENCE_BEAT_MS, PRESENCE_STALE_MS, presenceFromRow, presenceOf } from "../../src/shared/presence.js";

describe("presenceOf", () => {
  const now = 1_700_000_000_000;
  it("没报过：null（不画点，不替他说不在线）", () => {
    expect(presenceOf(undefined, now)).toBeNull();
  });
  it("在前台且心跳新鲜：在线", () => {
    expect(presenceOf({ uid: "u", online: true, seenTs: now - 10_000 }, now)).toBe("online");
  });
  it("心跳过期（被杀掉 / 断网报不了 false）：不在线", () => {
    expect(presenceOf({ uid: "u", online: true, seenTs: now - PRESENCE_STALE_MS }, now)).toBe("offline");
  });
  it("报了 false：不在线", () => {
    expect(presenceOf({ uid: "u", online: false, seenTs: now }, now)).toBe("offline");
  });
  it("过期门槛比两次心跳宽：晚到一次不闪红", () => {
    expect(PRESENCE_STALE_MS).toBeGreaterThan(2 * PRESENCE_BEAT_MS);
  });
});

describe("presenceFromRow", () => {
  it("正常一行", () => {
    expect(presenceFromRow({ uid: "u1", online: true, seen_at: "2026-10-04T00:00:00Z" })).toEqual({ uid: "u1", online: true, seenTs: Date.parse("2026-10-04T00:00:00Z") });
  });
  it("缺格 / 时间读不出：null", () => {
    expect(presenceFromRow(null)).toBeNull();
    expect(presenceFromRow({ uid: "u1", online: "yes", seen_at: "2026-10-04T00:00:00Z" })).toBeNull();
    expect(presenceFromRow({ uid: "u1", online: true, seen_at: "not a date" })).toBeNull();
    expect(presenceFromRow({ uid: "", online: true, seen_at: "2026-10-04T00:00:00Z" })).toBeNull();
  });
});

describe("0050：只有好友读得到、只能经 RPC 写、从不删行", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0050_presence.sql", import.meta.url), "utf8");
  it("读策略要求已接受的好友（或本人）", () => {
    expect(sql).toMatch(/create policy pr_select_friends on public\.presence for select to authenticated/);
    expect(sql).toMatch(/f\.status = 'accepted'/);
  });
  it("没有给 authenticated 的写策略；RPC 收掉 anon", () => {
    expect(sql).not.toMatch(/for (insert|update|delete) to authenticated/);
    expect(sql).toMatch(/revoke all on function public\.touch_presence\(boolean\) from anon/);
  });
});
