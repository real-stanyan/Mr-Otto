// WorkTreePill — 输入框正上方的"工作区改动"浮窗。
//
// 回答一个问题:刚才那一轮,盘上到底动了什么。会话里 agent 写文件、删文件、跑 bash
// 都可能改盘,但事件日志只记"调用了 write_file",记不了"于是工作区现在脏成什么样"——
// 后者只有 git 知道,所以数据源是 git status,不是日志投影(store.workTree 的注释同此)。
//
// 位置在 composer 上方、TodoPanel 同一摞:那里是"接下来要发生什么"的语境,
// 而"刚刚发生了什么"正是你打下一句话之前要读的东西。
//
// 动效用 GSAP(ADR-0029 把 ADR-0024 的边界从"只有牌桌"扩到这里):展开是
// 高度 + 逐行错开的一条编排,数字变化是另一条,CSS 表达不了"接着上一个"。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import {
  ChevronRight, FileMinus2, FilePenLine, FilePlus2, GitBranch, TriangleAlert, X,
} from "lucide-react";
import { useChat } from "../store.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { countChanges, statusSignature, type ChangeKind, type ChangedFile } from "../../../shared/gitStatus.js";

/** 一档改动的视觉身份:图标 + 颜色 + 人话。六档一次定死,别处只查表 */
const KIND: Record<ChangeKind, { icon: typeof FilePlus2; label: string; tone: string }> = {
  added: { icon: FilePlus2, label: "新建", tone: "text-ok" },
  untracked: { icon: FilePlus2, label: "新建", tone: "text-ok" },
  modified: { icon: FilePenLine, label: "改写", tone: "text-brand" },
  renamed: { icon: FilePenLine, label: "改名", tone: "text-brand" },
  deleted: { icon: FileMinus2, label: "删除", tone: "text-err" },
  conflicted: { icon: TriangleAlert, label: "冲突", tone: "text-warn" },
};

/** 长路径中间省略:目录前缀和文件名都是身份,砍中间不砍两头 */
function shortPath(path: string): string {
  if (path.length <= 44) return path;
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return `${parts[0] ?? ""}/…/${name}`;
}

/** 排序:先按严重度(冲突 > 删除 > 新建 > 改写),同档按路径。
    不按 git 的字典序——用户要先看见的是"出事了"和"多了/少了东西" */
const SEVERITY: Record<ChangeKind, number> = {
  conflicted: 0, deleted: 1, added: 2, untracked: 2, renamed: 3, modified: 4,
};

function reduceMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WorkTreePill() {
  const workspace = useChat((s) => s.workspace);
  const workTree = useChat((s) => s.workTree);
  const dismissedSig = useChat((s) => s.workTreeDismissed);
  const dismiss = useChat((s) => s.dismissWorkTree);
  const refresh = useChat((s) => s.refreshGitStatus);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // 进会话先问一次;窗口重新聚焦再问一次——你去别处改了文件回来,浮窗不该还停在旧事实
  useEffect(() => {
    void refresh();
  }, [workspace, refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const status = workTree?.ok ? workTree.status : null;
  const files = useMemo(
    () =>
      (status?.files ?? [])
        .slice()
        .sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.path.localeCompare(b.path)),
    [status]
  );
  const counts = useMemo(() => countChanges(files), [files]);
  const signature = status ? statusSignature(status) : "";
  const visible = files.length > 0 && signature !== dismissedSig;

  // 进场:从下方 6px 浮起 + 去模糊。它物理上贴着输入框,从"来处"进场(空间一致性)
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !visible) return;
    if (reduceMotion()) {
      gsap.set(el, { opacity: 1, y: 0, filter: "none" });
      return;
    }
    const tl = gsap.fromTo(
      el,
      { opacity: 0, y: 6, filter: "blur(3px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.34, ease: "power3.out" }
    );
    return () => {
      tl.kill();
    };
  }, [visible]);

  // 改动集变了 = 又发生了一件事:摘要行轻轻顶一下。只在已经可见时放,
  // 不然会和进场动画叠在同一帧上打架
  const lastSig = useRef(signature);
  useEffect(() => {
    if (!visible || lastSig.current === signature) {
      lastSig.current = signature;
      return;
    }
    lastSig.current = signature;
    const el = summaryRef.current;
    if (!el || reduceMotion()) return;
    gsap.fromTo(
      el,
      { y: -4, opacity: 0.4 },
      { y: 0, opacity: 1, duration: 0.28, ease: "power3.out", overwrite: "auto" }
    );
  }, [signature, visible]);

  // 展开/收起:高度是一条,行是错开的另一条——timeline 表达"接着上一个",
  // 收起时反过来跑同一条路径(进出同路)
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const rows = gsap.utils.toArray<HTMLElement>("[data-file-row]", el);
    if (reduceMotion()) {
      gsap.set(el, { height: open ? "auto" : 0, opacity: open ? 1 : 0 });
      gsap.set(rows, { opacity: open ? 1 : 0, y: 0 });
      return;
    }
    const tl = gsap.timeline();
    if (open) {
      tl.fromTo(el, { height: 0, opacity: 0 }, { height: "auto", opacity: 1, duration: 0.3, ease: "power3.out" })
        .fromTo(
          rows,
          { opacity: 0, y: -4 },
          { opacity: 1, y: 0, duration: 0.22, ease: "power2.out", stagger: 0.025 },
          "-=0.2"
        );
    } else {
      // 收起比展开快:决定是慢的,系统响应是快的
      tl.to(rows, { opacity: 0, duration: 0.1, ease: "power2.in" })
        .to(el, { height: 0, opacity: 0, duration: 0.18, ease: "power3.in" }, "-=0.05");
    }
    return () => {
      tl.kill();
    };
  }, [open, files.length]);

  // 关掉:沿来路退回下方再卸载(进出同路),而不是原地消失
  const close = () => {
    const el = rootRef.current;
    if (!el || reduceMotion()) {
      dismiss();
      return;
    }
    gsap.to(el, {
      opacity: 0, y: 6, filter: "blur(3px)", duration: 0.16, ease: "power2.in",
      onComplete: dismiss,
    });
  };

  if (!visible) return null;

  const head = files[0]!;
  const chips = (
    [
      { kind: "conflicted", n: counts.conflicted },
      { kind: "added", n: counts.added + counts.untracked },
      { kind: "modified", n: counts.modified + counts.renamed },
      { kind: "deleted", n: counts.deleted },
    ] satisfies { kind: ChangeKind; n: number }[]
  ).filter((c) => c.n > 0);

  return (
    <div
      ref={rootRef}
      className="@container mb-[6px] rounded-2xl border border-border/60 bg-card/75 backdrop-blur-xl shadow-[0_6px_20px_rgba(0,0,0,0.18)] overflow-hidden"
    >
      <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5">
        {/* 整条头行是展开触发器:命中区跨满整行,别逼人去点那颗 5px 的箭头 */}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 bg-transparent border-none p-0 text-left cursor-pointer transition-transform duration-150 ease-[var(--ease-strong)] active:scale-[0.99]"
        >
          <GitBranch className="size-4 shrink-0 text-brand" aria-hidden />
          <span className="shrink-0 text-[13px] font-[650] tracking-[-0.01em] text-foreground">
            {status?.branch ?? "游离 HEAD"}
          </span>
          <div ref={summaryRef} className="flex min-w-0 items-center gap-2">
            {/* 最要紧的那条(按 SEVERITY 排在最前)直接摆在头行:
                冲突/删除这类要先看见的东西,不该藏在"展开"后面 */}
            <FileTypeIcon path={head.path} className="size-[13px]" />
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {shortPath(head.path)}
            </span>
            <div className="hidden shrink-0 items-center gap-1 @[34rem]:flex">
              {chips.map((c) => {
                const k = KIND[c.kind];
                return (
                  <Badge key={c.kind} variant="outline" className={`gap-1 border-border/60 tabular-nums ${k.tone}`}>
                    <k.icon aria-hidden />
                    {c.n}
                  </Badge>
                );
              })}
            </div>
          </div>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {counts.total} 处改动
            {counts.insertions + counts.deletions > 0 && (
              <>
                <span className="ml-1.5 text-ok">+{counts.insertions}</span>
                <span className="ml-1 text-err">−{counts.deletions}</span>
              </>
            )}
          </span>
          <ChevronRight
            className={
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-[var(--ease-strong)] motion-reduce:transition-none" +
              (open ? " rotate-90" : "")
            }
            aria-hidden
          />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="收起改动提示" onClick={close}>
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>收起，直到下次有新改动</TooltipContent>
        </Tooltip>
      </div>

      {/* height 由 GSAP 写,初始态先设 0:首帧不能闪一整列出来 */}
      <div ref={listRef} style={{ height: 0, opacity: 0 }} className="overflow-hidden">
        <ul className="list-none m-0 max-h-[30vh] overflow-y-auto px-3 pb-2 pt-px flex flex-col gap-px">
          {files.map((f) => (
            <FileRow key={`${f.kind}:${f.path}`} file={f} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function FileRow({ file }: { file: ChangedFile }) {
  const k = KIND[file.kind];
  return (
    <li data-file-row className="flex items-center gap-2 py-[3px] text-[13px] leading-[1.45]">
      {/* 这里画的是**文件类型**,不是改动种类:改动种类紧跟在后面用带色的两个字
          说了(新建/改写/删除),同一件事画两遍是浪费这个位置。而这一列真正难扫的
          恰恰是文件类型 —— 十几行等宽路径里,哪几个是测试、哪个是配置 */}
      <FileTypeIcon path={file.path} className="size-[13px]" />
      <span className={`shrink-0 text-[11px] ${k.tone}`}>{k.label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={file.path}>
        {file.from ? `${file.from} → ${file.path}` : file.path}
      </span>
      {file.staged && (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">已暂存</span>
      )}
      {file.insertions !== undefined && file.deletions !== undefined && (
        <span className="ml-auto shrink-0 text-[11px] tabular-nums">
          <span className="text-ok">+{file.insertions}</span>
          <span className="ml-1 text-err">−{file.deletions}</span>
        </span>
      )}
    </li>
  );
}
