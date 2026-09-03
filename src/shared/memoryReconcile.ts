// 记忆云同步的对账（#852，spec §6）：本地文件 vs 云端 memory_docs，谁新谁胜。纯函数，
// 主进程用；手机端将来读同一张表时也能用同一份规则。
//
// 「后写胜」是有损的（两台机同时改同一桶，晚的盖早的）——接受：记忆是策展文本
// 不是账本，真丢了 memory_user_edit 里有 before（ADR-0206）。
// 内容相同直接跳过：不比时间——时间戳来自两台钟，内容才是事实。

export interface LocalDoc {
  key: string;
  content: string;
  mtimeMs: number;
}

export interface CloudDoc {
  key: string;
  content: string;
  updatedAtMs: number;
}

export interface ReconcilePlan {
  /** 云端更新 → 写本地 */
  pull: CloudDoc[];
  /** 本地更新 / 云端没有 → 推上去 */
  push: LocalDoc[];
}

export function planReconcile(local: readonly LocalDoc[], cloud: readonly CloudDoc[]): ReconcilePlan {
  const byKeyLocal = new Map(local.map((d) => [d.key, d]));
  const byKeyCloud = new Map(cloud.map((d) => [d.key, d]));
  const pull: CloudDoc[] = [];
  const push: LocalDoc[] = [];
  for (const l of local) {
    const c = byKeyCloud.get(l.key);
    if (!c) {
      push.push(l);
      continue;
    }
    if (c.content === l.content) continue;
    if (c.updatedAtMs > l.mtimeMs) pull.push(c);
    else push.push(l);
  }
  for (const c of cloud) {
    if (!byKeyLocal.has(c.key)) pull.push(c);
  }
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  return { pull: pull.sort(byKey), push: push.sort(byKey) };
}
