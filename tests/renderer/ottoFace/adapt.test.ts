// 私聊头部那张脸的表情从哪来（#1345，ADR-0314）。
//
// 这条映射不放在 JSX 里的理由就是这个文件：它的每一种错法都是安静的——一张脸
// 停在别的表情上，不报错、不塌。

import { describe, expect, it } from "vitest";
import { dmFaceState } from "../../../src/renderer/src/lib/ottoFace/adapt.js";
import type { OpenTurn } from "../../../src/shared/turnLedger.js";

const turn = (seq: number, agentId: string, state: OpenTurn["state"]): OpenTurn =>
  ({ seq, fromUid: "u1", agentId, state });

describe("dmFaceState", () => {
  it("一条都不欠 = plain：**不是 idle**——「没在答我」说不了「它闲着」", () => {
    expect(dmFaceState([], {}, "a_1")).toBe("plain");
    expect(dmFaceState([turn(1, "a_2", "running")], {}, "a_1")).toBe("plain");
  });

  it("排队中 = queued（唯一完全不动的那一档）", () => {
    expect(dmFaceState([turn(1, "a_1", "queued")], {}, "a_1")).toBe("queued");
  });

  it("在跑但一个字都还没掉 = working；正文开始掉了 = solving（嘴在动）", () => {
    expect(dmFaceState([turn(1, "a_1", "running")], {}, "a_1")).toBe("working");
    expect(dmFaceState([turn(1, "a_1", "running")], { a_1: "" }, "a_1")).toBe("working");
    expect(dmFaceState([turn(1, "a_1", "running")], { a_1: "好的" }, "a_1")).toBe("solving");
  });

  it("流式那一格认的是**这一只**的槽，不是随便哪一只在说话", () => {
    expect(dmFaceState([turn(1, "a_1", "running")], { a_2: "别人在说" }, "a_1")).toBe("working");
  });

  it("同一只排了两句：取 seq 最小那条——真正在跑的只有最早那一条（同 stopButtonRows）", () => {
    const pending = [turn(9, "a_1", "queued"), turn(2, "a_1", "running")];
    expect(dmFaceState(pending, {}, "a_1")).toBe("working");
    // 反过来：最早那条还排着，晚的那条读成 running 也不该让脸动起来
    const queuedFirst = [turn(2, "a_1", "queued"), turn(9, "a_1", "running")];
    expect(dmFaceState(queuedFirst, {}, "a_1")).toBe("queued");
  });
});
