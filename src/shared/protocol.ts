// Protocol 仪表盘 — 共享世界:类型 + 纯函数(ADR 文件名/标题解析、issue 角色判定、
// handoff 五段式解析、gh JSON 映射、gh 错误分类)。零 Node 依赖,三边可 import,全部可测。
// 只读第一刀:这里没有任何"写"的概念(spec: docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md)。

export interface AdrSummary {
  source: "adr" | "gearbox-adr";
  id: string;
  title: string;
  /** 仓库相对路径(readAdr 的凭证,主进程校验必须落在 ADR 目录内) */
  path: string;
}

/** gearbox 三角色(AGENTS.md "Roles of issues & PRs"),靠标题启发式猜——猜不中归 task */
export type IssueRole = "task" | "memory" | "gap";

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  role: IssueRole;
  updatedAt: string;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface IssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  role: IssueRole;
  body: string;
  comments: IssueComment[];
}

/** gearbox Memory 五段式(ADR-0004):① 做完 ② 阻塞 ③ 下一步 ④ 关单 ⑤ 决策理由 */
export interface HandoffParts {
  done: string;
  blocked: string;
  next: string;
  closed: string;
  rationale: string;
}

export type ProtocolErrorKind = "gh-missing" | "no-repo" | "gh-auth" | "gh-error";

/** issues 面板独立降级的载体:错误不 throw 过 IPC,而是结构化回流,渲染层按 kind 给指引 */
export type IssuesResult =
  | { ok: true; issues: IssueSummary[] }
  | { ok: false; kind: ProtocolErrorKind; detail: string };

export type IssueDetailResult =
  | { ok: true; issue: IssueDetail }
  | { ok: false; kind: ProtocolErrorKind; detail: string };

/** ADR 文件名 = NNNN-slug.md(两个 ADR 目录同规);不合命名的不是 ADR,返回 null 跳过 */
export function adrIdFromFilename(name: string): string | null {
  const m = name.match(/^(\d{4})-.+\.md$/);
  return m ? m[1]! : null;
}

/** 列表标题 = 文件里第一个 `# ` 行(ADR 惯例首行即标题);没有就退回文件名去后缀 */
export function extractAdrTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return fallback;
}

export function classifyIssueRole(title: string): IssueRole {
  const t = title.toLowerCase();
  if (t.includes("handoff") || title.includes("交接")) return "memory";
  if (t.includes("protocol gap") || title.includes("协议缺口")) return "gap";
  return "task";
}

const HANDOFF_MARKS = ["①", "②", "③", "④", "⑤"] as const;

/** 五段式解析:①—⑤ 必须齐全且按序出现,否则 null(渲染层回退原文——宁可不解析,不猜作者意图) */
export function parseHandoff(body: string): HandoffParts | null {
  const idx = HANDOFF_MARKS.map((m) => body.indexOf(m));
  if (idx.some((i) => i < 0)) return null;
  for (let i = 1; i < idx.length; i++) if (idx[i]! <= idx[i - 1]!) return null;
  const seg = (i: number) =>
    body.slice(idx[i]! + 1, i + 1 < idx.length ? idx[i + 1]! : undefined).trim();
  return { done: seg(0), blocked: seg(1), next: seg(2), closed: seg(3), rationale: seg(4) };
}

function toState(raw: unknown): "open" | "closed" {
  return String(raw).toLowerCase() === "closed" ? "closed" : "open";
}

/** gh issue list --json 的映射。形状不对就 throw——调用方(service)统一兜成 gh-error */
export function mapIssueList(json: unknown): IssueSummary[] {
  if (!Array.isArray(json)) throw new Error("gh 输出不是数组");
  return json.map((raw) => {
    const r = raw as Record<string, unknown>;
    if (typeof r.number !== "number" || typeof r.title !== "string") {
      throw new Error("issue 字段缺失(number/title)");
    }
    return {
      number: r.number,
      title: r.title,
      state: toState(r.state),
      role: classifyIssueRole(r.title),
      updatedAt: String(r.updatedAt ?? ""),
    };
  });
}

/** gh issue view --json 的映射。author.login 摊平成 string,comments 缺省给空数组 */
export function mapIssueDetail(json: unknown): IssueDetail {
  const r = json as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.title !== "string") {
    throw new Error("issue 字段缺失(number/title)");
  }
  const comments = Array.isArray(r.comments)
    ? r.comments.map((c) => {
        const cc = c as Record<string, unknown>;
        const author = (cc.author as Record<string, unknown> | undefined)?.login;
        return {
          author: typeof author === "string" ? author : "unknown",
          createdAt: String(cc.createdAt ?? ""),
          body: String(cc.body ?? ""),
        };
      })
    : [];
  return {
    number: r.number,
    title: r.title,
    state: toState(r.state),
    role: classifyIssueRole(r.title),
    body: String(r.body ?? ""),
    comments,
  };
}

/** gh 子进程错误分类——kind 决定渲染层给哪种指引(装 gh / 连 remote / 登录 / 通用错误) */
export function classifyGhError(err: {
  code?: string;
  stderr?: string;
  message?: string;
}): { kind: ProtocolErrorKind; detail: string } {
  const stderr = err.stderr ?? "";
  const detail = stderr.trim() || err.message || "unknown gh error";
  if (err.code === "ENOENT") return { kind: "gh-missing", detail };
  const s = stderr.toLowerCase();
  if (s.includes("not a git repository") || s.includes("no git remotes") || s.includes("could not determine"))
    return { kind: "no-repo", detail };
  if (s.includes("auth login") || s.includes("authentication") || s.includes("not logged in"))
    return { kind: "gh-auth", detail };
  return { kind: "gh-error", detail };
}
