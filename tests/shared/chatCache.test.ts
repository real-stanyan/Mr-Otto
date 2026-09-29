import { describe, expect, it } from "vitest";
import {
  CHAT_CACHE_MAX_CHARS, CHAT_CACHE_MAX_EVENTS,
  parseChatCache, parseChatCacheIndex, reconcileCachedEvents, removeFromChatCacheIndex,
  serializeChatCache, serializeChatCacheIndex, touchChatCacheIndex,
} from "../../src/shared/chatCache.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (seq: number, content = "x", sessionId = "s1"): SessionEvent =>
  ({ type: "chat_message", sessionId, seq, ts: 1000 + seq, fromUid: "u1", label: "alice", content }) as unknown as SessionEvent;
const seqs = (es: readonly SessionEvent[] | null): number[] | null => (es === null ? null : es.map((e) => e.seq));

describe("serializeChatCache / parseChatCache", () => {
  it("来回一遍原样", () => {
    const raw = serializeChatCache([ev(1), ev(2)]);
    expect(seqs(parseChatCache(raw, "s1"))).toEqual([1, 2]);
  });
  it("空的不存", () => {
    expect(serializeChatCache([])).toBeNull();
  });
  it("超过条数上限只留最新的", () => {
    const many = Array.from({ length: CHAT_CACHE_MAX_EVENTS + 5 }, (_, i) => ev(i));
    const back = parseChatCache(serializeChatCache(many), "s1")!;
    expect(back).toHaveLength(CHAT_CACHE_MAX_EVENTS);
    expect(back[0]!.seq).toBe(5);
    expect(back.at(-1)!.seq).toBe(CHAT_CACHE_MAX_EVENTS + 4);
  });
  it("超过字符上限从最旧的丢，最新那条留着", () => {
    const big = "字".repeat(Math.floor(CHAT_CACHE_MAX_CHARS / 3));
    const raw = serializeChatCache([ev(1, big), ev(2, big), ev(3, big), ev(4, "新")]);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThanOrEqual(CHAT_CACHE_MAX_CHARS);
    const back = seqs(parseChatCache(raw, "s1"))!;
    expect(back.at(-1)).toBe(4);
    expect(back).not.toContain(1);
  });
  it("只剩最新一条仍然超上限：这条聊天不存", () => {
    expect(serializeChatCache([ev(1), ev(2, "字".repeat(CHAT_CACHE_MAX_CHARS + 10))])).toBeNull();
  });
  it("读出来的东西不信：坏 JSON / 版本不对 / 不是数组 / seq 非数字 / sessionId 不符 → null", () => {
    expect(parseChatCache(null, "s1")).toBeNull();
    expect(parseChatCache("{", "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 2, events: [ev(1)] }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: {} }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: [{ ...ev(1), seq: "1" }] }), "s1")).toBeNull();
    expect(parseChatCache(JSON.stringify({ v: 1, events: [ev(1, "x", "other")] }), "s1")).toBeNull();
  });
  it("读出来按 seq 排好、同 seq 去重（insertCloudEvent 的前提是有序无重）", () => {
    const raw = JSON.stringify({ v: 1, events: [ev(3), ev(1), ev(3), ev(2)] });
    expect(seqs(parseChatCache(raw, "s1"))).toEqual([1, 2, 3]);
  });
});

describe("reconcileCachedEvents", () => {
  it("服务器一条都没给（serverMin 为 null）：全扔", () => {
    expect(reconcileCachedEvents([ev(1), ev(2)], null)).toEqual([]);
  });
  it("扔掉比服务器这一屏更早的，不留断档", () => {
    expect(seqs(reconcileCachedEvents([ev(100), ev(150), ev(300), ev(301)], 300))).toEqual([300, 301]);
  });
  it("团队群全量下发（serverMin 是第一条）：什么都不扔", () => {
    expect(seqs(reconcileCachedEvents([ev(0), ev(1), ev(2)], 0))).toEqual([0, 1, 2]);
  });
});

describe("缓存索引", () => {
  it("touch：新的排前面、同一条不重复、ts 更新", () => {
    let { index } = touchChatCacheIndex([], "a", 1, 30);
    ({ index } = touchChatCacheIndex(index, "b", 2, 30));
    ({ index } = touchChatCacheIndex(index, "a", 3, 30));
    expect(index).toEqual([{ sessionId: "a", ts: 3 }, { sessionId: "b", ts: 2 }]);
  });
  it("超过上限淘汰最久没写的", () => {
    const start = [{ sessionId: "old", ts: 1 }, { sessionId: "mid", ts: 5 }];
    const r = touchChatCacheIndex(start, "new", 9, 2);
    expect(r.index.map((x) => x.sessionId)).toEqual(["new", "mid"]);
    expect(r.evicted).toEqual(["old"]);
  });
  it("时钟往回拨：刚写的这条自己不被淘汰，被淘汰的是别人里最旧的", () => {
    const start = [{ sessionId: "a", ts: 100 }, { sessionId: "b", ts: 90 }];
    const r = touchChatCacheIndex(start, "new", 5, 2);
    expect(r.index.map((x) => x.sessionId)).toEqual(["new", "a"]);
    expect(r.evicted).toEqual(["b"]);
  });
  it("remove 与 parse/serialize 来回；坏数据回空表、坏条目跳过", () => {
    const idx = [{ sessionId: "a", ts: 2 }, { sessionId: "b", ts: 1 }];
    expect(parseChatCacheIndex(serializeChatCacheIndex(idx))).toEqual(idx);
    expect(removeFromChatCacheIndex(idx, "a")).toEqual([{ sessionId: "b", ts: 1 }]);
    expect(parseChatCacheIndex(null)).toEqual([]);
    expect(parseChatCacheIndex("nope")).toEqual([]);
    expect(parseChatCacheIndex(JSON.stringify([{ sessionId: "a", ts: 1 }, { sessionId: 3 }, null]))).toEqual([{ sessionId: "a", ts: 1 }]);
  });
});
