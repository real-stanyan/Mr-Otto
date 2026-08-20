import { describe, expect, it } from "vitest";

import {
  dropTask,
  pushTask,
  takeNext,
  unshiftTask,
  type QueuedTask,
} from "../../src/renderer/src/lib/messageQueue.js";

const t = (id: string, text = id): QueuedTask => ({ id, text });

describe("消息队列 —— 先来先发", () => {
  it("排到队尾,不插队", () => {
    expect(pushTask([t("a")], t("b")).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("原表不动 —— 队列是 zustand 的 state,就地改会漏掉重渲染", () => {
    const list = [t("a")];
    pushTask(list, t("b"));
    dropTask(list, "a");
    expect(list.map((x) => x.id)).toEqual(["a"]);
  });

  it("× 掉中间那条,前后的顺序不变", () => {
    expect(dropTask([t("a"), t("b"), t("c")], "b").map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("认不出的 id 什么都不删 —— 删「最像的那条」是拿用户的话赌", () => {
    expect(dropTask([t("a")], "zzz").map((x) => x.id)).toEqual(["a"]);
  });

  it("取队首:剩下的按原序留着", () => {
    const [head, rest] = takeNext([t("a"), t("b"), t("c")]);
    expect(head?.id).toBe("a");
    expect(rest.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("空队列取不出东西,也不报错 —— 空转是常态(每个 turn 收工都会问一次)", () => {
    const [head, rest] = takeNext([]);
    expect(head).toBeUndefined();
    expect(rest).toEqual([]);
  });

  it("发失败的那条回队首,不是队尾:它本来就该是下一条", () => {
    expect(unshiftTask([t("b")], t("a")).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("skill 一路带着 —— $ 指令排队后仍要注入同一个 skill", () => {
    const task: QueuedTask = { id: "1", text: "跑一下测试", skill: "tdd" };
    const [head] = takeNext(pushTask([], task));
    expect(head?.skill).toBe("tdd");
  });
});
