# 右侧栏 Files 面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右侧槽位加第 6 个互斥视图——工作区文件树 + 过滤/内容搜索 + 按格式上色的图标 + 只读预览。

**Architecture:** 纯逻辑落 `src/shared/files.ts`（零 IO，好测），主进程 `src/main/filesService.ts` 用依赖注入包住 fs/ripgrep（照 `protocolService.ts` / `gitGraphService.ts` 的模式），四条新 IPC 通道过 `ShellBridge`，渲染层 `FilesView.tsx` 只调 `window.otter.files*`。树懒加载（一次列一层），搜索走 ripgrep 缺失降级。

**Tech Stack:** TypeScript strict / Electron（主进程 fs + child_process）/ React + Zustand / Tailwind + shadcn/ui / react-markdown + rehype-highlight / vitest / Playwright-electron

**Spec:** `docs/superpowers/specs/2026-08-25-files-panel-design.md`

**Issue:** #400

## Global Constraints

- 渲染进程禁止 import Node/Electron 模块（`tests/architecture.test.ts` 第 2 条门禁）。`FilesView.tsx` 里一行 `node:path` 都不能有——需要拼路径就在 `shared/files.ts` 里写纯函数（`joinRel`），两边都能用。
- 主进程直用 `fs`/`child_process` 合规（app 功能不是 agent 工具，同 protocolService 先例）。**不要**为此改 `ExecutionWorld`。
- 面板只读：不提供任何写文件的通道。
- 面板内容不进事件日志、不进模型上下文（同终端面板 ADR-0031）。
- 每条通道返回判别联合 `{ ok: true, ... } | { ok: false, kind, detail }`，**不抛**（照 `GitLogResult` 的形状）。
- 门禁 = `npm test`（`tsc --noEmit` + `vitest run`）。基线：237 files / 2572 tests 全绿。
- 提交信息写**为什么**，不只是做了什么；结尾带 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

---

### Task 1: 纯逻辑层 `src/shared/files.ts`

零 IO 的类型 + 纯函数。主进程用它、渲染层用它、测试直接喂假数据。

**Files:**
- Create: `src/shared/files.ts`
- Test: `tests/shared/files.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface FileEntry { name: string; kind: "dir" | "file"; size: number; mtime: number }`
  - `interface FileHit { rel: string; line: number | null; text: string | null }`
  - `interface FilePreview { text: string; truncated: boolean }`
  - `type FilesErrorKind = "no-dir" | "denied" | "outside-root" | "too-large" | "binary" | "rg-missing" | "search-error"`
  - `type FilesResult<T> = { ok: true; value: T } | { ok: false; kind: FilesErrorKind; detail: string }`
  - `interface FilesSearchOpts { content: boolean; includeIgnored: boolean }`
  - `sortEntries(entries: FileEntry[]): FileEntry[]`
  - `matchesFilter(rel: string, query: string): boolean`
  - `parseRgJson(stdout: string): FileHit[]`
  - `classifyRgError(err: unknown): FilesErrorKind | null`
  - `isBinaryish(buf: Uint8Array): boolean`
  - `joinRel(dir: string, name: string): string`

- [ ] **Step 1: 写失败的测试**

新建 `tests/shared/files.test.ts`：

```ts
// shared/files.ts 是 Files 面板的纯逻辑层:排序/过滤/rg 输出解析/二进制判定。
// 这层没有 IO,所以这里能把"面板到底按什么规矩排、什么算命中"钉死,
// 不用去碰真文件系统。

import { describe, expect, it } from "vitest";
import {
  classifyRgError, isBinaryish, joinRel, matchesFilter, parseRgJson, sortEntries,
  type FileEntry,
} from "../../src/shared/files.js";

function entry(name: string, kind: "dir" | "file"): FileEntry {
  return { name, kind, size: 0, mtime: 0 };
}

describe("sortEntries", () => {
  it("目录排在文件前面", () => {
    const out = sortEntries([entry("a.ts", "file"), entry("zz", "dir")]);
    expect(out.map((e) => e.name)).toEqual(["zz", "a.ts"]);
  });

  it("同类按名字排,数字按数值不按字典序", () => {
    const out = sortEntries([entry("f10.ts", "file"), entry("f2.ts", "file")]);
    expect(out.map((e) => e.name)).toEqual(["f2.ts", "f10.ts"]);
  });

  it("点文件不下沉——树是全显的,把它们排到最后等于藏起来", () => {
    const out = sortEntries([entry("src", "dir"), entry(".github", "dir")]);
    expect(out.map((e) => e.name)).toEqual([".github", "src"]);
  });

  it("不改原数组", () => {
    const input = [entry("b", "file"), entry("a", "file")];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(["b", "a"]);
  });
});

describe("matchesFilter", () => {
  it("子序列命中:fic 命中 src/lib/fileIcon.ts", () => {
    expect(matchesFilter("src/lib/fileIcon.ts", "fic")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(matchesFilter("src/App.tsx", "app")).toBe(true);
  });

  it("顺序不对不算命中", () => {
    expect(matchesFilter("src/App.tsx", "xpp")).toBe(false);
  });

  it("空查询命中一切——空过滤框不该把树清空", () => {
    expect(matchesFilter("whatever", "")).toBe(true);
  });
});

describe("parseRgJson", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "/w/src/a.ts" } } }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "/w/src/a.ts" },
        lines: { text: "const foo = 1\n" },
        line_number: 12,
      },
    }),
    JSON.stringify({ type: "end", data: {} }),
  ].join("\n");

  it("只取 match 行,begin/end 忽略", () => {
    expect(parseRgJson(stdout)).toEqual([
      { rel: "/w/src/a.ts", line: 12, text: "const foo = 1" },
    ]);
  });

  it("坏行跳过而不是整批炸——rg 中途被杀会留半行 JSON", () => {
    expect(parseRgJson('{"type":"match"' + "\n" + stdout)).toHaveLength(1);
  });

  it("空输出 = 空数组", () => {
    expect(parseRgJson("")).toEqual([]);
  });
});

describe("classifyRgError", () => {
  it("ENOENT = 没装 rg", () => {
    expect(classifyRgError({ code: "ENOENT" })).toBe("rg-missing");
  });

  it("退出码 1 = 没匹配,不是错误", () => {
    expect(classifyRgError({ code: 1 })).toBe(null);
  });

  it("其它 = 搜索出错", () => {
    expect(classifyRgError({ code: 2, stderr: "boom" })).toBe("search-error");
  });
});

describe("isBinaryish", () => {
  it("含 NUL 字节 = 二进制", () => {
    expect(isBinaryish(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
  });

  it("纯文本不是", () => {
    expect(isBinaryish(new TextEncoder().encode("hello\n世界"))).toBe(false);
  });

  it("只看前 8KB:超出部分的 NUL 不算(截断预览本来就只读前面那截)", () => {
    const buf = new Uint8Array(9000);
    buf[8500] = 0;
    expect(isBinaryish(buf)).toBe(false);
  });
});

describe("joinRel", () => {
  it("根目录下拼出来不带前导斜杠", () => {
    expect(joinRel("", "src")).toBe("src");
  });

  it("子目录用 / 连", () => {
    expect(joinRel("src/lib", "a.ts")).toBe("src/lib/a.ts");
  });
});
```

- [ ] **Step 2: 跑一次确认它红**

```bash
npx vitest run tests/shared/files.test.ts
```

期望：FAIL，`Failed to resolve import "../../src/shared/files.js"`。

- [ ] **Step 3: 写实现**

新建 `src/shared/files.ts`：

```ts
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
  | "search-error";

export type FilesResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: FilesErrorKind; detail: string };

export interface FilesSearchOpts {
  /** true = 搜文件内容(? 前缀);false = 只过滤文件名 */
  content: boolean;
  /** true = 连 .gitignore 忽略掉的一起搜(面板头那个开关) */
  includeIgnored: boolean;
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
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
npx vitest run tests/shared/files.test.ts
```

期望：PASS，20 条左右。

- [ ] **Step 5: 提交**

```bash
git add src/shared/files.ts tests/shared/files.test.ts
git commit -m "feat(files): 面板的纯逻辑层——排序/fuzzy/rg 解析/二进制判定（#400）

零 IO 单独一层的理由:面板的规矩(目录排前面、fic 算命中 fileIcon.ts、
rg 退出码 1 是没匹配不是出错)都是能验的判断,不该埋在一个要开真目录、
真起 rg 子进程才能跑的地方。

点文件不下沉是刻意的:树全显,把点文件排到最后等于藏起来。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 主进程 `src/main/filesService.ts`

依赖注入包住 fs 和 ripgrep，四个能力 + 三条安全边界。

**Files:**
- Create: `src/main/filesService.ts`
- Test: `tests/main/filesService.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部导出
- Produces:
  - `interface FilesDeps { listDir(abs): {name,isDir,size,mtime}[]; statSize(abs): number; readHead(abs, max): Uint8Array; realpath(abs): string; execRg(args, cwd): Promise<{stdout:string}>; openPath(abs): void; showInFolder(abs): void }`
  - `createFilesService(deps?: FilesDeps): FilesService`
  - `interface FilesService { list(root, relDir): FilesResult<FileEntry[]>; search(root, query, opts): Promise<FilesResult<FileHit[]>>; read(root, rel): FilesResult<FilePreview>; reveal(root, rel, how): FilesResult<null> }`

- [ ] **Step 1: 写失败的测试**

新建 `tests/main/filesService.test.ts`：

```ts
// filesService 的合同 —— 重点是三条安全边界(越狱路径、大文件、二进制)
// 和 rg 缺失时的降级。全部喂假 deps,不碰真文件系统。

import { describe, expect, it, vi } from "vitest";
import { createFilesService, type FilesDeps } from "../../src/main/filesService.js";

const ROOT = "/w";

function deps(over: Partial<FilesDeps> = {}): FilesDeps {
  return {
    listDir: () => [
      { name: "src", isDir: true, size: 0, mtime: 1 },
      { name: "a.ts", isDir: false, size: 10, mtime: 2 },
    ],
    statSize: () => 10,
    readHead: () => new TextEncoder().encode("hello"),
    realpath: (p) => p,
    execRg: async () => ({ stdout: "" }),
    openPath: () => {},
    showInFolder: () => {},
    ...over,
  };
}

describe("list", () => {
  it("列一层,目录在前", () => {
    const svc = createFilesService(deps());
    const r = svc.list(ROOT, "");
    expect(r.ok && r.value.map((e) => e.name)).toEqual(["src", "a.ts"]);
  });

  it("目录读不了 = no-dir,不抛", () => {
    const svc = createFilesService(deps({
      listDir: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    }));
    const r = svc.list(ROOT, "gone");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe("no-dir");
  });

  it("没权限 = denied", () => {
    const svc = createFilesService(deps({
      listDir: () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); },
    }));
    const r = svc.list(ROOT, "secret");
    expect(!r.ok && r.kind).toBe("denied");
  });

  it("../ 越狱挡在读之前", () => {
    const listDir = vi.fn();
    const svc = createFilesService(deps({ listDir }));
    const r = svc.list(ROOT, "../etc");
    expect(!r.ok && r.kind).toBe("outside-root");
    expect(listDir).not.toHaveBeenCalled();
  });
});

describe("read", () => {
  it("普通文本文件读出来", () => {
    const svc = createFilesService(deps());
    const r = svc.read(ROOT, "a.ts");
    expect(r.ok && r.value).toEqual({ text: "hello", truncated: false });
  });

  it("符号链接指向根外 = outside-root(realpath 之后才判)", () => {
    const svc = createFilesService(deps({ realpath: () => "/etc/passwd" }));
    const r = svc.read(ROOT, "link.txt");
    expect(!r.ok && r.kind).toBe("outside-root");
  });

  it("超过 512KB 只读前 512KB 并标 truncated", () => {
    const big = 600 * 1024;
    const readHead = vi.fn(() => new TextEncoder().encode("head"));
    const svc = createFilesService(deps({ statSize: () => big, readHead }));
    const r = svc.read(ROOT, "big.log");
    expect(r.ok && r.value.truncated).toBe(true);
    expect(readHead).toHaveBeenCalledWith("/w/big.log", 512 * 1024);
  });

  it("二进制不预览 = binary,detail 带大小", () => {
    const svc = createFilesService(deps({
      readHead: () => new Uint8Array([0x89, 0x50, 0x00, 0x01]),
      statSize: () => 2048,
    }));
    const r = svc.read(ROOT, "logo.png");
    expect(!r.ok && r.kind).toBe("binary");
    expect(!r.ok && r.detail).toContain("2048");
  });
});

describe("search", () => {
  it("名字模式:rg --files 的路径表在主进程侧 fuzzy 筛", async () => {
    const execRg = vi.fn(async () => ({ stdout: "src/fileIcon.ts\nsrc/store.ts\n" }));
    const svc = createFilesService(deps({ execRg }));
    const r = await svc.search(ROOT, "fic", { content: false, includeIgnored: false });
    expect(r.ok && r.value.map((h) => h.rel)).toEqual(["src/fileIcon.ts"]);
    expect(execRg.mock.calls[0]![0]).toContain("--files");
  });

  it("includeIgnored 才加 --no-ignore --hidden", async () => {
    const execRg = vi.fn(async () => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    await svc.search(ROOT, "x", { content: false, includeIgnored: false });
    expect(execRg.mock.calls[0]![0]).not.toContain("--no-ignore");
    await svc.search(ROOT, "x", { content: false, includeIgnored: true });
    expect(execRg.mock.calls[1]![0]).toContain("--no-ignore");
  });

  it("内容模式:query 走 -- 之后,不会被当成 rg 的选项", async () => {
    const execRg = vi.fn(async () => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    await svc.search(ROOT, "-foo", { content: true, includeIgnored: false });
    const args = execRg.mock.calls[0]![0];
    expect(args[args.indexOf("--") + 1]).toBe("-foo");
  });

  it("退出码 1(没匹配)= 空结果,不是错误", async () => {
    const svc = createFilesService(deps({
      execRg: async () => { throw Object.assign(new Error("no match"), { code: 1 }); },
    }));
    const r = await svc.search(ROOT, "zzz", { content: true, includeIgnored: false });
    expect(r.ok && r.value).toEqual([]);
  });

  it("没装 rg = rg-missing,渲染层据此标降级", async () => {
    const svc = createFilesService(deps({
      execRg: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    }));
    const r = await svc.search(ROOT, "x", { content: true, includeIgnored: false });
    expect(!r.ok && r.kind).toBe("rg-missing");
  });

  it("空查询不起子进程", async () => {
    const execRg = vi.fn(async () => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    const r = await svc.search(ROOT, "", { content: false, includeIgnored: false });
    expect(r.ok && r.value).toEqual([]);
    expect(execRg).not.toHaveBeenCalled();
  });
});

describe("reveal", () => {
  it("外部打开同样过根内校验", () => {
    const openPath = vi.fn();
    const svc = createFilesService(deps({ openPath, realpath: () => "/etc/passwd" }));
    const r = svc.reveal(ROOT, "link.txt", "open");
    expect(!r.ok && r.kind).toBe("outside-root");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("正常路径转给 shell", () => {
    const showInFolder = vi.fn();
    const svc = createFilesService(deps({ showInFolder }));
    const r = svc.reveal(ROOT, "a.ts", "folder");
    expect(r.ok).toBe(true);
    expect(showInFolder).toHaveBeenCalledWith("/w/a.ts");
  });
});
```

- [ ] **Step 2: 跑一次确认它红**

```bash
npx vitest run tests/main/filesService.test.ts
```

期望：FAIL，`Failed to resolve import "../../src/main/filesService.js"`。

- [ ] **Step 3: 写实现**

新建 `src/main/filesService.ts`：

```ts
// Files 面板 — 主进程数据源:列目录走 fs,搜索走 ripgrep 子进程。
// app 功能不是 agent 工具,主进程直用 fs/child_process 合规(同 protocolService/
// gitGraphService 先例)。DI 模式照抄它们:测试喂假实现。
//
// 严格只读:没有任何写文件的出口。面板读到的东西不进事件日志、不进模型上下文
// (同终端面板 ADR-0031)——要让 Otto 看某个文件,用户把路径塞进 composer,
// 由 agent 自己走 read 工具,那条路径才有日志。

import { execFile } from "node:child_process";
import { openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { shell } from "electron";
import {
  classifyRgError, isBinaryish, matchesFilter, parseRgJson, sortEntries, PREVIEW_MAX_BYTES,
  type FileEntry, type FileHit, type FilePreview, type FilesResult, type FilesSearchOpts,
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
  openPath(abs: string): void;
  showInFolder(abs: string): void;
}

const nodeDeps: FilesDeps = {
  listDir(abs) {
    return readdirSync(abs, { withFileTypes: true }).map((d) => {
      // 符号链接按目标类型归类;目标读不到就当文件(至少还能试着预览)
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
  openPath(abs) {
    void shell.openPath(abs);
  },
  showInFolder(abs) {
    shell.showItemInFolder(abs);
  },
};

/** 名字模式最多回这么多条;内容模式最多这么多条命中。
    上限是给渲染层的保护:一次塞几万行进 React 列表,面板就废了 */
const MAX_NAME_HITS = 500;
const MAX_CONTENT_HITS = 200;

function fail(kind: FilesResult<never> extends { ok: false; kind: infer K } ? K : never, detail: string) {
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

export function createFilesService(deps: FilesDeps = nodeDeps): FilesService {
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
```

> 注意 `fail` 那个类型体操若 tsc 不认，直接写成 `function fail(kind: FilesErrorKind, detail: string) { return { ok: false as const, kind, detail }; }` 并 import `FilesErrorKind`。

- [ ] **Step 4: 跑测试确认全绿**

```bash
npx vitest run tests/main/filesService.test.ts && npx tsc --noEmit
```

期望：15 条 PASS，tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add src/main/filesService.ts tests/main/filesService.test.ts
git commit -m "feat(files): 主进程服务——列一层/rg 搜索/只读预览/外部打开（#400）

三条安全边界都钉了测试:resolve 挡字面 ../、realpath 挡指向根外的符号链接、
预览超 512KB 截断、二进制只报大小不预览。两道路径校验都要——realpath 对
不存在的路径解不出来,字面那道才是常态防线。

rg 的查询一律走 -- 之后:参数是数组传的不过 shell,这里防的是 \"-foo\" 被
当成选项,不是命令注入。退出码 1 是\"没匹配\"不是出错,单独一条测试钉着。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 四条 IPC 通道

**Files:**
- Modify: `src/shared/shellBridge.ts`（接口方法 + `CHANNELS`）
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: Task 1 的类型、Task 2 的 `createFilesService`
- Produces: `window.otter.filesList / filesSearch / filesRead / filesReveal`

- [ ] **Step 1: 加接口方法**

`src/shared/shellBridge.ts` 顶部 import 区加：

```ts
import type { FileEntry, FileHit, FilePreview, FilesResult, FilesSearchOpts } from "./files.js";
```

在 `gitStatus(...)` 那条之后、`setPresenceWorkspace` 之前插入：

```ts
  /** Files 面板(只读):列一层目录。全显——node_modules/out/点文件都列,
      不卡的前提是一次只列一层(懒加载),不是靠过滤 */
  filesList(root: string, relDir: string): Promise<FilesResult<FileEntry[]>>;
  /** 文件名 fuzzy(content:false)或内容搜索(content:true,? 前缀触发)。
      默认尊重 .gitignore——树全显是为了找得到,搜索全显是让 node_modules
      淹没结果;includeIgnored 是面板头那个开关 */
  filesSearch(root: string, query: string, opts: FilesSearchOpts): Promise<FilesResult<FileHit[]>>;
  /** 只读预览。>512KB 截断,二进制不预览(kind: "binary",detail 是字节数) */
  filesRead(root: string, rel: string): Promise<FilesResult<FilePreview>>;
  /** 交给系统:open = 默认程序,folder = 在 Finder 中显示 */
  filesReveal(root: string, rel: string, how: "open" | "folder"): Promise<FilesResult<null>>;
```

`CHANNELS` 里 `gitStatus` 那条之后加：

```ts
  filesList: "otter:filesList",
  filesSearch: "otter:filesSearch",
  filesRead: "otter:filesRead",
  filesReveal: "otter:filesReveal",
```

- [ ] **Step 2: preload 转发**

`src/preload/index.ts` 的 `gitStatus` 那行之后加：

```ts
  filesList: (root, relDir) => ipcRenderer.invoke(CHANNELS.filesList, root, relDir),
  filesSearch: (root, query, opts) => ipcRenderer.invoke(CHANNELS.filesSearch, root, query, opts),
  filesRead: (root, rel) => ipcRenderer.invoke(CHANNELS.filesRead, root, rel),
  filesReveal: (root, rel, how) => ipcRenderer.invoke(CHANNELS.filesReveal, root, rel, how),
```

- [ ] **Step 3: 主进程注册**

`src/main/index.ts` 顶部 import 加 `import { createFilesService } from "./filesService.js";`，在 Git Graph 那组 handler 之后加：

```ts
  // Files 面板(只读):service 无状态,建一次全局复用
  const files = createFilesService();
  ipcMain.handle(CHANNELS.filesList, (_e, root: string, relDir: string) => files.list(root, relDir));
  ipcMain.handle(CHANNELS.filesSearch, (_e, root: string, query: string, opts: FilesSearchOpts) =>
    files.search(root, query, opts)
  );
  ipcMain.handle(CHANNELS.filesRead, (_e, root: string, rel: string) => files.read(root, rel));
  ipcMain.handle(CHANNELS.filesReveal, (_e, root: string, rel: string, how: "open" | "folder") =>
    files.reveal(root, rel, how)
  );
```

同文件 import 区加 `import type { FilesSearchOpts } from "../shared/files.js";`。

- [ ] **Step 4: 跑门禁**

```bash
npm test
```

期望：tsc 无错，2587+ 全绿（Task 1/2 的新用例已经在里面）。tsc 会替我们抓漏：`ShellBridge` 加了方法而 preload 没实现，这里就红。

- [ ] **Step 5: 提交**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(files): 四条只读通道过 ShellBridge（#400）

渲染层不许碰 Node(架构门禁第 2 条),面板要列目录就只能走通道。四条都只读,
没有任何写文件的出口——写是 agent 的活,有日志有审批;面板里开一个写入口
等于开一条事实来源之外的旁路。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: store 状态 + 入口 + 快捷键

**Files:**
- Modify: `src/renderer/src/store.ts`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/renderer/filesPanelStore.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `useChat` 上的 `filesPanelOpen: boolean` / `openFilesPanel(): void` / `closeFilesPanel(): void`

- [ ] **Step 1: 写失败的测试**

新建 `tests/renderer/filesPanelStore.test.ts`（先照抄同目录里已有 store 测试的 import/重置写法——若目录里没有先例，用 `useChat.setState` 直接置位）：

```ts
// 右侧槽位是**一个**位置:6 个视图互斥。这条最容易漏——加第 6 个视图时,
// 前 5 个的 open 动作里都得多写一行 filesPanelOpen: false,漏一个就会出现
// "终端和 Files 同时开着,后者盖住前者"的鬼影。
//
// 这个测试就是那 6 行的守卫。

import { beforeEach, describe, expect, it } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";

describe("Files 面板与其它右侧视图互斥", () => {
  beforeEach(() => {
    useChat.setState({
      filesPanelOpen: false, terminalPanelOpen: false, browserPanelOpen: false,
      protocolOpen: false, gitGraphOpen: false, friendChat: null, settingsSection: null,
    });
  });

  it("开 Files 关掉终端", () => {
    useChat.getState().openTerminalPanel();
    useChat.getState().openFilesPanel();
    expect(useChat.getState().terminalPanelOpen).toBe(false);
    expect(useChat.getState().filesPanelOpen).toBe(true);
  });

  it("开终端关掉 Files", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().openTerminalPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("开浏览器关掉 Files", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().openBrowserPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("开设置页关掉 Files", () => {
    useChat.getState().openFilesPanel();
    void useChat.getState().openSettings("account");
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });

  it("关自己只关自己", () => {
    useChat.getState().openFilesPanel();
    useChat.getState().closeFilesPanel();
    expect(useChat.getState().filesPanelOpen).toBe(false);
  });
});
```

- [ ] **Step 2: 跑一次确认它红**

```bash
npx vitest run tests/renderer/filesPanelStore.test.ts
```

期望：FAIL，`openFilesPanel is not a function`。

- [ ] **Step 3: 改 store**

`src/renderer/src/store.ts`：

1. 状态接口里 `terminalPanelOpen: boolean;` 旁边加 `/** 右侧槽位:Files 面板(与其它 5 个视图互斥) */ filesPanelOpen: boolean;`
2. 动作接口里加 `openFilesPanel(): void;` / `closeFilesPanel(): void;`
3. 两处初始状态（约 667 / 742 行，`terminalPanelOpen: false` 各出现一次）各加 `filesPanelOpen: false,`
4. 动作实现，放在 `closeBrowserPanel` 之后：

```ts
  openFilesPanel: () =>
    set({
      filesPanelOpen: true,
      // 互斥:同一块右侧槽位
      terminalPanelOpen: false, browserPanelOpen: false, protocolOpen: false,
      gitGraphOpen: false, settingsSection: null, friendChat: null,
    }),

  closeFilesPanel: () => set({ filesPanelOpen: false }),
```

5. **把 `filesPanelOpen: false` 补进其它 5 个 open 动作的互斥块**：`openSettings` 的四个分支（约 824/833/839/845 行）、`openProtocol`（约 1125）、`openGitGraph`（约 1209）、`openTerminalPanel`（约 1220）、`openBrowserPanel`（约 1228）、开 DM 那处（约 1440）。

- [ ] **Step 4: 跑测试确认全绿**

```bash
npx vitest run tests/renderer/filesPanelStore.test.ts
```

期望：5 条 PASS。任何一条红 = 第 5 步漏了一处。

- [ ] **Step 5: 接进 App**

`src/renderer/src/App.tsx`：

1. import 加 `import { FilesView } from "./components/FilesView.js";`，lucide 那行加 `FolderOpen`（若已 import 则跳过）
2. 组件里加 `const filesPanelOpen = useChat((s) => s.filesPanelOpen);`（挨着 `terminalPanelOpen` 那几行）
3. `panel` 链加一档（排在 `protocolOpen` 前）：

```tsx
  const panel = friendChat ? <FriendChatView />
    : browserPanelOpen ? <BrowserPanel />
    : terminalPanelOpen ? <TerminalView />
    : filesPanelOpen ? <FilesView />
    : gitGraphOpen ? <GitGraphView />
    : protocolOpen ? <ProtocolView /> : null;
```

4. 「更多」菜单里，`终端` 那项之前加：

```tsx
            <DropdownMenuItem onClick={() => useChat.getState().openFilesPanel()}>
              <FolderOpen /> 文件
            </DropdownMenuItem>
```

5. 快捷键（照 `⌃\`` 那条 effect 的写法，放它旁边）：

```tsx
  // ⌘⇧E = 开/关 Files 面板(VS Code 的 Explorer 同款肌肉记忆)。挂 window:
  // 焦点可能在预览区或树里,输入框收不到
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (useChat.getState().filesPanelOpen) useChat.getState().closeFilesPanel();
        else useChat.getState().openFilesPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

此时 `FilesView` 还不存在，tsc 会红——Task 5 补上。**本步先不跑门禁、不提交**，接着做 Task 5。

---

### Task 5: `FilesView` 的树与过滤

**Files:**
- Create: `src/renderer/src/components/FilesView.tsx`
- Modify: `src/renderer/src/App.tsx`（Task 4 已改，本任务一起提交）

**Interfaces:**
- Consumes: `window.otter.filesList / filesSearch`、`FileTypeIcon` / `FolderIcon`、`joinRel` / `sortEntries` 类型
- Produces: `export function FilesView(): JSX.Element`

- [ ] **Step 1: 写组件（树 + 过滤，预览留给 Task 6）**

新建 `src/renderer/src/components/FilesView.tsx`：

```tsx
// Files 面板 —— 工作区文件树 + 过滤/内容搜索。纯人用的旁路:读到的东西
// 不进事件日志、不进模型上下文(同终端面板 ADR-0031)。要让 Otto 看某个文件,
// 用行内的 @ 动作把路径塞进 composer,由 agent 自己走 read 工具。
//
// 树是**全显**的(node_modules/out/点文件都列),不卡的前提是一次只列一层:
// 展开哪个目录才发一次 filesList,不是开面板扫全树。

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { HEADER_H } from "../settingsShell.js";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Switch } from "./ui/switch.js";
import { SidebarNub } from "./SidebarNub.js";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon.js";
import { joinRel, type FileEntry, type FileHit } from "../../../shared/files.js";

/** 一层目录的缓存:相对路径 → 这层的条目。折叠不清缓存,再展开不重发 */
type DirCache = Map<string, FileEntry[]>;

export function FilesView() {
  const root = useChat((s) => s.workspace);
  const closePanel = useChat((s) => s.closeFilesPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [cache, setCache] = useState<DirCache>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [hits, setHits] = useState<FileHit[] | null>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const loadDir = useCallback(
    async (rel: string) => {
      if (root === "") return;
      const r = await window.otter.filesList(root, rel);
      if (r.ok) {
        setCache((prev) => new Map(prev).set(rel, r.value));
        return;
      }
      // 目录没了就把它从缓存摘掉:留着它下次展开还是空,用户以为是空目录
      setCache((prev) => {
        const next = new Map(prev);
        next.delete(rel);
        return next;
      });
      setNotice(r.kind === "denied" ? "无权限读取该目录" : "目录不存在");
    },
    [root]
  );

  // 换会话 = 换根:清树、清搜索,重新列根目录
  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set());
    setHits(null);
    setQuery("");
    setSelected(null);
    void loadDir("");
  }, [root, loadDir]);

  // 过滤/搜索去抖 150ms。空查询 = 回到树
  useEffect(() => {
    if (query === "") {
      setHits(null);
      setNotice("");
      return undefined;
    }
    const content = query.startsWith("?");
    const term = content ? query.slice(1) : query;
    if (term === "") {
      setHits(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        if (root === "") return;
        const r = await window.otter.filesSearch(root, term, { content, includeIgnored });
        if (r.ok) {
          setHits(r.value);
          setNotice("");
        } else {
          setHits([]);
          setNotice(r.kind === "rg-missing" ? "未装 ripgrep,搜索已降级" : "搜索出错");
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [query, includeIgnored, root]);

  function toggleDir(rel: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else {
        next.add(rel);
        if (!cache.has(rel)) void loadDir(rel);
      }
      return next;
    });
  }

  function renderLevel(rel: string, depth: number): React.ReactNode {
    const entries = cache.get(rel);
    if (entries === undefined) return null;
    return entries.map((e) => {
      const childRel = joinRel(rel, e.name);
      const open = expanded.has(childRel);
      return (
        <div key={childRel}>
          <button
            type="button"
            data-testid="files-row"
            data-rel={childRel}
            onClick={() => (e.kind === "dir" ? toggleDir(childRel) : setSelected(childRel))}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[13px] hover:bg-foreground/[0.06] ${
              selected === childRel ? "bg-foreground/[0.08]" : ""
            }`}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {e.kind === "dir" ? (
              open ? <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                   : <ChevronRight className="size-3.5 shrink-0 opacity-60" />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {e.kind === "dir" ? <FolderIcon /> : <FileTypeIcon path={e.name} />}
            <span className="truncate">{e.name}</span>
          </button>
          {e.kind === "dir" && open && renderLevel(childRel, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3"
        style={{ height: HEADER_H }}
      >
        <SidebarNub />
        <FolderOpen className="size-[14px] opacity-70" />
        <span className="text-sm font-[650]">文件</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          含忽略文件
          <Switch checked={includeIgnored} onCheckedChange={setIncludeIgnored} />
        </label>
        <Button variant="ghost" size="sm" title="刷新" onClick={() => void loadDir("")}>
          <RefreshCw className="size-[14px]" />
        </Button>
        <Button variant="ghost" size="sm" title={panelWide ? "收起" : "展开"} onClick={togglePanelWide}>
          {panelWide ? <Minimize2 className="size-[14px]" /> : <Maximize2 className="size-[14px]" />}
        </Button>
        <Button variant="ghost" size="sm" title="关闭" onClick={closePanel}>
          <X className="size-[14px]" />
        </Button>
      </header>

      <div className="shrink-0 px-3 py-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="过滤文件… (?文本 搜索内容)"
          className="h-8 text-[13px]"
          data-testid="files-filter"
        />
        {notice !== "" && (
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="files-notice">{notice}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="files-tree">
        {hits === null ? (
          renderLevel("", 0)
        ) : hits.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">没有匹配</p>
        ) : (
          hits.map((h, i) => (
            <button
              key={`${h.rel}:${h.line}:${i}`}
              type="button"
              data-testid="files-hit"
              onClick={() => setSelected(h.rel)}
              className="flex w-full items-center gap-1.5 px-2 py-[3px] text-left text-[13px] hover:bg-foreground/[0.06]"
            >
              <FileTypeIcon path={h.rel} />
              <span className="truncate">{h.rel}</span>
              {h.line !== null && (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">:{h.line}</span>
              )}
              {h.text !== null && (
                <span className="truncate font-mono text-[11px] text-muted-foreground">{h.text.trim()}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 跑门禁**

```bash
npm test
```

期望：tsc 无错（`FilesView` 已存在，Task 4 的引用不再红），2592+ 全绿。若 `Switch` 的 props 名不是 `onCheckedChange`，照 `src/renderer/src/components/ui/switch.tsx` 的实际签名改。

- [ ] **Step 3: 提交（Task 4 + 5 一起）**

```bash
git add src/renderer/src/store.ts src/renderer/src/App.tsx src/renderer/src/components/FilesView.tsx tests/renderer/filesPanelStore.test.ts
git commit -m "feat(files): 右侧第 6 个互斥视图——文件树 + 过滤/内容搜索（#400）

树全显但一次只列一层:展开哪个目录才发一次 filesList。开面板扫全树的话,
node_modules 一层就够把面板卡死。

互斥那 6 处单独钉了测试(tests/renderer/filesPanelStore.test.ts):加第 6 个
视图时前 5 个的 open 动作各要多写一行 filesPanelOpen: false,漏一个就会出现
「终端和 Files 同时开着」的鬼影,而这种鬼影肉眼要很久才发现。

图标直接复用 FileTypeIcon/FolderIcon(material-icon-theme 那套早就在仓里)。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 预览区与行内动作

**Files:**
- Create: `src/renderer/src/lib/previewLang.ts`
- Modify: `src/renderer/src/components/FilesView.tsx`
- Test: `tests/renderer/previewLang.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `selected` 状态、`window.otter.filesRead / filesReveal`、`useChat.injectComposer(text, append)`
- Produces: `previewLang(path: string): string`

- [ ] **Step 1: 写失败的测试**

新建 `tests/renderer/previewLang.test.ts`：

```ts
// 后缀 → highlight.js 语言名。为什么不复用 fileIconName:图标名和语言名
// 语义不同(react_ts 是图标名,语言是 tsx;yaml 图标下面可能是 yml/yaml 两种后缀),
// 混用会喂给 rehype-highlight 一个它不认识的语言,整段掉回无高亮。

import { describe, expect, it } from "vitest";
import { previewLang } from "../../src/renderer/src/lib/previewLang.js";

describe("previewLang", () => {
  it("常见后缀认得出", () => {
    expect(previewLang("src/App.tsx")).toBe("tsx");
    expect(previewLang("a/b/store.ts")).toBe("typescript");
    expect(previewLang("x.py")).toBe("python");
    expect(previewLang("conf.yml")).toBe("yaml");
  });

  it("认不出就回空串——空 lang 让 rehype-highlight 自己猜,好过喂个假语言", () => {
    expect(previewLang("weird.zzz")).toBe("");
  });

  it("无后缀文件也不炸", () => {
    expect(previewLang("Makefile")).toBe("makefile");
    expect(previewLang("LICENSE")).toBe("");
  });
});
```

- [ ] **Step 2: 跑一次确认它红**

```bash
npx vitest run tests/renderer/previewLang.test.ts
```

期望：FAIL，模块不存在。

- [ ] **Step 3: 写 `src/renderer/src/lib/previewLang.ts`**

```ts
// 后缀 → highlight.js 语言名(预览区用)。
//
// 为什么不复用 lib/fileIcon.ts 那张表:那张表回的是**图标名**,和语言名
// 只是碰巧有时候一样(react_ts / test-ts / json_schema 都不是语言)。
// 喂 rehype-highlight 一个它不认识的语言,那段代码会整块掉回无高亮。
// 认不出就回空串,让它自己猜。

const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less", html: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  swift: "swift", kt: "kotlin", php: "php", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", graphql: "graphql", dockerfile: "dockerfile", lua: "lua",
};

const BY_NAME: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "dockerfile",
  ".gitignore": "bash",
};

export function previewLang(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? "";
  const named = BY_NAME[base.toLowerCase()];
  if (named !== undefined) return named;
  const parts = base.toLowerCase().split(".");
  if (parts.length < 2) return "";
  return BY_EXT[parts.at(-1) ?? ""] ?? "";
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
npx vitest run tests/renderer/previewLang.test.ts
```

期望：3 条 PASS。

- [ ] **Step 5: 预览区接进 FilesView**

`FilesView.tsx` 追加 import：

```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { AtSign, Copy, ExternalLink } from "lucide-react";
import { previewLang } from "../lib/previewLang.js";
import type { FilePreview } from "../../../shared/files.js";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
```

组件内加状态与副作用：

```tsx
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewNote, setPreviewNote] = useState("");

  // 选中变了就读。读不到不清空上一份?清:留着上一份文件的内容配着新文件名,
  // 是最坏的一种错——用户会以为自己在看这个文件
  useEffect(() => {
    if (selected === null || root === "") {
      setPreview(null);
      setPreviewNote("");
      return;
    }
    void (async () => {
      const r = await window.otter.filesRead(root, selected);
      if (r.ok) {
        setPreview(r.value);
        setPreviewNote(r.value.truncated ? "文件较大,只显示前 512KB" : "");
      } else {
        setPreview(null);
        setPreviewNote(
          r.kind === "binary" ? `二进制文件 · ${Number(r.detail).toLocaleString()} 字节`
          : r.kind === "denied" ? "无权限读取"
          : r.kind === "outside-root" ? "无法打开"
          : "文件不存在"
        );
      }
    })();
  }, [selected, root]);
```

组件内加动作（三个行内动作 + 复制路径）：

```tsx
  function mention(rel: string) {
    // 面板不把内容喂给模型:只把路径塞进输入框,由 agent 自己走 read 工具,
    // 那条路径才有事件日志(ADR-0031 的同一条边界)
    useChat.getState().injectComposer(`@${rel} `, true);
  }
```

在树容器之后、组件 return 的最后加预览区：

```tsx
      {selected !== null && (
        <div className="flex min-h-0 shrink-0 basis-[40%] flex-col border-t border-border/60">
          <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5">
            <FileTypeIcon path={selected} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={selected}>{selected}</span>
            <Button variant="ghost" size="sm" title="引用到输入框" onClick={() => mention(selected)}>
              <AtSign className="size-[13px]" />
            </Button>
            <Button variant="ghost" size="sm" title="复制路径"
              onClick={() => void navigator.clipboard.writeText(selected)}>
              <Copy className="size-[13px]" />
            </Button>
            <Button variant="ghost" size="sm" title="用外部程序打开"
              onClick={() => void window.otter.filesReveal(root, selected, "open")}>
              <ExternalLink className="size-[13px]" />
            </Button>
            <Button variant="ghost" size="sm" title="关闭预览" onClick={() => setSelected(null)}>
              <X className="size-[13px]" />
            </Button>
          </div>
          {previewNote !== "" && (
            <p className="px-3 pb-1 text-[11px] text-muted-foreground" data-testid="files-preview-note">
              {previewNote}
            </p>
          )}
          {preview !== null && (
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12px]" data-testid="files-preview">
              <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                {selected.toLowerCase().endsWith(".md")
                  ? preview.text
                  : "```" + previewLang(selected) + "\n" + preview.text + "\n```"}
              </Markdown>
            </div>
          )}
        </div>
      )}
```

树的每一行加 hover 出来的 `@` 按钮：把 Step 5 里那个 `<button data-testid="files-row">` 外面包一层 `<div className="group relative">`，在 `</button>` 之后插：

```tsx
          {e.kind === "file" && (
            <button
              type="button"
              title="引用到输入框"
              onClick={() => mention(childRel)}
              className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-foreground/50 hover:bg-foreground/10 group-hover:block"
            >
              <AtSign className="size-3" />
            </button>
          )}
```

- [ ] **Step 6: 跑门禁**

```bash
npm test
```

期望：全绿。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/lib/previewLang.ts tests/renderer/previewLang.test.ts src/renderer/src/components/FilesView.tsx
git commit -m "feat(files): 只读预览 + 行内动作（@ 引用 / 外部打开 / 复制路径）（#400）

预览的语言表单独一张,不复用 fileIconName:图标名和语言名语义不同
(react_ts 是图标名不是语言),喂 rehype-highlight 一个不认识的语言会让
整段掉回无高亮。认不出回空串,让它自己猜。

@ 动作只塞路径不塞内容:面板读到的东西不进事件日志也不进模型上下文,
路径进了输入框,agent 自己走 read 工具,那一次才有日志(ADR-0031 同款边界)。

读失败时清空上一份预览——留着上一份内容配新文件名是最坏的一种错。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: e2e + ADR + 词条

**Files:**
- Create: `tests/e2e/files.e2e.ts`
- Create: `docs/adr/0091-files面板是右侧第六个互斥视图.md`
- Modify: `CONTEXT.md`
- Modify: `AGENTS.md`（Where to find things 加一行）

- [ ] **Step 1: 写 e2e**

新建 `tests/e2e/files.e2e.ts`：

```ts
// Files 面板的端到端 —— 这一栏没法「读代码验」的部分:IPC 通道真的接上了吗、
// 树真的按点击一层层展开吗、互斥真的把终端关掉了吗。

import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";

test("#400 Files 面板:⌘⇧E 开、展开一层、点文件出预览、开终端把它互斥关掉", async () => {
  const otto = await launchOtto();
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "hello.ts"), "export const hello = 1\n");
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话好开文件面板");

    await win.keyboard.press("Meta+Shift+E");
    await expect(win.getByTestId("files-tree")).toBeVisible({ timeout: 20_000 });

    // 根目录列出来了:src 这个目录在
    const srcRow = win.locator('[data-testid="files-row"][data-rel="src"]');
    await expect(srcRow).toBeVisible();

    // 展开一层才去列子目录(懒加载)
    await expect(win.locator('[data-testid="files-row"][data-rel="src/hello.ts"]')).toHaveCount(0);
    await srcRow.click();
    const fileRow = win.locator('[data-testid="files-row"][data-rel="src/hello.ts"]');
    await expect(fileRow).toBeVisible();

    // 点文件出预览,内容是真读出来的
    await fileRow.click();
    await expect(win.getByTestId("files-preview")).toContainText("export const hello", { timeout: 10_000 });

    // 互斥:开终端,Files 面板整个消失
    await win.keyboard.press("Control+`");
    await expect(win.getByTestId("files-tree")).toHaveCount(0);

    expectNoRendererErrors(otto);
  } finally {
    await otto.app.close();
  }
});
```

- [ ] **Step 2: 跑 e2e**

```bash
npm run e2e -- files.e2e.ts
```

期望：1 passed。若 `startSession` / `launchOtto` 的签名和这里不一致，照 `tests/e2e/terminal.e2e.ts` 的实际调用改（那份是本仓的范本）。

- [ ] **Step 3: 写 ADR**

新建 `docs/adr/0091-files面板是右侧第六个互斥视图.md`（编号在合并前按 ADR-0074 复核；若被抢号，改成 `max+1` 并在文件顶部加 `原为 ADR-0091` 一行）：

内容要点（照 `docs/adr/` 现有格式：标题 / 状态 / 背景 / 决策 / 后果）：
- **背景**：图标那套早在仓里但没有浏览入口；ShellBridge 一条文件通道都没有。
- **决策一**：面板占右侧槽位第 6 个位置，与其它 5 个互斥（不是新开一列——右侧只有一块地方，两块会把会话挤没）。
- **决策二**：树全显 + 一次只列一层；搜索默认尊重 `.gitignore`（两者目标不同：树是"找得到"，搜索是"别被淹没"）。
- **决策三**：面板严格只读，且读到的内容不进事件日志、不进模型上下文——`@` 动作只塞路径，让 agent 走自己的 read 工具，日志因此仍然完整（ADR-0031 的同一条边界推广到文件浏览）。
- **后果**：多一条 ripgrep 的软依赖（缺失降级且显式标注）；预览与 agent 看到的内容可能不同步（面板不监听 fs，靠手动刷新）。

- [ ] **Step 4: CONTEXT.md 加词条**

在「产品/技术术语」一节加两条：

```markdown
- **Files 面板**：右侧槽位第 6 个互斥视图，工作区文件树 + 过滤/内容搜索 + 只读预览。纯人用旁路：内容不进事件日志、不进模型上下文（ADR-0091，同 ADR-0031 的边界）。
- **懒加载列目录**：Files 面板展开哪个目录才发一次 `filesList`，不是开面板扫全树。树全显（含 `node_modules`）的前提就是这条（ADR-0091）。
```

- [ ] **Step 5: AGENTS.md 索引加一行**

「Where to find things」里加：

```markdown
- `src/main/filesService.ts` / `src/shared/files.ts` — Files 面板的主进程数据源与纯逻辑层（只读；三条安全边界在 `tests/main/filesService.test.ts`，ADR-0091）
```

> 这是 L2（索引），可自主合并；ADR + issue + PR 三件套本任务已齐。

- [ ] **Step 6: 跑门禁 + 提交**

```bash
npm test && git add -A && git commit -m "test(files): 端到端 + ADR-0091 + 词条（#400）

e2e 钉的是读代码验不了的那几件事:IPC 真接上了、树真的一层层懒加载、
互斥真的把终端关掉了。

ADR 记的是三个会被后来者质疑的决定:为什么占右侧槽位而不新开一列、
为什么树全显而搜索尊重 gitignore、为什么面板只读且内容不进上下文。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: 开 PR**

```bash
git push -u origin claude/files-sidebar-feature-8a363b
gh pr create --title "feat(files): 右侧栏 Files 面板——文件树 + 过滤/内容搜索 + 类型图标 + 只读预览" --body "Closes #400

设计:docs/superpowers/specs/2026-08-25-files-panel-design.md
计划:docs/superpowers/plans/2026-08-25-files-panel.md
决策:ADR-0091

gate 绿;e2e 结果贴在下面评论。"
```

---

## 自查（写完计划后的复核）

- **spec 覆盖**：D1 懒加载 → Task 2 `list` + Task 5 `toggleDir`/`loadDir`；D2 gitignore → Task 2 `search` 的 `includeIgnored` + Task 5 开关；D3 rg 降级 → Task 2 `classifyRgError` + Task 5 `notice`；D4 三个动作 → Task 6。安全边界三条 → Task 2 Step 1 的四条测试。「明确不做」五条：计划里没有任何写文件、fs.watch、多根、拖拽、可拖分割的步骤 ✓
- **类型一致**：`FilesResult<T>` 用 `{ ok: true; value: T }`（Task 1 定义），Task 2 的返回、Task 3 的签名、Task 5/6 的 `r.ok ? r.value` 读法一致 ✓；`joinRel` / `matchesFilter` / `previewLang` 在定义处和使用处同名 ✓
- **无占位符**：每个代码步骤都有可粘贴的完整代码；两处显式标了"若签名不一致照现有范本改"（`Switch` 的 props、e2e harness 的调用），那是对现有代码的核对指令，不是待填空白 ✓
