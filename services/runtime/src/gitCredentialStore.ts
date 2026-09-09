// gitCredentialStore —— 一个团队能认证哪几台 Git 主机，以及那几把 token（#1103）。
//
// **落在 runtime 自己这份文件里，不搬 Supabase**，因为这条不变量：**token 从不
// 下行**。放进 Supabase 就要么给 `authenticated` 开 select（token 到了每个成员的
// 客户端），要么搞列级授权 + 只让 service key 读——后者能做，但为一个已经工作的
// 东西付一次 migration + RLS 的复杂度，换不到任何东西。
//
// 已知代价：这份数据只活在那台 VPS 的一个文件里，**没有备份**，机器没了要重填。
// 它替代的 workspace-config.json 也是如此，不是本次新增。
//
// 落盘纪律照抄 src/main/mcpAuthStore.ts:89-90：**mode 只在新建时生效，已有文件
// 要再补一刀 chmod**。这份文件是所有团队共用的一份，泄漏面比单机凭据库大。

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CsGitHost } from "../../../src/shared/remote/cloudSession.js";

interface HostRecord {
  token: string;
  addedBy: string;
  addedAt: number;
}

/** 一个团队的全部凭据：主机 → 那一把。主机名进来之前已经过 `normalizeGitHost` */
type WorkspaceRecord = Record<string, HostRecord>;

export interface GitCredentialStore {
  /** 这个团队能认证哪几台主机。**回的东西里没有 token**——它从不下行。
      按 host 排序，好让界面上那张表不会因为存的顺序而跳来跳去 */
  hosts(workspaceId: string): CsGitHost[];
  /** 取一台主机的 token。`clone_repo` / `git_push` 用它。null = 没配这台 */
  token(workspaceId: string, host: string): string | null;
  /** 存一把（同一台主机再存 = 换新）。`addedBy` 是 owner 的 uid */
  put(workspaceId: string, host: string, token: string, addedBy: string): void;
  /** 删掉一台主机。删不存在的那台不是错误——「现在没有了」是同一个结果 */
  remove(workspaceId: string, host: string): void;
  /** 团队整个没了：它那几把 token 也得跟着没（#835④ 的同一条不变量）。
      调用点在 runReconcile——容器+卷真的删掉的那一刻 */
  purge(workspaceId: string): void;
}

export function createGitCredentialStore(path: string): GitCredentialStore {
  function loadAll(): Record<string, WorkspaceRecord> {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      // 形状不对就当空的重来：这份文件只有我们自己写，读不懂 = 它坏了，
      // 而拿一份半懂的记录去 clone 比重新配一次糟糕得多
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, WorkspaceRecord>)
        : {};
    } catch {
      return {};
    }
  }

  function writeAll(all: Record<string, WorkspaceRecord>): void {
    // mode 只在新建时生效，已有文件要再补一刀（照抄 mcpAuthStore 的纪律）
    writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  return {
    hosts(workspaceId) {
      const ws = loadAll()[workspaceId] ?? {};
      return Object.entries(ws)
        .map(([host, r]) => ({ host, addedBy: r.addedBy, addedAt: r.addedAt }))
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    },

    token(workspaceId, host) {
      return loadAll()[workspaceId]?.[host]?.token ?? null;
    },

    put(workspaceId, host, token, addedBy) {
      const all = loadAll();
      const ws = all[workspaceId] ?? {};
      ws[host] = { token, addedBy, addedAt: Date.now() };
      all[workspaceId] = ws;
      writeAll(all);
    },

    remove(workspaceId, host) {
      const all = loadAll();
      const ws = all[workspaceId];
      if (!ws || ws[host] === undefined) return;
      delete ws[host];
      // 空了就把这个团队整条也删掉，别留一个 `{}` 在文件里长期占着
      if (Object.keys(ws).length === 0) delete all[workspaceId];
      else all[workspaceId] = ws;
      writeAll(all);
    },

    purge(workspaceId) {
      const all = loadAll();
      if (all[workspaceId] === undefined) return;
      delete all[workspaceId];
      writeAll(all);
    },
  };
}
