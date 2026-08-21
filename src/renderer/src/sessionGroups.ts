import type { SessionSummary } from "../../shared/shellBridge.js";

/** 一个工程文件夹下的会话堆 */
export interface SessionGroup {
  /** workspace 绝对路径——分组键,也是 UI 折叠状态的 key */
  workspace: string;
  /** 侧栏显示用的短名(路径末段);路径以 / 结尾时回退到上一段 */
  label: string;
  /** 组内会话,lastTs 倒序 */
  sessions: SessionSummary[];
  /** 组内最近一条会话的 lastTs——组序就按它排 */
  lastTs: number;
}

/** 路径末段;尾随 / 不算一段(/a/b/ 的名字是 b,不是空串) */
export function folderName(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? path;
}

/** 按 workspace 分组。workspace 为 null 的史前会话不在这里处理——调用方先滤掉,
    因为它们压根没有工程可归,归到"未知"组等于伪造事实。
    子会话(spawnedFrom 非空,ADR-0047)同样不进任何组:它们只能从派出它们的
    父会话时间线那张卡进去,混进侧栏/⌘K 搜索会让人以为能独立打开一个"工程会话"。
    组序 = 组内最近会话时间倒序(最近用过的工程在上),组内也是时间倒序。 */
export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionGroup[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.workspace === null || s.spawnedFrom !== null) continue;
    const bucket = byDir.get(s.workspace);
    if (bucket) bucket.push(s);
    else byDir.set(s.workspace, [s]);
  }
  return [...byDir.entries()]
    .map(([workspace, list]) => {
      const sorted = [...list].sort((a, b) => b.lastTs - a.lastTs);
      return {
        workspace,
        label: folderName(workspace),
        sessions: sorted,
        lastTs: sorted[0]?.lastTs ?? 0,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}
