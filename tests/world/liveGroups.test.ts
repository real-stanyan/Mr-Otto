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
