// WorkspaceMemoryTab —— 工作区设置页「记忆」tab：共享档 + 每只 agent 的私有档，
// 能看能编（#949，spec §6）。骨架照抄 WorkspaceUsageTab 的三态（loading/error/ok），
// 纯逻辑（顺序/占用/stale 判定）全在 workspaceMemoryView.ts 的 memoryDocs。
//
// 每份档一块：标题行（title + used/limit 字符，stale 的档标「（已删除）」）+
// 一个 Textarea（值是磁盘原文，含 "\n§\n" 分隔符，不重排格式）+ 保存按钮。
// 保存中禁用输入与按钮；成功后整份刷新列表（version 递增强制 remount，草稿
// 从服务端最新内容重新起草，同一时刻只有一次网络往返，不做乐观本地合并）。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useChat } from "../store.js";
import { memoryDocs, type MemoryDocView } from "../lib/workspaceMemoryView.js";
import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

function MemoryDocBlock({
  ws,
  doc,
  onSaved,
}: {
  ws: WorkspaceSnapshot;
  doc: MemoryDocView;
  onSaved: () => Promise<void>;
}) {
  const save = useChat((s) => s.saveWorkspaceMemory);
  const [text, setText] = useState(doc.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await save(ws.id, doc.agentId, text);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    await onSaved();
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {doc.title}
          {doc.stale && <span className="ml-1 text-muted-foreground">（已删除）</span>}
        </span>
        <span className="text-xs text-muted-foreground">
          {doc.used}/{doc.limit} 字符
        </span>
      </div>
      <Textarea
        className="min-h-24 text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      {error && <p className="text-xs text-err">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void onSave()} disabled={busy}>
          保存
        </Button>
      </div>
    </div>
  );
}

export function WorkspaceMemoryTab({ ws }: { ws: WorkspaceSnapshot }) {
  const load = useChat((s) => s.loadWorkspaceMemories);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; rows: WorkspaceMemoryRow[] }
  >({ kind: "loading" });
  // 每次成功刷新递增一次：下面 MemoryDocBlock 的 key 带上它，强制整块 remount，
  // 让草稿从服务端最新内容重新起草——不做「保留正在打的字 + 合并服务端新值」
  // 那套复杂度（同文件头注）
  const [version, setVersion] = useState(0);

  const refresh = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    if (r.ok) {
      setState({ kind: "ok", rows: r.value });
      setVersion((v) => v + 1);
    } else {
      setState({ kind: "error", message: r.message });
    }
  };

  // ws.id 变化才重拉；load 是 store 里的稳定引用，跟着它一起标依赖只会造成无意义的重跑
  useEffect(() => { void refresh(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") return <p className="px-2 text-xs text-muted-foreground">正在读记忆…</p>;
  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="px-2 text-xs text-err">拿不到记忆：{state.message}</p>
        <div><Button size="sm" variant="ghost" onClick={() => void refresh()}>再试一次</Button></div>
      </div>
    );
  }

  const docs = memoryDocs(ws, state.rows);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-2">
        <span className={SECTION_LABEL}>条目之间用一行 § 分隔；共享档每条以 [写入者] 开头。</span>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>刷新</Button>
      </div>
      {docs.map((d) => (
        <MemoryDocBlock key={`${d.agentId}:${version}`} ws={ws} doc={d} onSaved={refresh} />
      ))}
    </div>
  );
}
