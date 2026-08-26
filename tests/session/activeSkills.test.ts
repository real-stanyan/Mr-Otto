import { describe, expect, it } from "vitest";
import { activeSkills } from "../../src/session/activeSkills.js";
import type { SessionEvent } from "../../src/session/events.js";

const skill = (seq: number, name: string, content: string, args?: string): SessionEvent => ({
  seq,
  sessionId: "s",
  ts: seq,
  type: "skill_invoked",
  name,
  content,
  ...(args !== undefined ? { args } : {}),
});

const user = (seq: number, content: string): SessionEvent => ({
  seq, sessionId: "s", ts: seq, type: "user_message", content,
});

const released = (seq: number, name: string): SessionEvent => ({
  seq, sessionId: "s", ts: seq, type: "skill_released", name,
});

const modelSkill = (seq: number, name: string, content: string): SessionEvent => ({
  seq, sessionId: "s", ts: seq, type: "skill_invoked", name, content, source: "model",
});

describe("activeSkills（已启用 skill 的台账，ADR-0066/0068 共用）", () => {
  it("按名去重，后启用的快照覆盖并排到台账尾部", () => {
    const events = [
      skill(0, "tdd", "旧版"),
      user(1, "活一"),
      skill(2, "ponytail", "越少越好", "ultra"),
      user(3, "活二"),
      skill(4, "tdd", "新版"),
      user(5, "活三"),
    ];
    const out = activeSkills(events, new Set());
    expect([...out.keys()]).toEqual(["ponytail", "tdd"]); // tdd 重启用后排到尾部
    expect(out.get("tdd")).toEqual({ content: "新版" });
    expect(out.get("ponytail")).toEqual({ content: "越少越好", args: "ultra" });
  });

  it("before 截到区间：只算此前启用的", () => {
    const events = [skill(0, "a", "甲"), user(1, "活"), skill(2, "b", "乙")];
    expect([...activeSkills(events, new Set(), 2).keys()]).toEqual(["a"]);
  });

  it("barren 集合里的下标跳过（防御位：今天 barrenEventIndexes 不收 skill_invoked）", () => {
    const events = [skill(0, "a", "甲"), skill(1, "b", "乙")];
    expect([...activeSkills(events, new Set([0])).keys()]).toEqual(["b"]);
  });

  it("无 args 的条目没有 args 键（不是 undefined 值——快照要能原样 spread 进新事件）", () => {
    const out = activeSkills([skill(0, "a", "甲")], new Set());
    expect("args" in out.get("a")!).toBe(false);
  });
});

describe("停用（skill_released，本次新增）", () => {
  it("停用后不在台账里", () => {
    const events = [skill(0, "tdd", "旧版"), user(1, "活"), released(2, "tdd")];
    expect([...activeSkills(events, new Set()).keys()]).toEqual([]);
  });

  it("停了又启用 = 生效，且排到台账尾部", () => {
    const events = [
      skill(0, "a", "甲"), skill(1, "b", "乙"), released(2, "a"), skill(3, "a", "甲新"),
    ];
    const out = activeSkills(events, new Set());
    expect([...out.keys()]).toEqual(["b", "a"]);
    expect(out.get("a")).toEqual({ content: "甲新" });
  });

  it("停用不存在的 skill 是空操作，不抛", () => {
    const events = [skill(0, "a", "甲"), released(1, "b")];
    expect([...activeSkills(events, new Set()).keys()]).toEqual(["a"]);
  });

  it("barren 里的停用不算数（防御位，与启用同一条规矩）", () => {
    const events = [skill(0, "a", "甲"), released(1, "a")];
    expect([...activeSkills(events, new Set([1])).keys()]).toEqual(["a"]);
  });

  it("source 进台账：模型取的记 model，用户 $ 启用的不带这个键", () => {
    const out = activeSkills([modelSkill(0, "a", "甲"), skill(1, "b", "乙")], new Set());
    expect(out.get("a")).toEqual({ content: "甲", source: "model" });
    expect(out.get("b")).toEqual({ content: "乙" });
  });
});
