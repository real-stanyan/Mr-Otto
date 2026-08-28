// coworkLog —— 同一个文件夹里的水獭互相留言的那个本子（issue #658）
//
// 背景：ADR-0152 的互斥是**文件夹级**的，但危险是**文件级**的。一只写提案、一只写
// 预算，同一个文件夹，根本不会撞——却被一刀拦了。ADR-0157 之后那道闸只对非 git
// 文件夹生效（git 的各自拿副本），也就是说它只拦得住最不需要拦的那批用户。
//
// 换成两件东西：
//   1. 这个本子——谁、什么时候、动了哪个文件、为什么。人和水獭都读得到。
//   2. 文件级的闸——只有撞上**同一个文件**才拦，拦一次要求重读（见 staleWrite）。
//
// 本子落在**工作区根目录**，明文。ADR-0155 的锁刻意不放工作区（那是纯噪音，会进
// git status、会被误提交）；这个反过来——它的全部意义就是被看见。用户删掉它不会
// 坏事，只是大家失忆。
//
// 为什么是结构化记录而不是自由聊天：free-form 会长成没人读的墙，还吃上下文。
// 一条一行、字段固定，注入时才能按文件筛出「只跟你有关的那几条」。
//
// 纯函数、零 IO：读写落盘在 src/main/coworkLogFile.ts。

/** 本子的文件名。明文可见——用户在 Finder 里看得到它，这是故意的 */
export const COWORK_LOG_NAME = "Mr Otto 协作记录.md";

/** 新建本子时写在最前面的话。写给**人**看：他没要过这个文件，得知道它是什么、
    能不能删。水獭读记录只认 `- ` 开头那些行，抬头怎么写都不影响解析 */
export const COWORK_LOG_HEADER = [
  `# Mr Otto 协作记录`,
  ``,
  `同一个文件夹里的水獭在这儿互相留言：谁、什么时候、动了哪个文件、为什么。`,
  `它们靠这个本子知道文件为什么变了，不至于把对方的活覆盖掉还不吭声。`,
  ``,
  `这个文件由 Mr Otto 自己维护。删掉不会坏事，只是大家失忆。`,
  ``,
].join("\n");

/** 一条留言 */
export interface CoworkRecord {
  /** 写下这条的时刻（epoch ms） */
  ts: number;
  /** 哪只水獭（会话 id） */
  sessionId: string;
  /** 动了哪个文件（工作区内的相对路径——绝对路径换台机器就没意义了） */
  path: string;
  /** 一句为什么。水獭自己写的（write_file 的 reason 参数），
      没写就退回会话标题；两个都没有 → 空串，那一条只剩「谁动了什么」 */
  reason: string;
}

const SEP = " · ";

/** epoch ms → 带本地时区偏移的 ISO（`2026-08-28T18:40:12+08:00`）。
    为什么不用 UTC：这一行是给人读的，一个把提案放桌面文件夹的人不该被要求
    心算时差。为什么不用「18:40」这种纯人话：那样解析不回来，而本子既要人读
    也要机器读——一份表示，两边都认，不留下会漂的第二份 */
export function formatTs(ts: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ts + tzOffsetMinutes * 60_000);
  const base = shifted.toISOString().slice(0, 19);
  if (tzOffsetMinutes === 0) return `${base}Z`;
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${base}${sign}${hh}:${mm}`;
}

/** 一条留言 → 本子里的一行 */
export function formatRecord(r: CoworkRecord, tzOffsetMinutes: number): string {
  const head = `- ${formatTs(r.ts, tzOffsetMinutes)}${SEP}${r.sessionId}${SEP}\`${r.path}\``;
  return r.reason ? `${head}${SEP}${r.reason}` : head;
}

/** 本子 → 留言列表。认不出来的行**跳过**，不报错：这是用户目录里的明文文件，
    他可能手改过、可能被别的工具碰过。一行坏掉不该让整个机制罢工 */
export function parseLog(text: string): CoworkRecord[] {
  const out: CoworkRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const parts = line.slice(2).split(SEP);
    if (parts.length < 3) continue;
    const ts = Date.parse(parts[0]!);
    if (Number.isNaN(ts)) continue;
    const sessionId = parts[1]!;
    const rawPath = parts[2]!;
    if (!rawPath.startsWith("`") || !rawPath.endsWith("`") || rawPath.length < 3) continue;
    out.push({
      ts,
      sessionId,
      path: rawPath.slice(1, -1),
      reason: parts.slice(3).join(SEP),
    });
  }
  return out;
}

/** 谁最后动过这个文件——**别的家族**动的那次。
    同家族（子会话 / SideChat）不算：它们共享工作区是故意的，父 turn 跑着的时候
    子会话就在跑，互相拦等于把一条 lane 自己锁死（沿用 ADR-0152 的家族豁免）。 */
export function lastForeignWrite(
  records: readonly CoworkRecord[],
  path: string,
  isMyFamily: (sessionId: string) => boolean
): CoworkRecord | null {
  let best: CoworkRecord | null = null;
  for (const r of records) {
    if (r.path !== path) continue;
    if (isMyFamily(r.sessionId)) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best;
}

/** 要往 `path` 写了，拦不拦？
    返回那条撞上的留言 = 拦；null = 放行。
    判据：别的家族在**我最后一次看过这个文件之后**动过它。
    - 我从没看过它（`lastSeen` 为 null）而别人动过 → 拦。这是闭着眼睛覆盖别人的
      新文件，恰恰是最该拦的一种；
    - 没有别人的记录 → 放行。新建文件、只有我在动的文件，一律不打扰。 */
export function staleWrite(
  records: readonly CoworkRecord[],
  path: string,
  lastSeen: number | null,
  isMyFamily: (sessionId: string) => boolean
): CoworkRecord | null {
  const foreign = lastForeignWrite(records, path, isMyFamily);
  if (!foreign) return null;
  if (lastSeen === null) return foreign;
  return foreign.ts > lastSeen ? foreign : null;
}

/** 拦下来时给模型看的话。要点：说清被谁改了、为什么改、下一步干什么。
    「先重读」必须在场——只说"不行"的错误信息会让模型原地重试 */
export function staleWriteMessage(path: string, foreign: CoworkRecord): string {
  const why = foreign.reason ? `原因：${foreign.reason}` : `（那次没留原因）`;
  return (
    `没写：${path} 在你上次看过之后被另一只水獭改过了。\n` +
    `  改它的会话：${foreign.sessionId}\n` +
    `  ${why}\n\n` +
    `你手上那份内容是基于旧版本写的，直接覆盖会把对方的改动抹掉。\n` +
    `先 read_file 读一遍最新的，把两边的意思合起来，再写。\n` +
    `（同一个文件夹里有别的水獭在干活，完整经过见 ${COWORK_LOG_NAME}）`
  );
}

/** 要动某个文件之前，把「这个文件最近被谁动过」摆到模型眼前。
    **按需注入**：只给它要碰的那个文件的近况，不是每轮把整本喂进去——
    本子会长，上下文不会跟着长。 */
export function fileNoticeFor(
  records: readonly CoworkRecord[],
  path: string,
  isMyFamily: (sessionId: string) => boolean,
  tzOffsetMinutes: number
): string | null {
  const foreign = lastForeignWrite(records, path, isMyFamily);
  if (!foreign) return null;
  const why = foreign.reason ? `，原因：${foreign.reason}` : "";
  return (
    `注意：${path} 最近被另一只水獭（${foreign.sessionId}）改过` +
    `（${formatTs(foreign.ts, tzOffsetMinutes)}${why}）。`
  );
}

/** 本子的上限。超了就从最旧的开始扔——它是协作用的近况，不是事实来源
    （事实是各自会话的 append-only 日志）。这里丢一条不丢任何不可恢复的东西 */
export const MAX_RECORDS = 500;

/** 裁到上限之内，保留最新的那些（顺序不变） */
export function trimRecords(records: readonly CoworkRecord[], max = MAX_RECORDS): CoworkRecord[] {
  return records.length <= max ? [...records] : records.slice(records.length - max);
}
