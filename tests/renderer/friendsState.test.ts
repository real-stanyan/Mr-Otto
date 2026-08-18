import { describe, it, expect } from "vitest";
import { mergeDm, prependOlder } from "../../src/renderer/src/lib/friendsState.js";
import type { DirectMessage } from "../../src/shared/friends.js";

const M = (id: number): DirectMessage =>
  ({ id, sender: "a", recipient: "b", body: `m${id}`, createdAt: "t" });

describe("mergeDm", () => {
  it("升序插入", () => {
    expect(mergeDm([M(1), M(3)], M(2)).map((m) => m.id)).toEqual([1, 2, 3]);
  });
  it("重复 id 去重(Realtime 推送与本地回显撞车)", () => {
    expect(mergeDm([M(1), M(2)], M(2)).map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("prependOlder", () => {
  it("新→旧的一页翻转拼头部", () => {
    expect(prependOlder([M(5), M(6)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5, 6]);
  });
  it("与现有重叠的去重", () => {
    expect(prependOlder([M(4), M(5)], [M(4), M(3)]).map((m) => m.id)).toEqual([3, 4, 5]);
  });
});
