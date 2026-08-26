// 模型输出里的「文件:行号」—— 纯逻辑层,零 IO,渲染层和测试共用。
//
// 为什么单独一层:认路径这件事全是判断("engine.ts:386 是引用,claude.ai 不是"、
// "/Users/x/repo/src/a.ts 在这个工作区里的相对路径是 src/a.ts"),要么写成能验的
// 纯函数,要么就散进 rehype 插件里再也测不到。选前者(同 shared/files.ts)。

/** 一条引用。line/column 没写就是 null(整文件引用) */
export interface FileRef {
  path: string;
  line: number | null;
  column: number | null;
}

/** 文本里的一条引用 + 它在原串里的位置(rehype 插件要按位置切文本节点) */
export interface FileRefMatch extends FileRef {
  start: number;
  end: number;
}

// 只认这些后缀。判据是「误报的代价」:正文里 `claude.ai`、`v1.2` 这类东西长得和
// 路径一模一样,放进来就是满屏可点的假链接,点了还只能报"文件不存在"。
// 宁可漏认一个冷门后缀(用户还能用 Files 面板搜),也不要把散文变成雷区。
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "md", "mdx", "txt", "csv",
  "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "dart", "scala", "clj", "ex", "exs",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
  "sql", "prisma", "graphql", "gql", "proto", "plist", "xml", "svg",
  "lock", "gradle", "tf", "tfvars", "dockerfile", "makefile", "cmake",
]);

// 路径 + 可选 :行[:列]。
// 前瞻断言挡掉三类假货:`https://a/b.ts`(前面是 :// 的斜杠)、`a/b.ts` 已经在更长的
// 路径里(前面是字符/斜杠/点)、`@scope/pkg.js` 这种包名(前面是 @)。
// 后缀单独成组是为了拿去查 CODE_EXTS —— 正则本身不背那张表,表在上面看得见。
const REF_RE =
  /(?<![\w@./\\:-])(\/?(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+)\.([A-Za-z][A-Za-z0-9]{0,9})(?::(\d+))?(?::(\d+))?(?![\w/])/g;

function pick(raw: string, ext: string, line?: string, col?: string): FileRef | null {
  if (!CODE_EXTS.has(ext.toLowerCase())) return null;
  // `..` 段一律不认:面板只开工作区里的东西,认了也只能拒(见 toWorkspaceRel)
  if (raw.split("/").includes("..")) return null;
  const n = line === undefined ? null : Number(line);
  // 行号 0 不是行号(编辑器从 1 数起),当成"只给了文件"
  return {
    path: `${raw}.${ext}`,
    line: n !== null && n > 0 ? n : null,
    column: col === undefined ? null : Number(col),
  };
}

/** 扫一段纯文本里的所有引用。给 rehype 插件用:要位置才能把文本节点切开 */
export function scanFileRefs(text: string): FileRefMatch[] {
  const out: FileRefMatch[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    const ref = pick(m[1] ?? "", m[2] ?? "", m[3], m[4]);
    if (ref === null) continue;
    out.push({ ...ref, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 单独一串是不是引用(行内代码、markdown 链接的 href 走这条)。
    整串必须**就是**一条引用,不能是"一句话里带一条" —— href 里夹别的东西
    多半是外链,不是路径。顺带认 GitHub 那种 `#L12` 的写法 */
export function parseFileRef(raw: string): FileRef | null {
  const s = raw.trim();
  if (s === "") return null;
  // 有协议(http:、mailto:、vscode: …)一律不是本地路径
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || /^mailto:/i.test(s)) return null;
  const hash = /^(.*?)#L(\d+)$/.exec(s);
  const body = hash === null ? s : (hash[1] ?? "");
  const found = scanFileRefs(body);
  const one = found[0];
  if (one === undefined || one.start !== 0 || one.end !== body.length) return null;
  if (hash !== null) return { ...one, line: Number(hash[2]), column: null };
  return { path: one.path, line: one.line, column: one.column };
}

/** 引用里的路径 → 工作区相对路径。落在工作区外(或根本没工作区)返回 null,
    调用方据此提示"打不开",而不是把面板指到一个它读不了的地方 */
export function toWorkspaceRel(root: string, path: string): string | null {
  if (root === "") return null;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  let p = norm(path);
  if (p === "") return null;
  if (p.startsWith("./")) p = p.slice(2);
  const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (absolute) {
    if (!p.startsWith(`${r}/`)) return null;
    p = p.slice(r.length + 1);
  }
  if (p === "" || p.split("/").includes("..")) return null;
  return p;
}
