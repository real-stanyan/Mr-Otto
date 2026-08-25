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
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { EDITOR_CATALOG, editorSearchDirs, type EditorApp } from "../shared/editors.js";
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
  /** 路径存在吗(探编辑器 bundle 用) */
  exists(abs: string): boolean;
  /** 当前用户的家目录(~/Applications 那一层) */
  homeDir(): string;
  /** 那个 app 的图标,png 的 data URI。取不到回空串(菜单退回纯文字) */
  appIcon(appPath: string): Promise<string>;
  /** 用指定 app 打开:macOS 的 `open -a <app> <file>`。失败不抛给调用方,
      只记一笔——用户能看见的失败信号是"文件没在编辑器里打开" */
  openWith(appPath: string, target: string): void;
}

/** fs/rg/图标那几个的真实现。electron 那两个(openPath / showInFolder)由
    index.ts 补上——这里补不了,import electron 会让本模块在 vitest 里加载失败 */
/** 一枚图标解出来就记住:同一次开面板要问十几个 app,而 .app 的图标在
    app 自己升级前不会变。进程内缓存,重启即失效 */
const iconCache = new Map<string, string>();

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) rej(err);
      else res(String(stdout));
    });
  });
}

/** app bundle 里那枚 .icns 的路径。先问 Info.plist 的 CFBundleIconFile
    (plutil 认二进制 plist),问不出来就退回 Resources 里第一枚 .icns */
async function icnsPath(appPath: string): Promise<string> {
  const resources = `${appPath}/Contents/Resources`;
  try {
    const raw = (
      await run("plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", `${appPath}/Contents/Info.plist`])
    ).trim();
    if (raw !== "") {
      const file = raw.endsWith(".icns") ? raw : `${raw}.icns`;
      if (existsSync(`${resources}/${file}`)) return `${resources}/${file}`;
    }
  } catch {
    // 没这个键 / plist 读不了 —— 退回扫目录
  }
  const found = readdirSync(resources).find((f) => f.endsWith(".icns"));
  if (found === undefined) throw new Error(`no icns in ${resources}`);
  return `${resources}/${found}`;
}

export const nodeFilesDeps: Omit<FilesDeps, "openPath" | "showInFolder"> = {
  // electron 的 app.getFileIcon 对 .app 包回的是通用占位图(三个编辑器长一个样),
  // 所以自己去 bundle 里取那枚 .icns,用系统自带的 sips 转成 png
  async appIcon(appPath) {
    const hit = iconCache.get(appPath);
    if (hit !== undefined) return hit;
    const out = `${tmpdir()}/otto-editor-icon-${appPath.replace(/[^a-zA-Z0-9]/g, "_")}.png`;
    try {
      await run("sips", ["-s", "format", "png", "--resampleHeightWidthMax", "64", await icnsPath(appPath), "--out", out]);
      const uri = `data:image/png;base64,${readFileSync(out).toString("base64")}`;
      iconCache.set(appPath, uri);
      return uri;
    } finally {
      rmSync(out, { force: true });
    }
  },
  exists(abs) {
    return existsSync(abs);
  },
  homeDir() {
    return homedir();
  },
  openWith(appPath, target) {
    // 参数走数组不过 shell;appPath 只可能来自本服务探出来的名单(reveal 里校验过)
    execFile("open", ["-a", appPath, target], () => {});
  },
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
  /** 本机装了哪些编辑器(按 EDITOR_CATALOG 的顺序,带各自的图标)。现探不缓存:
      用户装完新编辑器不该重启 app 才看得见 */
  editors(): Promise<EditorApp[]>;
  list(root: string, relDir: string): FilesResult<FileEntry[]>;
  search(root: string, query: string, opts: FilesSearchOpts): Promise<FilesResult<FileHit[]>>;
  read(root: string, rel: string): FilesResult<FilePreview>;
  /** open = 系统默认程序,folder = 在 Finder 中显示,app = 指定编辑器
      (appName 必须是 editors() 给过的名字) */
  reveal(root: string, rel: string, how: "open" | "folder" | "app", appName?: string): FilesResult<null>;
}

export function createFilesService(deps: FilesDeps): FilesService {
  /** 根内校验:先按字面 resolve 挡 ../,再 realpath 挡指向根外的符号链接。
      两道都要——realpath 对不存在的路径解不出来,字面那道才是常态防线。
      第二道比的是**解过的根**:macOS 的 /var/folders/... 本身就是 /private/var
      的软链,拿字面根去比,整个工作区都会被判成越狱(e2e 在这翻过车)。 */
  function inside(root: string, rel: string): string | null {
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    const realRoot = deps.realpath(root);
    const real = deps.realpath(abs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return abs;
  }

  /** 装了哪些(不含图标)。reveal 的白名单校验走这个同步版本——
      为了校验一个名字去解码十几枚图标是白花的力气 */
  function probe(): EditorApp[] {
    const dirs = editorSearchDirs(deps.homeDir());
    const out: EditorApp[] = [];
    for (const name of EDITOR_CATALOG) {
      for (const dir of dirs) {
        const appPath = `${dir}/${name}.app`;
        if (deps.exists(appPath)) {
          out.push({ name, appPath, icon: "" });
          break; // 两层都装了只算一个:菜单里出现两条同名项没有意义
        }
      }
    }
    return out;
  }

  return {
    async editors() {
      const found = probe();
      const icons = await Promise.all(
        // 一枚取不到不该拖垮整份名单:那一项退回纯文字条目
        found.map((e) => deps.appIcon(e.appPath).catch(() => ""))
      );
      return found.map((e, i) => ({ ...e, icon: icons[i] ?? "" }));
    },

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
      // 恒含被忽略的文件:树是全显的,搜索另设一套规矩会让"树里看得见、搜不出来"
      // 变成一个要解释的怪现象。一条规矩管两处
      const ignore = ["--no-ignore", "--hidden"];
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

    reveal(root, rel, how, appName) {
      const abs = inside(root, rel);
      if (abs === null) return fail("outside-root", rel);
      if (how === "app") {
        // 只认自己探出来的那份名单:菜单给什么就只能开什么。渲染层被注入了
        // 别的字符串也进不了 `open -a`
        const app = probe().find((e) => e.name === appName);
        if (app === undefined) return fail("unknown-app", String(appName));
        deps.openWith(app.name, abs);
        return { ok: true, value: null };
      }
      if (how === "open") deps.openPath(abs);
      else deps.showInFolder(abs);
      return { ok: true, value: null };
    },
  };
}
