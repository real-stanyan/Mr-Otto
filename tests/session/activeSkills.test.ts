import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { activeSkills, activeSkillsOf } from "../../src/session/activeSkills.js";
import { barrenEventIndexes } from "../../src/session/barrenTurns.js";
import { EventStore } from "../../src/session/store.js";
import { tempDir } from "../helpers/tempDir.js";
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

// ── activeSkillsOf：库里现算的那条稀疏路径（issue #482 欠账 ②） ──
//
// 它只捞 skill_invoked / skill_released 两类事件，barren 传空集。这组测试钉的
// 就是那条捷径的前提：全量路径算出来的 barren 与 skill 事件的交集恒为空。
// 哪天空跑规则扩到 skill_invoked，这里先红。
describe("activeSkillsOf（稀疏索引现算）", () => {
  function fixture() {
    const dir = tempDir("otter-active-skills-");
    const store = new EventStore(join(dir, "events.db"));
    return { dir, store };
  }

  /** 全量口径 —— 被等价性断言当作参照物 */
  const viaFullLoad = (store: EventStore, sid: string) => {
    const log = store.load(sid);
    return activeSkills(log, barrenEventIndexes(log));
  };

  it("与全量路径逐条等价：夹着空跑 turn、覆盖启用、停用", () => {
    const { store } = fixture();
    const sid = "s1";
    const at = (ts: number, e: Record<string, unknown>) =>
      store.append({ sessionId: sid, ts, ...e } as Parameters<EventStore["append"]>[0]);
    at(1, { type: "session_created", workspace: "/w" });
    at(2, { type: "user_message", content: "干活" });
    at(3, { type: "skill_invoked", name: "tdd", content: "旧版", source: "user" });
    at(4, { type: "assistant_message", content: "好" });
    at(5, { type: "turn_ended", outcome: "completed" });
    // 空跑 turn：user_message 之后直接 turn_ended(error)，中间一个产出都没有。
    // 它里面还夹着一条 skill_invoked——正是这条决定两条路径会不会分叉
    at(6, { type: "user_message", content: "重试" });
    at(7, { type: "skill_invoked", name: "ponytail", content: "扎马尾", source: "model" });
    at(8, { type: "turn_ended", outcome: "error" });
    at(9, { type: "user_message", content: "再来" });
    at(10, { type: "skill_invoked", name: "tdd", content: "新版", source: "model" });
    at(11, { type: "skill_released", name: "ponytail" });
    at(12, { type: "assistant_message", content: "行" });
    at(13, { type: "turn_ended", outcome: "completed" });

    const full = viaFullLoad(store, sid);
    // 参照物不是空的，否则这条断言什么也没证明
    expect([...full.keys()]).toEqual(["tdd"]);
    expect(full.get("tdd")).toEqual({ content: "新版", source: "model" });
    expect(activeSkillsOf(store, sid)).toEqual(full);
  });

  it("分支会话退回全量：父会话前缀里的 skill 照样在账上（ofType 看不见它）", () => {
    const { store } = fixture();
    store.append({ sessionId: "p", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "p", ts: 2, type: "user_message", content: "干活" });
    store.append({ sessionId: "p", ts: 3, type: "skill_invoked", name: "tdd", content: "父的" });
    store.append({ sessionId: "p", ts: 4, type: "assistant_message", content: "好", model: "m" });
    const boundary = store.append({ sessionId: "p", ts: 5, type: "turn_ended", outcome: "completed" });
    store.fork("p", boundary.seq, "c", 6);

    // 单会话裸查（ofType）在分支上是空的——这是退回全量的理由，钉住它
    expect(store.ofType("c", "skill_invoked")).toEqual([]);
    expect(activeSkillsOf(store, "c").get("tdd")?.content).toBe("父的");
    expect(activeSkillsOf(store, "c")).toEqual(viaFullLoad(store, "c"));
  });

  it("没有任何 skill 事件 = 空台账，不是崩溃", () => {
    const { store } = fixture();
    store.append({ sessionId: "s2", ts: 1, type: "session_created", workspace: "/w" });
    expect(activeSkillsOf(store, "s2").size).toBe(0);
  });
});
