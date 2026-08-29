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
