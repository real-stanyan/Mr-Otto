// exec 输出 IPC 限流（issue #343 第二层）。

import { describe, expect, it } from "vitest";
import { createExecStreamLimiter } from "../../src/shared/execStream.js";

describe("createExecStreamLimiter", () => {
  it("小 chunk 原样过桥,不拆不吞", () => {
    const got: string[] = [];
    const f = createExecStreamLimiter((c) => got.push(c));
    f("hello", "stdout");
    expect(got).toEqual(["hello"]);
  });

  it("大 chunk 按上限切片,每片 ≤ maxChunkChars", () => {
    const got: string[] = [];
    const f = createExecStreamLimiter((c) => got.push(c), { maxChunkChars: 10 });
    f("x".repeat(25), "stdout");
    expect(got.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(got.join("")).toBe("x".repeat(25));
  });

  it("不从 surrogate pair 中间切", () => {
    const got: string[] = [];
    const f = createExecStreamLimiter((c) => got.push(c), { maxChunkChars: 3 });
    f("ab😀cd", "stdout"); // 😀 占两个 code unit,落在切点上
    for (const c of got) expect(() => encodeURIComponent(c)).not.toThrow(); // 无孤立 surrogate
    expect(got.join("")).toBe("ab😀cd");
  });

  it("配额烧完静默丢弃 —— 直播结束,消费不受影响(读到 EOF 由 world 层保证)", () => {
    const got: string[] = [];
    const f = createExecStreamLimiter((c) => got.push(c), { maxChunkChars: 5, maxChunks: 3 });
    for (let i = 0; i < 10; i++) f("12345", "stdout");
    expect(got).toHaveLength(3);
    f("会被丢", "stderr"); // 再喂不抛
    expect(got).toHaveLength(3);
  });

  it("配额按 chunk 数计,切片出的每片都占额", () => {
    const got: string[] = [];
    const f = createExecStreamLimiter((c) => got.push(c), { maxChunkChars: 2, maxChunks: 2 });
    f("abcdef", "stdout"); // 切成 3 片,只放行 2
    expect(got).toEqual(["ab", "cd"]);
  });
});
