import { describe, it, expect } from "vitest";
import { timingStats, fmtDuration } from "../../src/renderer/src/aui/messageTiming.js";

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

describe("timingStats", () => {
  it("没有 usage、也没有耗时:一格都不出(而不是出一排 0)", () => {
    expect(timingStats({ model: "m" }, undefined)).toEqual([]);
  });

  it("只有耗时:就出耗时那一格", () => {
    expect(timingStats({ model: "m" }, 1500)).toEqual([{ label: "elapsed", value: "1.5s" }]);
  });

  it("有 usage 就出 token 一格,上下箭头分别是入和出", () => {
    const stats = timingStats(
      { model: "m", usage: { promptTokens: 12_300, completionTokens: 482 } },
      undefined
    );
    expect(val(stats, "tokens")).toBe("↑12.3k ↓482");
  });

  it("吞吐 = 输出 token ÷ 耗时", () => {
    const stats = timingStats(
      { model: "m", usage: { promptTokens: 100, completionTokens: 500 } },
      2000
    );
    expect(val(stats, "tok/s")).toBe("250");
  });

  it("耗时为 0(同一毫秒落盘)不出吞吐 —— 不许出 Infinity", () => {
    const stats = timingStats(
      { model: "m", usage: { promptTokens: 100, completionTokens: 500 } },
      0
    );
    expect(val(stats, "tok/s")).toBeUndefined();
    expect(val(stats, "tokens")).toBeDefined();
  });

  it("纯工具调用(输出 0 token)不出吞吐 —— 0 tok/s 读起来像卡住了", () => {
    const stats = timingStats(
      { model: "m", usage: { promptTokens: 100, completionTokens: 0 } },
      1000
    );
    expect(val(stats, "tok/s")).toBeUndefined();
  });

  it("价目表里没有的型号不出 cost —— 不知道价钱不等于免费", () => {
    const stats = timingStats(
      { model: "某个没查过价的型号", usage: { promptTokens: 1000, completionTokens: 1000 } },
      1000
    );
    expect(val(stats, "cost")).toBeUndefined();
  });

  it("免费档出 $0 —— 那是事实,不是缺数据", () => {
    const stats = timingStats(
      { model: "glm-4.5-flash", usage: { promptTokens: 9000, completionTokens: 900 } },
      1000
    );
    expect(val(stats, "cost")).toBe("$0");
  });

  it("本机 Ollama 整族按 0 算", () => {
    const stats = timingStats(
      { model: "ollama/cogito:8b", usage: { promptTokens: 500, completionTokens: 500 } },
      1000
    );
    expect(val(stats, "cost")).toBe("$0");
  });

  it("负耗时(时钟回拨)不出耗时那一格", () => {
    expect(timingStats({ model: "m" }, -5)).toEqual([]);
  });
});
