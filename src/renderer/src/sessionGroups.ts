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
    归档会话(archived,ADR-0087)也不进组:它们走 groupArchivedByWorkspace 那一屏
    (ADR-0089),这里滤掉让 ⌘K 搜索/子会话范围等所有消费方一并不见它们。
    side chat 会话(sideChat,issue #502)同理不进组:/btw 浮窗自己管历史,
    混进侧栏/⌘K 会让人以为能当普通会话打开——打开了主时间线就成了浮窗的时间线。
    组序 = 组内最早会话 startedTs 倒序(新工程进场排最上,之后位置定死,
    不随组内会话完成/活动而蹿顶——会话完成只在组内上移),组内 = lastTs 倒序。 */
export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionGroup[] {
  return buildGroups(
    sessions.filter((s) => !s.archived && s.spawnedFrom === null && s.workspace !== null && !s.sideChat)
  );
}

/** 归档视图的分组结果:能归组的按工程分,没 workspace 的史前会话单独一摞 */
export interface ArchivedGroups {
  groups: SessionGroup[];
  /** workspace 为 null 的归档会话——归不进任何工程,平铺在分组之后 */
  ungrouped: SessionSummary[];
}

/** 已归档会话按工程分组(ADR-0089 那一屏)。和上面同一套组序/组内序规则,
    区别只在筛选面:这里只要 archived 的顶层会话。
    没 workspace 的史前归档会话不塞进"未知"组(那是伪造事实),单独走 ungrouped——
    藏起来就成了看不见也删不掉的库存垃圾,和侧栏里 prehistoric 那一摞同理。 */
export function groupArchivedByWorkspace(sessions: SessionSummary[]): ArchivedGroups {
  const archived = sessions.filter((s) => s.archived && s.spawnedFrom === null && !s.sideChat);
  return {
    groups: buildGroups(archived.filter((s) => s.workspace !== null)),
    ungrouped: archived
      .filter((s) => s.workspace === null)
      .sort((a, b) => b.lastTs - a.lastTs),
  };
}

/** 分组本身:调用方负责筛选,这里只按 workspace 装桶排序(workspace 非 null) */
function buildGroups(sessions: SessionSummary[]): SessionGroup[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const bucket = byDir.get(s.workspace!);
    if (bucket) bucket.push(s);
    else byDir.set(s.workspace!, [s]);
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
