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

export interface FileStat {
  file: string;
  /** 改名/复制的来源路径。只有 numstat 报了 `old => new` 时才有——
      缺席的语义是"这不是一次改名",不是"来源未知" */
  renamedFrom?: string;
  insertions: number | null;
  deletions: number | null;
}

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
  | { ok: true; head: string | null; commits: RawCommit[]; spineBranch: string | null }
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

/** 一条全名 ref → 类型 + 短名。`refs/heads/refs/heads/x` 这种只剥一层前缀,
    剩下的原样留着——分支名里带 refs 字样是合法的 */
function classifyFullRef(ref: string): GitRef | null {
  if (ref.startsWith("refs/heads/")) return { name: ref.slice("refs/heads/".length), type: "branch" };
  if (ref.startsWith("refs/remotes/")) return { name: ref.slice("refs/remotes/".length), type: "remote" };
  if (ref.startsWith("refs/tags/")) return { name: ref.slice("refs/tags/".length), type: "tag" };
  return null;
}

/** %D 解码。数据源用 `--decorate=full`,所以正常输入是全名形式:
    "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1"。

    为什么要全名:短名下没法区分 remote 和"名字里带斜杠的本地分支"。
    原来靠 `origin/` / `upstream/` 前缀猜,任何叫别的名字的 remote(fork/、
    公司内网的 gitlab/)都会被当成本地分支画错徽章。前缀是 git 给的事实,猜不是。

    没有 refs/ 前缀时退回旧的短名启发式——用户的 `log.decorate` 配置
    可能把它按回 short,那种情况下猜总比全丢强。 */
export function parseRefs(decorate: string): GitRef[] {
  if (!decorate.trim()) return [];
  return decorate.split(", ").map((part): GitRef => {
    if (part === "HEAD") return { name: "HEAD", type: "head" }; // detached
    if (part.startsWith("HEAD -> ")) {
      const target = part.slice("HEAD -> ".length);
      return { name: classifyFullRef(target)?.name ?? target, type: "head" };
    }
    if (part.startsWith("tag: ")) {
      const target = part.slice("tag: ".length);
      return { name: classifyFullRef(target)?.name ?? target, type: "tag" };
    }
    const full = classifyFullRef(part);
    if (full) return full;
    // 短名兜底:已知 remote 前缀视为 remote,其他视为本地分支
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

/** 改名行的紧凑写法:`src/{a.txt => b.txt}`、`src/{ => sub}/a.txt`。
    花括号一侧为空时拼出来会多一道斜杠,收掉 */
const RENAME_BRACE = /^(.*?)\{(.*?) => (.*?)\}(.*)$/;

/** numstat 的路径字段 → 新路径(+ 改名来源)。
    git 只在真是改名/复制时写 " => "(带空格),所以文件名里出现 `a=>b` 不会误伤 */
function parseNumstatPath(raw: string): { file: string; renamedFrom?: string } {
  const braced = RENAME_BRACE.exec(raw);
  if (braced) {
    const [, pre, from, to, post] = braced;
    const join = (mid: string) => `${pre}${mid}${post}`.replace(/\/{2,}/g, "/");
    return { file: join(to!), renamedFrom: join(from!) };
  }
  const sep = raw.indexOf(" => ");
  if (sep !== -1) {
    return { file: raw.slice(sep + " => ".length), renamedFrom: raw.slice(0, sep) };
  }
  return { file: raw };
}

/** numstat 行:"12\t3\tpath"、"-\t-\tbinary",或改名行 "0\t0\tsrc/{a => b}" */
export function parseNumstat(stdout: string): FileStat[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [ins, del, ...rest] = l.split("\t");
      return {
        ...parseNumstatPath(rest.join("\t")),
        insertions: ins === "-" ? null : Number(ins),
        deletions: del === "-" ? null : Number(del),
      };
    });
}

/**
 * 主脊分支 = 该钉在 0 道的那根。origin/HEAD 指的最准(remoteHead,调用方已剥掉
 * "origin/" 前缀);拿不到就退 main / master / 当前 HEAD 分支。
 * 一个都不认得就返回 null——不预留道,不硬猜。
 */
export function pickSpineBranch(commits: RawCommit[], remoteHead: string | null): string | null {
  const names = new Set<string>();
  let headName: string | null = null;
  for (const c of commits) {
    for (const r of c.refs) {
      if (r.type === "branch") names.add(r.name);
      // detached HEAD 的 ref 名就是字面量 "HEAD",不是分支,不能当主脊
      else if (r.type === "head" && r.name !== "HEAD") {
        names.add(r.name);
        headName ??= r.name;
      }
    }
  }
  if (remoteHead && names.has(remoteHead)) return remoteHead;
  if (names.has("main")) return "main";
  if (names.has("master")) return "master";
  return headName;
}

/**
 * 泳道分配:输入 topo 序 commit(子在前父在后),输出每行落点 + 行间线段。
 * 活动泳道表 active[j] = 泳道 j 在等的父 hash;origin[j] = 该道的线当前行的横向位置
 * (刚从 dot 分出来的道,线起点在 dot 所在道,下一行才归位)。
 * 规则:等它的道里最左落座,其余收拢;没人等就开道(优先复用空道);
 * 第一父续占本道,其余父已有道在等就并入、否则开新道。
 *
 * spineBranch 给了且在窗口里找得到它的 tip 时,0 道整条留给主干:主干 tip 强制落 0,
 * 其一父链自然续占,其余线分道时跳过 0(ADR-0015)。主干 tip 之前的几行 0 道空着——
 * 那是"主干不在这几行"的事实,不是排版空洞。找不到该分支就不预留,免得白留一列。
 */
export function assignLanes(commits: RawCommit[], spineBranch?: string | null): GraphRow[] {
  const active: (string | null)[] = [];
  const origin: number[] = [];
  const rows: GraphRow[] = [];

  const spineTip = spineBranch
    ? commits.find((c) =>
        c.refs.some((r) => r.name === spineBranch && (r.type === "head" || r.type === "branch"))
      )?.hash ?? null
    : null;
  // 预留位数:1 = 0 道归主干,别人从 1 开始分
  const reserved = spineTip === null ? 0 : 1;
  if (reserved === 1) { active.push(null); origin.push(0); }

  /** 取一条可用道(跳过预留位);没有空道就开新道 */
  const alloc = (): number => {
    for (let j = reserved; j < active.length; j++) {
      if (active[j] === null) return j;
    }
    active.push(null);
    origin.push(active.length - 1);
    return active.length - 1;
  };

  for (const c of commits) {
    const waiting: number[] = [];
    active.forEach((h, j) => { if (h === c.hash) waiting.push(j); });

    let lane: number;
    if (c.hash === spineTip) {
      lane = 0; // 主干 tip 压过"最左等待道":哪怕别的线先等到它,也把它拽回主脊
    } else if (waiting.length > 0) {
      lane = waiting[0]!; // waiting 不空,索引 0 必存在
    } else {
      lane = alloc();
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
          const t = alloc();
          active[t] = p;
          origin[t] = lane; // 新道的线这一行还在 dot 上,下一行才归位
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
