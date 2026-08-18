import { describe, it, expect } from "vitest";
import { presenceStateToIds } from "../../src/main/supabaseFriendsApi.js";

describe("presenceStateToIds", () => {
  it("state 的 key 即在线 uid,排序输出", () => {
    expect(presenceStateToIds({ b: [{}], a: [{}, {}] })).toEqual(["a", "b"]);
  });
  it("空 state → 空数组", () => {
    expect(presenceStateToIds({})).toEqual([]);
  });
});
