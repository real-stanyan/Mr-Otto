// 日期分隔条（#1280，spec §8.3）：永久线上唯一的「分段」。
//
// 好友聊天那边有一份同类的（friendsState.ts 的 dayLabel），收 ISO 串、管的是另一套
// 分组规则；这里收事件的 ts，多「周几」一档——一条线聊上几个月，六天之内「周三」
// 比「9 月 16 日」好认，再往前反过来（第二个周三就分不出是哪一个了）。
//
// 判的是**自然日**不是 24 小时：昨晚 23:00 与今晨 01:00 只差两小时，但人读起来是两天。

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 这条消息该挂在哪一天下面。`now` 由调用方递（组件挂载那一刻取一次，跨零点不追——
    下次进来就对了），不在这里取 Date.now()：纯函数才测得动 */
export function dayLabelOf(ts: number, now: number): string {
  // 差值用两个自然日的零点相减，再 round 掉夏令时那一小时的毛刺
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  // 未来的时间戳（本机时钟被调过、或者对端的时钟快）按今天算，不写成「-1 天」
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return WEEKDAY[new Date(ts).getDay()]!;
  const d = new Date(ts);
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
    : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export type DayRow<T> = { kind: "day"; key: string; label: string } | { kind: "item"; item: T };

/** 在每个自然日的第一条之前插一条分隔行。`items` 必须已经按时间升序——时间线本来就是
    （事件日志 append-only），这里不再排一次：排了就会把调用方的顺序悄悄改掉 */
export function withDaySeparators<T extends { ts: number }>(items: readonly T[], now: number): DayRow<T>[] {
  const out: DayRow<T>[] = [];
  let last = Number.NaN;
  for (const item of items) {
    const day = startOfDay(item.ts);
    if (day !== last) {
      out.push({ kind: "day", key: `day-${day}`, label: dayLabelOf(item.ts, now) });
      last = day;
    }
    out.push({ kind: "item", item });
  }
  return out;
}
