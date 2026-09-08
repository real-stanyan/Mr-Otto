// 连接器 tab 第二组「代码仓库」的纯逻辑（#1104）。
//
// 判据留在这里而不是组件的 `useMemo`：留在那儿就没有保鲜期（同 ADR-0244 那条）。

import { formatWorkTime } from "./workFilesView.js";
import type { CsGitHost } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceMemberRow } from "../../../shared/workspaces.js";

export interface GitHostRow {
  host: string;
  /** 「由某某添加 · 9/8」。添加者已经退群 / 查不到 = 只写日期，**不写 uid**——
      一串 uuid 对读的人没有任何意义，而「由 xxx 添加」那半句本来就只是背景 */
  meta: string;
  /** owner 才画删除钮。判据与 `sandbox_approval` 逐字相同（ADR-0243） */
  canRemove: boolean;
}

/** 一台主机一行。清单本身已经按 host 排好（服务端那侧排的），这里不再排——
    两处各排一次的话，哪天服务端换了口径界面会跟着变而没人知道为什么 */
export function gitHostRows(
  hosts: readonly CsGitHost[],
  members: readonly WorkspaceMemberRow[],
  isOwner: boolean,
  now: number,
): GitHostRow[] {
  const labelOf = new Map(members.map((m) => [m.uid, m.label]));
  return hosts.map((h) => {
    const who = labelOf.get(h.addedBy);
    const when = formatWorkTime(h.addedAt, now);
    return {
      host: h.host,
      meta: who === undefined ? when : `由 ${who} 添加 · ${when}`,
      canRemove: isOwner,
    };
  });
}

/** 这一组该说哪句话，`null` = 有内容可画。**三种「空」不是一回事**：
    · `null` 清单 = 这一刻读不到（协议 15 的 `gitHosts: null`）
    · `[]` = 一台都没配
    · 还没查 = 正在读
    合并它们就是把「读不到」画成「没有」（同 ADR-0243 对 `sandbox_approval` 的处置） */
export function gitHostsNotice(
  hosts: readonly CsGitHost[] | null | undefined,
  loading: boolean,
): { text: string; tone: "muted" | "err" } | null {
  if (loading) return { text: "正在读取…", tone: "muted" };
  if (hosts === null || hosts === undefined) {
    return { text: "这一刻读不到凭据清单。", tone: "err" };
  }
  if (hosts.length === 0) {
    return { text: "还没有配过。私有仓库要先在这里存一把访问令牌，水獭才拉得动。", tone: "muted" };
  }
  return null;
}
