// lastWriter —— 名册「最后一句」写库的首尾两沿节流（#1356 A1，spec §7.1）。
// 时钟与定时器都注入：不用 vi 的假定时器，断言读得出「此刻写了几次」。

import { describe, expect, it } from "vitest";
import { createLastWriter } from "../../services/runtime/src/lastWriter.js";
import type { SessionLast } from "../../src/shared/sessionLast.js";

function harness(throttleMs = 3000) {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const written: string[] = [];
  const w = createLastWriter({
    write: async (l) => { written.push(l.excerpt); },
    throttleMs,
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(due), 1); due.fn(); }
  };
  const push = (excerpt: string) => w.push({ ts: t, excerpt, from: "human:u1" } satisfies SessionLast);
  return { push, advance, written, timers };
}

describe("createLastWriter", () => {
  it("首沿当场写：人刚说完的那句立刻顶上名册", () => {
    const h = harness();
    h.push("一");
    expect(h.written).toEqual(["一"]);
  });
  it("3 秒内的后几句只写最后一句，而且一定写到（尾沿）", () => {
    const h = harness();
    h.push("一");
    h.advance(500);
    h.push("二");
    h.push("三");
    expect(h.written).toEqual(["一"]);
    expect(h.timers).toHaveLength(1); // 只排一个定时器，不是每句一个
    h.advance(2500);
    expect(h.written).toEqual(["一", "三"]);
  });
  it("隔了够久的下一句又走首沿", () => {
    const h = harness();
    h.push("一");
    h.advance(4000);
    h.push("二");
    expect(h.written).toEqual(["一", "二"]);
  });
  it("尾沿写完之后的 3 秒里又来一句 → 再排一次尾沿（从上一次**写**算起，不从上一次 push 算起）", () => {
    const h = harness();
    h.push("一");          // t=0 写
    h.advance(1000);
    h.push("二");          // 排到 t=3000
    h.advance(2000);       // t=3000 写「二」
    h.advance(500);
    h.push("三");          // t=3500，距上次写 500ms → 排到 t=6000
    expect(h.written).toEqual(["一", "二"]);
    h.advance(2500);
    expect(h.written).toEqual(["一", "二", "三"]);
  });
  it("throttleMs = 0：每句都当场写（测试装配用）", () => {
    const h = harness(0);
    h.push("一");
    h.push("二");
    expect(h.written).toEqual(["一", "二"]);
  });
  it("write 抛了也不影响下一次（投影写失败只丢这一格，下一句盖掉）", () => {
    let calls = 0;
    const w = createLastWriter({
      write: async () => { calls += 1; throw new Error("fetch failed"); },
      throttleMs: 0,
    });
    w.push({ ts: 1, excerpt: "一", from: "human:u1" });
    w.push({ ts: 2, excerpt: "二", from: "human:u1" });
    expect(calls).toBe(2);
  });
});
