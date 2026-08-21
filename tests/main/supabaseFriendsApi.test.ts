import { describe, it, expect } from "vitest";
import { mergeChannelHealth, presenceStateToEntries, presenceStateToIds } from "../../src/main/supabaseFriendsApi.js";

describe("presenceStateToIds", () => {
  it("state 的 key 即在线 uid,排序输出", () => {
    expect(presenceStateToIds({ b: [{}], a: [{}, {}] })).toEqual(["a", "b"]);
  });
  it("空 state → 空数组", () => {
    expect(presenceStateToIds({})).toEqual([]);
  });
});

describe("mergeChannelHealth", () => {
  it("四条通道全 SUBSCRIBED 才算 live", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED"])).toBe("live");
  });

  // 只有 messages 哑掉时,好友列表照常刷新,聊天却静悄悄——最难察觉的那种坏。
  // 整体判 degraded 让轮询兜住,宁可多轮询也别装作正常
  it("任一条没通就整体 degraded", () => {
    expect(mergeChannelHealth(["SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED", "SUBSCRIBED"])).toBe("degraded");
    expect(mergeChannelHealth(["SUBSCRIBED", "TIMED_OUT", "SUBSCRIBED", "SUBSCRIBED"])).toBe("degraded");
    expect(mergeChannelHealth(["CONNECTING", "CONNECTING", "CONNECTING", "CONNECTING"])).toBe("degraded");
  });
});

describe("presenceStateToEntries", () => {
  it("meta 里的 repoKey/branch 捞出来;老客户端只有 {at} → workspace null", () => {
    expect(presenceStateToEntries({
      b: [{ at: 1 }],
      a: [{ at: 1, repoKey: "k", branch: "main" }],
    })).toEqual([
      { id: "a", workspace: { repoKey: "k", branch: "main" } },
      { id: "b", workspace: null },
    ]);
  });

  it("多窗口:取第一个带 repoKey 的 meta;branch 不是字符串当 null", () => {
    expect(presenceStateToEntries({
      a: [{ at: 1 }, { at: 2, repoKey: "k", branch: 42 }, { at: 3, repoKey: "k2", branch: "x" }],
    })).toEqual([{ id: "a", workspace: { repoKey: "k", branch: null } }]);
  });

  it("形状不对的 meta 一律当没有(对端不可信)", () => {
    expect(presenceStateToEntries({ a: [null, "str", { repoKey: "" }, { repoKey: 7 }] }))
      .toEqual([{ id: "a", workspace: null }]);
  });
});
