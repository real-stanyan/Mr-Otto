// Files 面板 —— 工作区文件树 + 过滤/内容搜索 + 只读预览。纯人用的旁路:
// 读到的东西不进事件日志、不进模型上下文(同终端面板 ADR-0031)。要让 Otto 看
// 某个文件,用行内的 @ 动作把路径塞进 composer,由 agent 自己走 read 工具。
//
// 树是**全显**的(node_modules/out/点文件都列),不卡的前提是一次只列一层:
// 展开哪个目录才发一次 filesList,不是开面板扫全树。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AtSign, ChevronDown, ChevronRight, Copy, ExternalLink, FolderOpen, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { HEADER_H } from "../settingsShell.js";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { SidebarNub } from "./SidebarNub.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon.js";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { previewLang } from "../lib/previewLang.js";
import type { EditorApp } from "../../../shared/editors.js";
import { joinRel, type FileEntry, type FileHit, type FilePreview } from "../../../shared/files.js";

// 插件数组提到模块级:内联的 [remarkGfm] 每次渲染都是新引用(同 ProtocolView 的理由)
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

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
  const [hits, setHits] = useState<FileHit[] | null>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewNote, setPreviewNote] = useState("");
  const [editors, setEditors] = useState<EditorApp[]>([]);

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

  // 装了哪些编辑器现探一次(开面板时)。不缓存进 store:用户装完新编辑器
  // 关了面板再开就该看得见,不必重启 app
  useEffect(() => {
    void (async () => setEditors(await window.otter.filesEditors()))();
  }, []);

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
        const r = await window.otter.filesSearch(root, term, { content });
        if (r.ok) {
          setHits(r.value);
          setNotice("");
        } else {
          setHits([]);
          // 降级要说出来:不说的话用户以为空结果就是"仓里没有"
          setNotice(r.kind === "rg-missing" ? "未装 ripgrep,搜索已降级" : "搜索出错");
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [query, root]);

  // 选中变了就读。读失败要清掉上一份——留着上一份文件的内容配着新文件名,
  // 是最坏的一种错:用户会以为自己在看这个文件
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
        return;
      }
      setPreview(null);
      setPreviewNote(
        r.kind === "binary" ? `二进制文件 · ${Number(r.detail).toLocaleString()} 字节`
        : r.kind === "denied" ? "无权限读取"
        : r.kind === "outside-root" ? "无法打开"
        : "文件不存在"
      );
    })();
  }, [selected, root]);

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

  function mention(rel: string) {
    // 面板不把内容喂给模型:只把路径塞进输入框,由 agent 自己走 read 工具,
    // 那条路径才有事件日志(ADR-0031 的同一条边界)
    useChat.getState().injectComposer(`@${rel} `, true);
  }

  function renderLevel(rel: string, depth: number): ReactNode {
    const entries = cache.get(rel);
    if (entries === undefined) return null;
    return entries.map((e) => {
      const childRel = joinRel(rel, e.name);
      const open = expanded.has(childRel);
      return (
        <div key={childRel}>
          <div className="group relative">
            <button
              type="button"
              data-testid="files-row"
              data-rel={childRel}
              onClick={() => (e.kind === "dir" ? toggleDir(childRel) : setSelected(childRel))}
              className={`flex w-full items-center gap-1.5 rounded py-[3px] pr-8 text-left text-[13px] hover:bg-foreground/[0.06] ${
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
          </div>
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
              <span className="shrink-0 truncate max-w-[45%]">{h.rel}</span>
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

      {selected !== null && (
        <div className="flex min-h-0 shrink-0 basis-[40%] flex-col border-t border-border/60">
          <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
            <FileTypeIcon path={selected} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={selected}>{selected}</span>
            <Button variant="ghost" size="sm" title="引用到输入框" onClick={() => mention(selected)}>
              <AtSign className="size-[13px]" />
            </Button>
            <Button
              variant="ghost" size="sm" title="复制路径"
              onClick={() => void navigator.clipboard.writeText(selected)}
            >
              <Copy className="size-[13px]" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" title="打开方式" data-testid="files-open-with">
                  <ExternalLink className="size-[13px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editors.map((ed) => (
                  <DropdownMenuItem
                    key={ed.name}
                    title={ed.appPath}
                    onClick={() => void window.otter.filesReveal(root, selected, "app", ed.name)}
                  >
                    {/* 图标是名字的复述(名字就在旁边),读屏器不该念第二遍;
                        取不到图标的那条自然退回纯文字,不占位 */}
                    {ed.icon !== "" && (
                      <img src={ed.icon} alt="" aria-hidden draggable={false} className="size-4 shrink-0" />
                    )}
                    {ed.name}
                  </DropdownMenuItem>
                ))}
                {editors.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() => void window.otter.filesReveal(root, selected, "open")}
                >
                  系统默认程序
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void window.otter.filesReveal(root, selected, "folder")}
                >
                  在访达中显示
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
    </div>
  );
}
