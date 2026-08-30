import type { SessionEvent } from "./events.js";
import { residueSettled, type ResidueItem } from "../shared/residue.js";

/** detected 减 cleaned 的差集（issue #759）：app 上次退出时没清的树外残留，
    下次启动从日志重放出来。key = detector:id。
    **只有真了结的 cleaned 才删**（review C1d）：判据是 result.kind 而不是
    "有没有 ok/note"——`kind: "failed"`（信号发了、进程还活着）必须留在表里，
    原来那句"cleaned 无论 ok 与否都算清"把仍在运行的进程组从清单上抹掉了，
    用户再也看不到它。cleaned/gone/skipped 三档才算了结，无 kind 的旧日志按
    已清对待（向后兼容，判据统一在 shared/residue.ts 的 residueSettled） */
export function pendingResidue(events: SessionEvent[]): ResidueItem[] {
  const pending = new Map<string, ResidueItem>();
  for (const e of events) {
    if (e.type === "residue_detected")
      for (const it of e.items) pending.set(`${it.detector}:${it.id}`, it);
    else if (e.type === "residue_cleaned" && residueSettled(e.result))
      pending.delete(`${e.item.detector}:${e.item.id}`);
  }
  return [...pending.values()];
}
