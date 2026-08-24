// HeadTail 缓冲（issue #343 第一层：内存有界）。

import { describe, expect, it } from "vitest";
import { HeadTailBuffer } from "../../src/shared/headTail.js";

describe("HeadTailBuffer", () => {
  it("没超限:原样拼回,无标记", () => {
    const b = new HeadTailBuffer(100);
    b.push("hello ");
    b.push("world");
    expect(b.text()).toBe("hello world");
    expect(b.omittedChars).toBe(0);
  });

  it("超限:头尾各半保留,中段丢弃并计数", () => {
    const b = new HeadTailBuffer(10); // 头 5 尾 5
    b.push("AAAAA");
    b.push("MMMMMMMMMM"); // 中段,该被挤掉
    b.push("ZZZZZ");
    expect(b.text()).toContain("AAAAA");
    expect(b.text()).toContain("ZZZZZ");
    expect(b.text()).toContain("省略 10 字符");
    expect(b.omittedChars).toBe(10);
  });

  it("内存有界:狂灌 10MB,持有量不随输入涨", () => {
    const b = new HeadTailBuffer(1_000);
    for (let i = 0; i < 10_000; i++) b.push("x".repeat(1_000));
    // 头 500 + 尾 500 + 标记,持有量在缓冲上限一个数量级内
    expect(b.text().length).toBeLessThan(1_100);
    expect(b.omittedChars).toBe(10_000 * 1_000 - 1_000);
  });

  it("跨 chunk 边界:一个 chunk 同时填头进尾", () => {
    const b = new HeadTailBuffer(4); // 头 2 尾 2
    b.push("abcdef");
    expect(b.text()).toBe("ab\n…[中间省略 2 字符]…\nef");
  });

  it("尾巴不从 surrogate pair 中间开场", () => {
    const b = new HeadTailBuffer(4);
    b.push("ab");
    b.push("xx😀yy"); // 若切在 😀 中间,低位起头的字符要再丢一个
    const tail = b.text().split("\n").at(-1)!;
    expect(tail.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    // 拼回的文本 JSON 序列化不炸(没有孤立 surrogate)
    expect(() => JSON.stringify(b.text())).not.toThrow();
  });
});
