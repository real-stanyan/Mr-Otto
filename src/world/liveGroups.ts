// src/world/liveGroups.ts —— agent 起的进程组的存活登记表（issue #759）。
// 「谁还真的活着」的唯一判据在主进程内存里（事件日志重放不出进程存活），
// 与 backgroundTasks 的 liveMap 同一哲学。world 内模块：允许贴着进程 API。
import { killGroup, groupAlive } from "./localWorld.js";

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

  sweepAll(): void {
    for (const g of [...this.liveMap.values(), ...this.escapedMap.values()])
      killGroup(g.pgid, "SIGTERM");
    this.liveMap.clear();
    this.escapedMap.clear();
  }
}
