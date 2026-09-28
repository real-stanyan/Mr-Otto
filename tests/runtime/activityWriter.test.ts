// activityWriter —— agent_activity 写库的合帧 + 心跳（#1282，spec §3.2）。时钟与定时器注入，不动 vi 的假定时器。
// 写一次一个、排在上一次后面（起跑落在微任务里），所以断言写之前先 flush 一拍。
import { describe, expect, it } from "vitest";
import { createActivityWriter, type ActivityWrite } from "../../services/runtime/src/activityWriter.js";

/** hold：每次写都挂着，由用例手动落定（resolve / reject）——看得见上一次还在飞时下一次有没有起跑 */
function rig(o: { fail?: boolean; hold?: boolean } = {}) {
  let t = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const writes: ActivityWrite[][] = [];
  const held: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const w = createActivityWriter({
    write: async (rows) => {
      writes.push(rows);
      if (o.hold) await new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
      if (o.fail) throw new Error("boom");
    },
    throttleMs: 1_000,
    beatMs: 60_000,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn });
    },
  });
  /** 时钟走到 to，途中到点的定时器按时刻先后执行 */
  const advance = (to: number): void => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > to) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = to;
  };
  return { w, writes, held, advance };
}
const states = (rows: ActivityWrite[]) => rows.map((r) => `${r.agentId}:${r.state}`);
/** 让排着的写都跑到头：跨一个宏任务，途中的微任务全部清空 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createActivityWriter", () => {
  it("第一次就是非 idle：当场写（首沿）；第一次就是 idle：不写（没有那一行 = 闲着）", async () => {
    const r = rig();
    r.w.set("ads", "idle");
    await flush();
    expect(r.writes).toEqual([]);
    r.w.set("ops", "queued");
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:queued"]]);
    expect(r.writes[0]![0]).toMatchObject({ since: 1_000, beat: 1_000 });
  });
  it("窗口里的几次变化合成一次尾沿写，带每只最后的状态；同一个状态再 set 不写", async () => {
    const r = rig();
    r.w.set("ops", "queued");
    r.w.set("ops", "composing");
    r.w.set("ops", "composing");
    r.w.set("ads", "queued");
    r.w.set("ops", "working");
    await flush();
    expect(r.writes).toHaveLength(1);
    r.advance(2_000);
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:queued"], ["ops:working", "ads:queued"]]);
  });
  it("心跳：此刻在进行的几档每 beatMs 补写一次（同状态同 since、新 beat）；闲下来就停", async () => {
    const r = rig();
    r.w.set("ops", "working");
    r.advance(61_000);
    await flush();
    expect(r.writes).toHaveLength(2);
    expect(r.writes[1]).toEqual([{ agentId: "ops", state: "working", since: 1_000, beat: 61_000 }]);
    r.w.set("ops", "idle");
    r.advance(201_000);
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:working"], ["ops:idle"]]);
  });
  it("出错 / 额度用完不心跳（说的是上一轮的结局，不过期）", async () => {
    const r = rig();
    r.w.set("ops", "failed");
    r.advance(301_000);
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:failed"]]);
  });
  it("close：不在 idle 的当场写成 idle；之后的 set 与到点的定时器一律不理", async () => {
    const r = rig();
    r.w.set("ops", "working");
    r.w.set("ads", "failed"); // 窗口内，挂在尾沿
    r.w.close();
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:idle", "ads:idle"]]);
    r.w.set("ops", "queued");
    r.advance(301_000);
    await flush();
    expect(r.writes).toHaveLength(2);
  });
  it("写失败不抛（这是日志的投影，下一次变化盖掉）", async () => {
    const r = rig({ fail: true });
    expect(() => r.w.set("ops", "working")).not.toThrow();
    await flush();
    expect(r.writes).toHaveLength(1);
  });
  it("写一次一个：心跳还在飞时紧跟着来的变化，等它落定才发（两次 upsert 同时在飞可能倒着提交，表里留下旧状态配新 beat）", async () => {
    const r = rig({ hold: true });
    r.w.set("ops", "working"); // 首沿
    await flush();
    r.held[0]!.resolve();
    r.advance(61_000); // 心跳：还在飞
    r.w.set("ops", "idle"); // 心跳不推进节流窗口，这次变化当场就要写
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:working"]]);
    r.held[1]!.resolve();
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:working"], ["ops:idle"]]);
  });
  it("上一次写失败不拦后面的：首沿还在飞时收摊，首沿失败之后 idle 照样发出去", async () => {
    const r = rig({ hold: true });
    r.w.set("ops", "working"); // 首沿
    r.w.close(); // idle 排在首沿后面
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"]]);
    r.held[0]!.reject(new Error("boom"));
    await flush();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:idle"]]);
  });
});
