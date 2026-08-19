import { describe, it, expect } from "vitest";
import { mergeChannelHealth, presenceStateToIds } from "../../src/main/supabaseFriendsApi.js";

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
