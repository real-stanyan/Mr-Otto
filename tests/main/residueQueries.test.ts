// 残留清单那四个查询的可执行版（#780 I3-I5）。
//
// 在此之前它们是 `src/main/index.ts` 里的装配根闭包，唯一的覆盖是
// `residueWiring.test.ts` 那条读源码的断言——而这一族**坏掉的样子全是无声的**：
// 少扫几个会话 = 清单里少几条，和「本来就没有」长得一样；没有 baseline 却兜底成
// 空快照 = 整机的端口全被算成本会话的残留，进了一个默认勾选、一按就清的清单。
// 所以这里钉的不是「调了哪个函数」，是每一种无声失败对应的那个返回值。

import { describe, expect, it } from "vitest";
import { createResidueQueries, type ResidueQueriesDeps } from "../../src/main/residueQueries.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ResidueItem, ResidueSnapshot } from "../../src/shared/residue.js";

function item(over: Partial<ResidueItem> & Pick<ResidueItem, "detector" | "id">): ResidueItem {
  return {
    label: `label-${over.id}`,
    confidence: "owned",
    cleanupHint: "hint",
    ...over,
  } as ResidueItem;
}

function ev(sessionId: string, seq: number, e: Record<string, unknown>): SessionEvent {
  return { sessionId, seq, ts: seq, ignorable: true, ...e } as unknown as SessionEvent;
}

const EMPTY: ResidueSnapshot = { ts: 0, simulators: [], ports: [] };

interface Harness {
  deps: ResidueQueriesDeps;
  /** sessionIdsWithEvent 被问过哪些类型——M4 那条判据要它 */
  asked: string[];
  probed: Array<[number, string]>;
}

function harness(opts: {
  logs?: Record<string, SessionEvent[]>;
  baselines?: Record<string, ResidueSnapshot>;
  /** 会话 → 它那份 residue 能力现拍出来的快照；缺席 = 这个会话没有这层能力 */
  snapshots?: Record<string, ResidueSnapshot>;
  escaped?: Array<{ pgid: number; cmd: string }>;
  alive?: (pgid: number, label: string) => boolean;
}): Harness {
  const logs = opts.logs ?? {};
  const asked: string[] = [];
  const probed: Array<[number, string]> = [];
  const deps: ResidueQueriesDeps = {
    store: {
      sessionIdsWithEvent: (type) => {
        asked.push(type);
        return Object.keys(logs)
          .filter((sid) => (logs[sid] ?? []).some((e) => e.type === type))
          .sort();
      },
      eventsOfType: (sid, type) => (logs[sid] ?? []).filter((e) => e.type === type),
      lastOfType: (sid, type) => {
        if (type !== "residue_baseline") return null;
        const snap = opts.baselines?.[sid];
        return snap ? ev(sid, 0, { type: "residue_baseline", snapshot: snap }) : null;
      },
    },
    groupStillIs: (pgid, label) => {
      probed.push([pgid, label]);
      return (opts.alive ?? (() => true))(pgid, label);
    },
    residueCapOf: (sid) => {
      const snap = opts.snapshots?.[sid];
      return snap ? { snapshot: async () => snap } : undefined;
    },
    escapedGroups: () => opts.escaped ?? [],
  };
  return { deps, asked, probed };
}

describe("pendingResidueNow —— app 级重放（#780 M4）", () => {
  it("遍历口是「落过 residue_detected 的会话」，归档与否一概不问", async () => {
    const h = harness({
      logs: {
        // 这一条在真 store 里是**系统**归档的：`sessions()` 整个不返回它，
        // 按那个口遍历的话下面这条残留永远重放不出来，而清单里只是少一行
        sysArchived: [ev("sysArchived", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:9999" })] })],
        live: [ev("live", 1, { type: "residue_detected", items: [item({ detector: "simulators", id: "SIM-1" })] })],
      },
    });
    const q = createResidueQueries(h.deps);
    expect(q.pendingResidueNow().map((i) => i.id).sort()).toEqual(["SIM-1", "port:9999"]);
    expect(h.asked).toEqual(["residue_detected"]);
  });

  it("detected 与 cleaned 按 seq 归并回时间序——先清后检出的那条必须留着", () => {
    const target = item({ detector: "process_groups", id: "9001" });
    const h = harness({
      logs: {
        s1: [
          // 注意落盘顺序：cleaned(seq 2) 在 detected(seq 3) **之前**。
          // 两类事件各取一串、不排序地先喂完 detected 再喂 cleaned 的话，
          // 这条刚刚重新检出的残留会被一条更早的清理记录抹掉
          ev("s1", 1, { type: "residue_detected", items: [target] }),
          ev("s1", 2, { type: "residue_cleaned", item: target, result: { id: "9001", ok: true, kind: "cleaned" } }),
          ev("s1", 3, { type: "residue_detected", items: [target] }),
        ],
      },
    });
    expect(createResidueQueries(h.deps).pendingResidueNow().map((i) => i.id)).toEqual(["9001"]);
  });

  it("进程组要过身份核对，端口/模拟器一律不探活", () => {
    const h = harness({
      logs: {
        s1: [
          ev("s1", 1, {
            type: "residue_detected",
            items: [
              item({ detector: "process_groups", id: "4242", label: "python3 -m http.server" }),
              item({ detector: "process_groups", id: "4343", label: "早就不在了" }),
              item({ detector: "ports", id: "port:3000" }),
              item({ detector: "simulators", id: "SIM-9" }),
            ],
          }),
        ],
      },
      alive: (pgid) => pgid === 4242,
    });
    const q = createResidueQueries(h.deps);
    expect(q.pendingResidueNow().map((i) => i.id).sort()).toEqual(["4242", "SIM-9", "port:3000"]);
    // 探活只问了两条进程组（端口/模拟器现拍一次要 lsof/simctl，而 bootInfo 是同步的）
    expect(h.probed.map(([pgid]) => pgid).sort()).toEqual([4242, 4343]);
  });
});

describe("currentResidueDiff —— 没有 baseline 就不做（#780 I5）", () => {
  const machine: ResidueSnapshot = {
    ts: 1,
    // 整机现场：一个跟这个会话毫无关系的数据库 + 一台早就开着的模拟器
    simulators: [{ udid: "SIM-OLD", name: "iPhone", runtime: "iOS-26-0" }],
    ports: [{ port: 5432, pid: 11, command: "postgres" }],
  };

  it("日志里没有基线时回空——**不**兜底成空快照把整机算成残留", async () => {
    const h = harness({ snapshots: { s1: machine } }); // baselines 里没有 s1
    expect(await createResidueQueries(h.deps).currentResidueDiff("s1")).toEqual([]);
  });

  it("有基线时才算差集，基线里已有的那些不算残留", async () => {
    const h = harness({
      baselines: { s1: machine },
      snapshots: {
        s1: {
          ts: 2,
          simulators: machine.simulators,
          ports: [...machine.ports, { port: 9999, pid: 77, command: "python3" }],
        },
      },
    });
    const items = await createResidueQueries(h.deps).currentResidueDiff("s1");
    expect(items.map((i) => i.id)).toEqual(["port:9999"]);
  });

  it("这个会话没有残留能力时回空，一次快照都不拍", async () => {
    const h = harness({ baselines: { s1: machine } }); // snapshots 里没有 s1
    expect(await createResidueQueries(h.deps).currentResidueDiff("s1")).toEqual([]);
  });
});

describe("residueListNow —— 这一个会话此刻的清单", () => {
  it("没有残留能力 = 空数组，哪怕日志里重放得出条目", async () => {
    const h = harness({
      logs: { s1: [ev("s1", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:1" })] })] },
      baselines: { s1: EMPTY },
    });
    expect(await createResidueQueries(h.deps).residueListNow("s1")).toEqual([]);
  });

  it("只重放**这一个**会话的日志，别人的条目不进来", async () => {
    const h = harness({
      logs: {
        s1: [ev("s1", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:1" })] })],
        s2: [ev("s2", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:2" })] })],
      },
      baselines: { s1: EMPTY },
      snapshots: { s1: EMPTY },
    });
    expect((await createResidueQueries(h.deps).residueListNow("s1")).map((i) => i.id)).toEqual(["port:1"]);
  });

  it("同一个 detector:id 两边都有时，现查那份覆盖重放那份", async () => {
    const h = harness({
      logs: {
        s1: [
          ev("s1", 1, {
            type: "residue_detected",
            // 落盘那一刻的旧快照：当时判成 suspected
            items: [item({ detector: "ports", id: "port:9999", confidence: "suspected", label: "旧标签" })],
          }),
        ],
      },
      baselines: { s1: EMPTY },
      snapshots: { s1: { ts: 2, simulators: [], ports: [{ port: 9999, pid: 5, command: "python3", pgid: 77 }] } },
      escaped: [{ pgid: 77, cmd: "python3 -m http.server 9999" }],
    });
    const items = await createResidueQueries(h.deps).residueListNow("s1");
    const port = items.find((i) => i.id === "port:9999");
    expect(port?.confidence).toBe("owned"); // 现查赢
    expect(port?.label).not.toBe("旧标签");
  });
});

describe("residueCleanPool —— 匹配池是 app 级的（#780 I3）", () => {
  it("别的会话（含归档的）落下的条目也在池子里", async () => {
    const h = harness({
      logs: {
        archived: [ev("archived", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:8080" })] })],
        current: [],
      },
      baselines: { current: EMPTY },
      snapshots: { current: EMPTY },
    });
    // 按会话级清单去匹配的话这里是空数组，于是 residueClean 的 targets 也是空、
    // 循环一圈什么都不做，而渲染层对空数组的 every(...) 恒真 → 报「清理成功」
    const pool = await createResidueQueries(h.deps).residueCleanPool("current");
    expect(pool.map((i) => i.id)).toEqual(["port:8080"]);
  });

  it("当前会话没有残留能力时，池子里仍然有重放出来的那些", async () => {
    const h = harness({
      logs: { archived: [ev("archived", 1, { type: "residue_detected", items: [item({ detector: "ports", id: "port:8080" })] })] },
    });
    // 归档把 agent 删掉了，现查那一半必然为空——但清理能力有 app 级退路
    // （residueCapFor），池子不能跟着空掉
    expect((await createResidueQueries(h.deps).residueCleanPool("gone")).map((i) => i.id)).toEqual(["port:8080"]);
  });
});
