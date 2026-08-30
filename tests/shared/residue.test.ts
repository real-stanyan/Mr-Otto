import { describe, it, expect } from "vitest";
import {
  commandMatches,
  diffResidue,
  mergeResidue,
  residueSettled,
  type ResidueSnapshot,
  type ResidueItem,
} from "../../src/shared/residue.js";

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
    // review C1f：owned 端口带结构化 pgid，清理侧不必再从 cleanupHint regex 回捞
    expect(p3000?.pgid).toBe(555);
    // suspected 那条**不给** pgid：写死了"仅展示"，给它 pgid 像在暗示可以杀
    expect(p8791?.pgid).toBeUndefined();
  });

  it("escaped 组本身必进清单（owned），即使没占端口；带结构化 pgid（review C1f）", () => {
    const items = diffResidue(base, base, [{ pgid: 999, cmd: "sh -c 'sleep 100 &'" }]);
    expect(items).toEqual([
      expect.objectContaining({ detector: "process_groups", id: "999", confidence: "owned", pgid: 999 }),
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

// issue #759 review I4：groupStillIs 原来只判 `line.includes(want)`，方向反了——
// escaped 组的孙进程命令行是登记命令的**子串**，恒为 false，重放全丢。
// 比对判据抽成这个纯函数，方向由它一处说了算。
describe("commandMatches（进程组身份核对的比对判据，review I4）", () => {
  it("ps 那行**包含**登记命令（`sh -c` 那层壳）→ 认", () => {
    expect(commandMatches("npm run dev", "sh -c npm run dev --port 3000")).toBe(true);
  });

  it("ps 那行是登记命令的**子串**（孙进程只剩可执行名）→ 也认（这条原来恒 false）", () => {
    expect(commandMatches("npm run dev --silent --port 3000", "npm run dev")).toBe(true);
  });

  it("完全对不上 → 丢弃（安全方向：宁可漏报也不误杀回收给别人的 pgid）", () => {
    expect(commandMatches("npm run dev", "/usr/sbin/cupsd -l")).toBe(false);
  });

  it("空白差异不影响（两边都归一化）", () => {
    expect(commandMatches("npm   run\tdev", "sh -c  npm run dev ")).toBe(true);
  });

  it("太短的串一律不认——短过 4 个字符随便就能互相包含，双向匹配下等于什么都对得上", () => {
    expect(commandMatches("sh", "sh -c npm run dev")).toBe(false);
    expect(commandMatches("npm run dev", "sh")).toBe(false);
    expect(commandMatches("", "npm run dev")).toBe(false);
  });

  it("只比 want 的头 60 字符：后面常是被 ps 改写/截断的参数", () => {
    const want = "node ".concat("x".repeat(80));
    expect(commandMatches(want, "node ".concat("x".repeat(55)))).toBe(true);
  });
});

// issue #759 review C1d/C1e：三处消费方共用的"算不算了结"判据
describe("residueSettled（清理结果的了结判据，review C1）", () => {
  it("cleaned / gone / skipped 算了结", () => {
    expect(residueSettled({ ok: true, kind: "cleaned" })).toBe(true);
    expect(residueSettled({ ok: false, kind: "gone", note: "已消失" })).toBe(true);
    expect(residueSettled({ ok: false, kind: "skipped", note: "仅展示，不提供清理" })).toBe(true);
  });

  it("failed **不算**了结——哪怕它带着一句 note（旧写法就是被 note 骗过去的）", () => {
    expect(residueSettled({ ok: false, kind: "failed", note: "已发送 SIGTERM/SIGKILL，进程组仍存活" })).toBe(false);
  });

  it("没有 kind 的旧结果按已清对待（向后兼容：老日志重放不该多出僵尸条目）", () => {
    expect(residueSettled({ ok: true })).toBe(true);
    expect(residueSettled({ ok: false, note: "已消失" })).toBe(true);
  });
});
