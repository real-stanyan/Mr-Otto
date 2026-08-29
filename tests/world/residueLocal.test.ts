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
