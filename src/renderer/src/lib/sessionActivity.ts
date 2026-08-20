// 会话热力图的数据 —— 每天开了几个会话。
//
// 纯函数、注入"现在":日期这种东西一旦直接读 Date.now(),测试就只能靠时钟碰运气。
//
// 按**本地日期**归并,不按 UTC:格子代表的是"我那天干了活",而不是某个时区的某一天。
// toLocaleDateString 会给出带地区习惯的写法,这里要的是稳定可比的 key,所以自己拼。

export interface DayCount {
  date: string;
  count: number;
}

export interface ActivityWindow {
  data: DayCount[];
  /** 窗口起止(heat-graph 用它铺格子,不是数据的最早/最晚) */
  start: Date;
  end: Date;
  /** 窗口内的会话总数 */
  total: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日期 key。用 en-CA 之类的 locale 技巧不可靠(不同运行时的 CLDR 版本不一样) */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 往前推 n 天的零点。零点而不是"此刻减 n×24h":窗口的边界是日期,不是时刻 */
function startOfDayBefore(now: number, days: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

/** 会话 → 按天计数。窗口外的会话不计入,也不进 total ——
    卡上写的那个总数必须是格子里能数出来的那个数,否则两个数字互相拆台。 */
export function sessionActivity(
  sessions: readonly { startedTs: number }[],
  now: number,
  days = 181,
): ActivityWindow {
  const start = startOfDayBefore(now, days - 1);
  const end = new Date(now);
  const from = start.getTime();
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of sessions) {
    if (s.startedTs < from || s.startedTs > now) continue;
    const key = dayKey(s.startedTs);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  // 排序让同一份输入永远渲染出同一个 DOM 顺序（heat-graph 自己按日期铺格子，
  // 顺序不影响画面，但影响 diff 的稳定性）
  const data = [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { data, start, end, total };
}
