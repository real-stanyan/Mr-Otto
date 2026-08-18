// Protocol 仪表盘 — 主进程数据源:ADR 走 fs 扫描,issues 走 gh CLI 子进程。
// 这是 app 功能不是 agent 工具,主进程直用 fs/child_process 合规(同 SQLite 日志先例,
// 不经 ExecutionWorld;见 spec §2)。依赖注入照抄 skills.ts 模式:测试喂假实现。
// 严格只读:gh 只调 list/view,永不写。

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, normalize } from "node:path";
import {
  classifyGhError, mapIssueDetail, mapIssueList, adrIdFromFilename, extractAdrTitle,
  type AdrSummary, type IssueDetailResult, type IssuesResult,
} from "../shared/protocol.js";

export interface ProtocolDeps {
  /** dir 下的文件名(不含子目录);目录不存在/读不了 = [] */
  listFiles(dir: string): string[];
  /** 文件全文;不存在/读不了 = null */
  readFile(path: string): string | null;
  /** gh 子进程;reject 的错误对象带 code/stderr(classifyGhError 的输入形状) */
  execGh(args: string[], cwd: string): Promise<{ stdout: string }>;
  /** repoDir 是否存在——localStorage 记的目录可能被删/改名,exec 前先挡,
   * 否则 execFile 对不存在的 cwd 抛 ENOENT,和"没装 gh"是同一错误码,会被
   * classifyGhError 误判成 gh-missing(见调用处注释) */
  dirExists(dir: string): boolean;
}

const nodeDeps: ProtocolDeps = {
  listFiles(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  execGh(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve({ stdout: String(stdout) });
      });
    });
  },
  dirExists(dir) {
    return existsSync(dir);
  },
};

/** 两个 ADR 目录写死:project ADR 在前(阅读优先级),gearbox 协议 ADR 在后 */
const ADR_DIRS: { rel: string; source: AdrSummary["source"] }[] = [
  { rel: "docs/adr", source: "adr" },
  { rel: "docs/gearbox-adr", source: "gearbox-adr" },
];

export interface ProtocolService {
  listAdrs(repoDir: string): AdrSummary[];
  readAdr(repoDir: string, relPath: string): { markdown: string };
  listIssues(repoDir: string): Promise<IssuesResult>;
  getIssue(repoDir: string, n: number): Promise<IssueDetailResult>;
}

export function createProtocolService(deps: ProtocolDeps = nodeDeps): ProtocolService {
  return {
    listAdrs(repoDir) {
      const out: AdrSummary[] = [];
      for (const { rel, source } of ADR_DIRS) {
        for (const name of deps.listFiles(join(repoDir, rel)).sort()) {
          const id = adrIdFromFilename(name);
          if (!id) continue; // README 等非 ADR 命名不是 ADR
          const md = deps.readFile(join(repoDir, rel, name));
          if (md === null) continue;
          out.push({ source, id, title: extractAdrTitle(md, name.replace(/\.md$/, "")), path: `${rel}/${name}` });
        }
      }
      return out;
    },

    readAdr(repoDir, relPath) {
      // 渲染层传来的路径只是"凭证",必须钉死在两个 ADR 目录内——防任意文件读
      const norm = normalize(relPath);
      const inside = ADR_DIRS.some(({ rel }) => norm.startsWith(rel + "/")) && !norm.includes("..");
      if (!inside) throw new Error(`ADR 路径越界: ${relPath}`);
      const md = deps.readFile(join(repoDir, norm));
      if (md === null) throw new Error(`ADR 不存在: ${relPath}`);
      return { markdown: md };
    },

    async listIssues(repoDir) {
      // localStorage 记的 repoDir 可能已被删/改名——exec 前先挡,否则 execFile 对不存在
      // 的 cwd 抛 ENOENT,和"没装 gh"撞同一错误码,会被误判成 gh-missing(UI 引导装 gh 就跑偏了)
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        const { stdout } = await deps.execGh(
          ["issue", "list", "--state", "all", "--limit", "200", "--json", "number,title,state,updatedAt"],
          repoDir
        );
        return { ok: true, issues: mapIssueList(JSON.parse(stdout)) };
      } catch (e) {
        return { ok: false, ...classifyGhError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },

    async getIssue(repoDir, n) {
      // 同 listIssues:目录不存在先挡,别让 execFile 的 ENOENT 混进 classifyGhError
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        const { stdout } = await deps.execGh(
          ["issue", "view", String(n), "--json", "number,title,state,body,comments"],
          repoDir
        );
        return { ok: true, issue: mapIssueDetail(JSON.parse(stdout)) };
      } catch (e) {
        return { ok: false, ...classifyGhError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },
  };
}
