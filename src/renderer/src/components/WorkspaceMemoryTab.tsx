// WorkspaceMemoryTab —— 工作区设置里的「记忆」那一页：共享档 + 每只 agent 的私有档
// （#949，spec §6；#1120 把编辑从「一屏几个 textarea」改成「一行推一页」）。
//
// ## 为什么改成推入页
//
// 原来所有档摞在同一屏，每块一个 `min-h-24` 的 textarea：420px 宽的抽屉里，四份档
// 就是四个小窗口，哪一份都不够写。更麻烦的是它逼出了一整套「谁有未保存草稿」的记账
// ——因为「刷新」会把所有块一起卸载重装，得先问一句才敢重拉。改成一次编一份之后
// 那套记账**整段没了**：站在编辑页上根本够不到列表那颗刷新（它在上一页），
// 「重拉会丢草稿」这个情形在结构上不存在了。
//
// 保留的两条纪律一个字没动：
// · 保存带 CAS（`doc.version`）——这一档在你编辑期间被别人（agent 或另一台）改过，
//   保存会**拒绝并说清楚**，不是拿你的草稿盖掉对方（#949 review finding 2 / #962）。
// · 打字时的占用算**本地草稿**归一化后的字数，不是 `doc.used`（那是上次保存成功时
//   服务端算的，冻在那儿直到下次成功保存——用户敲字时超没超限完全看不出来）。
//   归一化用的是与主进程落库前同一步纯函数，所以这个数就是「现在按保存会存成什么样」。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { InsetEmpty, InsetGroup, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useNav } from "@/components/ui/nav-stack.js";
import { useChat } from "../store.js";
import { memoryDocs, replaceRow, type MemoryDocView } from "../lib/workspaceMemoryView.js";
import { charCount, formatEntries, parseEntries } from "../../../shared/memoryStore.js";
import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function WorkspaceMemoryTab({ ws }: { ws: WorkspaceSnapshot }) {
  const nav = useNav();
  const load = useChat((s) => s.loadWorkspaceMemories);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; rows: WorkspaceMemoryRow[] }
  >({ kind: "loading" });

  const loadAll = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    setState(r.ok ? { kind: "ok", rows: r.value } : { kind: "error", message: r.message });
  };

  // ws.id 变化才重拉；load 是 store 里的稳定引用，跟着它一起标依赖只会造成无意义的重跑
  useEffect(() => { void loadAll(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 单份保存成功：只替换那一行，不重拉整份——别的档与这一份没关系 */
  const handleSaved = (agentId: string, content: string, version: string): void => {
    setState((s) => (s.kind === "ok" ? { kind: "ok", rows: replaceRow(s.rows, agentId, content, Date.now(), version) } : s));
  };

  if (state.kind === "loading") {
    return <InsetGroup><InsetEmpty title="正在读记忆…" /></InsetGroup>;
  }
  if (state.kind === "error") {
    return (
      <InsetGroup>
        <InsetEmpty title="拿不到记忆" hint={state.message} />
        <InsetRow title="再试一次" tone="action" onClick={() => void loadAll()} />
      </InsetGroup>
    );
  }

  const docs = memoryDocs(ws, state.rows);

  return (
    <div className="flex flex-col">
      <InsetLabel className="pt-0">记忆档</InsetLabel>
      <InsetGroup>
        {docs.map((doc) => (
          <InsetRow
            key={doc.agentId}
            title={
              <span>
                {doc.title}
                {doc.stale && <span className="ml-1 text-muted-foreground">（已删除）</span>}
              </span>
            }
            label={doc.title}
            subtitle={firstLine(doc.content)}
            trailing={<span className="tabular-nums text-[11.5px]">{doc.used}/{doc.limit}</span>}
            chevron
            onClick={() =>
              nav.push({
                key: `memory:${ws.id}:${doc.agentId || "shared"}`,
                title: doc.title,
                backLabel: "记忆",
                render: () => <MemoryDocScreen ws={ws} doc={doc} onSaved={handleSaved} onDone={() => nav.pop()} />,
              })
            }
          />
        ))}
      </InsetGroup>
      <InsetNote>
        <b className="font-medium text-foreground">共享档</b>群里每只水獭都读得到，每条以写入者开头；
        <b className="font-medium text-foreground">私有档</b>只有那一只读得到。条目之间用一行 <code>§</code> 分隔。
      </InsetNote>
    </div>
  );
}

/** 列表行上那句预览：档里的第一条。空档说「还是空的」——留白会让人以为这一行坏了 */
function firstLine(content: string): string {
  const first = content.split("\n").map((l) => l.trim()).find((l) => l !== "" && l !== "§");
  return first ?? "还是空的";
}

function MemoryDocScreen({
  ws, doc, onSaved, onDone,
}: {
  ws: WorkspaceSnapshot;
  doc: MemoryDocView;
  onSaved: (agentId: string, content: string, version: string) => void;
  onDone: () => void;
}) {
  const save = useChat((s) => s.saveWorkspaceMemory);
  const [text, setText] = useState(doc.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(doc.version);

  // 打字时的占用算本地草稿（见文件头注）
  const used = charCount(formatEntries(parseEntries(text)));
  const overLimit = used > doc.limit;
  const dirty = text !== doc.content;

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await save(ws.id, doc.agentId, text, version);
    setBusy(false);
    if (!r.ok) {
      // 冲突文案已经是人话（「这一档刚被别人改过，刷新后再改」），原样显示即可
      setError(r.message);
      return;
    }
    // 主进程落库前做的正是这一步归一化——本地直接算出同一个结果
    const normalized = formatEntries(parseEntries(text));
    setText(normalized);
    setVersion(r.value);
    onSaved(doc.agentId, normalized, r.value);
    onDone();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          {doc.title}
        </span>
        <span className={overLimit ? "text-[11.5px] tabular-nums text-err" : "text-[11.5px] tabular-nums text-muted-foreground"}>
          {used}/{doc.limit} 字符
        </span>
      </div>
      <InsetGroup>
        <Textarea
          className="min-h-[320px] border-0 bg-transparent px-[13px] py-[11px] font-mono text-[12.5px] shadow-none focus-visible:ring-0"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          autoFocus
        />
      </InsetGroup>
      {/* 超限只染红不拦保存的话，人这条路和工具那条路（applyEntryOps 带 limit，会拒）
          长得一模一样——同一个数字对 agent 是硬闸、对人是提示（M11）。禁用钮 + 说清楚
          差几个字，别让用户猜「保存」为什么按不动 */}
      {overLimit && <p className="px-1 text-xs text-err">超出上限 {used - doc.limit} 字，删掉一些再保存</p>}
      {error && <p className="px-1 text-xs text-err">{error}</p>}
      <InsetNote>
        这一档要是在你编辑期间被别人（或某只水獭）改过，保存会<b className="font-medium text-foreground">拒绝并告诉你</b>，
        不会拿你的草稿盖掉对方。
      </InsetNote>
      <div className="pt-2">
        <Button className="w-full" onClick={() => void onSave()} disabled={busy || overLimit || !dirty}>
          {busy ? "保存中…" : dirty ? "保存" : "没有改动"}
        </Button>
      </div>
    </div>
  );
}
