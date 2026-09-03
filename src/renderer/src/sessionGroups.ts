import type { SessionSummary } from "../../shared/shellBridge.js";

/** 一个工程文件夹下的会话堆 */
export interface SessionGroup {
  /** 工程绝对路径——分组键,也是 UI 折叠状态的 key、组头「＋」开新会话的目录。
      = 会话的 projectRoot（独立副本上的会话，ADR-0157）或 workspace（其余）；
      见 projectOf */
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

/** Windows 形状的路径:盘符开头(C:\\…)或 UNC(\\\\server\\share)。
    只对这两种形状把反斜杠当分隔符——POSIX 下反斜杠是合法文件名字符,
    无条件按它切会把 /Users/stan/a\\b 的名字截成 b(issue #606) */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** 路径末段;尾随分隔符不算一段(/a/b/ 的名字是 b,不是空串)。
    Windows 路径按 \\ 和 / 一起切:electron-builder 有 win 目标(dist:win),
    只切 / 的话侧栏和头部会把整条 C:\\Users\\…\\OneDrive 糊成一行 */
export function folderName(path: string): string {
  const segs = path.split(isWindowsPath(path) ? /[\\/]/ : "/").filter((s) => s !== "");
  return segs[segs.length - 1] ?? path;
}

/** 一条会话归哪个工程：独立副本上的会话（ADR-0157）workspace 是
    `<userData>/worktrees/<hash>-<rand>`，按它分组会让同一个项目裂成 N 组、组头是一串
    哈希（issue #692，岛那边是 #690 / ADR-0172）。**组头回答「这是哪个项目」，副本身份
    是行级的事实**——侧栏没理由给出与岛不同的答案。
    折叠状态的持久化键随之从副本路径换成项目路径：主目录会话的键本来就是项目路径，
    不变；副本组原来那些哈希键成了孤儿，不迁移——它们对应的组头本来就没人认得。 */
export function projectOf(s: SessionSummary): string | null {
  return s.projectRoot ?? s.workspace;
}

/** 按工程分组（projectOf）。workspace 为 null 的史前会话不在这里处理——调用方先滤掉,
    因为它们压根没有工程可归,归到"未知"组等于伪造事实。
    子会话(spawnedFrom 非空,ADR-0047)同样不进任何组:它们只能从派出它们的
    父会话时间线那张卡进去,混进侧栏/⌘K 搜索会让人以为能独立打开一个"工程会话"。
    归档会话(archived,ADR-0087)也不进组:它们走 groupArchivedByWorkspace 那一屏
    (ADR-0089),这里滤掉让 ⌘K 搜索/子会话范围等所有消费方一并不见它们。
    组序 = 组内最早会话 startedTs 倒序(新工程进场排最上,之后位置定死,
    不随组内会话完成/活动而蹿顶——会话完成只在组内上移),组内 = lastTs 倒序。 */
export function groupSessionsByWorkspace(sessions: SessionSummary[]): SessionGroup[] {
  return buildGroups(sessions.filter((s) => !s.archived && s.spawnedFrom === null && s.workspace !== null));
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
  const archived = sessions.filter((s) => s.archived && s.spawnedFrom === null);
  return {
    groups: buildGroups(archived.filter((s) => s.workspace !== null)),
    ungrouped: archived
      .filter((s) => s.workspace === null)
      .sort((a, b) => b.lastTs - a.lastTs),
  };
}

/** 分组本身:调用方负责筛选,这里只按工程（projectOf）装桶排序(workspace 非 null) */
function buildGroups(sessions: SessionSummary[]): SessionGroup[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = projectOf(s)!;
    const bucket = byDir.get(key);
    if (bucket) bucket.push(s);
    else byDir.set(key, [s]);
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

/** 任务栏(#559)那一摞:内置 Default 工作区的顶层会话,平铺,lastTs 倒序照原序。
    和 groupSessionsByWorkspace 共用同一条可见性口径——**子会话(spawnedFrom 非空)
    同样不进这一栏**:memory-reviewer / Explore 这些派出去的活跑在父会话的
    workspace 里,而任务栏的会话恰恰都住在内置 Default,于是这一栏是子会话唯一
    漏得出来的口子(表现:侧栏凭空多出一个叫「当前 MEMORY:」的会话,没人开过它)。
    口径写成函数而不是在 App.tsx 里再抄一遍谓词——上一次抄漏的正是这一条。 */
export function taskSessions(sessions: SessionSummary[], builtin: string | null): SessionSummary[] {
  return sessions.filter(
    (s) => !s.archived && s.spawnedFrom === null && s.workspace !== null && s.workspace === builtin
  );
}

/** 任务栏的「已归档」那一摞:同上,只是要 archived 的那半边 */
export function archivedTaskSessions(sessions: SessionSummary[], builtin: string | null): SessionSummary[] {
  return sessions.filter(
    (s) => s.archived && s.spawnedFrom === null && s.workspace !== null && s.workspace === builtin
  );
}

export interface TopicGroup {
  /** null = 未分类 */
  topic: string | null;
  label: string;
  sessions: SessionSummary[];
  lastTs: number;
}

/** 任务栏按主题桶分组（#846）。组序按组内最近活动倒序——任务栏的语义一直是「最近的在上」，
    分组只是在这上面加一层；未分类永远沉底。labelOf 由调用方给（种子表 + 用户改过的 .label）。
    known = 此刻真实存在的桶 slug 集合（种子桶 + 自定义桶,调用方传 withSeedTopics(...)）——
    桶被删了的会话回未分类（spec §3）:slug 文件已经不在了,继续按它分组会画出一个
    没人能点进去、标题还是旧 slug 的组。判据只看 known,不去问文件系统:分组是纯函数,
    真实性由调用方（读过一次磁盘）担保。 */
export function groupTasksByTopic(
  sessions: SessionSummary[],
  labelOf: (slug: string) => string,
  known: ReadonlySet<string>
): TopicGroup[] {
  const byTopic = new Map<string | null, SessionSummary[]>();
  for (const s of sessions) {
    const topic = s.topic !== null && known.has(s.topic) ? s.topic : null;
    const bucket = byTopic.get(topic);
    if (bucket) bucket.push(s);
    else byTopic.set(topic, [s]);
  }
  return [...byTopic.entries()]
    .map(([topic, list]) => {
      const sorted = [...list].sort((a, b) => b.lastTs - a.lastTs);
      return { topic, label: topic === null ? "未分类" : labelOf(topic), sessions: sorted, lastTs: sorted[0]?.lastTs ?? 0 };
    })
    .sort((a, b) => {
      if (a.topic === null) return 1;
      if (b.topic === null) return -1;
      return b.lastTs - a.lastTs;
    });
}

/** 同步（分享）过的会话与纯本地会话分区（issue #809）：分享是把「我干了啥」
    交到别人手里的动作，之后这条会话对 A 就有了「对面还有一份」的身份——
    侧栏把它们抽出来单列，本地那摞保持原样。判据 = session_shared 投影非空
    （sharedWith，见 store.ts），输入序保持（store 给的本来就是 lastTs 倒序）。 */
export function partitionShared(sessions: SessionSummary[]): {
  shared: SessionSummary[]; local: SessionSummary[];
} {
  const shared: SessionSummary[] = [];
  const local: SessionSummary[] = [];
  for (const s of sessions) (s.sharedWith.length > 0 ? shared : local).push(s);
  return { shared, local };
}
