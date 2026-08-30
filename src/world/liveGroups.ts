// src/world/liveGroups.ts —— agent 起的进程组的存活登记表（issue #759）。
// 「谁还真的活着」的唯一判据在主进程内存里（事件日志重放不出进程存活），
// 与 backgroundTasks 的 liveMap 同一哲学。world 内模块：允许贴着进程 API。
import { killGroup, groupAlive, KILL_GRACE_MS } from "./localWorld.js";

export interface LiveGroup {
  pgid: number;
  cmd: string;        // 头 200 字符
  startedAt: number;  // epoch ms
  kind: "exec" | "detached";
}

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

  live(): LiveGroup[] {
    return [...this.liveMap.values()];
  }

  /** 读时顺手剔除已自然死掉的（escaped 里的组可能自己退出了） */
  escaped(): LiveGroup[] {
    for (const [pgid] of this.escapedMap) if (!groupAlive(pgid)) this.escapedMap.delete(pgid);
    return [...this.escapedMap.values()];
  }

  ackEscaped(pgid: number): void {
    this.escapedMap.delete(pgid);
  }

  /** 收尸。
      默认：套用 localWorld 的超时模式——SIGTERM 宽限后 SIGKILL 补刀。
      `immediate`：SIGTERM 之后当场补 SIGKILL，不留 timer。**app 退出那一路
      必须用它**：`before-quit` 一返回 Electron 就继续退出流程，宽限用的
      `setTimeout(...).unref()` 永远等不到触发，SIGKILL 补刀等于不存在，
      trap 了 TERM 的组会活成孤儿（同 index.ts 里 mcpHub.closeAll 那段注释
      讲的是同一个坑）。不给宽限也安全：这张表里全是本 app 自己起的组，
      没有误杀的可能。 */
  sweepAll(opts: { immediate?: boolean } = {}): void {
    for (const g of [...this.liveMap.values(), ...this.escapedMap.values()]) {
      killGroup(g.pgid, "SIGTERM");
      if (opts.immediate) {
        // 同步补刀：调用方（正在退出的 app）活不到 timer 触发那一刻
        if (groupAlive(g.pgid)) killGroup(g.pgid, "SIGKILL");
      } else {
        // app 正在退出，timer 用 .unref() 不拖住事件循环
        setTimeout(() => { if (groupAlive(g.pgid)) killGroup(g.pgid, "SIGKILL"); }, KILL_GRACE_MS).unref();
      }
    }
    this.liveMap.clear();
    this.escapedMap.clear();
  }
}
