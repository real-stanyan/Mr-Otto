// 后台任务面板的投影（issue #452 / ADR-0109）。
// 这一层是纯函数：事件流 + 「谁还真的活着」的集合 → 面板要画的行。
// 硬规则「任何投影必须可从日志推导」的可执行版就在这里——面板读的是日志，
// 不是主进程另开的一路推送。

import { describe, it, expect } from "vitest";
import {
  projectBackgroundRuns,
  formatElapsed,
} from "../../src/shared/backgroundRuns.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const reset = () => {
  seq = 0;
};

function started(taskId: string, cmd: string, ts: number): SessionEvent {
  return { seq: seq++, sessionId: "s", ts, type: "background_task_started", ignorable: true, taskId, cmd };
}
function completed(taskId: string, exitCode: number, ts: number, cmd = "x"): SessionEvent {
  return { seq: seq++, sessionId: "s", ts, type: "background_task_completed", ignorable: true, taskId, cmd, exitCode };
}
function delivered(taskIds: string[], ts: number): SessionEvent {
  return {
    seq: seq++,
    sessionId: "s",
    ts,
    type: "user_message",
    content: "[后台任务 bg-1 完成] …",
    origin: "background",
    backgroundTaskIds: taskIds,
  };
}
function humanSaid(text: string, ts: number): SessionEvent {
  return { seq: seq++, sessionId: "s", ts, type: "user_message", content: text };
}

describe("projectBackgroundRuns", () => {
  it("起了还没完 + 进程确实活着 = running", () => {
    reset();
    const runs = projectBackgroundRuns([started("bg-1", "npm run build", 1000)], new Set(["bg-1"]));
    expect(runs).toEqual([
      { id: "bg-1", cmd: "npm run build", state: "running", startedAt: 1000 },
    ]);
  });

  it("exit 0 = ready，非 0 = failed，退出码带出来", () => {
    reset();
    const runs = projectBackgroundRuns(
      [
        started("bg-1", "a", 1000),
        started("bg-2", "b", 1001),
        completed("bg-1", 0, 2000),
        completed("bg-2", 127, 2001),
      ],
      new Set()
    );
    expect(runs.map((r) => [r.id, r.state, r.exitCode])).toEqual([
      ["bg-1", "ready", 0],
      ["bg-2", "failed", 127],
    ]);
  });

  it("完成 ≠ 已注回：ready 要一直显示到结果真的进了对话", () => {
    reset();
    // turn 在跑时完成的任务攒进 pendingBg，收口后才注回——这中间就是 ready
    const evs = [started("bg-1", "a", 1000), completed("bg-1", 0, 2000)];
    expect(projectBackgroundRuns(evs, new Set())[0]!.state).toBe("ready");
    // 注回那条 user_message 驮着 id，这一行才摘掉
    expect(projectBackgroundRuns([...evs, delivered(["bg-1"], 3000)], new Set())).toEqual([]);
  });

  it("一条回注驮多个任务：攒着的那几个一起摘掉", () => {
    reset();
    const runs = projectBackgroundRuns(
      [
        started("bg-1", "a", 1000),
        started("bg-2", "b", 1001),
        started("bg-3", "c", 1002),
        completed("bg-1", 0, 2000),
        completed("bg-2", 0, 2001),
        delivered(["bg-1", "bg-2"], 3000),
      ],
      new Set(["bg-3"])
    );
    expect(runs.map((r) => r.id)).toEqual(["bg-3"]);
  });

  it("人亲手打的字不摘任何行——只有 backgroundTaskIds 算数，不看正文", () => {
    reset();
    // 正文长得和回注一模一样也不算：ADR-0103 否掉了「靠前缀反解」那条路
    const runs = projectBackgroundRuns(
      [started("bg-1", "a", 1000), completed("bg-1", 0, 2000), humanSaid("[后台任务 bg-1 完成] 我自己打的", 3000)],
      new Set()
    );
    expect(runs.map((r) => r.id)).toEqual(["bg-1"]);
  });

  it("上次 app 留下的孤儿（started 没 completed 且不在 live 里）不显示", () => {
    reset();
    // 进程随上次 app 一起没了，画成「还在跑」是撒谎
    expect(projectBackgroundRuns([started("bg-1", "a", 1000)], new Set())).toEqual([]);
  });

  it("孤儿只影响 running：跑完了的不需要 live 背书", () => {
    reset();
    const runs = projectBackgroundRuns(
      [started("bg-1", "a", 1000), completed("bg-1", 0, 2000)],
      new Set()
    );
    expect(runs.map((r) => r.state)).toEqual(["ready"]);
  });

  it("taskId 跨 app 重启会重号，后来的那次覆盖先前的", () => {
    reset();
    // bg-N 的计数器随 agent 装配重建（backgroundTasks.ts 的 this.n），
    // 同一个会话重开后又会从 bg-1 开始——重放整份日志时两条 bg-1 会撞上
    const runs = projectBackgroundRuns(
      [
        started("bg-1", "上次那条，已经死了", 1000),
        started("bg-1", "这次这条", 5000),
      ],
      new Set(["bg-1"])
    );
    expect(runs).toEqual([
      { id: "bg-1", cmd: "这次这条", state: "running", startedAt: 5000 },
    ]);
  });

  it("只有 completed 没有 started 的旧日志不产生幽灵行", () => {
    reset();
    // ADR-0109 之前的日志里没有 started 事件，那些任务早就结束了
    expect(projectBackgroundRuns([completed("bg-1", 0, 2000)], new Set())).toEqual([]);
  });

  it("按起始时间排，读起来和时间线同向", () => {
    reset();
    const runs = projectBackgroundRuns(
      [started("bg-2", "b", 5000), started("bg-1", "a", 1000)],
      new Set(["bg-1", "bg-2"])
    );
    expect(runs.map((r) => r.id)).toEqual(["bg-1", "bg-2"]);
  });
});

describe("formatElapsed", () => {
  it("不满一分钟按秒", () => {
    expect(formatElapsed(0, 4_000)).toBe("4 秒");
    expect(formatElapsed(0, 59_000)).toBe("59 秒");
  });

  it("超过一分钟按 分:秒", () => {
    expect(formatElapsed(0, 60_000)).toBe("1:00");
    expect(formatElapsed(0, 134_000)).toBe("2:14");
    expect(formatElapsed(0, 3_599_000)).toBe("59:59");
  });

  it("超过一小时带上小时", () => {
    expect(formatElapsed(0, 3_600_000)).toBe("1:00:00");
    expect(formatElapsed(0, 3_725_000)).toBe("1:02:05");
  });

  it("时钟往回跳按 0 秒，不显示负数", () => {
    // 机器时钟偏一点是常事，「-3 秒」只会让人以为是 bug（同 formatRelativeTime 的立场）
    expect(formatElapsed(5_000, 1_000)).toBe("0 秒");
  });
});
