// Files 面板 — 主进程数据源:列目录走 fs,搜索走 ripgrep 子进程。
// app 功能不是 agent 工具,主进程直用 fs/child_process 合规(同 protocolService/
// gitGraphService 先例)。DI 模式照抄它们:测试喂假实现。
//
// 这里刻意不 import electron:shell.openPath/showItemInFolder 由 index.ts 注入
// (同 browserHub 的 webContentsViewFactory)。import 了的话这个模块在 vitest 里
// 根本加载不起来,四条安全边界就没法在单测里钉。
//
// 严格只读:没有任何写文件的出口。面板读到的东西不进事件日志、不进模型上下文
// (同终端面板 ADR-0031)——要让 Otto 看某个文件,用户把路径塞进 composer,
// 由 agent 自己走 read 工具,那条路径才有日志。

import { execFile } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  classifyRgError, isBinaryish, matchesFilter, parseRgJson, sortEntries, PREVIEW_MAX_BYTES,
  type FileEntry, type FileHit, type FilePreview, type FilesErrorKind, type FilesResult,
  type FilesSearchOpts,
} from "../shared/files.js";

export interface FilesDeps {
  /** 一层目录项;抛出的错误带 code(ENOENT/EACCES) */
  listDir(abs: string): { name: string; isDir: boolean; size: number; mtime: number }[];
  statSize(abs: string): number;
  /** 读前 max 字节。文件比 max 短就读多少算多少 */
  readHead(abs: string, max: number): Uint8Array;
  /** 解符号链接。解不开就原样返回(文件可能刚被删) */
  realpath(abs: string): string;
  /** rg 子进程;reject 的错误带 code(ENOENT = 没装;1 = 没匹配) */
  execRg(args: string[], cwd: string): Promise<{ stdout: string }>;
  /** 交给系统默认程序(electron 的 shell,由 index.ts 注入) */
  openPath(abs: string): void;
  /** 在 Finder 里选中它(同上) */
  showInFolder(abs: string): void;
}

/** fs/rg 那五个的真实现。electron 那两个由 index.ts 补上——这里补不了,
    import electron 会让本模块在 vitest 里加载失败 */
export const nodeFilesDeps: Omit<FilesDeps, "openPath" | "showInFolder"> = {
  listDir(abs) {
    return readdirSync(abs, { withFileTypes: true }).map((d) => {
      // 符号链接按目标类型归类;目标读不到(断链)就退回 dirent 自己的判断
      let isDir = d.isDirectory();
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(resolve(abs, d.name));
        isDir = st.isDirectory();
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        isDir = d.isDirectory();
      }
      return { name: d.name, isDir, size, mtime };
    });
  },
  statSize(abs) {
    return statSync(abs).size;
  },
  readHead(abs, max) {
    const fd = openSync(abs, "r");
    try {
      const buf = new Uint8Array(max);
      const read = readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  },
  realpath(abs) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  },
  execRg(args, cwd) {
    return new Promise((res, rej) => {
      execFile("rg", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) rej(Object.assign(err, { stderr: String(stderr) }));
        else res({ stdout: String(stdout) });
      });
    });
  },
};

/** 名字模式最多回这么多条;内容模式最多这么多条命中。
    上限是给渲染层的保护:一次塞几万行进 React 列表,面板就废了 */
const MAX_NAME_HITS = 500;
const MAX_CONTENT_HITS = 200;

function fail(kind: FilesErrorKind, detail: string) {
  return { ok: false as const, kind, detail };
}

function classifyFsError(err: unknown): "no-dir" | "denied" {
  return (err as { code?: string } | null)?.code === "EACCES" ? "denied" : "no-dir";
}

export interface FilesService {
  list(root: string, relDir: string): FilesResult<FileEntry[]>;
  search(root: string, query: string, opts: FilesSearchOpts): Promise<FilesResult<FileHit[]>>;
  read(root: string, rel: string): FilesResult<FilePreview>;
  reveal(root: string, rel: string, how: "open" | "folder"): FilesResult<null>;
}

export function createFilesService(deps: FilesDeps): FilesService {
  /** 根内校验:先按字面 resolve 挡 ../,再 realpath 挡指向根外的符号链接。
      两道都要——realpath 对不存在的路径解不出来,字面那道才是常态防线 */
  function inside(root: string, rel: string): string | null {
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    const real = deps.realpath(abs);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return abs;
  }

  return {
    list(root, relDir) {
      const abs = inside(root, relDir);
      if (abs === null) return fail("outside-root", relDir);
      try {
        const raw = deps.listDir(abs);
        return {
          ok: true,
          value: sortEntries(
            raw.map((d) => ({
              name: d.name,
              kind: d.isDir ? ("dir" as const) : ("file" as const),
              size: d.size,
              mtime: d.mtime,
            }))
          ),
        };
      } catch (err) {
        return fail(classifyFsError(err), String((err as Error).message ?? err));
      }
    },

    async search(root, query, opts) {
      if (query === "") return { ok: true, value: [] };
      const ignore = opts.includeIgnored ? ["--no-ignore", "--hidden"] : [];
      // 查询一律走 `--` 之后:参数是数组传的、不过 shell,这里防的是
      // "-foo" 被 rg 当成选项(选项注入),不是命令注入
      const args = opts.content
        ? ["--json", "-n", "--max-count", "5", ...ignore, "--", query]
        : ["--files", ...ignore];
      try {
        const { stdout } = await deps.execRg(args, root);
        if (!opts.content) {
          const hits = stdout
            .split("\n")
            .filter((p) => p !== "" && matchesFilter(p, query))
            .slice(0, MAX_NAME_HITS)
            .map((rel) => ({ rel, line: null, text: null }));
          return { ok: true, value: hits };
        }
        return { ok: true, value: parseRgJson(stdout).slice(0, MAX_CONTENT_HITS) };
      } catch (err) {
        const kind = classifyRgError(err);
        if (kind === null) return { ok: true, value: [] }; // 退出码 1 = 没匹配
        return fail(kind, String((err as Error).message ?? err));
      }
    },

    read(root, rel) {
      const abs = inside(root, rel);
      if (abs === null) return fail("outside-root", rel);
      try {
        const size = deps.statSize(abs);
        const buf = deps.readHead(abs, PREVIEW_MAX_BYTES);
        if (isBinaryish(buf)) return fail("binary", String(size));
        return {
          ok: true,
          value: { text: new TextDecoder().decode(buf), truncated: size > PREVIEW_MAX_BYTES },
        };
      } catch (err) {
        return fail(classifyFsError(err), String((err as Error).message ?? err));
      }
    },

    reveal(root, rel, how) {
      const abs = inside(root, rel);
      if (abs === null) return fail("outside-root", rel);
      if (how === "open") deps.openPath(abs);
      else deps.showInFolder(abs);
      return { ok: true, value: null };
    },
  };
}
