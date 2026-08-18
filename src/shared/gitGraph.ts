// Git Graph 纯函数层:git log 输出解析 + 泳道分配算法。
// 零依赖、无 IO——主进程和测试共用;渲染模型(GraphRow)可从 commit 数组推导,
// 符合"任何投影必须可从日志推导"的项目哲学。

export interface GitRef { name: string; type: "head" | "branch" | "remote" | "tag" }

export interface RawCommit {
  hash: string;
  parents: string[];
  refs: GitRef[];
  author: string;
  timestamp: number; // unix 秒(%at)
  subject: string;
}

export interface Edge { fromLane: number; toLane: number }
/** edges = 本行中心到下一行中心之间的线段(最后一行 edges 只含 merge 预置段) */
export interface GraphRow { hash: string; lane: number; edges: Edge[] }

export interface FileStat { file: string; insertions: number | null; deletions: number | null }

export interface CommitDetail {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  body: string; // 完整消息(%B,含 subject)
  files: FileStat[];
}

export type GitErrorKind = "git-missing" | "no-repo" | "git-error";

export type GitLogResult =
  | { ok: true; head: string | null; commits: RawCommit[] }
  | { ok: false; kind: GitErrorKind; detail: string };

export type GitCommitResult =
  | { ok: true; detail: CommitDetail }
  | { ok: false; kind: GitErrorKind; detail: string };

/** 本地分支一条:current = HEAD 当前所在(detached 时全 false) */
export interface BranchInfo { name: string; current: boolean }

export type GitBranchesResult =
  | { ok: true; current: string | null; branches: BranchInfo[] }
  | { ok: false; kind: GitErrorKind; detail: string };

/** checkout 特有失败:dirty = 工作区有未提交改动挡路(可行动的降级,不是 git-error) */
export type GitCheckoutResult =
  | { ok: true; branch: string }
  | { ok: false; kind: GitErrorKind | "dirty"; detail: string };

/** 分支名验形:进 execFile 参数表前挡住 `-` 开头(会被 git 当选项)与空白/控制字符。
    参数是数组传的、不过 shell,所以这里防的是选项注入,不是命令注入 */
export function isValidBranchName(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  if (name.startsWith("-")) return false;
  // git 自身禁止的字符集(check-ref-format 的子集,够挡住实际能打出来的坏名字)
  return !/[\s~^:?*[\\]|\.\.|@\{/.test(name);
}

/** `git branch --format=%(HEAD)%00%(refname:short)` 输出 → BranchInfo[]。
    %(HEAD) 在当前分支是 "*",其余是空格 */
export function parseBranchList(stdout: string): BranchInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line): BranchInfo[] => {
      const [flag, name] = line.split("\x00");
      if (name === undefined || name === "") return []; // 格式错的行跳过,不猜
      return [{ name, current: flag === "*" }];
    });
}

/** %D 解码:"HEAD -> main, origin/main, tag: v1" → 结构化 ref 列表 */
export function parseRefs(decorate: string): GitRef[] {
  if (!decorate.trim()) return [];
  return decorate.split(", ").map((part): GitRef => {
    if (part.startsWith("HEAD -> ")) return { name: part.slice("HEAD -> ".length), type: "head" };
    if (part === "HEAD") return { name: "HEAD", type: "head" }; // detached
    if (part.startsWith("tag: ")) return { name: part.slice("tag: ".length), type: "tag" };
    // 已知 remote 前缀视为 remote;其他视为本地分支(启发式:origin/X 形式才归 remote)
    if (part.startsWith("origin/") || part.startsWith("upstream/")) return { name: part, type: "remote" };
    return { name: part, type: "branch" };
  });
}

/** format = %x01%H%x00%P%x00%D%x00%an%x00%at%x00%s:\x01 分记录,\x00 分字段;格式错误跳过 */
export function parseGitLog(stdout: string): RawCommit[] {
  return stdout
    .split("\x01")
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      const fields = rec.split("\x00");
      // 格式错误(字段少于 6 个)则跳过此记录
      if (fields.length < 6) return null;
      const hash = fields[0]!;
      const parents = fields[1]!;
      const decorate = fields[2]!;
      const author = fields[3]!;
      const at = fields[4]!;
      const subject = fields[5]!;
      return {
        hash,
        parents: parents.split(" ").filter(Boolean),
        refs: parseRefs(decorate),
        author,
        timestamp: Number(at),
        subject: (subject ?? "").replace(/\n$/, ""),
      };
    })
    .filter((commit): commit is RawCommit => commit !== null);
}

/** numstat 行:"12\t3\tpath" 或 "-\t-\tbinary" */
export function parseNumstat(stdout: string): FileStat[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [ins, del, ...rest] = l.split("\t");
      return {
        file: rest.join("\t"),
        insertions: ins === "-" ? null : Number(ins),
        deletions: del === "-" ? null : Number(del),
      };
    });
}

/**
 * 泳道分配:输入 topo 序 commit(子在前父在后),输出每行落点 + 行间线段。
 * 活动泳道表 active[j] = 泳道 j 在等的父 hash;origin[j] = 该道的线当前行的横向位置
 * (刚从 dot 分出来的道,线起点在 dot 所在道,下一行才归位)。
 * 规则:等它的道里最左落座,其余收拢;没人等就开道(优先复用空道);
 * 第一父续占本道,其余父已有道在等就并入、否则开新道。
 */
export function assignLanes(commits: RawCommit[]): GraphRow[] {
  const active: (string | null)[] = [];
  const origin: number[] = [];
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const waiting: number[] = [];
    active.forEach((h, j) => { if (h === c.hash) waiting.push(j); });

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0]!; // waiting 不空,索引 0 必存在
    } else {
      const free = active.indexOf(null);
      if (free !== -1) lane = free;
      else { lane = active.length; active.push(null); origin.push(lane); }
    }

    // 上一行 → 本行的线段:每条活线一段;等本 commit 的弯进 lane,其余直落自己道
    if (rows.length > 0) {
      const prev = rows[rows.length - 1]!; // rows 不空,长度 > 0
      active.forEach((h, j) => {
        if (h === null) return;
        const originJ = origin[j]; // 存在于 active 对应位置
        if (originJ !== undefined) {
          prev.edges.push({ fromLane: originJ, toLane: h === c.hash ? lane : j });
        }
      });
    }

    // 收拢:等它的道全释放(含落座道,下面按父指针重新占用);线已归位
    for (const j of waiting) active[j] = null;
    for (let j = 0; j < origin.length; j++) origin[j] = j;

    const row: GraphRow = { hash: c.hash, lane, edges: [] };
    rows.push(row);

    if (c.parents.length > 0) {
      const firstParent = c.parents[0]!; // parents 长度 > 0
      active[lane] = firstParent;
      for (const p of c.parents.slice(1)) {
        const existing = active.findIndex((h) => h === p);
        if (existing !== -1) {
          // 已有道在等这个父:merge 线从 dot 直接并过去,本行就画
          row.edges.push({ fromLane: lane, toLane: existing });
        } else {
          let t = active.indexOf(null);
          if (t === -1) { t = active.length; active.push(p); origin.push(lane); }
          else { active[t] = p; origin[t] = lane; }
        }
      }
    }
  }
  return rows;
}

/** execFile 错误 → 三分类。ENOENT = 没装 git;stderr 报 not a git repository = no-repo */
export function classifyGitError(e: { code?: string; stderr?: string; message?: string }): {
  kind: GitErrorKind; detail: string;
} {
  const detail = (e.stderr || e.message || "").trim();
  if (e.code === "ENOENT") return { kind: "git-missing", detail };
  if (detail.includes("not a git repository")) return { kind: "no-repo", detail };
  return { kind: "git-error", detail };
}
