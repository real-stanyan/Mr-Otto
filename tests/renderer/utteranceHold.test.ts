import { describe, expect, it } from "vitest";
import {
  HOLD_BELOW, HOLD_IDLE, HOLD_MAX_AGE_MS, HOLD_MAX_MERGES, HOLD_MS, VERDICT_WAIT_MS, holdStep, joinSpoken,
  type HoldEffect, type HoldEvent, type HoldState,
} from "../../src/renderer/src/lib/utteranceHold.js";

/** 把一串 (事件, 时刻) 喂进去，收集全部副作用 */
function run(steps: [HoldEvent, number][], hold = true, from: HoldState = HOLD_IDLE) {
  let state = from;
  const effects: HoldEffect[] = [];
  for (const [ev, now] of steps) {
    const r = holdStep(state, ev, now, { hold });
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects, sent: effects.filter((e) => e.type === "send").map((e) => (e as { text: string }).text) };
}

describe("joinSpoken", () => {
  it("中文直接接，两头都是 ASCII 才补空格", () => {
    expect(joinSpoken("", "你好")).toBe("你好");
    expect(joinSpoken("我想让你。", "帮我看一下")).toBe("我想让你。帮我看一下");
    expect(joinSpoken("push to", "main")).toBe("push to main");
  });
});

describe("停嘴那一刻投机问一次", () => {
  it("quiet → judge；同一段文字只问一次；太短不问", () => {
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 0], [{ type: "quiet", text: "帮我看一下构建" }, 50], [{ type: "quiet", text: "嗯" }, 60]]);
    expect(r.effects).toEqual([{ type: "judge", key: "帮我看一下构建", text: "帮我看一下构建" }]);
  });
  it("扣着的时候问的是**合起来**的那句，key 仍是新那一段", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 100]], true, held);
    expect(r.effects).toEqual([{ type: "judge", key: "帮我看一下构建", text: "我想让你。帮我看一下构建" }]);
  });
});

describe("final 到了", () => {
  it("答案已到且说完了 → 同一拍发出去", () => {
    const r = run([[{ type: "quiet", text: "好的谢谢" }, 0], [{ type: "verdict", key: "好的谢谢", p: 0.95 }, 300], [{ type: "final", text: "好的谢谢" }, 700]]);
    expect(r.sent).toEqual(["好的谢谢"]);
  });
  it("答案已到且没说完 → 扣住，起一只 HOLD_MS 的表", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: HOLD_BELOW - 0.01 }, 300], [{ type: "final", text: "我想让你。" }, 700]]);
    expect(r.sent).toEqual([]);
    expect(r.state.buffer).toBe("我想让你。");
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 700 + HOLD_MS });
  });
  it("扣着、人接着说了、下一句说完了 → 合并成一条发", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 300], [{ type: "final", text: "我想让你。" }, 700],
      [{ type: "partial", text: "帮我" }, 1200],
      [{ type: "quiet", text: "帮我看一下构建。" }, 2500], [{ type: "verdict", key: "帮我看一下构建。", p: 0.9 }, 2800], [{ type: "final", text: "帮我看一下构建。" }, 3200],
    ]);
    expect(r.sent).toEqual(["我想让你。帮我看一下构建。"]);
    expect(r.state.buffer).toBe("");
  });
  it("扣着、人没再开口 → 表到点把扣着的发出去", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 300], [{ type: "final", text: "我想让你。" }, 700],
      [{ type: "tick" }, 700 + HOLD_MS - 1], [{ type: "tick" }, 700 + HOLD_MS],
    ]);
    expect(r.sent).toEqual(["我想让你。"]);
  });
  it("答案还在路上 → 最多等 VERDICT_WAIT_MS；到点按说完了算", () => {
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 0], [{ type: "final", text: "帮我看一下构建" }, 700]]);
    expect(r.sent).toEqual([]);
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 700 + VERDICT_WAIT_MS });
    const after = holdStep(r.state, { type: "tick" }, 700 + VERDICT_WAIT_MS, { hold: true });
    expect(after.effects).toEqual([{ type: "send", text: "帮我看一下构建" }]);
  });
  it("等的那一下里答案回来了 → 当场按它判", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "final", text: "我想让你。" }, 700], [{ type: "verdict", key: "我想让你。", p: 0.05 }, 800]]);
    expect(r.sent).toEqual([]);
    expect(r.state.buffer).toBe("我想让你。");
  });
  it("从没问过（quiet 没来过）→ 照今天的发", () => {
    expect(run([[{ type: "final", text: "你好" }, 0]]).sent).toEqual(["你好"]);
  });
  it("judge 失败（p 是 null）→ 按说完了算", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: null }, 300], [{ type: "final", text: "我想让你。" }, 700]]);
    expect(r.sent).toEqual(["我想让你。"]);
  });
});

describe("两道封顶", () => {
  it(`最多连扣 ${HOLD_MAX_MERGES} 次，第 ${HOLD_MAX_MERGES + 1} 句无论如何发出去`, () => {
    const steps: [HoldEvent, number][] = [];
    for (let i = 0; i <= HOLD_MAX_MERGES; i++) {
      const t = `第${i}段，`;
      const at = i * 1000;
      steps.push([{ type: "quiet", text: t }, at], [{ type: "verdict", key: t, p: 0.01 }, at + 100], [{ type: "final", text: t }, at + 200]);
    }
    const r = run(steps);
    expect(r.sent).toEqual(["第0段，第1段，第2段，第3段，"]);
  });
  it("人一直在说：从第一次扣住起 HOLD_MAX_AGE_MS 到点，把扣着的先发出去", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 100], [{ type: "final", text: "我想让你。" }, 200],
      [{ type: "partial", text: "帮" }, 500],
    ]);
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 200 + HOLD_MAX_AGE_MS });
    const after = holdStep(r.state, { type: "tick" }, 200 + HOLD_MAX_AGE_MS, { hold: true });
    expect(after.effects).toEqual([{ type: "send", text: "我想让你。" }]);
  });
});

describe("hold:false（影子期 / 没开）：照问不误，但一拍都不耽误", () => {
  it("答案说没说完也照发；答案在路上也不等", () => {
    const a = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.01 }, 300], [{ type: "final", text: "我想让你。" }, 700]], false);
    expect(a.sent).toEqual(["我想让你。"]);
    const b = run([[{ type: "quiet", text: "帮我看一下" }, 0], [{ type: "final", text: "帮我看一下" }, 700]], false);
    expect(b.sent).toEqual(["帮我看一下"]);
  });
});

describe("reset（关麦 / 换会话）", () => {
  it("扣着的那句照样发出去——人确实说了", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    const r = holdStep(held, { type: "reset" }, 100, { hold: true });
    expect(r.effects).toEqual([{ type: "send", text: "我想让你。" }]);
    expect(r.state).toEqual(HOLD_IDLE);
  });
});

describe("abandon（会话在底下没了，#1289）", () => {
  it("扣着的那句**不发**，回 drop 带上丢掉的原文", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    const r = holdStep(held, { type: "abandon" }, 100, { hold: true });
    expect(r.effects).toEqual([{ type: "drop", text: "我想让你。" }]);
    expect(r.state).toEqual(HOLD_IDLE);
  });
  it("等着答案的那句一起丢，与 reset 同一个拼法", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800, waiting: { text: "帮我看一下", until: 300 } };
    const r = holdStep(held, { type: "abandon" }, 100, { hold: true });
    expect(r.effects).toEqual([{ type: "drop", text: "我想让你。帮我看一下" }]);
  });
  it("什么都没扣着 → 一个副作用都不回（没有「丢掉了空话」这回事）", () => {
    const r = holdStep(HOLD_IDLE, { type: "abandon" }, 100, { hold: true });
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(HOLD_IDLE);
  });
  it("一个 send 都不产生——这正是它与 reset 的全部分别", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    expect(run([[{ type: "abandon" }, 100]], true, held).sent).toEqual([]);
  });
});
