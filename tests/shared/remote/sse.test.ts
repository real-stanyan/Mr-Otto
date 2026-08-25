import { describe, expect, it } from "vitest";
import { createSseParser } from "../../../src/shared/remote/sse.js";

function collect() {
  const comments: string[] = [];
  const data: string[] = [];
  const p = createSseParser({ comment: (c) => comments.push(c), data: (d) => data.push(d) });
  return { p, comments, data };
}

describe("createSseParser", () => {
  it("控制行与 data 行分开投递", () => {
    const { p, comments, data } = collect();
    p.push(":ok\n\n:peer\n\ndata: AAA\n\n:\n\n");
    expect(comments).toEqual(["ok", "peer", ""]);
    expect(data).toEqual(["AAA"]);
  });

  it("一次收到多帧全部派发；半条帧留到下一块（TCP 想在哪断就在哪断）", () => {
    const { p, comments, data } = collect();
    p.push("data: AB");
    expect(data).toEqual([]);
    p.push("C\n\ndata: D\n\n:pe");
    expect(data).toEqual(["ABC", "D"]);
    expect(comments).toEqual([]);
    p.push("er\n\n");
    expect(comments).toEqual(["peer"]);
  });

  it("认不得的行整条跳过，不当成 data", () => {
    const { p, comments, data } = collect();
    p.push("event: ping\n\nid: 7\n\ndata: X\n\n");
    expect(data).toEqual(["X"]);
    expect(comments).toEqual([]);
  });
});
