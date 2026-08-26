// TurnDiffPanel — 输入框上方的「本轮改动」面板（issue #345）。
//
// 数据源是主进程推的 TurnDiffUpdate（turn 级聚合 diff）：每次写盘后整份替换，
// 同文件多次修改已在主进程叠成一份——前端不缝合，直接渲染。灵动岛显示的
// 摘要行出自同一份推送，两处的数字不可能不一致。
//
// 与 WorkTreePill 的分工：那边答"盘上现在脏成什么样"（git status，含 bash
// 乱动的文件），这边答"这一轮 agent 用写盘工具改了什么"（含 diff 细节）。
// 一个是世界现状，一个是本轮动作——都要，谁也替不了谁。
//
// 展示期：从本轮第一次写盘起，保留到下一轮第一次写盘（turnId 换代整份覆盖）。
// turn 刚收尾时"刚才改了什么"正是要读的东西，不随 idle 消失。

import { useState } from "react";
import { ChevronRight, FilePenLine } from "lucide-react";
import { useChat } from "../store.js";
import { CodeDiff } from "@/components/elements/code-diff.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { cn } from "@/lib/utils.js";
import type { TurnDiffFile } from "../../../shared/shellBridge.js";

/** 长路径中间省略（同 WorkTreePill 的取舍：目录前缀和文件名都是身份） */
function shortPath(path: string): string {
  if (path.length <= 44) return path;
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return `${parts[0] ?? ""}/…/${name}`;
}

function FileRow({ file }: { file: TurnDiffFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-foreground/[0.05]"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-foreground/40 transition-transform", open && "rotate-90")}
        />
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>
          {shortPath(file.path)}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-ok">+{file.additions}</span>{" "}
          <span className="text-err">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.lines ? (
          <CodeDiff
            filename={file.path}
            additions={file.additions}
            deletions={file.deletions}
            lines={file.lines}
            className="mt-1 mb-2 max-h-[240px] max-w-none overflow-y-auto"
          />
        ) : (
          <div className="mx-2 mb-2 rounded-md bg-foreground/[0.04] px-3 py-2 text-xs text-muted-foreground">
            文件过大，不展示 diff（统计为行数计数）
          </div>
        ))}
    </div>
  );
}

export function TurnDiffPanel() {
  const diff = useChat((s) => s.turnDiffBySession[s.sessionId]);
  const [open, setOpen] = useState(false);

  if (!diff || diff.files.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/80 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-foreground/[0.04]"
        aria-expanded={open}
      >
        <FilePenLine className="size-3.5 shrink-0 text-brand" />
        <span className="text-xs font-medium">本轮改动</span>
        <span className="text-xs text-muted-foreground">
          {diff.files.length} 文件
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-ok">+{diff.additions}</span>{" "}
          <span className="text-err">−{diff.deletions}</span>
        </span>
        <ChevronRight
          className={cn("size-3 shrink-0 text-foreground/40 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-[2px] px-1 pb-2">
          {diff.files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}
