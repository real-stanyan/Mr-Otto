import { describe, it, expect } from "vitest";
import { diffResidue, mergeResidue, type ResidueSnapshot, type ResidueItem } from "../../src/shared/residue.js";

const base: ResidueSnapshot = {
  ts: 1000,
  simulators: [{ udid: "AAA", name: "iPhone 17", runtime: "iOS 26.5" }],
  ports: [{ port: 5432, pid: 100, command: "postgres" }],
};

describe("diffResidue", () => {
  it("新 boot 的 sim = suspected；基线里就有的不报", () => {
    const after: ResidueSnapshot = {
      ts: 2000,
      simulators: [...base.simulators, { udid: "BBB", name: "iPhone 17 Pro", runtime: "iOS 26.5" }],
      ports: base.ports,
    };
    const items = diffResidue(base, after, []);
    expect(items).toEqual([
      expect.objectContaining({ detector: "simulators", id: "BBB", confidence: "suspected" }),
    ]);
  });

  it("新端口且 pid 属 escaped 组 = owned；无主新端口 = suspected", () => {
    const after: ResidueSnapshot = {
      ts: 2000,
      simulators: base.simulators,
      ports: [...base.ports,
        { port: 3000, pid: 555, command: "next-server" },
        { port: 8791, pid: 777, command: "python3" }],
    };
    // pid 555 属于 escaped pgid 555 的组（组长 pid = pgid 的最常见形态）
    const items = diffResidue(base, after, [{ pgid: 555, cmd: "npx next dev" }]);
    const p3000 = items.find((i) => i.id === "port:3000");
    const p8791 = items.find((i) => i.id === "port:8791");
    expect(p3000?.confidence).toBe("owned");
    expect(p8791?.confidence).toBe("suspected");
  });

  it("escaped 组本身必进清单（owned），即使没占端口", () => {
    const items = diffResidue(base, base, [{ pgid: 999, cmd: "sh -c 'sleep 100 &'" }]);
    expect(items).toEqual([
      expect.objectContaining({ detector: "process_groups", id: "999", confidence: "owned" }),
    ]);
  });

  it("owned 端口与同 pgid 的 process_groups 去重——保留端口条目，略去组条目", () => {
    // after 中有个占端口的 owned 进程
    const after: ResidueSnapshot = {
      ts: 2000,
      simulators: base.simulators,
      ports: [...base.ports, { port: 3000, pid: 555, command: "next-server" }],
    };
    // 同一个 pgid=555 既被 escaped 列表声明，又通过端口关联
    const items = diffResidue(base, after, [{ pgid: 555, cmd: "npx next dev" }]);

    // 应该有一个 port:3000 条目（owned）
    const portItem = items.find((i) => i.id === "port:3000");
    expect(portItem).toBeDefined();
    expect(portItem?.confidence).toBe("owned");

    // 不应该有独立的 process_groups 条目（被去重了）
    const groupItem = items.find((i) => i.detector === "process_groups" && i.id === "555");
    expect(groupItem).toBeUndefined();
  });
});

describe("mergeResidue", () => {
  it("按 detector:id 去重——不同 key 的条目全部保留", () => {
    const current: ResidueItem[] = [
      { detector: "ports", id: "port:3000", label: "next-server:3000", confidence: "owned", cleanupHint: "kill 进程组 555" },
    ];
    const replayed: ResidueItem[] = [
      { detector: "simulators", id: "AAA", label: "iPhone 17 (iOS 26.5)", confidence: "suspected", cleanupHint: "simctl shutdown AAA" },
    ];
    const merged = mergeResidue(current, replayed);
    expect(merged).toHaveLength(2);
    expect(merged.map((i) => `${i.detector}:${i.id}`).sort()).toEqual(["ports:port:3000", "simulators:AAA"]);
  });

  it("同 key 冲突时现查（current）覆盖重放（replayed）", () => {
    const stale: ResidueItem = {
      detector: "process_groups",
      id: "555",
      label: "npx next dev（旧标签）",
      confidence: "owned",
      cleanupHint: "kill 进程组 555",
    };
    const fresh: ResidueItem = {
      detector: "process_groups",
      id: "555",
      label: "npx next dev（现查最新）",
      confidence: "owned",
      cleanupHint: "kill 进程组 555",
    };
    const merged = mergeResidue([fresh], [stale]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(fresh);
  });
});
