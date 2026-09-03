import { describe, it, expect } from "vitest";
import {
  detectToolLoop,
  roundFingerprint,
  loopNudgeText,
  DEFAULT_MIN_REPEATS,
  DEFAULT_MAX_PERIOD,
} from "../../src/shared/toolLoopGuard.js";

describe("roundFingerprint", () => {
  it("同一次调用，参数键序不同也算同一个指纹", () => {
    const a = roundFingerprint([{ name: "bash", args: { cmd: "ls", cwd: "/x" } }]);
    const b = roundFingerprint([{ name: "bash", args: { cwd: "/x", cmd: "ls" } }]);
    expect(a).toBe(b);
  });

  it("参数差一个字节就是两个指纹", () => {
    const a = roundFingerprint([{ name: "bash", args: { cmd: "ls" } }]);
    const b = roundFingerprint([{ name: "bash", args: { cmd: "ls " } }]);
    expect(a).not.toBe(b);
  });

  it("工具名不同、参数相同，不是同一个指纹", () => {
    const a = roundFingerprint([{ name: "read_file", args: { path: "a" } }]);
    const b = roundFingerprint([{ name: "write_file", args: { path: "a" } }]);
    expect(a).not.toBe(b);
  });

  it("一圈里多把刀，顺序变了就是另一个指纹（并行调用的顺序是模型的选择）", () => {
    const a = roundFingerprint([
      { name: "bash", args: { cmd: "a" } },
      { name: "bash", args: { cmd: "b" } },
    ]);
    const b = roundFingerprint([
      { name: "bash", args: { cmd: "b" } },
      { name: "bash", args: { cmd: "a" } },
    ]);
    expect(a).not.toBe(b);
  });

  it("循环引用不抛错（护栏自己把 turn 弄崩是最差的结局）", () => {
    const args: Record<string, unknown> = { cmd: "ls" };
    args.self = args;
    expect(() => roundFingerprint([{ name: "bash", args }])).not.toThrow();
  });
});

describe("detectToolLoop", () => {
  it("历史不够长就不喊", () => {
    expect(detectToolLoop(["a", "a"])).toBeNull();
  });

  it("同一条命令连着 3 遍 = 周期 1", () => {
    expect(detectToolLoop(["x", "a", "a", "a"])).toEqual({ period: 1, repeats: 3 });
  });

  it("取最小周期：[a,a,a,a] 是周期 1，不是周期 2", () => {
    expect(detectToolLoop(["a", "a", "a", "a"])?.period).toBe(1);
  });

  it("周期 2 转 3 圈", () => {
    expect(detectToolLoop(["a", "b", "a", "b", "a", "b"])).toEqual({ period: 2, repeats: 3 });
  });

  it("只看后缀：前面跑过什么都不影响此刻在不在打转", () => {
    const history = ["起手", "看了一眼", "又看了一眼", "a", "b", "a", "b", "a", "b"];
    expect(detectToolLoop(history)).toEqual({ period: 2, repeats: 3 });
  });

  it("最后一圈跳出了循环就不喊（判据是此刻，不是曾经）", () => {
    expect(detectToolLoop(["a", "b", "a", "b", "a", "b", "写文件"])).toBeNull();
  });

  it("真实形态：周期 14 的只读循环（轨迹 s-20260903012849-797611f1）", () => {
    // 观测到的那 14 条命令，逐字循环
    const cycle = [
      'grep -rn "streamdown-caret\\|caret" src/renderer/src/app.css',
      'grep -rn "streamdown" src/renderer/src/app.css',
      'grep -n "streamdown-caret" node_modules/streamdown/dist/styles.css',
      "ls node_modules/streamdown/dist/*.css",
      'find node_modules/streamdown -name "*.css"',
      'grep -n "caret\\|streamdown-caret" node_modules/streamdown/styles.css',
      'grep -n "caret\\|cursor" node_modules/streamdown/styles.css',
      'grep -n "code\\|pre" node_modules/streamdown/styles.css',
      "wc -l node_modules/streamdown/styles.css",
      "sed -n '525,545p' src/renderer/src/app.css",
      'grep -rn "animate\\|caret" node_modules/streamdown/dist/index.js',
      "ls node_modules/streamdown/dist/",
      'grep -n "caret" node_modules/streamdown/dist/index.js',
      'grep -n "caret" node_modules/streamdown/dist/chunk-BO2N2NFS.js',
    ];
    expect(cycle).toHaveLength(14);

    // 转两圈还不喊 —— 两次是巧合，三次是模式
    expect(detectToolLoop([...cycle, ...cycle])).toBeNull();
    // 第三圈跑完才喊
    expect(detectToolLoop([...cycle, ...cycle, ...cycle])).toEqual({ period: 14, repeats: 3 });
    // 真实轨迹跑了 14 遍，repeats 如实回传
    const fourteen = Array.from({ length: 14 }, () => cycle).flat();
    expect(detectToolLoop(fourteen)).toEqual({ period: 14, repeats: 14 });
  });

  it("「连续相同」抓不到的正是这个形态：相邻两圈从来不相等", () => {
    const cycle = ["a", "b", "c"];
    const history = [...cycle, ...cycle, ...cycle];
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).not.toBe(history[i - 1]);
    }
    expect(detectToolLoop(history)).not.toBeNull();
  });

  it("周期超过上限就不认（已知天花板，不是漏做）", () => {
    const long = Array.from({ length: DEFAULT_MAX_PERIOD + 1 }, (_, i) => `c${i}`);
    expect(detectToolLoop([...long, ...long, ...long])).toBeNull();
  });

  it("minRepeats 可调，但 < 2 一律不喊（「重复 1 遍」等于什么都没重复）", () => {
    expect(detectToolLoop(["a"], { minRepeats: 1 })).toBeNull();
    expect(detectToolLoop(["a", "a"], { minRepeats: 2 })).toEqual({ period: 1, repeats: 2 });
  });

  it("默认门槛是 3 遍", () => {
    expect(DEFAULT_MIN_REPEATS).toBe(3);
    expect(detectToolLoop(["a", "b", "a", "b"])).toBeNull();
  });

  it("正常的长任务不会被误判：每圈都在动不同的东西", () => {
    const history = Array.from({ length: 200 }, (_, i) => `read ${i}`);
    expect(detectToolLoop(history)).toBeNull();
  });
});

describe("loopNudgeText", () => {
  it("周期 1 和周期 N 的说法不同（用户/模型读到的是自己的实际形态）", () => {
    expect(loopNudgeText({ period: 1, repeats: 3 })).toContain("同一次工具调用原样重复了 3 遍");
    expect(loopNudgeText({ period: 14, repeats: 3 })).toContain(
      "同一组 14 次工具调用原样重复了 3 遍",
    );
  });

  it("说的是「换做法」，不是「停下」——硬停仍然只有停止键", () => {
    const text = loopNudgeText({ period: 14, repeats: 3 });
    expect(text).toContain("换一种做法");
    expect(text).not.toContain("已中断");
  });
});
