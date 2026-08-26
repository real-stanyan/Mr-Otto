// 会话热力图的数据 —— 每天开了几个会话。
//
// 住在 src/shared 而不是 renderer/lib:手机端的设置页也画这张图(ADR-0115),
// 而它 import 的是同一份源码。同一张图两处算,迟早对不上。
// 纯文件:不许 import node builtin / electron。
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
  const from = startOfDayBefore(now, days - 1).getTime();
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
  return activityWindow(data, total, now, days);
}

/** 从「每天几个」重建一个窗口。手机端只拿得到 data + total(统计帧里传的就是这两样),
    起止得按同一套规矩自己算 —— 不然两端铺出来的格子会差一格 */
export function activityWindow(
  data: DayCount[], total: number, now: number, days: number,
): ActivityWindow {
  return { data, total, start: startOfDayBefore(now, days - 1), end: new Date(now) };
}

export interface HeatCell {
  date: string;
  count: number;
}

/**
 * 把窗口铺成一列一周(周日在上),给格子图直接 map。
 *
 * 边上会有空格:窗口的第一天多半不是周日,最后一天多半不是周六。
 * **空格用 null,不是 count 0** —— 0 是"那天没开会话"这个事实,
 * 而边角那些格子代表的日子根本不在窗口里,画成"没干活"是在报一个假数。
 */
export function heatWeeks(w: ActivityWindow): (HeatCell | null)[][] {
  const counts = new Map(w.data.map((d) => [d.date, d.count]));
  const from = dayKey(w.start.getTime());
  const to = dayKey(w.end.getTime());
  // 回退到窗口第一天所在那一周的周日
  const cur = new Date(w.start);
  cur.setDate(cur.getDate() - cur.getDay());
  const weeks: (HeatCell | null)[][] = [];
  for (;;) {
    const col: (HeatCell | null)[] = [];
    for (let i = 0; i < 7; i += 1) {
      const k = dayKey(cur.getTime());
      col.push(k < from || k > to ? null : { date: k, count: counts.get(k) ?? 0 });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(col);
    if (dayKey(cur.getTime()) > to) return weeks;
  }
}

/** 一格的深浅档位 0–4。按窗口内的最大值分档,不按绝对数 ——
    一天开两个会话的人和一天开二十个的人,看到的都该是"这天比那天忙" */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const r = count / max;
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}
