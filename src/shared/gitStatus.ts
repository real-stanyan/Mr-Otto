// 工作区状态(git status)的纯函数层:porcelain 输出解析 + 汇总。
// 零依赖、无 IO——主进程和测试共用。
//
// 为什么另起一个文件而不是塞进 gitGraph.ts:gitGraph 回答的是"历史长什么样"
// (commit 拓扑,只读过去),这里回答的是"此刻工作区脏在哪"(未提交的现在)。
// 两个问题的刷新时机、失效条件都不同,类型混在一起会互相牵动。

import type { GitErrorKind } from "./gitGraph.js";

/** 一个文件此刻的处境。git 的 XY 两位码收敛成人话的六档 */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  /** 仓库根的相对路径(git 给什么就是什么,不做本机绝对化) */
  path: string;
  kind: ChangeKind;
  /** 索引里已暂存(X 位有货)。同一文件可以既暂存又有新改动,这里只报"进过暂存区" */
  staged: boolean;
  /** rename 的原路径 */
  from?: string;
  /** 行增删,来自 numstat。未跟踪文件 / 二进制文件没有这个数字 */
  insertions?: number;
  deletions?: number;
}

export interface WorkTreeStatus {
  /** 当前分支;detached HEAD = null */
  branch: string | null;
  /** 相对上游领先/落后多少个 commit(没上游都是 0) */
  ahead: number;
  behind: number;
  files: ChangedFile[];
}

export type GitStatusResult =
  | { ok: true; status: WorkTreeStatus }
  | { ok: false; kind: GitErrorKind; detail: string };

/** `## main...origin/main [ahead 1, behind 2]` → 分支 + 领先落后。
    认得四种形态:普通、带上游、detached(`HEAD (no branch)`)、空仓库(`No commits yet on X`) */
export function parseStatusBranch(line: string): { branch: string | null; ahead: number; behind: number } {
  const body = line.startsWith("## ") ? line.slice(3) : line;
  const ahead = Number(/\bahead (\d+)/.exec(body)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)/.exec(body)?.[1] ?? 0);
  // 方括号里的领先落后摘掉,再剥上游,剩下的才是本地分支名
  const head = body.replace(/\s*\[.*$/, "").split("...")[0] ?? "";
  if (head === "" || head.startsWith("HEAD (no branch)")) return { branch: null, ahead, behind };
  // 空仓库:git 报 "No commits yet on main",分支名在末尾
  const noCommits = /^No commits yet on (.+)$/.exec(head);
  if (noCommits) return { branch: noCommits[1]!, ahead, behind };
  return { branch: head, ahead, behind };
}

/** XY 两位码 → ChangeKind。冲突优先(冲突文件的 X/Y 也是 A/D,不先判会误报成新增) */
export function classifyCode(x: string, y: string): ChangeKind {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  // 磁盘上没了就是没了,盖过索引里记的一切(`AD` = 建完又删,报"删")
  if (y === "D") return "deleted";
  // 其余以索引位为准:索引记的是"相对 HEAD 发生了什么"(`AM` = 新文件又改过,仍是"新")
  const code = x !== " " && x !== "" ? x : y;
  switch (code) {
    case "A":
    case "C": // copy 对人来说就是多了个文件
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default: // M / T(类型变) / 其余一律算改动
      return "modified";
  }
}

/**
 * `git status --porcelain -z --branch --untracked-files=all` 输出 → 结构化。
 * -z 下记录以 NUL 分隔、路径不转义(不用解 C-quoted 字符串);rename 条目额外吃一条记录当原路径。
 * 忽略项(`!!`)不会出现——没传 --ignored。格式错的记录跳过,不猜。
 */
export function parseGitStatus(stdout: string): WorkTreeStatus {
  const records = stdout.split("\0");
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: ChangedFile[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec === "") continue;
    if (rec.startsWith("## ")) {
      ({ branch, ahead, behind } = parseStatusBranch(rec));
      continue;
    }
    // "XY path":两位码 + 一个空格 + 路径
    if (rec.length < 4) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const path = rec.slice(3);
    const kind = classifyCode(x, y);
    const file: ChangedFile = { path, kind, staged: x !== " " && x !== "?" };
    // rename/copy 的原路径单独占下一条记录,必须吃掉,否则会被当成一条畸形条目
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const from = records[++i];
      if (from !== undefined && from !== "") file.from = from;
    }
    files.push(file);
  }
  return { branch, ahead, behind, files };
}

/** numstat 的行增删贴回文件表。numstat 只覆盖已跟踪文件,贴不上的保持没有数字 */
export function mergeNumstat(
  files: ChangedFile[],
  stats: { file: string; insertions: number | null; deletions: number | null }[]
): ChangedFile[] {
  const byPath = new Map(stats.map((s) => [s.file, s]));
  return files.map((f) => {
    const s = byPath.get(f.path) ?? (f.from ? byPath.get(f.from) : undefined);
    if (!s || s.insertions === null || s.deletions === null) return f;
    return { ...f, insertions: s.insertions, deletions: s.deletions };
  });
}

export interface ChangeCounts {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  total: number;
  insertions: number;
  deletions: number;
}

/** 按档计数 + 行增删求和。UI 的摘要行全部由它推,不在组件里数第二遍 */
export function countChanges(files: ChangedFile[]): ChangeCounts {
  const c: ChangeCounts = {
    added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0,
    total: files.length, insertions: 0, deletions: 0,
  };
  for (const f of files) {
    c[f.kind] += 1;
    c.insertions += f.insertions ?? 0;
    c.deletions += f.deletions ?? 0;
  }
  return c;
}

/**
 * 一次工作区状态的指纹。用途只有一个:用户手动关掉浮窗后,
 * 状态再变(指纹变了)才允许重新出现——不然每次轮询都把关掉的东西弹回来。
 * 行增删不进指纹:一个字符的编辑不该算"新事件"把浮窗顶回来,文件集合变了才算。
 */
export function statusSignature(status: WorkTreeStatus): string {
  const files = status.files
    .map((f) => `${f.kind}:${f.staged ? "s" : "w"}:${f.path}`)
    .sort()
    .join("|");
  return `${status.branch ?? "-"}#${files}`;
}
