// 相对时间格式化——纯函数、无 IO、不读时钟（now 由调用方传）。
// 行内列表要的是"多久以前"，不是"哪一天"：读 commit 列表时你在问的是新旧，
// 不是日期。绝对日期留给详情栏（spec §4 就是这么分的）。

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 超过这个跨度，相对说法反而更难读——「87 天前」没人算得出是哪天 */
const RELATIVE_LIMIT = 30 * DAY;

/** 本地时区的 YYYY-MM-DD。不用 toLocaleDateString：那个随机器区域设置变形状 */
function isoDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ts/now 都是 unix 秒（%at 的单位）。未来时间戳按"刚刚"处理：
    机器时钟偏一点是常事，显示负数只会让人以为是 bug */
export function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < RELATIVE_LIMIT) return `${Math.floor(diff / DAY)} 天前`;
  return isoDate(ts);
}

/** ISO 时间串版本（gh 的 updatedAt 就是这个形状）。
    解析不出来给空串——显示 "NaN 分钟前" 比什么都不显示更糟 */
export function formatRelativeIso(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return formatRelativeTime(Math.floor(ms / 1000), now);
}
