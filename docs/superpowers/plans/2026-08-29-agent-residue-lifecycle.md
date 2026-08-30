# Agent 副作用生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 起的进程超时/中断/退出时全进程组连坐；simctl 等树外残留有审计清单 + 用户确认一键清。

**Architecture:** 腿1 = spawn `detached:true` 起独立进程组 + `kill(-pgid)` 三路统一 + LiveGroupRegistry 登记/探活；腿2 = ExecutionWorld 可选 `residue?` capability（快照差分三探测器）。事件 residue_baseline/detected/cleaned 纯新增，UI 走 ShellBridge。

**Tech Stack:** TypeScript strict / Node child_process / vitest / Electron IPC / React+Tailwind+shadcn

**Spec:** docs/superpowers/specs/2026-08-29-agent-residue-lifecycle-design.md（Task issue #759）

## Global Constraints

- append-only 事件日志：schema 只加不改；新审计事件必须标 `ignorable: true` 并加进 `KNOWN_EVENT_TYPES_MAP`
- 工具层禁 import fs/child_process——只有 `src/world/localWorld.ts`（及本计划新增的 world 内模块）可以
- 渲染进程只走 ShellBridge；测试放 `tests/` 镜像 `src/` 结构
- 门禁：`npm test`（= typecheck + vitest run），每个 task 收口前必须绿
- 提交小步、message 写 why；本仓主 checkout 冻结——全部工作在本 lane worktree 内

---

### Task 1: killGroup + 进程组化 exec/execDetached

**Files:**
- Modify: `src/world/localWorld.ts`（exec 在 ~L80-145，execDetached 在 ~L148-175）
- Test: `tests/world/localWorldProcessGroup.test.ts`（新建）

**Interfaces:**
- Produces: `killGroup(pgid: number, signal?: NodeJS.Signals): void`（模块内导出 `export function killGroup`，Task 2/4 复用）；exec/execDetached 行为不变（超时仍 `exitCode 124 + stderr 标注`，abort 仍 reject）

- [ ] **Step 1: 写失败测试（孙进程随组死）**

```ts
// tests/world/localWorldProcessGroup.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

describe("进程组硬杀", () => {
  it("超时杀掉后台孙进程（旧实现只杀 shell，孙进程逃逸）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    const pidFile = join(dir, "grandchild.pid");
    const world = createLocalWorld({ root: dir });
    // sleep 100 & 是逃逸原型：shell 被杀后它以前会被 reparent 到 launchd
    const r = await world.exec(`sleep 100 & echo $! > ${pidFile}; wait`, {
      timeoutMs: 500,
    });
    expect(r.exitCode).toBe(124);
    const gpid = Number(readFileSync(pidFile, "utf8").trim());
    // SIGTERM 后给 200ms 让信号送达
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(gpid)).toBe(false);
  }, 10_000);

  it("abort 杀掉后台孙进程", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    const pidFile = join(dir, "grandchild.pid");
    const world = createLocalWorld({ root: dir });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(
      world.exec(`sleep 100 & echo $! > ${pidFile}; wait`, { signal: ac.signal })
    ).rejects.toThrow(/中断/);
    const gpid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(gpid)).toBe(false);
  }, 10_000);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/world/localWorldProcessGroup.test.ts`
Expected: FAIL——两条都在 `expect(alive(gpid)).toBe(false)` 挂（孙进程还活着，正是现状 bug）

- [ ] **Step 3: 实现 killGroup + 改 exec**

`src/world/localWorld.ts` 顶部（EXEC_BUFFER_CAP 附近）加：

```ts
/** 杀整个进程组（负 pid）。组已死是常态不是错误（issue #759）。
    detached:true 起的子进程是组长（pgid = child.pid），全组连坐堵住
    「SIGTERM 只打 shell、`&` 起的孙进程被 reparent 到 launchd 逃逸」的洞 */
export function killGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(-pgid, signal); } catch { /* 组已死 */ }
}

/** SIGTERM 后的宽限：组里还有硬骨头就 SIGKILL 补刀 */
const KILL_GRACE_MS = 5_000;

/** 探组存活：EPERM 也算活着（有进程但无权限，本 app 起的组不该出现） */
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
```

exec 的 spawn 改法（execDetached 同款）：

```ts
const child = spawn(cmd, {
  shell: true,
  detached: true,            // 独立进程组，组长 pgid = child.pid
  // timeout / killSignal / signal 三个原生选项全部移除——它们只打直接子进程，
  // 改为下面自管：到点/中断 killGroup 全组连坐
  env: childEnv(),
  ...(root ? { cwd: root } : {}),
});
const pgid = child.pid;      // detached 下 spawn 同步拿到组长 pid
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (pgid) {
    killGroup(pgid, "SIGTERM");
    setTimeout(() => { if (groupAlive(pgid)) killGroup(pgid, "SIGKILL"); }, KILL_GRACE_MS).unref();
  }
}, timeoutMs);
const onAbort = () => { if (pgid) killGroup(pgid, "SIGTERM"); };
opts?.signal?.addEventListener("abort", onAbort, { once: true });
```

close 处理器改动：
- 开头 `clearTimeout(timer); opts?.signal?.removeEventListener("abort", onAbort);`
- `opts?.signal?.aborted` 分支保持 reject 语义不变
- 原来靠 `signal !== null` 判超时——自管后改为 `timedOut || signal !== null` 都走 124 分支（stderr 文案不变）
- error 处理器同样 clearTimeout + removeEventListener

execDetached：同款 detached + 自管 30 分钟定时器 + killGroup（无 abort 信号，本来就没有）。

- [ ] **Step 4: 跑测试确认绿 + 旧测试不红**

Run: `npx vitest run tests/world/`
Expected: 全绿（localWorld.test.ts 的既有超时/中断用例语义未变）

- [ ] **Step 5: Commit**

```bash
git add src/world/localWorld.ts tests/world/localWorldProcessGroup.test.ts
git commit -m "fix(world): exec/execDetached 进程组硬杀——超时/中断全组连坐 (#759)

为什么：spawn 原生 timeout/killSignal/signal 只打 shell 本身，命令里 & 起的
孙进程被 reparent 到 launchd 逃逸（宿主机 next-server 挂 5 天的根因）。
detached:true 起独立进程组 + kill(-pgid) 三路统一，SIGTERM 5s 宽限后 SIGKILL 补刀。"
```

---

### Task 2: LiveGroupRegistry（登记/探活/收尸）

**Files:**
- Create: `src/world/liveGroups.ts`
- Modify: `src/world/localWorld.ts`（spawn 处登记、close 处注销）
- Test: `tests/world/liveGroups.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `killGroup` / `groupAlive`
- Produces:

```ts
export interface LiveGroup {
  pgid: number;
  cmd: string;        // 头 200 字符
  startedAt: number;  // epoch ms
  kind: "exec" | "detached";
}
export class LiveGroupRegistry {
  register(pgid: number, cmd: string, kind: LiveGroup["kind"]): void;
  noteClosed(pgid: number): void;   // shell 死了：组仍活 → 移入 escaped
  live(): LiveGroup[];
  escaped(): LiveGroup[];
  ackEscaped(pgid: number): void;   // 清理完成后移除
  sweepAll(): void;                 // live+escaped 全部 killGroup（app 退出用）
}
```
- `createLocalWorld` opts 新增 `liveGroups?: LiveGroupRegistry`（可选 = 既有测试/装配零改动；缺席 = 不登记，行为同旧）

- [ ] **Step 1: 写失败测试**

```ts
// tests/world/liveGroups.test.ts
import { describe, it, expect } from "vitest";
import { LiveGroupRegistry } from "../../src/world/liveGroups.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

describe("LiveGroupRegistry", () => {
  it("正常结束的组注销后不留痕", async () => {
    const reg = new LiveGroupRegistry();
    const world = createLocalWorld({ root: mkdtempSync(join(tmpdir(), "lg-")), liveGroups: reg });
    await world.exec("true");
    expect(reg.live()).toHaveLength(0);
    expect(reg.escaped()).toHaveLength(0);
  });

  it("shell 死了组还活着 = escaped", async () => {
    // 手工造一个逃逸组模拟 noteClosed 时组仍存活的判定
    const child = spawn("sleep 60", { shell: true, detached: true });
    const pgid = child.pid!;
    const reg = new LiveGroupRegistry();
    reg.register(pgid, "sleep 60", "exec");
    reg.noteClosed(pgid);              // shell 还没死但组活着 → escaped
    expect(reg.escaped().map((g) => g.pgid)).toContain(pgid);
    reg.sweepAll();                    // 收尸
    await new Promise((r) => setTimeout(r, 200));
    expect(reg.live()).toHaveLength(0);
    expect(reg.escaped()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/world/liveGroups.test.ts`
Expected: FAIL with "Cannot find module .../liveGroups"

- [ ] **Step 3: 实现 liveGroups.ts + localWorld 接线**

```ts
// src/world/liveGroups.ts —— agent 起的进程组的存活登记表（issue #759）。
// 「谁还真的活着」的唯一判据在主进程内存里（事件日志重放不出进程存活），
// 与 backgroundTasks 的 liveMap 同一哲学。world 内模块：允许贴着进程 API。
import { killGroup, groupAlive } from "./localWorld.js";

export interface LiveGroup { /* 如上接口块 */ }

export class LiveGroupRegistry {
  private liveMap = new Map<number, LiveGroup>();
  private escapedMap = new Map<number, LiveGroup>();

  register(pgid: number, cmd: string, kind: LiveGroup["kind"]): void {
    this.liveMap.set(pgid, { pgid, cmd: cmd.slice(0, 200), startedAt: Date.now(), kind });
  }
  /** close 只代表 shell 死了：注销前探一次组，还有活口 = 泄漏出走 */
  noteClosed(pgid: number): void {
    const g = this.liveMap.get(pgid);
    this.liveMap.delete(pgid);
    if (g && groupAlive(pgid)) this.escapedMap.set(pgid, g);
  }
  live(): LiveGroup[] { return [...this.liveMap.values()]; }
  /** 读时顺手剔除已自然死掉的（escaped 里的组可能自己退出了） */
  escaped(): LiveGroup[] {
    for (const [pgid] of this.escapedMap) if (!groupAlive(pgid)) this.escapedMap.delete(pgid);
    return [...this.escapedMap.values()];
  }
  ackEscaped(pgid: number): void { this.escapedMap.delete(pgid); }
  sweepAll(): void {
    for (const g of [...this.liveMap.values(), ...this.escapedMap.values()])
      killGroup(g.pgid, "SIGTERM");
    this.liveMap.clear();
    this.escapedMap.clear();
  }
}
```

localWorld 接线（exec 与 execDetached 各两行）：
- spawn 成功且 `child.pid` 存在 → `opts.liveGroups?.register(pgid, cmd, "exec")`
- close 处理器开头 → `opts.liveGroups?.noteClosed(pgid)`

注意循环 import：liveGroups → localWorld（killGroup）。若 vitest 报循环问题，把 killGroup/groupAlive 挪到新文件 `src/world/processGroup.ts`，两边都从那 import（Step 4 跑了就知道）。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/world/`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/world/liveGroups.ts src/world/localWorld.ts tests/world/liveGroups.test.ts
git commit -m "feat(world): LiveGroupRegistry——进程组登记/escaped 探活/一键收尸 (#759)

为什么：close 事件只说 shell 死了；注销前 kill(-pgid,0) 探一次组抓出泄漏出走者，
是残留清单的第一个数据源（零成本零误报）。app 退出 sweepAll 全组连坐。"
```

---

### Task 3: 残留类型 + ResidueCapability 接口 + 纯 diff 函数

**Files:**
- Create: `src/shared/residue.ts`（渲染进程也要用的类型 + 纯函数）
- Modify: `src/world/executionWorld.ts`（可选 capability 字段）
- Test: `tests/shared/residue.test.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/residue.ts
export interface SimSnapshot { udid: string; name: string; runtime: string }
export interface PortSnapshot { port: number; pid: number; command: string }
export interface ResidueSnapshot {
  ts: number;
  simulators: SimSnapshot[];   // booted only
  ports: PortSnapshot[];       // LISTEN only
}
export interface ResidueItem {
  detector: "simulators" | "ports" | "process_groups";
  id: string;                  // sim UDID / "port:3000" / String(pgid)
  label: string;
  confidence: "owned" | "suspected";
  cleanupHint: string;
}
export interface CleanupResult { id: string; ok: boolean; note?: string } // note: "已消失" 等
export function diffResidue(
  before: ResidueSnapshot,
  after: ResidueSnapshot,
  escaped: Array<{ pgid: number; cmd: string }>
): ResidueItem[];
```

```ts
// src/world/executionWorld.ts 新增（browser?/mcp? 同款注释风格）
export interface ResidueCapability {
  snapshot(): Promise<ResidueSnapshot>;
  cleanup(item: ResidueItem): Promise<CleanupResult>;
}
// ExecutionWorld 接口加：residue?: ResidueCapability;
```
（diff 是纯函数放 shared，不进 capability——capability 只封装「碰宿主」的两件事）

- [ ] **Step 1: 写失败测试（fixture 驱动纯 diff）**

```ts
// tests/shared/residue.test.ts
import { describe, it, expect } from "vitest";
import { diffResidue, type ResidueSnapshot } from "../../src/shared/residue.js";

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
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/shared/residue.test.ts`
Expected: FAIL with "Cannot find module .../residue"

- [ ] **Step 3: 实现 diffResidue + 类型 + capability 字段**

diffResidue 逻辑：
1. escaped 组每个出一条 `process_groups/owned`，label = cmd，cleanupHint = `kill 进程组 <pgid>`
2. after.simulators 中 udid 不在 before 的 → `simulators/suspected`，label = `${name} (${runtime})`，cleanupHint = `simctl shutdown <udid>`
3. after.ports 中 port 不在 before 的 → pid 与某 escaped.pgid 相等则 `ports/owned`（cleanupHint = `kill 进程组 <pgid>`），否则 `ports/suspected`（cleanupHint = `仅展示，不提供清理`）
4. owned 端口与其 escaped 组去重：同一 pgid 已有 process_groups 条目时，端口条目仍保留（信息更具体），但 process_groups 那条略去——一个组一条，按端口条优先

executionWorld.ts 加 `residue?: ResidueCapability`，注释按 browser?/mcp? 先例写「可选 = 假 world 零改动；缺席 = 该世界无残留审计能力」。

- [ ] **Step 4: 跑测试确认绿 + typecheck**

Run: `npm test`
Expected: 全绿（capability 可选，既有假 world 编译通过——这就是第 5 节说的零改动验证）

- [ ] **Step 5: Commit**

```bash
git add src/shared/residue.ts src/world/executionWorld.ts tests/shared/residue.test.ts
git commit -m "feat(residue): 残留类型 + diffResidue 纯函数 + ExecutionWorld.residue? capability (#759)

为什么：diff 是纯函数放 shared（渲染层/测试可用，fixture 驱动不碰真机），
capability 只封装碰宿主的 snapshot/cleanup 两件事，v2 Docker world 可不实现。"
```

---

### Task 4: LocalWorld residue 实现（simctl + lsof 采集与清理）

**Files:**
- Create: `src/world/residueLocal.ts`
- Modify: `src/world/localWorld.ts`（挂 residue 字段）
- Test: `tests/world/residueLocal.test.ts`

**Interfaces:**
- Consumes: Task 2 `LiveGroupRegistry`、Task 3 类型、Task 1 `killGroup`/`groupAlive`
- Produces: `createLocalResidue(reg: LiveGroupRegistry, runCmd?: (cmd: string) => Promise<string>): ResidueCapability`（runCmd 可注入 = 测试喂 fixture 不跑真 simctl/lsof）

- [ ] **Step 1: 写失败测试（fixture 喂解析器）**

```ts
// tests/world/residueLocal.test.ts
import { describe, it, expect } from "vitest";
import { createLocalResidue } from "../../src/world/residueLocal.js";
import { LiveGroupRegistry } from "../../src/world/liveGroups.js";

const SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { udid: "AAA", name: "iPhone 17", state: "Booted" },
      { udid: "CCC", name: "iPad", state: "Shutdown" },
    ],
  },
});
// lsof -iTCP -sTCP:LISTEN -P -n 的典型输出
const LSOF = [
  "COMMAND   PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
  "next-serv 555 stanyan   23u  IPv6 0x1      0t0  TCP *:3000 (LISTEN)",
  "postgres  100 stanyan    7u  IPv4 0x2      0t0  TCP 127.0.0.1:5432 (LISTEN)",
].join("\n");

describe("createLocalResidue.snapshot", () => {
  it("simctl 只收 Booted；lsof 解析出 port/pid/command", async () => {
    const runCmd = async (cmd: string) =>
      cmd.includes("simctl") ? SIMCTL_JSON : LSOF;
    const residue = createLocalResidue(new LiveGroupRegistry(), runCmd);
    const snap = await residue.snapshot();
    expect(snap.simulators).toEqual([
      { udid: "AAA", name: "iPhone 17", runtime: "iOS 26.5" },
    ]);
    expect(snap.ports).toContainEqual({ port: 3000, pid: 555, command: "next-serv" });
    expect(snap.ports).toContainEqual({ port: 5432, pid: 100, command: "postgres" });
  });

  it("simctl/lsof 挂了不炸——回空列表（残留审计是旁路，不能拖垮主流程）", async () => {
    const residue = createLocalResidue(new LiveGroupRegistry(), async () => {
      throw new Error("no simctl");
    });
    const snap = await residue.snapshot();
    expect(snap.simulators).toEqual([]);
    expect(snap.ports).toEqual([]);
  });
});

describe("createLocalResidue.cleanup", () => {
  it("simulators 走 simctl shutdown；已消失标 note 不算错", async () => {
    const calls: string[] = [];
    const residue = createLocalResidue(new LiveGroupRegistry(), async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("shutdown")) throw new Error("Unable to shutdown");
      return "";
    });
    const r = await residue.cleanup({
      detector: "simulators", id: "AAA", label: "iPhone 17",
      confidence: "suspected", cleanupHint: "simctl shutdown AAA",
    });
    expect(calls.some((c) => c.includes("simctl shutdown AAA"))).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/已消失|失败/);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/world/residueLocal.test.ts`
Expected: FAIL with "Cannot find module .../residueLocal"

- [ ] **Step 3: 实现 residueLocal.ts**

要点：
- 默认 runCmd 用 child_process spawn（world 内模块允许），5s 超时，非零 exit 抛错
- snapshot：`xcrun simctl list devices -j` → 遍历 devices，`state === "Booted"` 收集，runtime 从 key `com.apple.CoreSimulator.SimRuntime.iOS-26-5` 剥成 `iOS 26.5`；`lsof -iTCP -sTCP:LISTEN -P -n` → 跳过表头，split /\s+/，NAME 列取 `:` 后端口数字，去重（同 pid 多行取一）
- 每个探测器独立 try/catch 回空（一个挂不拖另一个）
- cleanup 按 detector 分派：`simulators` → `xcrun simctl shutdown <udid>`（失败 = `{ok:false, note:"已消失或关闭失败"}`）；`process_groups`/owned `ports` → `killGroup(Number(pgid))` + `reg.ackEscaped(pgid)`，探活确认后 `{ok:true}`；suspected `ports` → `{ok:false, note:"仅展示，不提供清理"}`
- localWorld.ts：`opts.liveGroups` 存在时挂 `residue: createLocalResidue(opts.liveGroups)`（没登记表就没归属判定，不挂）

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/world/ tests/shared/`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/world/residueLocal.ts src/world/localWorld.ts tests/world/residueLocal.test.ts
git commit -m "feat(world): LocalWorld residue 实现——simctl/lsof 采集 + 分派清理 (#759)

为什么：runCmd 可注入让解析逻辑全走 fixture（不测真机）；探测器互相独立
try/catch——残留审计是旁路，simctl 缺席的机器不该因此炸主流程。"
```

---

### Task 5: 三个残留事件进 schema

**Files:**
- Modify: `src/session/events.ts`（新接口 ~L595 前、union ~L598、KNOWN_EVENT_TYPES_MAP ~L644）
- Test: `tests/session/residueEvents.test.ts`

**Interfaces:**
- Consumes: Task 3 `ResidueSnapshot`/`ResidueItem`/`CleanupResult`（from `../shared/residue.js`）
- Produces: `ResidueBaselineEvent`/`ResidueDetectedEvent`/`ResidueCleanedEvent` + `pendingResidue(events: SessionEvent[]): ResidueItem[]`（差集重放，导出自 events.ts 或新建 `src/session/residueProjection.ts`——按仓里投影函数放哪跟哪，grep `deriveMessages` 定位先例）

- [ ] **Step 1: 写失败测试（差集重放）**

```ts
// tests/session/residueEvents.test.ts
import { describe, it, expect } from "vitest";
import { pendingResidue } from "../../src/session/residueProjection.js";
import type { SessionEvent } from "../../src/session/events.js";

const item = (id: string) => ({
  detector: "simulators" as const, id, label: id,
  confidence: "suspected" as const, cleanupHint: `simctl shutdown ${id}`,
});
const base = { sessionId: "s1", ts: 0 };

describe("pendingResidue", () => {
  it("detected 减 cleaned = 差集；重复 detected 不重复计", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA"), item("BBB")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: true }, ignorable: true },
      { ...base, seq: 3, type: "residue_detected", items: [item("BBB")], ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events).map((i) => i.id)).toEqual(["BBB"]);
  });

  it("清理失败但已消失（ok:false + note）也算清掉——别永远挂着", () => {
    const events = [
      { ...base, seq: 1, type: "residue_detected", items: [item("AAA")], ignorable: true },
      { ...base, seq: 2, type: "residue_cleaned", item: item("AAA"), result: { id: "AAA", ok: false, note: "已消失" }, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(pendingResidue(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/session/residueEvents.test.ts`
Expected: FAIL with "Cannot find module .../residueProjection"

- [ ] **Step 3: 实现事件 + 投影**

events.ts 新增（BackgroundTaskStartedEvent 后面，注释风格照抄它——都是「审计注记，模型不消费」）：

```ts
/** 残留审计三兄弟（issue #759）。全部 ignorable：审计注记，模型不消费，
    旧版本跳过照常重放。写入时必须带 ignorable: true */
export interface ResidueBaselineEvent extends SessionEventBase {
  type: "residue_baseline";
  snapshot: ResidueSnapshot;
}
export interface ResidueDetectedEvent extends SessionEventBase {
  type: "residue_detected";
  items: ResidueItem[];
}
export interface ResidueCleanedEvent extends SessionEventBase {
  type: "residue_cleaned";
  item: ResidueItem;
  result: CleanupResult;
}
```

三处登记：union 加三行；KNOWN_EVENT_TYPES_MAP 加三键；import 类型 from `../shared/residue.js`。

`src/session/residueProjection.ts`：

```ts
import type { SessionEvent } from "./events.js";
import type { ResidueItem } from "../shared/residue.js";

/** detected 减 cleaned 的差集（issue #759）：app 上次退出时没清的树外残留，
    下次启动从日志重放出来。key = detector:id；cleaned 无论 ok 与否都算清
    ——ok:false 的 note 是「已消失」类，永远挂着比漏一次更糟 */
export function pendingResidue(events: SessionEvent[]): ResidueItem[] {
  const pending = new Map<string, ResidueItem>();
  for (const e of events) {
    if (e.type === "residue_detected")
      for (const it of e.items) pending.set(`${it.detector}:${it.id}`, it);
    else if (e.type === "residue_cleaned")
      pending.delete(`${e.item.detector}:${e.item.id}`);
  }
  return [...pending.values()];
}
```

- [ ] **Step 4: 跑测试确认绿 + typecheck**

Run: `npm test`
Expected: 全绿（union 变了，KNOWN_EVENT_TYPES_MAP 的 Record 类型会强制三键齐全——漏一个 typecheck 就红）

- [ ] **Step 5: Commit**

```bash
git add src/session/events.ts src/session/residueProjection.ts tests/session/residueEvents.test.ts
git commit -m "feat(events): residue_baseline/detected/cleaned 三事件 + 差集投影 (#759)

为什么：树外残留（simulator）app 退出时不杀，落日志下次启动重放差集再弹清单
——孤儿 sim 攒 4 天的事故改为下次开 app 第一眼看见。全 ignorable：审计注记。"
```

---

### Task 6: 主进程接线（装配 + 三触发点）

**Files:**
- Modify: `src/main/index.ts`（四处，用 grep 锚点定位）
- Test: `tests/main/residueWiring.test.ts`（若 index.ts 装配不可单测——看仓里 tests/main/ 有没有先例；没有则本 task 的验证 = typecheck + 手动验收清单，把手动步骤写进 PR 描述）

**Interfaces:**
- Consumes: Task 2 `LiveGroupRegistry`、Task 4（world.residue）、Task 5 三事件 + `pendingResidue`
- Produces: 主进程持有 `const liveGroups = new LiveGroupRegistry()`（单例，随 createLocalWorld 传入）；事件按既有 appendEvent 路径落盘

四处接线（每处先 grep 锚点再改）：

- [ ] **Step 1: 装配处传 liveGroups**

锚点：`grep -n "createLocalWorld(" src/main/index.ts`。在装配参数里加 `liveGroups`（模块级单例——进程组是 app 级资源，不随 session 分家）。

- [ ] **Step 2: session 创建落 baseline**

锚点：`grep -n "session_created" src/main/index.ts` 找落事件处。session 建成后：

```ts
// 残留基线（issue #759）：异步拍，拍完落事件；失败静默——审计旁路不拖开工
void world.residue?.snapshot().then((snapshot) => {
  appendEvent(sessionId, { type: "residue_baseline", snapshot, ignorable: true });
}).catch(() => {});
```
（appendEvent 的真名/签名以锚点处既有调用为准，照抄旁边的写法。）

- [ ] **Step 3: turn 收口查 escaped + 归档全量 diff**

锚点：`grep -n "turn_ended\|archiveSession" src/main/index.ts`。
- turn 收口：`liveGroups.escaped()` 有新增（对比上次已落 detected 的差集，用 `pendingResidue` 判重）→ 落 `residue_detected`（只含 process_groups 条目）
- archiveSession 处理器（注释说「归档顺带注销活资源」——同一位置）：取 baseline（重放日志里最后一条 residue_baseline）+ 现拍 snapshot + `diffResidue(baseline, now, liveGroups.escaped())` → 非空落 `residue_detected`，并推给渲染层弹清单（推送通道跟旁边活资源注销的既有推送走同一路，grep 锚点处怎么推就怎么推）

- [ ] **Step 4: before-quit 收尸 + 启动重放**

锚点：`src/main/index.ts:3477` 的 `app.on("before-quit"`。加 `liveGroups.sweepAll()`（owned 组静默清，无弹窗）。
启动侧：boot 流程（`grep -n "listSessions\|boot" src/main/index.ts` 的 boot handler）对每个未归档 session `pendingResidue(events)` 非空 → 逐项探活（sim：现拍 snapshot 看 udid 还在不在 booted 里；组：`groupAlive`）→ 仍活着的合并进 BootInfo 新可选字段 `pendingResidue?: ResidueItem[]`（`src/shared/shellBridge.ts` 的 BootInfo 加可选字段，旧渲染层零改动）

- [ ] **Step 5: typecheck + commit**

Run: `npm test`
Expected: 绿

```bash
git add src/main/index.ts src/shared/shellBridge.ts
git commit -m "feat(main): 残留三触发点接线——baseline/turn 收口/归档 diff/退出收尸/启动重放 (#759)

为什么：owned 进程组退出静默清（自己登记的无误杀可能）；树外残留不杀落日志，
下次启动重放差集探活后进 BootInfo，UI 第一眼弹「上次残留」。"
```

---

### Task 7: ShellBridge + IPC + preload

**Files:**
- Modify: `src/shared/shellBridge.ts`（接口 + CHANNELS）、`src/preload/index.ts`、`src/main/index.ts`（两个 ipcMain.handle）
- Test: typecheck 即验证（bridge 三件套是纯管道，仓里先例如 liveBackgroundTasks 也不单测管道本身）

**Interfaces:**
- Produces:

```ts
// ShellBridge 新增（liveBackgroundTasks 旁边，注释风格同款）
/** 当前会话此刻的残留清单（issue #759）：escaped 组现查 + 日志差集探活合并。
    审计旁路：world 无 residue 能力时回空数组 */
residueList(sessionId: string): Promise<ResidueItem[]>;
/** 清理选中项，逐项落 residue_cleaned，返回逐项结果（失败=已消失，不算错） */
residueClean(sessionId: string, itemIds: string[]): Promise<CleanupResult[]>;
```

- [ ] **Step 1: shellBridge.ts 加两方法 + CHANNELS 两键**（CHANNELS 定义处 grep `residue` 无碰撞，按字母序插入）
- [ ] **Step 2: preload/index.ts 两行透传**（照抄 liveBackgroundTasks 行）
- [ ] **Step 3: main/index.ts 两个 handle**：residueList = `diffResidue(最后 baseline, 现拍, escaped)` 与 `pendingResidue` 合并去重（key = detector:id）；residueClean = 逐项 `world.residue.cleanup(item)` + 落 `residue_cleaned`，suspected ports 直接回 `{ok:false, note:"仅展示"}`
- [ ] **Step 4: Run `npm test`** — 绿
- [ ] **Step 5: Commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(bridge): residueList/residueClean 走 ShellBridge (#759)"
```

---

### Task 8: 渲染层清单面板

**Files:**
- Create: `src/renderer/src/components/ResiduePanel.tsx`
- Modify: 挂载点按既有面板先例（`grep -rn "liveBackgroundTasks" src/renderer` 找后台任务面板怎么挂、怎么被 boot 数据触发，照抄挂法）
- Test: 仓里渲染层测试先例 `ls tests/renderer` 有则写渲染测试（testing-library 渲染 items 断言勾选默认值），无则 Playwright/手动验收，步骤写进 PR

**Interfaces:**
- Consumes: `window.bridge.residueList/residueClean`（preload 暴露名 grep `contextBridge.exposeInMainWorld` 确认）、`BootInfo.pendingResidue`

- [ ] **Step 1: ResiduePanel 组件**

```tsx
// 残留清单（issue #759）：按 detector 分组；owned 默认勾选、suspected 默认不勾
// （用户可能故意留着 dev server）。一键清逐项走 residueClean，失败项标「已消失」。
// shadcn/ui + Tailwind（ADR-0010：新增 UI 即日遵守）
export function ResiduePanel({ sessionId, items, onDone }: {
  sessionId: string;
  items: ResidueItem[];
  onDone: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.confidence === "owned").map((i) => i.id))
  );
  const [results, setResults] = useState<Map<string, CleanupResult>>(new Map());
  const clean = async () => {
    const res = await window.bridge.residueClean(sessionId, [...checked]);
    setResults(new Map(res.map((r) => [r.id, r])));
    if (res.every((r) => r.ok || r.note)) onDone();
  };
  // 渲染：detector 分组标题（"进程组 / 模拟器 / 端口"）+ Checkbox 行
  // （label + cleanupHint 灰字 + suspected 加「可能是你自己开的」badge）
  // + 底部 Button「清理选中(N)」。空 items 不渲染。细节按 shadcn Dialog/Checkbox 常规。
}
```

- [ ] **Step 2: 两个触发挂载**：boot 后 `BootInfo.pendingResidue` 非空 → 弹「上次残留」；archiveSession 的推送到达 → 弹本次清单（推送监听照抄后台任务面板对完成推送的监听写法）
- [ ] **Step 3: 手动验收**（写进 PR 描述）：
  1. bash 工具跑 `python3 -m http.server 9999 & disown` → turn 结束角标出现，归档弹清单，port:9999 显示 owned 已勾
  2. bash 工具跑 `xcrun simctl boot <某 UDID>` → 归档清单出现 suspected sim，勾选清理后 `simctl list | grep Booted` 为空
  3. 留一个残留直接退 app → 重启后弹「上次残留」
- [ ] **Step 4: Run `npm test`** — 绿
- [ ] **Step 5: Commit + PR**

```bash
git add src/renderer/src/components/ResiduePanel.tsx <挂载点文件>
git commit -m "feat(ui): 残留清单面板——owned 默认勾选一键清，boot 弹上次残留 (#759)"
gh pr create --title "feat: agent 副作用生命周期——进程组硬杀 + 残留审计/收尸 (#759)" \
  --body "Closes #759. Spec: docs/superpowers/specs/2026-08-29-agent-residue-lifecycle-design.md"
```

---

## Self-Review 记录

- Spec 覆盖：第 1 节→Task 1；第 2 节→Task 2；第 3 节→Task 3/4；第 4 节事件→Task 5、触发点→Task 6、UI→Task 7/8；第 5 节测试分散进各 task ✓
- 类型一致：`killGroup(pgid, signal?)` / `LiveGroupRegistry.escaped()` / `diffResidue(before, after, escaped)` / `pendingResidue(events)` 各 task 引用一致 ✓
- 已知不确定点（executor 按锚点现场核）：Task 2 可能的循环 import（解法已写）；Task 6 appendEvent 真名、archiveSession 推送通道；Task 8 面板挂载点——全部给了 grep 锚点 + 「照抄旁边」原则
