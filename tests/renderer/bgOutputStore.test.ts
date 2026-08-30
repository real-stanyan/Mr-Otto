// 后台任务输出尾巴的落点（issue #772 / ADR-0193）。
//
// 两条都是「不这么写也不会报错，只会画错」的那种规矩：
//
// ① **按会话分格**：taskId 是 `bg-N`，计数器每个会话各数各的。平铺一层存的话
//    A 会话的 bg-1 会把 B 会话 bg-1 的输出画出来，而两者都叫 bg-1。
// ② **名单整份替换、尾巴只合并**：那趟 5 秒一次的轮询问的是「谁还活着」，
//    跑完了但结果还没贴回对话的任务不在答案里——可它的卡片还画在面板上。
//    照名单整份替换尾巴，那张卡会每 5 秒被清一次屏。

import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

const A = "sess-a";
const B = "sess-b";

beforeEach(() => {
  useChat.setState({ liveBgIds: [], bgOutputBySession: {} });
});

describe("setLiveBg", () => {
  it("名单整份替换，尾巴按会话落格", () => {
    useChat.getState().setLiveBg(A, [{ id: "bg-1", tail: "A 的输出" }]);
    useChat.getState().setLiveBg(B, [{ id: "bg-1", tail: "B 的输出" }]);

    expect(useChat.getState().liveBgIds).toEqual(["bg-1"]);
    expect(useChat.getState().bgOutputBySession).toEqual({
      [A]: { "bg-1": "A 的输出" },
      [B]: { "bg-1": "B 的输出" },
    });
  });

  it("跑完的任务不在 live 名单里，它的尾巴不该被这一趟清掉", () => {
    useChat.getState().setLiveBg(A, [
      { id: "bg-1", tail: "跑完了" },
      { id: "bg-2", tail: "还在跑" },
    ]);
    // 下一趟：bg-1 已经结束，只剩 bg-2 活着
    useChat.getState().setLiveBg(A, [{ id: "bg-2", tail: "还在跑 更多" }]);

    expect(useChat.getState().liveBgIds).toEqual(["bg-2"]);
    expect(useChat.getState().bgOutputBySession[A]).toEqual({
      "bg-1": "跑完了", // 卡片还在面板上，终端不该被清屏
      "bg-2": "还在跑 更多",
    });
  });

  it("没有会话时只清名单 —— 尾巴按会话存着，没有会话就没有该动的那一格", () => {
    useChat.getState().setLiveBg(A, [{ id: "bg-1", tail: "留着" }]);
    useChat.getState().setLiveBg(null, []);

    expect(useChat.getState().liveBgIds).toEqual([]);
    expect(useChat.getState().bgOutputBySession).toEqual({ [A]: { "bg-1": "留着" } });
  });
});
