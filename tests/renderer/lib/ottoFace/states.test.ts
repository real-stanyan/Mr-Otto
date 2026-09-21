// 状态表的三条设计约束——它们不是配色细节，错了不会崩、只会安静地说错话。

import { describe, expect, it } from "vitest";
import { FACE_STATES, FACE_STATE_LIST, isFaceState, type FaceState } from "@/lib/ottoFace/states.js";

describe("ottoFace 状态表", () => {
  it("清单与表一一对应，没有只存在于其中一边的状态", () => {
    expect([...FACE_STATE_LIST].sort()).toEqual(Object.keys(FACE_STATES).sort());
    expect(new Set(FACE_STATE_LIST).size).toBe(FACE_STATE_LIST.length);
  });

  it("每一格都写了它对应仓里哪个枚举", () => {
    // origin 是给读代码的人的：没有它，半年后没人知道 weaving 是从哪来的
    for (const s of FACE_STATE_LIST) expect(FACE_STATES[s].origin.length).toBeGreaterThan(4);
  });

  it("waiting 是唯一做水平摆动的", () => {
    // sessionOrb.ts 的法理：「等你」必须压过「在跑」，否则人会以为不用管它、
    // 而它其实一步都走不了。一墙静止头像里横向运动是最强的钩子——多一格用了它，
    // 这个信号就被稀释掉
    const urgent = FACE_STATE_LIST.filter((s) => FACE_STATES[s].sway === "urgent");
    expect(urgent).toEqual(["waiting"]);
  });

  it("queued 完全不动：不呼吸也不眨眼", () => {
    // ADR-0250：queued 连打字指示器都不画（「它一个 token 都还没跑，画上去就是
    // 撒谎的勾」）。头像会呼吸会眨眼就是换个地方撒同一个谎
    const q = FACE_STATES.queued;
    expect(q.bobAmp).toBe(0);
    expect(q.blinks).toBe(false);
    // 而 running 那一侧必须是动的，否则两格看起来一样，这条约束就白立了
    expect(FACE_STATES.thinking.bobAmp).toBeGreaterThan(0);
  });

  it("frozen 是唯一降饱和的", () => {
    // frozen 是持久记号、不会自动重试，得看起来「这个不会自己好」
    const dim = FACE_STATE_LIST.filter((s) => FACE_STATES[s].desaturate === true);
    expect(dim).toEqual(["frozen"]);
  });

  it("除空闲外都有角标：40px 下光靠眼形分不出状态", () => {
    for (const s of FACE_STATE_LIST) {
      if (s === "idle") continue;
      expect(FACE_STATES[s].badge, `${s} 缺角标`).toBeDefined();
      expect(FACE_STATES[s].accent, `${s} 缺强调色`).toBeDefined();
    }
  });

  it("fixed 视线的状态必须给 fixedLook，否则它其实是 still", () => {
    for (const s of FACE_STATE_LIST) {
      if (FACE_STATES[s].look === "fixed") expect(FACE_STATES[s].fixedLook, s).toBeDefined();
    }
  });

  it("isFaceState 认得出表里的，也挡得住表外的", () => {
    expect(isFaceState("waiting")).toBe(true);
    expect(isFaceState("running")).toBe(false);
    expect(isFaceState("")).toBe(false);
    // 原型链上的属性不算
    expect(isFaceState("toString")).toBe(false);
  });

  it("状态名不与仓里已有枚举的取值撞名歧义", () => {
    // turnLedger 的 "running" / sessionOrb 的 "waiting" 都是别处的词。
    // "waiting" 有意同名（就是同一件事），"running" 有意不用（它在这里分成五格）
    const names = new Set<string>(FACE_STATE_LIST as readonly string[]);
    expect(names.has("running")).toBe(false);
    expect(names.has("waiting")).toBe(true);
  });
});

it("状态清单覆盖 adapter 可能产出的每一格", () => {
  const produced: FaceState[] = [
    "frozen", "failed", "ratelimit", "done", "speaking", "listening",
    "thinking", "queued", "searching", "working", "answering", "weaving",
    "waiting", "idle", "sleep",
  ];
  for (const s of produced) expect(FACE_STATES[s], s).toBeDefined();
});
