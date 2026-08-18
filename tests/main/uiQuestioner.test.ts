import { describe, expect, it, vi } from "vitest";
import { UIQuestioner } from "../../src/main/uiQuestioner.js";
import type { AskUserQuestion } from "../../src/shared/askUser.js";

const questions: AskUserQuestion[] = [
  { header: "路线", question: "走哪条?", options: [{ label: "A" }, { label: "B" }] },
];

describe("UIQuestioner", () => {
  it("ask 悬停到 resolve 被调用为止 —— 这就是「问人」的全部机制", async () => {
    const send = vi.fn();
    const q = new UIQuestioner(send);
    const pending = q.ask({ toolCallId: "c1", questions });

    expect(send).toHaveBeenCalledWith("c1", questions);
    q.resolve("c1", { status: "answered", answers: [{ header: "路线", selected: ["A"] }] });
    await expect(pending).resolves.toEqual({
      status: "answered",
      answers: [{ header: "路线", selected: ["A"] }],
    });
  });

  it("认错 toolCallId 的 resolve 不唤醒任何人（过期卡/重复提交）", async () => {
    const q = new UIQuestioner(() => {});
    const pending = q.ask({ toolCallId: "c1", questions });
    q.resolve("别的调用", { status: "answered", answers: [] });

    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    q.resolve("c1", { status: "answered", answers: [] });
    await expect(pending).resolves.toEqual({ status: "answered", answers: [] });
  });

  it("turn 中断 → 挂起的问卷立即以「已取消」收场，管线不卡死", async () => {
    const ac = new AbortController();
    const q = new UIQuestioner(() => {});
    const pending = q.ask({ toolCallId: "c1", questions }, ac.signal);
    ac.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled", reason: "turn 被用户中断" });
  });

  it("信号已中止 → 短路，压根不给 UI 发一张必死的卡", async () => {
    const send = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(
      new UIQuestioner(send).ask({ toolCallId: "c1", questions }, ac.signal)
    ).resolves.toEqual({ status: "cancelled", reason: "turn 被用户中断" });
    expect(send).not.toHaveBeenCalled();
  });

  it("人已交卷之后再中断 turn，不覆盖已有答案", async () => {
    const ac = new AbortController();
    const q = new UIQuestioner(() => {});
    const pending = q.ask({ toolCallId: "c1", questions }, ac.signal);
    q.resolve("c1", { status: "answered", answers: [{ header: "路线", selected: ["B"] }] });
    ac.abort();
    await expect(pending).resolves.toEqual({
      status: "answered",
      answers: [{ header: "路线", selected: ["B"] }],
    });
  });

  it("多张卡并行挂着，各认各的钥匙", async () => {
    const q = new UIQuestioner(() => {});
    const first = q.ask({ toolCallId: "c1", questions });
    const second = q.ask({ toolCallId: "c2", questions });
    q.resolve("c2", { status: "cancelled", reason: "用户关掉了卡片" });
    await expect(second).resolves.toEqual({ status: "cancelled", reason: "用户关掉了卡片" });
    q.resolve("c1", { status: "answered", answers: [] });
    await expect(first).resolves.toEqual({ status: "answered", answers: [] });
  });
});
