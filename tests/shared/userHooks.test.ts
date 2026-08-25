import { describe, it, expect } from "vitest";
import {
  validateUserHooks,
  parsePreVerdict,
  parsePostVerdict,
  exit2Reason,
} from "../../src/shared/userHooks.js";

describe("validateUserHooks（issue #395）", () => {
  it("合法文件：钩子原样通过", () => {
    const v = validateUserHooks({
      hooks: [
        { name: "guard", phase: "pre", tools: ["bash"], command: "./check.sh" },
        { name: "note", phase: "post", tools: "*", command: "cat >> /tmp/log" },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.hooks.length).toBe(2);
    expect(v.hooks[0]?.name).toBe("guard");
  });

  it("缺 hooks 数组 / 元素形状坏：整份拒绝（fail-safe，不存在半份钩子）", () => {
    expect(validateUserHooks({}).error).toContain("hooks 数组");
    expect(validateUserHooks({ hooks: [{ name: "", phase: "pre", tools: "*", command: "x" }] }).error).toContain("name");
    expect(validateUserHooks({ hooks: [{ name: "a", phase: "both", tools: "*", command: "x" }] }).error).toContain("phase");
    expect(validateUserHooks({ hooks: [{ name: "a", phase: "pre", tools: [], command: "x" }] }).error).toContain("tools");
    expect(validateUserHooks({ hooks: [{ name: "a", phase: "pre", tools: "*", command: " " }] }).error).toContain("command");
    // 一条坏 = 全部不生效
    const mixed = validateUserHooks({
      hooks: [
        { name: "ok", phase: "pre", tools: "*", command: "x" },
        { name: "bad", phase: "pre", tools: 3, command: "x" },
      ],
    });
    expect(mixed.hooks).toEqual([]);
    expect(mixed.error).toBeTruthy();
  });
});

describe("裁决解析", () => {
  it("pre：认 block / reviseArgs，别的键不认", () => {
    expect(parsePreVerdict('{"block":"危险"}')).toEqual({ block: "危险" });
    expect(parsePreVerdict('{"reviseArgs":{"cmd":"ls"}}')).toEqual({ reviseArgs: { cmd: "ls" } });
    expect(parsePreVerdict('{"feedback":"x"}')).toBeNull(); // post 的键在 pre 无效
    expect(parsePreVerdict("")).toBeNull();
  });

  it("post：认 reject / feedback", () => {
    expect(parsePostVerdict('{"reject":"结果不合规"}')).toEqual({ reject: "结果不合规" });
    expect(parsePostVerdict('{"feedback":"注意行尾"}')).toEqual({ feedback: "注意行尾" });
    expect(parsePostVerdict('{"block":"x"}')).toBeNull();
  });

  it("非 JSON 输出 = 弃权：钩子顺手打的日志不误读成裁决", () => {
    expect(parsePreVerdict("checked 3 files, all good")).toBeNull();
    expect(parsePreVerdict("{broken json")).toBeNull();
    expect(parsePostVerdict("done")).toBeNull();
  });

  it("exit 2 理由：stderr 优先，退 stdout，再退默认文案", () => {
    expect(exit2Reason("out", "err")).toBe("err");
    expect(exit2Reason("out", "")).toBe("out");
    expect(exit2Reason("", " ")).toContain("未给理由");
  });
});
