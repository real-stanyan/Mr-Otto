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
import { killGroup, groupAlive, KILL_GRACE_MS } from "./localWorld.js";

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

/** 条目 → 可清理的进程组 id（issue #759 review C1f）。三级取值，优先级从高到低：
    1. `item.pgid` —— diffResidue 现在直接带上的结构化字段，唯一可靠的一档
    2. cleanupHint 里那句中文 `kill 进程组 12345` —— **只作 fallback**：旧日志
       重放出来的条目没有 pgid 字段，文案一改（或哪天换语言）这条就静默失效
    3. process_groups 条目的 id 本身就是 pgid */
function pgidOf(item: ResidueItem): number | null {
  if (typeof item.pgid === "number" && Number.isFinite(item.pgid)) return item.pgid;
  const m = /kill 进程组 (\d+)/.exec(item.cleanupHint);
  if (m) return Number(m[1]);
  if (item.detector === "process_groups") {
    const n = Number(item.id);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 探活轮询的间隔：SIGTERM 送达是异步的（实测：kill 后立刻探活，进程往往还
    "活着"——内核还没调度完终止），紧跟着探一次会把刚杀成功的组误判成杀不掉。 */
const PROBE_INTERVAL_MS = 100;

/** 轮询到组真的死了为止，或超过 budgetMs 认输。
    早退：一探就是死的立刻回 true——fixture 测试里 pgid 本来就不存在，
    不会真的睡满这个预算。 */
async function confirmDead(pgid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
}

export function createLocalResidue(
  reg: LiveGroupRegistry,
  runCmd: (cmd: string) => Promise<string> = defaultRunCmd,
  /** SIGTERM 之后给组的宽限，超了就 SIGKILL 补刀。默认复用 localWorld 那条
      exec/execDetached 超时补刀共用的 KILL_GRACE_MS——同一件事该是同一个数。
      可注入是为了测试："这个组不吃 SIGTERM" 那条用例不该真等 5 秒（issue #759 C1a） */
  killGraceMs: number = KILL_GRACE_MS
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
          return { id: item.id, ok: true, kind: "cleaned" };
        } catch {
          // simctl shutdown 失败的绝大多数成因是"这台早就关了/不在了"（Booted
          // 才会进清单，跑到这一步失败通常是中间它自己关了）。判 gone 而不是
          // failed：它已经不在，继续挂在清单上只会让用户反复点同一行
          return { id: item.id, ok: false, kind: "gone", note: "已消失或关闭失败" };
        }
      }

      if (item.confidence === "suspected") {
        // suspected ports：diffResidue 明确标了"仅展示，不提供清理"——不属于
        // 本 agent 起的组，不该由残留审计代它做主
        return { id: item.id, ok: false, kind: "skipped", note: "仅展示，不提供清理" };
      }

      // 走到这里：process_groups（owned）或 owned ports——都要一个 pgid（取值
      // 三级见 pgidOf）
      const pgid = pgidOf(item);
      if (pgid === null || !Number.isFinite(pgid)) {
        // 拿不到 pgid = 一个信号都没发出去，这条残留物原封不动还在
        // ——failed 而不是带 note 的"算清了"（review C1c）
        return { id: item.id, ok: false, kind: "failed", note: "无法解析进程组 id" };
      }

      // 本来就没了：一个信号都不用发。台账照样摘干净（escaped 里挂着一个
      // 早死的组，下次重放又会把它当残留报出来）
      if (!groupAlive(pgid)) {
        reg.ackEscaped(pgid);
        return { id: item.id, ok: true, kind: "gone", note: "已消失" };
      }

      // SIGTERM → 宽限 → 还活着就 SIGKILL 补刀 → 再确认（review C1a）。
      // 只发一发 SIGTERM 就走人的老写法，对"忽略 SIGTERM 的进程"永远是失败，
      // 而失败又被三处消费方当成成功——用户以为清干净了，进程还在跑。
      // 补刀逻辑与 localWorld 的 exec/execDetached 超时路径同构（那边也是
      // SIGTERM → KILL_GRACE_MS → groupAlive 则 SIGKILL）
      killGroup(pgid, "SIGTERM");
      if (!(await confirmDead(pgid, killGraceMs))) {
        killGroup(pgid, "SIGKILL");
        // 补刀后只给一小段确认窗口：SIGKILL 不可捕获，内核调度完就是死；
        // 这一段等的是调度而不是进程的善后（宽限已经在上面花掉了）
        if (!(await confirmDead(pgid, PROBE_INTERVAL_MS * 5))) {
          // **不** ackEscaped：组还活着，从 escaped 台账里摘掉等于把这条
          // 残留物从下次重放里抹掉——它还在跑，却再也没人报给用户（review C1b）
          return {
            id: item.id,
            ok: false,
            kind: "failed",
            note: "已发送 SIGTERM/SIGKILL，进程组仍存活",
          };
        }
      }
      // 确认死亡之后才销账（review C1b：ackEscaped 原来在探活之前无条件执行）
      reg.ackEscaped(pgid);
      return { id: item.id, ok: true, kind: "cleaned" };
    },
  };
}
