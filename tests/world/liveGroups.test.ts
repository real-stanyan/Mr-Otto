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

  it(
    "SIGTERM 无视者：sweepAll 宽限后补 SIGKILL",
    async () => {
      // 进程陷阱 SIGTERM，只有 SIGKILL 才能杀死
      const child = spawn("sh -c 'trap \"\" TERM; sleep 100'", {
        shell: true,
        detached: true,
      });
      const pgid = child.pid!;
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "sh -c 'trap \"\" TERM; sleep 100'", "exec");
      reg.noteClosed(pgid);
      reg.sweepAll();
      // 给宽限时间 + 缓冲（确保 setTimeout 执行）
      await new Promise((r) => setTimeout(r, 6_000));
      // 进程现在应该已经被 SIGKILL 杀死
      expect(reg.escaped()).toHaveLength(0);
      expect(reg.live()).toHaveLength(0);
    },
    10_000
  );
});
