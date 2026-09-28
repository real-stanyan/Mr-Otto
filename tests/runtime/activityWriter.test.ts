// activityWriter —— agent_activity 写库的合帧 + 心跳（#1282，spec §3.2）。时钟与定时器注入，不动 vi 的假定时器。
import { describe, expect, it } from "vitest";
import { createActivityWriter, type ActivityWrite } from "../../services/runtime/src/activityWriter.js";

function rig(o: { fail?: boolean } = {}) {
  let t = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const writes: ActivityWrite[][] = [];
  const w = createActivityWriter({
    write: async (rows) => {
      writes.push(rows);
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
  return { w, writes, advance };
}
const states = (rows: ActivityWrite[]) => rows.map((r) => `${r.agentId}:${r.state}`);

describe("createActivityWriter", () => {
  it("第一次就是非 idle：当场写（首沿）；第一次就是 idle：不写（没有那一行 = 闲着）", () => {
    const r = rig();
    r.w.set("ads", "idle");
    expect(r.writes).toEqual([]);
    r.w.set("ops", "queued");
    expect(r.writes.map(states)).toEqual([["ops:queued"]]);
    expect(r.writes[0]![0]).toMatchObject({ since: 1_000, beat: 1_000 });
  });
  it("窗口里的几次变化合成一次尾沿写，带每只最后的状态；同一个状态再 set 不写", () => {
    const r = rig();
    r.w.set("ops", "queued");
    r.w.set("ops", "composing");
    r.w.set("ops", "composing");
    r.w.set("ads", "queued");
    r.w.set("ops", "working");
    expect(r.writes).toHaveLength(1);
    r.advance(2_000);
    expect(r.writes.map(states)).toEqual([["ops:queued"], ["ops:working", "ads:queued"]]);
  });
  it("心跳：此刻在进行的几档每 beatMs 补写一次（同状态同 since、新 beat）；闲下来就停", () => {
    const r = rig();
    r.w.set("ops", "working");
    r.advance(61_000);
    expect(r.writes).toHaveLength(2);
    expect(r.writes[1]).toEqual([{ agentId: "ops", state: "working", since: 1_000, beat: 61_000 }]);
    r.w.set("ops", "idle");
    r.advance(201_000);
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:working"], ["ops:idle"]]);
  });
  it("出错 / 额度用完不心跳（说的是上一轮的结局，不过期）", () => {
    const r = rig();
    r.w.set("ops", "failed");
    r.advance(301_000);
    expect(r.writes.map(states)).toEqual([["ops:failed"]]);
  });
  it("close：不在 idle 的当场写成 idle；之后的 set 与到点的定时器一律不理", () => {
    const r = rig();
    r.w.set("ops", "working");
    r.w.set("ads", "failed"); // 窗口内，挂在尾沿
    r.w.close();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:idle", "ads:idle"]]);
    r.w.set("ops", "queued");
    r.advance(301_000);
    expect(r.writes).toHaveLength(2);
  });
  it("写失败不抛（这是日志的投影，下一次变化盖掉）", async () => {
    const r = rig({ fail: true });
    expect(() => r.w.set("ops", "working")).not.toThrow();
    await Promise.resolve();
    expect(r.writes).toHaveLength(1);
  });
});
