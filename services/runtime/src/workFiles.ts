// workFiles —— 「工作文件夹里有什么」这一问的容器侧实现（#1056）。
//
// 分工：这个文件只负责**一段 shell 脚本**和**它输出的解析**，一个 docker 的字都
// 不碰（sandbox.ts 负责找容器/起容器/exec，frameHandler.ts 负责验籍与组帧）。
// 拆成这样是为了它进得了单测——真正会坏的是字符串协议：字段顺序、分隔符、
// 「截断了没有」这三件事，而它们在真 docker 上跑一遍的成本高到没人会跑第二遍。
//
// 输出协议：**第一行是表头，换行之后全是载荷**。
//   denied\n                     路径 realpath 之后不在 /work 下
//   missing\n                    这个路径不存在
//   dir\n<载荷>                   载荷 = find 的 NUL 分隔记录
//   file\t<字节数>\t<截断了没有>\n<载荷>   载荷 = 文件前 N 字节
//   binary\t<字节数>\n            读到 NUL 字节，不是人话
// 目录记录内部用 `\t` 分三个字段 + 文件名，**文件名放最后**：名字里可以有 `\t`，
// 放最后就永远解析得出来（前三个 `\t` 是分隔符，剩下的整段都是名字）。记录之间
// 用 `\0` 分隔而不是 `\n`：文件名里换行是合法的，NUL 不是。
//
// **脚本里的转义序列一律走 `String.raw`**：普通模板串里的 `\0` 会变成一个真的 NUL
// 字节，而 execve 的参数在 NUL 处截断——`find -printf '…%f\0'` 于是丢掉分隔符、
// 每个目录都解析成空的，`tr -d '\0'` 变成 `tr -d ''` 于是二进制永远判不出来。
// 两处都不报错，只是安静地给出错误答案。`tests/runtime/workFiles.test.ts` 里有一条
// 断言钉住「built 出来的脚本里不许有裸控制字符」，那是这笔账的保鲜期。
//
// 两道路径闸缺一不可：`normalizeWorkPath`（三端共用，拒 `..` 与绝对路径）挡的是
// 「客户端要去哪」，容器里这道 `realpath` 挡的是「解析完软链之后真的落在哪」——
// 一条指向 /etc 的软链过得了第一道，过不了第二道。

import type { CsWorkEntry, CsWorkHit, CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import {
  CS_WORK_CONTENT_HITS_MAX,
  CS_WORK_FILE_MAX_BYTES,
  CS_WORK_NAME_HITS_MAX,
} from "../../../src/shared/remote/cloudSession.js";
import { classifyRgError, matchesFilter, parseRgJson } from "../../../src/shared/files.js";

/** find 那一段最多回多少字节。被它砍掉的尾巴是一条**没有结尾 NUL** 的残记录，
    解析时整条丢掉并置 truncated——不猜半条记录的内容 */
export const WORK_LIST_MAX_BYTES = 512 * 1024;
/** 一屏最多列多少项。目录里真有上万个文件时，这一页也不是翻它的正确工具 */
export const WORK_LIST_MAX_ENTRIES = 500;

/** 单引号包裹 + `'\''` 转义——同 sandbox.ts / dockerWorld.ts 的那一份。
    三处各写一遍是有意的：合并要跨 services/runtime 与 src/ 的边界，
    而这函数六行、行为由测试钉住 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 读一格工作文件夹的脚本。`path` 必须已经过 `normalizeWorkPath`（相对路径，
    `""` = 工作文件夹本身）；这里仍然假定它可能是恶意的，一路 `--` + 引号 +
    realpath 兜底 */
export function buildWorkReadScript(path: string): string {
  return [
    "set -u",
    `p=${shellQuote(path)}`,
    "target=/work",
    String.raw`if [ -n "$p" ]; then target="/work/$p"; fi`,
    // realpath -m：路径里有不存在的一段也照样解析（-m = missing ok），
    // 于是「不存在」这件事由下面的 -e 来说，不会在这里变成一次解析失败
    String.raw`real=$(realpath -m -- "$target" 2>/dev/null) || real=""`,
    String.raw`case "$real" in`,
    String.raw`  /work|/work/*) ;;`,
    String.raw`  *) printf 'denied\n'; exit 0 ;;`,
    "esac",
    String.raw`if [ ! -e "$real" ]; then printf 'missing\n'; exit 0; fi`,
    String.raw`if [ -d "$real" ]; then`,
    String.raw`  printf 'dir\n'`,
    // %y=类型字母 %s=字节 %T@=mtime(秒,带小数) %f=名字（放最后，见文件头）
    String.raw`  find "$real" -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0' 2>/dev/null | head -c ` +
      String(WORK_LIST_MAX_BYTES),
    "  exit 0",
    "fi",
    String.raw`size=$(stat -c %s -- "$real" 2>/dev/null || printf 0)`,
    // 二进制判据：前 N 字节里有没有 NUL。`tr -d` 之后长度变了就是有
    String.raw`n=$(head -c ` + String(CS_WORK_FILE_MAX_BYTES) + String.raw` -- "$real" | wc -c)`,
    String.raw`z=$(head -c ` + String(CS_WORK_FILE_MAX_BYTES) + String.raw` -- "$real" | tr -d '\0' | wc -c)`,
    String.raw`if [ "$n" != "$z" ]; then printf 'binary\t%s\n' "$size"; exit 0; fi`,
    String.raw`if [ "$size" -gt ` + String(CS_WORK_FILE_MAX_BYTES) + String.raw` ]; then trunc=1; else trunc=0; fi`,
    String.raw`printf 'file\t%s\t%s\n' "$size" "$trunc"`,
    String.raw`head -c ` + String(CS_WORK_FILE_MAX_BYTES) + String.raw` -- "$real"`,
    "exit 0",
  ].join("\n");
}

export type WorkReadResult = { ok: true; node: CsWorkNode } | { ok: false; message: string };

/** 解析上面那段脚本的 stdout。看不懂一律回 ok:false——**不猜**：猜出来的目录
    清单和真的长得一模一样，而它是假的 */
export function parseWorkReadOutput(stdout: string): WorkReadResult {
  const nl = stdout.indexOf("\n");
  if (nl < 0) return { ok: false, message: "读工作文件夹没有回话，稍后再试。" };
  const header = stdout.slice(0, nl);
  const payload = stdout.slice(nl + 1);
  const fields = header.split("\t");

  if (fields[0] === "denied") return { ok: false, message: "这条路径不在工作文件夹里。" };
  if (fields[0] === "missing") return { ok: true, node: { kind: "missing" } };

  if (fields[0] === "dir") {
    const { entries, truncated } = parseEntries(payload);
    return { ok: true, node: { kind: "dir", entries, truncated } };
  }

  if (fields[0] === "binary") {
    const size = Number(fields[1]);
    if (!Number.isFinite(size)) return { ok: false, message: "读工作文件夹的结果解析不出来。" };
    return { ok: true, node: { kind: "binary", size } };
  }

  if (fields[0] === "file") {
    const size = Number(fields[1]);
    if (!Number.isFinite(size)) return { ok: false, message: "读工作文件夹的结果解析不出来。" };
    // 截断有两个来源：脚本自己说的（size 超上限），以及载荷本身就比上限长
    // （理论上不会，但两个来源取或比赌其中一个可靠）
    const truncated = fields[2] === "1" || payload.length > CS_WORK_FILE_MAX_BYTES;
    return { ok: true, node: { kind: "file", text: payload, truncated, size } };
  }

  return { ok: false, message: "读工作文件夹的结果解析不出来。" };
}

/** NUL 分隔的记录 → 排好序的清单。排序放在这一侧而不是渲染层：`head -c` 砍过
    之后的那一份要**稳定**，不然同一个目录两次点开顺序不同、还看不出少了谁 */
function parseEntries(payload: string): { entries: CsWorkEntry[]; truncated: boolean } {
  if (payload === "") return { entries: [], truncated: false };
  const parts = payload.split("\0");
  // 完整的记录一律以 NUL 收尾，所以 split 之后最后一格必然是空串。不是空串 =
  // 这条记录被 head -c 砍掉了半截，整条丢掉
  let truncated = false;
  const last = parts.pop();
  if (last !== "") truncated = true;

  const entries: CsWorkEntry[] = [];
  for (const rec of parts) {
    if (rec === "") continue;
    const cut1 = rec.indexOf("\t");
    const cut2 = rec.indexOf("\t", cut1 + 1);
    const cut3 = rec.indexOf("\t", cut2 + 1);
    if (cut1 < 0 || cut2 < 0 || cut3 < 0) continue;
    const type = rec.slice(0, cut1);
    const size = Number(rec.slice(cut1 + 1, cut2));
    const mtime = Number(rec.slice(cut2 + 1, cut3));
    const name = rec.slice(cut3 + 1);
    if (name === "" || !Number.isFinite(size) || !Number.isFinite(mtime)) continue;
    entries.push({
      name,
      kind: type === "d" ? "dir" : type === "f" ? "file" : "other",
      size: type === "d" ? 0 : size,
      mtimeMs: Math.round(mtime * 1000),
    });
  }

  entries.sort(compareEntries);
  if (entries.length > WORK_LIST_MAX_ENTRIES) {
    return { entries: entries.slice(0, WORK_LIST_MAX_ENTRIES), truncated: true };
  }
  return { entries, truncated };
}

/** 目录在前，然后按名字。`localeCompare` 不带 locale——两端只要**一致**就行，
    而这份排序的消费方只有渲染层那一列 */
function compareEntries(a: CsWorkEntry, b: CsWorkEntry): number {
  const rank = (k: CsWorkEntry["kind"]): number => (k === "dir" ? 0 : 1);
  const d = rank(a.kind) - rank(b.kind);
  if (d !== 0) return d;
  return a.name.localeCompare(b.name);
}

// ─── 搜索（#1066）────────────────────────────────────────────────────────
// 容器镜像里有 ripgrep 13（`/usr/bin/rg`，真机验过），且 `-w /work` 下
// `rg --json` / `rg --files` 输出的相对路径与本机 Files 面板逐字同形——所以这里
// **共用 `src/shared/files.ts` 的三个纯函数**（`parseRgJson` / `matchesFilter` /
// `classifyRgError`），不另写一份：两处各写一遍，「rg 退出码 1 是没匹配不是出错」
// 这条规矩迟早分家，而分家的样子是「搜不出来」这种没人报的 bug。
//
// 输出协议：`hits\t<rg 的退出码>\n<载荷>` 或 `files\t<退出码>\n<载荷>`。
// **退出码必须原样带回来**：管道到 head 之后 `$?` 是 head 的，rg 没装（127）与
// 「搜过了没有匹配」（1）会长得一模一样，于是「rg 挂了」被说成「仓里没有」。
// 所以先落一个 mktemp 再 head，退出码单独带。

/** `rg --files` 那一路的输出上限。大仓的全量文件名清单能有兆级，但过滤与截断
    都发生在 runtime 进程里（同本机面板在主进程里做），线上只走最多几百条 */
export const WORK_SEARCH_NAMES_MAX_BYTES = 2 * 1024 * 1024;
/** `rg --json` 那一路。每条命中还带一行正文，比上面小一档 */
export const WORK_SEARCH_CONTENT_MAX_BYTES = 1024 * 1024;

/** 搜工作文件夹的脚本。搜索永远从 /work 根开始（`execInContainer` 的 WorkingDir）。
    **恒含被忽略的文件**（`--no-ignore --hidden`）——树是全显的，搜索另设一套规矩
    会让「树里看得见、搜不出来」变成一个要解释的怪现象，一条规矩管两处（本机
    `filesService.search` 的原话）。查询走 `--` 之后防的是「-foo 被 rg 当成选项」，
    命令注入那一半由 shellQuote 挡 */
export function buildWorkSearchScript(query: string, content: boolean): string {
  const cap = content ? WORK_SEARCH_CONTENT_MAX_BYTES : WORK_SEARCH_NAMES_MAX_BYTES;
  const cmd = content
    ? `rg --json -n --max-count 5 --no-ignore --hidden -- ${shellQuote(query)}`
    : "rg --files --no-ignore --hidden";
  const tag = content ? "hits" : "files";
  return [
    "set -u",
    "tmp=$(mktemp)",
    `${cmd} > "$tmp" 2>/dev/null`,
    "rc=$?",
    String.raw`printf '` + tag + String.raw`\t%s\n' "$rc"`,
    String.raw`head -c ` + String(cap) + String.raw` -- "$tmp"`,
    String.raw`rm -f -- "$tmp"`,
    "exit 0",
  ].join("\n");
}

export type WorkSearchResult = { ok: true; hits: CsWorkHit[] } | { ok: false; message: string };

/** 解析上面那段脚本的 stdout。`query` 只在文件名那一路用得上（内容那一路的过滤
    是 rg 自己做的） */
export function parseWorkSearchOutput(stdout: string, query: string): WorkSearchResult {
  const nl = stdout.indexOf("\n");
  if (nl < 0) return { ok: false, message: "搜索没有回话，稍后再试。" };
  const [kind, rcText] = stdout.slice(0, nl).split("\t");
  const payload = stdout.slice(nl + 1);
  const rc = Number(rcText);
  if ((kind !== "hits" && kind !== "files") || !Number.isFinite(rc)) {
    return { ok: false, message: "搜索的结果解析不出来。" };
  }

  // 退出码 → 本机面板那份分类。**shell 的 127 就是它的 ENOENT**（命令不存在），
  // 转成那个字符串才对得上 classifyRgError 的判据；1 = 没匹配，不是失败。
  // 0 先择出去：`classifyRgError` 收的是一个**抛出来的错误**，成功那一路它从来
  // 没见过（本机是 try 里没抛就直接用 stdout），喂 0 进去会被判成 search-error
  if (rc !== 0) {
    const bad = classifyRgError({ code: rc === 127 ? "ENOENT" : rc });
    if (bad === "rg-missing") return { ok: false, message: "云端沙箱里没有 ripgrep，搜不了。" };
    if (bad !== null) return { ok: false, message: "搜索出错了，稍后再试。" };
  }

  if (kind === "hits") {
    return { ok: true, hits: parseRgJson(payload).slice(0, CS_WORK_CONTENT_HITS_MAX) };
  }
  const hits = payload
    .split("\n")
    .filter((rel) => rel !== "" && matchesFilter(rel, query))
    .slice(0, CS_WORK_NAME_HITS_MAX)
    .map((rel) => ({ rel, line: null, text: null }));
  return { ok: true, hits };
}
