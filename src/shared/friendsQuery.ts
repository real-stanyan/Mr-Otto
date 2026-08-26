// friendsQuery — 好友/私信查询里的**纯逻辑**。两边共用:桌面主进程
// (src/main/supabaseFriendsApi.ts)和手机端(mobile/src/friendsApi.ts)。
//
// 为什么住在 src/shared 而不是各自复制一份:这里面有两条是**安全相关**的 ——
// PostgREST 的 `.or()` 过滤串是拼字符串拼出来的,逗号/括号/引号都是语法字符。
// 复制一份逻辑等于复制一份漏洞的修法,而修法只会被改在其中一份上。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份源码)。

import type { DirectMessage } from "./friends.js";

/** 模糊搜索的 .or() 过滤串。PostgREST 的 or 语法用逗号/括号做分隔,引号会开始 quoted 段,
    这些字符出现在搜索词里会被当语法解析 → 直接剥掉(用户名/邮箱里本就罕见);
    % 和 _ 是 LIKE 通配符,反斜杠转义成字面量,防止 "a_b" 匹配到 "aXb" */
export function profileSearchOr(query: string): string {
  const q = query.replace(/[,()"'\\]/g, "").replace(/[%_]/g, (c) => `\\${c}`);
  return `name.ilike.%${q}%,email.ilike.%${q}%`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一对一私信那一串 .or() 过滤条件。
    两个 id 都当场校验成 uuid 才拼:它们**当下**都来自库里的行,拼进去是安全的,
    但"当下安全"是调用方的性质,不是这个函数的。多一道正则,这条串就不再依赖
    调用链上每一环都保持不变 —— 而调用链是会长的(手机端就是新长出来的一环)。 */
export function dmOr(uid: string, friendId: string): string {
  if (!UUID.test(uid) || !UUID.test(friendId)) {
    throw new Error("dmOr:收到不是 uuid 的 id,拒绝拼进 PostgREST 过滤串");
  }
  return `and(sender.eq.${uid},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${uid})`;
}

/** 每条通道的订阅状态汇成一个健康度:全 SUBSCRIBED 才叫 live。
    只要有一条没通,推送就是残的(比如 messages 断了 = 收不到消息),
    宁可整体判 degraded 让轮询兜住,也不要"看着是好的但其实哑了" */
export function mergeChannelHealth(statuses: string[]): "live" | "degraded" {
  return statuses.every((s) => s === "SUBSCRIBED") ? "live" : "degraded";
}

/** 把新到的消息并进已有的一条会话。id 去重 + 升序。
    去重是必需的:轮询兜底(ADR-0027)和 Realtime 推送会送来同一条,
    而"同一条消息出现两次"在聊天里是最刺眼的一种错。
    并且**后到的覆盖先到的** —— 轮询那份是从库里重读的,更权威。 */
export function mergeMessages(
  list: readonly DirectMessage[],
  incoming: readonly DirectMessage[],
): DirectMessage[] {
  const byId = new Map<number, DirectMessage>();
  for (const m of list) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** 好友列表的排序键。**待我处理的排最前** —— 那是这一屏唯一需要人动手的东西;
    我发出去的等在最后,它既不需要我动手,也没有新消息 */
export function rankFriendship(status: "pending" | "accepted", direction: "incoming" | "outgoing"): number {
  if (status === "pending" && direction === "incoming") return 0;
  if (status === "accepted") return 1;
  return 2;
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日历里的第几天(不是 UTC 的)。跨零点要换成"昨天",靠的是日历日而不是 24 小时 */
function dayIndex(d: Date): number {
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
}

/** 聊天里那条居中的时间分隔。iOS 信息的规矩:今天只给时分,昨天带"昨天",
    再往前带日期,跨年才带年份 —— 越近的消息越不需要日期,人自己知道 */
export function timeLabel(iso: string, nowMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const now = new Date(nowMs);
  const days = dayIndex(now) - dayIndex(d);
  if (days <= 0) return hm;
  if (days === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 相邻两条之间隔多久才值得插一条时间。五分钟:再密就成了每条都带时间戳 */
const TIME_GAP_MS = 5 * 60_000;

/** 这一条要不要在它上面插一条时间分隔。prevIso = null 表示它是第一条(一定要插) */
export function needsTimeLabel(iso: string, prevIso: string | null): boolean {
  if (prevIso === null) return true;
  const a = new Date(prevIso).getTime();
  const b = new Date(iso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return b - a >= TIME_GAP_MS;
}
