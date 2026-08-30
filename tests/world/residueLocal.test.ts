import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { createLocalResidue } from "../../src/world/residueLocal.js";
import { LiveGroupRegistry } from "../../src/world/liveGroups.js";

// 本仓 idiom（tests/world/localWorldProcessGroup.test.ts）：不 mock kill，起真进程拿真
// pgid，用 process.kill(pid, 0) 探真活——killGroup/groupAlive 底层就是 process.kill，
// mock 掉等于没测到真正会炸的那条线。
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

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
    // review C1c：结构化判据——shutdown 失败绝大多数是"这台早就不在了"
    expect(r.kind).toBe("gone");
  });

  it("simulators 关成功 = kind:'cleaned'（review C1c）", async () => {
    const residue = createLocalResidue(new LiveGroupRegistry(), async () => "");
    const r = await residue.cleanup({
      detector: "simulators", id: "AAA", label: "iPhone 17",
      confidence: "suspected", cleanupHint: "simctl shutdown AAA",
    });
    expect(r).toEqual({ id: "AAA", ok: true, kind: "cleaned" });
  });

  it("suspected 端口（仅展示）= kind:'skipped'，不是失败也不是成功（review C1c）", async () => {
    const residue = createLocalResidue(new LiveGroupRegistry());
    const r = await residue.cleanup({
      detector: "ports", id: "port:9999", label: "python3:9999",
      confidence: "suspected", cleanupHint: "仅展示，不提供清理",
    });
    expect(r.kind).toBe("skipped");
    expect(r.ok).toBe(false);
  });

  it("拿不到 pgid = kind:'failed'——一个信号都没发出去，别当成清完了（review C1c）", async () => {
    const residue = createLocalResidue(new LiveGroupRegistry());
    const r = await residue.cleanup({
      detector: "ports", id: "port:9999", label: "python3:9999",
      confidence: "owned", cleanupHint: "（这句 hint 里没有 pgid）",
    });
    expect(r.kind).toBe("failed");
    expect(r.ok).toBe(false);
  });

  it(
    "process_groups owned：真杀真进程组，escaped 台账里也摘干净",
    async () => {
      const child = spawn("sleep 100", { shell: true, detached: true });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sleep 100", "detached");
      reg.noteClosed(pgid); // 组还活着 → 进 escaped（模拟"shell 死了组没死"）
      expect(reg.escaped().map((g) => g.pgid)).toContain(pgid);

      const residue = createLocalResidue(reg);
      const r = await residue.cleanup({
        detector: "process_groups", id: String(pgid), label: "sleep 100",
        confidence: "owned", cleanupHint: `kill 进程组 ${pgid}`,
      });

      expect(r.ok).toBe(true);
      expect(r.kind).toBe("cleaned"); // review C1c：确认死亡之后才敢说 cleaned
      expect(alive(pgid)).toBe(false);
      expect(reg.escaped().map((g) => g.pgid)).not.toContain(pgid);
    },
    10_000
  );

  it(
    "owned port：同一条 pgid 解析路径，走 ports 探测器一样能真杀",
    async () => {
      const child = spawn("sleep 100", { shell: true, detached: true });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sleep 100", "detached");
      reg.noteClosed(pgid);
      expect(reg.escaped().map((g) => g.pgid)).toContain(pgid);

      const residue = createLocalResidue(reg);
      const r = await residue.cleanup({
        detector: "ports", id: `port:${pgid}`, label: `sleep:${pgid}`,
        confidence: "owned", cleanupHint: `kill 进程组 ${pgid}`,
      });

      expect(r.ok).toBe(true);
      expect(r.kind).toBe("cleaned");
      expect(alive(pgid)).toBe(false);
      expect(reg.escaped().map((g) => g.pgid)).not.toContain(pgid);
    },
    10_000
  );

  // issue #759 review C1f：条目自带 pgid 时优先用它，cleanupHint 只作 fallback。
  // 这里故意给一句**对不上**的 hint（指向一个不存在的组），杀成功就说明走的是 pgid
  it(
    "优先用 item.pgid，cleanupHint 只是 fallback（review C1f）",
    async () => {
      const child = spawn("sleep 100", { shell: true, detached: true });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sleep 100", "detached");
      reg.noteClosed(pgid);

      const residue = createLocalResidue(reg);
      const r = await residue.cleanup({
        detector: "process_groups", id: String(pgid), label: "sleep 100",
        confidence: "owned",
        cleanupHint: "kill 进程组 999999", // 对不上的旧文案：走它就杀不到
        pgid,
      });

      expect(r.kind).toBe("cleaned");
      expect(alive(pgid)).toBe(false);
    },
    10_000
  );

  // issue #759 review C1a/C1b —— Critical 的核心：不吃 SIGTERM 的组。
  // 老实现只发一发 SIGTERM 就走人，且**探活之前**就 ackEscaped，于是
  // ①进程还活着 ②台账已经销了 ③三处消费方一致把它当"清完了"抹掉。
  it(
    "组忽略 SIGTERM：宽限过后 SIGKILL 补刀，仍算 cleaned，台账才销",
    async () => {
      // 真·SIGTERM 免疫的组：sh 自己 trap 掉 TERM，循环里的 sleep 是短命子进程
      // ——组收到 SIGTERM，sh 忽略、当前那条 sleep 死掉，下一轮马上补上，组照样活。
      // 单写 `trap '' TERM; sleep 100` 不够：那条 sleep 自己不免疫，它一死 sh 就退了
      const child = spawn("trap '' TERM; while true; do sleep 0.2; done", {
        shell: true, detached: true,
      });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "loop", "detached");
      reg.noteClosed(pgid);

      // 等 shell 真的跑到 `trap` 那一行：spawn 返回时它还没开始执行，
      // 这时候发 SIGTERM 打的是一个还没设好陷阱的默认处置的进程
      await new Promise((r) => setTimeout(r, 300));
      // 先自证这个组确实吃不动 SIGTERM，否则这条用例测的就不是补刀那条路
      process.kill(-pgid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 400));
      expect(alive(pgid)).toBe(true);

      // 宽限注入成 300ms：这条用例不该真等默认的 KILL_GRACE_MS（5 秒）
      const residue = createLocalResidue(reg, undefined, 300);
      const r = await residue.cleanup({
        detector: "process_groups", id: String(pgid), label: "loop",
        confidence: "owned", cleanupHint: `kill 进程组 ${pgid}`, pgid,
      });

      expect(r.kind).toBe("cleaned"); // 补刀之后确认死亡才回 cleaned
      expect(alive(pgid)).toBe(false);
      expect(reg.escaped().map((g) => g.pgid)).not.toContain(pgid);
    },
    15_000
  );

  // review C1b：确认不了死亡就**不能**销台账——销了等于把还在跑的组从
  // 下次重放里抹掉，用户再也看不到它
  it(
    "杀不掉：kind:'failed' + escaped 台账**不销**（否则这条残留永远消失）",
    async () => {
      const child = spawn("trap '' TERM; sleep 100", { shell: true, detached: true });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sleep 100", "detached");
      reg.noteClosed(pgid);

      // 假 kill：什么都不做，模拟"信号发了但进程不死"（真 SIGKILL 杀得掉，
      // 造不出稳定的"连 SIGKILL 都杀不掉"，所以这条用 mock 打确认路径）
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: string | number
      ) => {
        if (signal === 0) return true; // 探活：永远说"还活着"
        return true; // 杀：什么都不做
      }) as unknown as typeof process.kill);
      try {
        const residue = createLocalResidue(reg, undefined, 200);
        const r = await residue.cleanup({
          detector: "process_groups", id: String(pgid), label: "sleep 100",
          confidence: "owned", cleanupHint: `kill 进程组 ${pgid}`, pgid,
        });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe("failed");
        expect(r.note).toMatch(/仍存活/);
        // 台账里还挂着——下次重放照样报给用户
        expect(reg.escaped().map((g) => g.pgid)).toContain(pgid);
        // 两发信号都出手了：SIGTERM 之后确实补了 SIGKILL
        expect(killSpy.mock.calls.some(([, sig]) => sig === "SIGTERM")).toBe(true);
        expect(killSpy.mock.calls.some(([, sig]) => sig === "SIGKILL")).toBe(true);
      } finally {
        killSpy.mockRestore();
        try { process.kill(-pgid, "SIGKILL"); } catch { /* 已死 */ }
      }
    },
    15_000
  );

  it(
    "组本来就没了：kind:'gone'，一个信号都不发，台账照样销",
    async () => {
      const child = spawn("sleep 100", { shell: true, detached: true });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sleep 100", "detached");
      reg.noteClosed(pgid);
      // 先在测试里把它杀干净，再让 cleanup 去"清"一个已经不在的组
      process.kill(-pgid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));

      const residue = createLocalResidue(reg);
      const r = await residue.cleanup({
        detector: "process_groups", id: String(pgid), label: "sleep 100",
        confidence: "owned", cleanupHint: `kill 进程组 ${pgid}`, pgid,
      });
      expect(r.kind).toBe("gone");
      expect(r.ok).toBe(true);
      expect(reg.escaped().map((g) => g.pgid)).not.toContain(pgid);
    },
    10_000
  );
});
