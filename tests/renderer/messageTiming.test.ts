import { describe, it, expect } from "vitest";
import { accumulateTurn, EMPTY_TURN_AGG, liveTimingStats, turnTimingStats, fmtDuration } from "../../src/renderer/src/aui/messageTiming.js";

const val = (stats: { label: string; value: string }[], label: string): string | undefined =>
  stats.find((s) => s.label === label)?.value;

describe("fmtDuration", () => {
  it("秒以内给毫秒原值", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  it("秒级给一位小数 —— 1s 和 1.9s 是两回事", () => {
    expect(fmtDuration(1200)).toBe("1.2s");
    expect(fmtDuration(59_900)).toBe("59.9s");
  });

  it("过一分钟改成 m s", () => {
    expect(fmtDuration(60_000)).toBe("1m0s");
    expect(fmtDuration(125_000)).toBe("2m5s");
  });
});

describe("liveTimingStats —— turn 跑着的时候那一行", () => {
  const live = (o: Partial<Parameters<typeof liveTimingStats>[0]> = {}) =>
    liveTimingStats({ elapsedMs: 5000, promptTokens: 6200, completionTokens: 150, ...o });

  it("耗时是真的", () => {
    expect(val(live(), "elapsed")).toBe("5.0s");
  });

  it("估出来的数不标 ~ —— 这一行只在跑着的时候出现，那本身就说明了它是估的", () => {
    expect(val(live(), "tokens")).toBe("↑6.2k ↓150");
    expect(val(live(), "tok/s")).toBe("30");
  });

  it("第一秒之内不报吞吐 —— 分母太小，开头那一下会报出个几百", () => {
    expect(val(live({ elapsedMs: 400, completionTokens: 20 }), "tok/s")).toBeUndefined();
    expect(val(live({ elapsedMs: 400 }), "elapsed")).toBe("400ms");
  });

  it("一个字都还没吐出来时不报吞吐 —— 0 除以时间是 0，写出来像卡住了", () => {
    expect(val(live({ completionTokens: 0 }), "tok/s")).toBeUndefined();
    expect(val(live({ completionTokens: 0 }), "tokens")).toBe("↑6.2k ↓0");
  });

  it("不报花费 —— 单价乘一个猜出来的 token 数，是个看着像结算金额的假数", () => {
    expect(val(live(), "cost")).toBeUndefined();
  });

  it("耗时永远在，token 那一格永远在 —— 这一行不会整条消失", () => {
    expect(live({ elapsedMs: 0, completionTokens: 0, promptTokens: 0 }).map((s) => s.label))
      .toEqual(["elapsed", "tokens"]);
  });
});

describe("turnTimingStats(按 turn 结算)", () => {
  it("几波调用的 token / 钱累加,吞吐按模型时间,耗时按墙上时间", () => {
    let agg = accumulateTurn(EMPTY_TURN_AGG, { model: "claude-sonnet-5", usage: { promptTokens: 1000, completionTokens: 100 } }, 1000);
    agg = accumulateTurn(agg, { model: "claude-sonnet-5", usage: { promptTokens: 2000, completionTokens: 200 } }, 2000);
    const stats = turnTimingStats({ ...agg, wallMs: 10_000 });
    expect(stats.find((s) => s.label === "elapsed")?.value).toBe("10.0s");
    expect(stats.find((s) => s.label === "tok/s")?.value).toBe("100");
    expect(stats.find((s) => s.label === "tokens")?.value).toBe("↑3.0k ↓300");
    expect(stats.some((s) => s.label === "cost")).toBe(true);
  });
  it("有一条算不出价钱,整段不出 cost", () => {
    let agg = accumulateTurn(EMPTY_TURN_AGG, { model: "claude-sonnet-5", usage: { promptTokens: 1, completionTokens: 1 } }, 10);
    agg = accumulateTurn(agg, { model: "no-such-model", usage: { promptTokens: 1, completionTokens: 1 } }, 10);
    expect(turnTimingStats({ ...agg, wallMs: 20 }).some((s) => s.label === "cost")).toBe(false);
  });

  // 订阅额度那条路（#1091）。判据是**这条消息自己的 route**，不是「此刻订没订阅」——
  // 页脚报的是已经发生的事，而订阅是此刻的状态
  it("hosted 那条路不出 cost —— 那个数是厂商按量价，不是订阅用户花的钱", () => {
    const agg = accumulateTurn(
      EMPTY_TURN_AGG,
      { model: "claude-sonnet-5", usage: { promptTokens: 1000, completionTokens: 100 }, route: "hosted" },
      1000
    );
    const stats = turnTimingStats({ ...agg, wallMs: 10_000 });
    expect(stats.some((s) => s.label === "cost")).toBe(false);
    // 别的三格一格不少 —— 撤的只是钱
    expect(stats.map((s) => s.label)).toEqual(["elapsed", "tok/s", "tokens"]);
  });

  it("route 缺席 = direct（旧日志 / 子会话）—— 照旧计价", () => {
    const agg = accumulateTurn(EMPTY_TURN_AGG, { model: "claude-sonnet-5", usage: { promptTokens: 1000, completionTokens: 100 } }, 1000);
    expect(turnTimingStats({ ...agg, wallMs: 10_000 }).some((s) => s.label === "cost")).toBe(true);
  });

  it("一个 turn 里混着两条路 —— 整段不出 cost，不报「只算 direct 那半」的残数", () => {
    // 同「有一条算不出价钱整段就算不出」那条规矩（ADR-0211）：报一个残缺的合计
    // 比不报更坏——它看着像这一轮的全部花销
    let agg = accumulateTurn(EMPTY_TURN_AGG, { model: "claude-sonnet-5", usage: { promptTokens: 1, completionTokens: 1 }, route: "direct" }, 10);
    agg = accumulateTurn(agg, { model: "claude-sonnet-5", usage: { promptTokens: 1, completionTokens: 1 }, route: "hosted" }, 10);
    expect(turnTimingStats({ ...agg, wallMs: 20 }).some((s) => s.label === "cost")).toBe(false);
  });
});
