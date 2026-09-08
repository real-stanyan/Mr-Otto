// WorkspaceFilesTab —— 工作区设置页的「文件」tab（#1056，ADR 见下；前身是
// 「仓库」tab，#991 / ADR-0234 把它从云会话头部搬到这里）。
//
// **这一页的主语是「水獭在哪儿干活」，不是「Git 地址填什么」。** 每个工作区都有
// 一个共用工作文件夹（一容器一卷，ADR-0232），这跟你是不是程序员无关；Git 仓库
// 只是往那个文件夹里装东西的一种方式，而且是此前唯一做出来的一种。上一版把这唯一
// 一种来源当成了页面本身的身份，于是：tab 叫「仓库」（非程序员读到的第一个词就跟
// 自己无关）、正文第一句在解释「你可能用不到这一页」（一页要先说服你它可能与你无关，
// 就是定义错了）、空目录写成「未配仓库」（一个正当状态被写成缺一格配置）。
//
// 所以顺序是：先画文件夹里有什么，Git 收成下面一节可选的「来源」。**列得出内容是
// 这次改名成立的前提**——一个叫「文件」却一个文件都列不出来的页面，是 #722「撒谎的
// 勾」的近亲。
//
// PAT 纪律照抄 ProviderKeyDialog 的不变量原话："输入框存完即清，渲染层不留 key
// 的任何副本；状态只有布尔"。token 栏永远是空的：服务端只回 hasPat，token 不下行。
// 「清除已存的 token」是显式开关：地址栏预填了、密码框天生是空的，owner 顺手改个
// 地址就把私有仓库的凭据清了，下次 clone 静默失败——三态因此是：省略 = 不动，
// `""` = 清除（只有这个开关能产生），非空 = 换新。
// 错误落本地状态，不落 workspaceGroupsError：那一格是整页共用的，这一页刚打开那
// 一刻可能还留着一条跟这里毫不相干的旧错误。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, RotateCw, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useChat } from "../store.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";
import { entryMeta, workFileNotice, workFolderNotice } from "../lib/workFilesView.js";
import { joinWorkPath } from "../../../shared/remote/workPath.js";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon.js";
import { previewLang } from "../lib/previewLang.js";
import { rehypeCodeLines } from "../lib/codeLines.js";
import type { CsWorkEntry, CsWorkHit, CsWorkNode } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudWorkspaceState } from "../../../shared/shellBridge.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

// 插件数组提到模块级：内联的 [remarkGfm] 每次渲染都是新引用（同 FilesView）
const REMARK_PLUGINS = [remarkGfm];
// 切行要排在高亮**之后**：反过来切出来的是没上色的行（见 lib/codeLines 开头）
const REHYPE_PLUGINS = [rehypeHighlight, rehypeCodeLines];

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; value: CloudWorkspaceState };

export function WorkspaceFilesTab({ ws }: { ws: WorkspaceSnapshot }) {
  const load = useChat((s) => s.workspaceCloudState);
  const [state, setState] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void load(ws.id).then((r) => {
      if (!alive) return;
      setState(r.ok ? { kind: "ok", value: r.value } : { kind: "error", message: r.message });
    });
    return () => {
      alive = false;
    };
  }, [ws.id, load]);

  // 起不了 turn 这件事仍然在这一页说一次（ADR-0246 的判据原样：只在起不了 turn
  // 的时候出现）。它跟文件无关，摆在最上面是因为**这一页是它在会话界面之外唯一
  // 的落点**——真正该住的地方是页头（跨 tab 可见），那要给设置页每次打开都加一次
  // 控制房 RPC，留给以后
  const modelStatus = modelStatusText(state.kind === "ok" ? state.value.modelRoute : null);

  return (
    <div className="flex flex-col gap-5">
      {modelStatus && (
        // 这一页有的是地方，写整句——`short` 是给会话头部那一格 150px 用的
        <p className="text-xs text-err">{modelStatus.full}</p>
      )}

      <WorkFolder workspaceId={ws.id} />
    </div>
  );
}

// ─── 工作文件夹浏览 ────────────────────────────────────────────────────
/** 翻工作文件夹（#1066 起照右侧栏那个 `FilesView` 的样子做）。
    **共用的不只是长相**：图标、语言判定、切行插件都是同一批模块，搜索那一半连
    判据都是同一份纯函数（`parseRgJson` / `matchesFilter` / `classifyRgError` 在
    runtime 侧共用，见 `services/runtime/src/workFiles.ts`）。

    树是**全显**的（点文件、node_modules 都列），不卡的前提是一次只列一层——展开
    哪个目录才发一次 `files` 帧，不是开页面扫全树。同 FilesView 的原话。

    三样搬不过来，因为它们在这一侧不存在：**打开方式 / 在访达中显示**（文件在
    VPS 的容器里，不在这台 Mac 上）、**@引用到输入框**（这一页是抽屉里的设置页，
    没有 composer）、**正文里「文件:行号」跳过来**（云会话时间线没接这条线）。

    **读不到 ≠ 里面是空的**（同 ADR-0243）：出错时上一份内容留在原地、错误另起
    一行说——把树清空会让人以为水獭做的东西没了。 */
function WorkFolder({ workspaceId }: { workspaceId: string }) {
  const loadFiles = useChat((s) => s.workspaceFiles);
  const searchFiles = useChat((s) => s.workspaceFilesSearch);

  // 一层目录的缓存：相对路径 → 这层的条目。折叠不清缓存，再展开不重发
  const [cache, setCache] = useState<Map<string, CsWorkEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 根那一格的**状态**，不是内容：容器还没建起来（absent）这件事树画不出来 */
  const [root, setRoot] = useState<CsWorkNode | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CsWorkHit[] | null>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsWorkNode | null>(null);
  const [previewNote, setPreviewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());

  const loadDir = useCallback(
    async (rel: string): Promise<void> => {
      setBusy(true);
      const r = await loadFiles(workspaceId, rel);
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setError(null);
      if (rel === "") setRoot(r.value);
      if (r.value.kind === "dir") {
        setCache((prev) => new Map(prev).set(rel, r.value.kind === "dir" ? r.value.entries : []));
        return;
      }
      // 目录没了就把它从缓存摘掉：留着它下次展开还是那一份旧清单，
      // 而用户会以为那些文件还在（FilesView 的同一条）
      setCache((prev) => {
        const next = new Map(prev);
        next.delete(rel);
        return next;
      });
    },
    [workspaceId, loadFiles],
  );

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  // 过滤/搜索去抖 150ms。空查询 = 回到树（同 FilesView）
  useEffect(() => {
    if (query === "") {
      setHits(null);
      setNotice("");
      return undefined;
    }
    const content = query.startsWith("?");
    const term = content ? query.slice(1) : query;
    if (term.trim() === "") {
      setHits(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setBusy(true);
        const r = await searchFiles(workspaceId, term, content);
        setBusy(false);
        if (r.ok) {
          setHits(r.value);
          setNotice("");
          return;
        }
        // **降级要说出来**：不说的话空结果读起来就是「仓里没有」（FilesView 原话）
        setHits([]);
        setNotice(r.message);
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [query, workspaceId, searchFiles]);

  // 选中变了就读。读失败要清掉上一份——留着上一份文件的内容配着新文件名，
  // 是最坏的一种错：用户会以为自己在看这个文件（FilesView 原话）
  useEffect(() => {
    if (selected === null) {
      setPreview(null);
      setPreviewNote("");
      return;
    }
    void (async () => {
      const r = await loadFiles(workspaceId, selected);
      if (!r.ok) {
        setPreview(null);
        setPreviewNote(r.message);
        return;
      }
      setPreview(r.value);
      setPreviewNote(workFileNotice(r.value) ?? "");
    })();
  }, [selected, workspaceId, loadFiles]);

  function toggleDir(rel: string): void {
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

  function renderLevel(rel: string, depth: number): ReactNode {
    const entries = cache.get(rel);
    if (entries === undefined) return null;
    return entries.map((e) => {
      const childRel = joinWorkPath(rel, e.name);
      const open = expanded.has(childRel);
      return (
        <div key={childRel}>
          <button
            type="button"
            onClick={() => (e.kind === "dir" ? toggleDir(childRel) : setSelected(childRel))}
            className={`flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-[13px] transition-colors duration-150 ease-out hover:bg-foreground/[0.06] ${
              selected === childRel ? "bg-foreground/[0.08]" : ""
            }`}
            style={{ paddingLeft: 4 + depth * 12 }}
          >
            {e.kind === "dir" ? (
              open ? <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                   : <ChevronRight className="size-3.5 shrink-0 opacity-60" />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {e.kind === "dir" ? <FolderIcon /> : <FileTypeIcon path={e.name} />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{entryMeta(e, now)}</span>
          </button>
          {e.kind === "dir" && open && renderLevel(childRel, depth + 1)}
        </div>
      );
    });
  }

  const rootNotice = root === null ? null : workFolderNotice(root);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className={SECTION_LABEL}>工作文件夹</p>
        <button
          type="button"
          className="text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground disabled:opacity-40"
          title="刷新"
          disabled={busy}
          onClick={() => {
            // 刷新 = 把整棵树重新拉一遍，不是只刷根：展开着的那几层不重拉的话，
            // 「刷新过了」和「没刷」在屏幕上分不出来
            setCache(new Map());
            void loadDir("");
            for (const rel of expanded) void loadDir(rel);
          }}
        >
          <RotateCw className={`size-3 ${busy ? "animate-spin" : ""}`} />
        </button>
      </div>

      <p className="text-[12px] text-muted-foreground">
        水獭在这个文件夹里干活，做出来的东西都留在这儿。同一个工作区的所有会话共用这一份。
      </p>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="过滤文件…（?文本 搜索内容）"
        className="h-8 text-[13px]"
        autoComplete="off"
        spellCheck={false}
      />
      {notice !== "" && <p className="text-[11px] text-err">{notice}</p>}

      <div className="min-w-0 overflow-y-auto rounded-md border border-border" style={{ maxHeight: 260 }}>
        {hits !== null ? (
          hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">没有匹配</p>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.rel}:${h.line}:${i}`}
                type="button"
                onClick={() => setSelected(h.rel)}
                className="flex w-full items-center gap-1.5 px-2 py-[3px] text-left text-[13px] transition-colors duration-150 ease-out hover:bg-foreground/[0.06]"
              >
                <FileTypeIcon path={h.rel} />
                <span className="max-w-[45%] shrink-0 truncate">{h.rel}</span>
                {h.line !== null && (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">:{h.line}</span>
                )}
                {h.text !== null && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{h.text.trim()}</span>
                )}
              </button>
            ))
          )
        ) : root === null ? (
          <p className="px-3 py-4 text-[12px] text-muted-foreground">
            {error === null ? "正在读取…" : "读不到工作文件夹。"}
          </p>
        ) : rootNotice !== null ? (
          <p className="px-3 py-4 text-[12px] text-muted-foreground">{rootNotice}</p>
        ) : (
          <div className="py-1">{renderLevel("", 0)}</div>
        )}
      </div>

      {selected !== null && (
        <div className="flex min-w-0 flex-col rounded-md border border-border">
          <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1">
            <FileTypeIcon path={selected} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={selected}>{selected}</span>
            <button
              type="button"
              title="复制路径"
              className="rounded p-1 text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/10 hover:text-foreground"
              onClick={() => void navigator.clipboard.writeText(selected)}
            >
              <Copy className="size-3" />
            </button>
            <button
              type="button"
              title="关闭预览"
              className="rounded p-1 text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/10 hover:text-foreground"
              onClick={() => setSelected(null)}
            >
              <X className="size-3" />
            </button>
          </div>
          {previewNote !== "" && (
            <p className="px-2 pt-1 text-[11px] text-muted-foreground">{previewNote}</p>
          )}
          {preview?.kind === "file" && (
            <div className="md min-w-0 overflow-auto px-2 py-1.5 text-[12px]" style={{ maxHeight: 300 }}>
              <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                {/* .md 平时是渲染出来读的（同 FilesView）；其余走高亮代码块 */}
                {selected.toLowerCase().endsWith(".md")
                  ? preview.text
                  : "```" + previewLang(selected) + "\n" + preview.text.replace(/\n$/, "") + "\n```"}
              </Markdown>
            </div>
          )}
        </div>
      )}

      {error !== null && <p className="text-xs text-err">{error}</p>}
    </section>
  );
}
