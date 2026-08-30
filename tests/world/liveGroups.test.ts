import { describe, it, expect } from "vitest";
import { LiveGroupRegistry } from "../../src/world/liveGroups.js";
import { createLocalWorld, groupAlive } from "../../src/world/localWorld.js";
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

  // 真·SIGTERM 无视者：`sh -c 'trap "" TERM; sleep 100'` **不管用**——那条命令
  // 被 SIGTERM 一发就死，用它做夹具的话「补刀」这条路根本没被走到（两个版本
  // 都绿）。node 里显式挂一个空的 SIGTERM 处理器才真的挺得住，实测：
  // SIGTERM 后 alive=true，SIGKILL 后 alive=false
  const spawnTermIgnorer = () =>
    spawn("node -e \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"", {
      shell: true,
      detached: true,
      stdio: "ignore",
    });

  it(
    "SIGTERM 无视者：sweepAll 宽限后补 SIGKILL",
    async () => {
      const child = spawnTermIgnorer();
      const pgid = child.pid!;
      await new Promise((r) => setTimeout(r, 400)); // 等 node 把处理器挂上
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "node -e ...SIGTERM ignorer", "exec");
      reg.noteClosed(pgid);
      reg.sweepAll();
      // 判据用真实进程存活：登记表清空两条路都成立，证不了补刀有没有发生
      await new Promise((r) => setTimeout(r, 500));
      expect(groupAlive(pgid)).toBe(true); // 宽限内只挨了 SIGTERM，还活着
      await new Promise((r) => setTimeout(r, 6_000)); // 越过 KILL_GRACE_MS
      expect(groupAlive(pgid)).toBe(false); // timer 触发，SIGKILL 补刀
    },
    15_000
  );

  it(
    "immediate：SIGTERM 无视者当场被 SIGKILL，不依赖 timer（退出那一路的契约）",
    async () => {
      // 这条盯的是 before-quit 的坑：宽限 timer 在 app 退出时永远等不到触发，
      // 所以 immediate 必须在 sweepAll **返回之前**就把组杀掉
      const child = spawnTermIgnorer();
      const pgid = child.pid!;
      await new Promise((r) => setTimeout(r, 400));
      const reg = new LiveGroupRegistry();
      reg.register(pgid, "node -e ...SIGTERM ignorer", "exec");
      reg.noteClosed(pgid);
      expect(groupAlive(pgid)).toBe(true);
      reg.sweepAll({ immediate: true });
      // 不等宽限、不等 timer：只给内核回收 SIGKILL 的一点点时间
      await new Promise((r) => setTimeout(r, 300));
      expect(groupAlive(pgid)).toBe(false);
    },
    15_000
  );
});
