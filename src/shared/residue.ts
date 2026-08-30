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
  /** 可清理条目的进程组 id（issue #759 review C1f）。process_groups 条目和
      owned ports 条目都带上——在此之前清理侧只能拿 cleanupHint 那句中文
      `kill 进程组 12345` 去 regex 回捞，文案一改（或换语言）就静默失效。
      结构化字段是事实，cleanupHint 回落成纯人话。
      可选 = 向后兼容：旧日志重放出来的条目没有这个字段，清理侧照旧走
      cleanupHint fallback（residueLocal.pgidOf） */
  pgid?: number;
}

/** 清理结果的结构化判据（issue #759 review C1c）。
    在此之前只有 `ok` + 一句中文 note，三处消费方（residueProjection 的差集、
    store.applyResidueEvent 的摘除、ResiduePanel 的划线）各自用
    `ok || note` 猜"算不算清完了"——于是"信号发了但进程还活着"这种真失败，
    因为带了 note，被三处一致地当成成功抹掉。kind 把判据从猜测变成事实：
    · cleaned —— 真杀掉了（确认死亡）
    · gone    —— 本来就不在了（探活即死 / simctl 说找不到）
    · skipped —— 只展示不清理（suspected 端口那档）
    · failed  —— 发了信号它还活着，或压根没能下手 → **不算清完** */
export type CleanupKind = "cleaned" | "gone" | "skipped" | "failed";

/** kind 为这三档 = 这条残留物不必再挂在清单上（清掉了 / 本来就没了 / 明确不清）。
    failed 不在其中——它还活着，必须留在清单里给用户看见 */
const SETTLED_KINDS: ReadonlySet<string> = new Set(["cleaned", "gone", "skipped"]);

/**
 * residueSettled — 纯函数（issue #759 review C1d/C1e），判"这条清理结果算不算了结"。
 *
 * 三处消费方（residueProjection.pendingResidue 的差集、store.applyResidueEvent
 * 的精确摘除、ResiduePanel 的划线/红字）必须同一套判据，否则又会出现
 * "日志里删了但 UI 还挂着"这种各说各话。
 *
 * 向后兼容：旧日志里的 residue_cleaned 没有 kind 字段，按老语义（写进日志
 * 就算清过了）当已了结——重放老日志不该突然多出一批清不掉的僵尸条目。
 */
export function residueSettled(result: { ok: boolean; kind?: string; note?: string }): boolean {
  if (result.kind === undefined) return true; // 旧日志：无 kind = 按已清对待
  return SETTLED_KINDS.has(result.kind);
}

export interface CleanupResult {
  id: string;
  ok: boolean;
  /** 结构化判据，见 CleanupKind。可选 = 向后兼容（旧日志/旧实现没有它，
      消费方一律走 residueSettled 的无 kind 分支） */
  kind?: CleanupKind;
  note?: string; // "已消失" 等人话，给用户看，不作判据
}

/** 命令行身份比对的最短长度：短过这个的串（"sh"、"-zsh"）随便就能互相
    包含，双向匹配下会变成"什么都对得上"，而对得上就意味着可以杀 */
const MIN_MATCH_LEN = 4;

/**
 * commandMatches — 纯函数（issue #759 review I4），进程组身份核对的比对判据。
 *
 * want = 登记时记下的命令（ResidueItem.label，当初 cmd 的头 200 字符），
 * line = `ps -o command= -g <pgid>` 现在吐出来的某一行。
 *
 * **双向**包含：原来只判 `line.includes(want)`，方向反了——escaped 组里跑的
 * 往往是 `sh -c <命令>` 底下的孙进程，它的命令行是登记命令的**子串**（登记的
 * 是完整命令行带参数，ps 那行常只剩可执行名和头几个参数），于是恒为 false，
 * 重放出来的进程组条目被全数丢弃。两个方向都认才覆盖得住两种壳。
 *
 * 仍以「核不上 = 丢弃」为安全方向：查不到、太短、空串一律 false——宁可漏报
 * 一条陈旧残留，不可把回收给别人的 pgid 当成自己的残留误杀。
 */
export function commandMatches(want: string, line: string): boolean {
  const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
  // 只比头一截：后面常是被 ps 改写/截断的参数，比全串会假阴性
  const w = norm(want).slice(0, 60);
  const l = norm(line);
  if (w.length < MIN_MATCH_LEN || l.length < MIN_MATCH_LEN) return false;
  return l.includes(w) || w.includes(l);
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
      pgid: esc.pgid, // 结构化事实，清理侧不必再从 cleanupHint 里 regex 回捞（review C1f）
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
        // 只有 owned 端口才有可清理的进程组（suspected 那档写死"仅展示"，
        // 给它 pgid 反而像在暗示可以杀）——review C1f
        ...(belongsToEscaped ? { pgid: port.pid } : {}),
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
