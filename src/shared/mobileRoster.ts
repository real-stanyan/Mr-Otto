// mobileRoster —— 手机名册那一列剩下的一格（#1356 A1 起；#1386 名册单栏换成微信式的「聊天」「通讯录」两个页签，
// 那一列的混排 / 搜索 / 群脸叠放 / 新来的那一行都随名册一起退役，判据换到 wechatInbox.ts）。
// 留下的只有「刚刚 / 12:41 / 昨天」这一格时间：记忆那一页的「最后改过」还在用它。

import { dayLabelOf } from "./dayLabel.js";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 右边那格时间：一分钟之内「刚刚」→ 同一个自然日写时刻 → 往前「昨天 / 周几 / 几月几日」
    （判自然日不判 24 小时，同 dayLabel.ts）。未来的时间戳（本机时钟被调过）按「刚刚」 */
export function rosterTimeLabel(ts: number, now: number): string {
  if (now - ts < 60_000) return "刚刚";
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return dayLabelOf(ts, now);
}
