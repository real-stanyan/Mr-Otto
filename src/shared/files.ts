// Files 面板的纯逻辑层 —— 零 IO,主进程和渲染层共用。
//
// 为什么单独一层:面板的规矩("目录排前面"、"fic 算命中 fileIcon.ts"、
// "rg 退出码 1 是没匹配不是出错")都是能验的判断,不该埋在一个要开真目录、
// 真起 rg 子进程才能跑的地方。

/** 目录里的一条。size/mtime 目录也带(排序不用,详情列可能用) */
export interface FileEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
}

/** 一条命中。名字模式没有行号和行文本,两个字段都是 null */
export interface FileHit {
  rel: string;
  line: number | null;
  text: string | null;
}

export interface FilePreview {
  text: string;
  truncated: boolean;
}

export type FilesErrorKind =
  | "no-dir"
  | "denied"
  | "outside-root"
  | "too-large"
  | "binary"
  | "rg-missing"
  | "search-error"
  // 要求用一个不在候选名单里的 app 打开。名单是主进程探出来的,
  // 渲染层只会回传它给过的项——出现这个 kind 说明有人绕过了菜单
  | "unknown-app";

export type FilesResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: FilesErrorKind; detail: string };

export interface FilesSearchOpts {
  /** true = 搜文件内容(? 前缀);false = 只过滤文件名 */
  content: boolean;
}

/** 预览上限:超过就只读前这么多字节 */
export const PREVIEW_MAX_BYTES = 512 * 1024;

/** 二进制判定只看开头这么多字节 */
const SNIFF_BYTES = 8 * 1024;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 目录在前,同类按名字(数字按数值:f2 在 f10 前)。不改原数组 */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/** 子序列 fuzzy:查询的字符按顺序出现即命中(fic → src/lib/fileIcon.ts)。
    空查询命中一切 —— 空过滤框的语义是"不过滤",不是"什么都不匹配" */
export function matchesFilter(rel: string, query: string): boolean {
  if (query === "") return true;
  const hay = rel.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/** `rg --json` 的 NDJSON → 命中列表。只认 match 行;坏行跳过不炸
    (rg 中途被杀会留半行 JSON) */
export function parseRgJson(stdout: string): FileHit[] {
  const out: FileHit[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const m = msg as {
      type?: string;
      data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
    };
    if (m.type !== "match") continue;
    const rel = m.data?.path?.text;
    if (typeof rel !== "string") continue;
    out.push({
      rel,
      line: typeof m.data?.line_number === "number" ? m.data.line_number : null,
      text: (m.data?.lines?.text ?? "").replace(/\r?\n$/, ""),
    });
  }
  return out;
}

/** rg 的失败分类。返回 null = 这不是失败(退出码 1 = 没匹配,rg 的正常出口) */
export function classifyRgError(err: unknown): FilesErrorKind | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "rg-missing";
  if (code === 1) return null;
  return "search-error";
}

/** 头 8KB 含 NUL 字节即判二进制(和 rg/git 的启发一致) */
export function isBinaryish(buf: Uint8Array): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/** 相对路径拼接。渲染层不许 import node:path,树展开要拼子路径只能走这条 */
export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}
