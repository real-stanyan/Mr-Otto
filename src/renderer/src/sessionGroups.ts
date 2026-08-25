import type { SessionSummary } from "../../shared/shellBridge.js";

/** 一个工程文件夹下的会话堆 */
export interface SessionGroup {
  /** workspace 绝对路径——分组键,也是 UI 折叠状态的 key */
  workspace: string;
  /** 侧栏显示用的短名(路径末段);路径以 / 结尾时回退到上一段 */
  label: string;
  /** 组内会话,lastTs 倒序 */
  sessions: SessionSummary[];
  /** 组内最近一条会话的 lastTs——展示用,不参与组序 */
  lastTs: number;
  /** 组内最早会话的 startedTs——工程首次使用时间,组序按它排 */
  firstTs: number;
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
    归档会话(archived,ADR-0087)也不进组:它们收在侧栏底部的「已归档」区,
    这里滤掉让 ⌘K 搜索/子会话范围等所有消费方一并不见它们。
    组序 = 组内最早会话 startedTs 倒序(新工程进场排最上,之后位置定死,
    不随组内会话完成/活动而蹿顶——会话完成只在组内上移),组内 = lastTs 倒序。 */
export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionGroup[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.workspace === null || s.spawnedFrom !== null || s.archived) continue;
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
        firstTs: Math.min(...list.map((s) => s.startedTs)),
      };
    })
    .sort((a, b) => b.firstTs - a.firstTs);
}
