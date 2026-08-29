// LocalWorld 的残留物审计能力（issue #759）：simctl 采集模拟器、lsof 采集监听端口，
// 按 diffResidue（Task 3）算出来的条目做分派清理。runCmd 可注入——测试全走 fixture，
// 不碰真机的 simctl/lsof；world 内模块允许直接 import child_process（tests/architecture.test.ts
// 只禁 src/tools，见该用例）。
import { spawn } from "node:child_process";
import type { ResidueCapability } from "./executionWorld.js";
import type {
  ResidueSnapshot,
  SimSnapshot,
  PortSnapshot,
  ResidueItem,
  CleanupResult,
} from "../shared/residue.js";
import type { LiveGroupRegistry } from "./liveGroups.js";
import { killGroup, groupAlive } from "./localWorld.js";

const RUN_CMD_TIMEOUT_MS = 5_000;

/** 默认 runCmd：spawn 一条 shell 命令，5s 超时，非零 exit 抛错。
    残留审计不该继承 exec() 那套超时/审批管线——它是旁路，独立一条轻量实现即可。 */
async function defaultRunCmd(cmd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, { shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`命令超时（${RUN_CMD_TIMEOUT_MS}ms）: ${cmd}`));
    }, RUN_CMD_TIMEOUT_MS);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`命令退出码 ${code}: ${cmd}\n${stderr}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

/** simctl list devices -j 的输出剥成 booted 列表。
    runtime key 形如 com.apple.CoreSimulator.SimRuntime.iOS-26-5 → "iOS 26.5" */
function parseSimctl(json: string): SimSnapshot[] {
  const parsed = JSON.parse(json) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
  };
  const out: SimSnapshot[] = [];
  for (const [runtimeKey, devices] of Object.entries(parsed.devices)) {
    const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtimeKey);
    const runtime = m ? `${m[1]} ${m[2]!.replace(/-/g, ".")}` : runtimeKey;
    for (const d of devices) {
      if (d.state === "Booted") {
        out.push({ udid: d.udid, name: d.name, runtime });
      }
    }
  }
  return out;
}

/** lsof -iTCP -sTCP:LISTEN -P -n 的输出剥成 port/pid/command 列表。
    跳过表头，NAME 列取 `:` 后的端口数字；同 pid+port 多行只取一条（去重）。 */
function parseLsof(output: string): PortSnapshot[] {
  const lines = output.split("\n").slice(1); // 跳过表头
  const seen = new Set<string>();
  const out: PortSnapshot[] = [];
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const [command, pidStr, , , , , , , name] = cols;
    const portMatch = /:(\d+)(?:\s|$)/.exec(name!);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    const pid = Number(pidStr);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid, command: command! });
  }
  return out;
}

/** cleanupHint 形如 "kill 进程组 12345"（diffResidue 里唯一产出这种 hint 的地方）——
    process_groups 和 owned ports 条目共用同一格式，pgid 从这里解析而不是另开字段。 */
function pgidFromHint(hint: string): number | null {
  const m = /kill 进程组 (\d+)/.exec(hint);
  return m ? Number(m[1]) : null;
}

export function createLocalResidue(
  reg: LiveGroupRegistry,
  runCmd: (cmd: string) => Promise<string> = defaultRunCmd
): ResidueCapability {
  return {
    async snapshot(): Promise<ResidueSnapshot> {
      // 每个探测器独立 try/catch：一个挂了不该拖垮另一个——残留审计是旁路，
      // 不该因为这台机器没装 Xcode（没有 simctl）就连端口都看不到
      const simulators = await (async () => {
        try {
          const out = await runCmd("xcrun simctl list devices -j");
          return parseSimctl(out);
        } catch {
          return [];
        }
      })();
      const ports = await (async () => {
        try {
          const out = await runCmd("lsof -iTCP -sTCP:LISTEN -P -n");
          return parseLsof(out);
        } catch {
          return [];
        }
      })();
      return { ts: Date.now(), simulators, ports };
    },

    async cleanup(item: ResidueItem): Promise<CleanupResult> {
      if (item.detector === "simulators") {
        try {
          await runCmd(`xcrun simctl shutdown ${item.id}`);
          return { id: item.id, ok: true };
        } catch {
          return { id: item.id, ok: false, note: "已消失或关闭失败" };
        }
      }

      if (item.confidence === "suspected") {
        // suspected ports：diffResidue 明确标了"仅展示，不提供清理"——不属于
        // 本 agent 起的组，不该由残留审计代它做主
        return { id: item.id, ok: false, note: "仅展示，不提供清理" };
      }

      // 走到这里：process_groups（owned）或 owned ports——都靠 cleanupHint 里的
      // "kill 进程组 <pgid>" 拿到 pgid（诊断见 src/shared/residue.ts 的 diffResidue）
      const pgid = pgidFromHint(item.cleanupHint) ??
        (item.detector === "process_groups" ? Number(item.id) : null);
      if (pgid === null || !Number.isFinite(pgid)) {
        return { id: item.id, ok: false, note: "无法解析进程组 id" };
      }
      killGroup(pgid);
      reg.ackEscaped(pgid);
      // 探活确认：killGroup 是 fire-and-forget（SIGTERM 可能被忽略），
      // 探一下才知道真死了没有
      if (groupAlive(pgid)) {
        return { id: item.id, ok: false, note: "已发送终止信号，进程组仍存活" };
      }
      return { id: item.id, ok: true };
    },
  };
}
