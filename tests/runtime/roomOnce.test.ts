import { describe, expect, it } from "vitest";
import { liveOr } from "../../services/runtime/src/roomOnce.js";

describe("liveOr：一条会话只开一间房（#1441 终审 I2）", () => {
  it("已经开着：回现成的那间，open 一次都不调", () => {
    let opened = 0;
    const live = { id: "a" };
    expect(liveOr(live, () => (opened++, { id: "b" }))).toBe(live);
    expect(opened).toBe(0);
  });
  it("没开着（undefined / null）：调一次 open，回它开出来的", () => {
    let opened = 0;
    const fresh = { id: "b" };
    expect(liveOr<{ id: string }>(undefined, () => (opened++, fresh))).toBe(fresh);
    expect(liveOr<{ id: string }>(null, () => (opened++, fresh))).toBe(fresh);
    expect(opened).toBe(2);
  });
});
