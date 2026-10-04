// src/shared/sendQueue.ts 的可执行版（#1473）：输入框不再等回执就清空之后，人可以在上一句的回执
// 还没回来时就发第二句，而云会话客户端对「上一句还没有回执」的第二次 say 是直接拒的（SAY_BUSY_MESSAGE，
// 不排队）。这条队列把发送串成一条链——一句一句发，前一句失败也不卡住后一句。
import { describe, expect, it } from "vitest";
import { createSendQueue } from "../../src/shared/sendQueue.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createSendQueue", () => {
  it("第二句等第一句落定之后才开始", async () => {
    const q = createSendQueue();
    const order: string[] = [];
    let release: () => void = () => {};
    const first = q.run(() => {
      order.push("a:start");
      return new Promise<string>((resolve) => {
        release = () => resolve("a");
      });
    });
    const second = q.run(async () => {
      order.push("b:start");
      return "b";
    });
    await tick();
    expect(order).toEqual(["a:start"]);
    release();
    expect(await first).toBe("a");
    expect(await second).toBe("b");
    expect(order).toEqual(["a:start", "b:start"]);
  });

  it("前一句抛了，后一句照样发；抛的那一句把错误原样交回它自己的调用方", async () => {
    const q = createSendQueue();
    const first = q.run(async () => {
      throw new Error("boom");
    });
    const second = q.run(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });

  it("三句按入队顺序发", async () => {
    const q = createSendQueue();
    const seen: number[] = [];
    await Promise.all([1, 2, 3].map((n) => q.run(async () => {
      await tick();
      seen.push(n);
    })));
    expect(seen).toEqual([1, 2, 3]);
  });
});
