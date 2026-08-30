// 残留物生命周期（simulators / ports / processes）的类型与检测逻辑。
// 纯函数放这里，渲染层和测试都能用而不需 Node API（shared/ 约束）。

export interface SimSnapshot {
  udid: string;
  name: string;
  runtime: string;
}

export interface PortSnapshot {
  port: number;
  pid: number;
  command: string;
}

export interface ResidueSnapshot {
  ts: number;
  simulators: SimSnapshot[]; // booted only
  ports: PortSnapshot[]; // LISTEN only
}

export interface ResidueItem {
  detector: "simulators" | "ports" | "process_groups";
  id: string; // sim UDID / "port:3000" / String(pgid)
  label: string;
  confidence: "owned" | "suspected";
  cleanupHint: string;
}

export interface CleanupResult {
  id: string;
  ok: boolean;
  note?: string; // "已消失" 等
}

/**
 * diffResidue — 纯函数，对比两个残留物快照，计算新增条目的清单。
 *
 * 逻辑（4 条规则）：
 * 1. escaped 组每个出一条 `process_groups/owned`
 * 2. 新 boot 的 simulator（udid 不在 before）→ `simulators/suspected`
 * 3. 新端口（port 不在 before）→ 若 pid 属某 escaped.pgid 则 `ports/owned`；否则 `ports/suspected`
 * 4. owned 端口与同 pgid 的 process_groups 去重：
 *    - 若某个 pgid 既有 process_groups 条目 + 对应的 owned port 条目
 *    - 则保留 port 条目（信息更具体），去掉 process_groups 条目
 *    - 即一个组最多一条记录，优先取有端口的那条
 */
export function diffResidue(
  before: ResidueSnapshot,
  after: ResidueSnapshot,
  escaped: Array<{ pgid: number; cmd: string }>
): ResidueItem[] {
  const items: ResidueItem[] = [];

  // 规则 1: escaped 组每个出一条 process_groups/owned
  const escapedSet = new Map<number, string>();
  for (const esc of escaped) {
    escapedSet.set(esc.pgid, esc.cmd);
    items.push({
      detector: "process_groups",
      id: String(esc.pgid),
      label: esc.cmd,
      confidence: "owned",
      cleanupHint: `kill 进程组 ${esc.pgid}`,
    });
  }

  // 规则 2: 新 boot 的 simulator
  const beforeUdids = new Set(before.simulators.map((s) => s.udid));
  for (const sim of after.simulators) {
    if (!beforeUdids.has(sim.udid)) {
      items.push({
        detector: "simulators",
        id: sim.udid,
        label: `${sim.name} (${sim.runtime})`,
        confidence: "suspected",
        cleanupHint: `simctl shutdown ${sim.udid}`,
      });
    }
  }

  // 规则 3: 新端口，同时收集 owned port 对应的 pgid（用于规则 4）
  const beforePorts = new Set(before.ports.map((p) => p.port));
  const pgidsWithOwnedPorts = new Set<number>();
  for (const port of after.ports) {
    if (!beforePorts.has(port.port)) {
      const belongsToEscaped = escapedSet.has(port.pid);
      const confidence = belongsToEscaped ? "owned" : "suspected";
      const cleanupHint =
        confidence === "owned"
          ? `kill 进程组 ${port.pid}`
          : "仅展示，不提供清理";
      const item: ResidueItem = {
        detector: "ports",
        id: `port:${port.port}`,
        label: `${port.command}:${port.port}`,
        confidence,
        cleanupHint,
      };
      items.push(item);
      // 规则 4：记录有 owned 端口的 pgid，用于后续去重
      if (belongsToEscaped) {
        pgidsWithOwnedPorts.add(port.pid);
      }
    }
  }

  // 过滤掉被去重的 process_groups 条目
  const result = items.filter((item) => {
    if (item.detector === "process_groups" && item.confidence === "owned") {
      const pgid = Number(item.id);
      return !pgidsWithOwnedPorts.has(pgid);
    }
    return true;
  });

  return result;
}

/**
 * mergeResidue — 纯函数（issue #759），合并"此刻现查"清单与"日志重放"清单，
 * 按 key = detector:id 去重，现查优先。
 *
 * 为什么现查优先：replayed（pendingResidue 重放出来的）是上次落盘时刻的快照
 * （label/confidence 可能已经过期），而 current（diffResidue 现拍现算）是这一刻
 * 的真实现场——同一个残留物两边都有记录时，以看得见的那份为准，不是谁先谁后。
 */
export function mergeResidue(current: ResidueItem[], replayed: ResidueItem[]): ResidueItem[] {
  const merged = new Map<string, ResidueItem>();
  for (const item of replayed) merged.set(`${item.detector}:${item.id}`, item);
  for (const item of current) merged.set(`${item.detector}:${item.id}`, item); // 现查覆盖同 key
  return [...merged.values()];
}
