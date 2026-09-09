// WorkspaceWikiTab —— 团队设置里的「记忆」那一页（#1140，ADR-0281 推翻 ADR-0222 的两档编辑器）。
// 读走现成的 files 帧（wiki/index.md、wiki/log.md、wiki/<页>），改走 wiki_write 帧——服务端与 wiki 工具同一条
// 写入路径，人改的和 agent 改的过同一道门。
// 三态（同 ADR-0264 决策 8）：loading / 读不到（上一份留在原地，错误另起一行）/ 读到了。`absent`（容器还没建）
// 与空索引是两回事：前者这个团队一次活都没干过，后者干过但 wiki 里还没有页。
// 不做：页面历史（journal 里有，界面不画）、上传附件（spec §13）。

import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { InsetEmpty, InsetGroup, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useNav } from "@/components/ui/nav-stack.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { useChat } from "../store.js";
import {
  WIKI_DIR, WIKI_INDEX_PATH, WIKI_LOG_PATH, WIKI_PINNED_BUDGET, isRemovableWikiPath, isWikiPagePath, nudgeFrom, parseIndex, parseWikiPage,
  type WikiIndexGroup, type WikiPage,
} from "../../../shared/wiki.js";
import type { CsWikiWriteReq, CsWorkNode } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

const REMARK_PLUGINS = [remarkGfm];

type IndexState =
  | { kind: "loading" }
  | { kind: "error"; message: string; groups: WikiIndexGroup[] | null }
  | { kind: "absent" }
  | { kind: "ok"; groups: WikiIndexGroup[]; nudge: string | null };

function textOf(node: CsWorkNode): string | null {
  return node.kind === "file" ? node.text : node.kind === "missing" ? "" : null;
}

export function WorkspaceWikiTab({ ws }: { ws: WorkspaceSnapshot }) {
  const nav = useNav();
  const loadFiles = useChat((s) => s.workspaceFiles);
  const [state, setState] = useState<IndexState>({ kind: "loading" });

  const load = async (): Promise<void> => {
    setState((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    const idx = await loadFiles(ws.id, `${WIKI_DIR}/${WIKI_INDEX_PATH}`);
    if (!idx.ok) {
      setState((s) => ({ kind: "error", message: idx.message, groups: s.kind === "ok" ? s.groups : null }));
      return;
    }
    if (idx.value.kind === "absent") { setState({ kind: "absent" }); return; }
    const indexText = textOf(idx.value);
    if (indexText === null) { setState({ kind: "error", message: "索引不是文本，读不了。", groups: null }); return; }
    const log = await loadFiles(ws.id, `${WIKI_DIR}/${WIKI_LOG_PATH}`);
    const logText = log.ok ? (textOf(log.value) ?? "") : "";
    setState({ kind: "ok", groups: parseIndex(indexText), nudge: nudgeFrom(logText, Date.now()) });
  };
  useEffect(() => { void load(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPage = (path: string, title: string): void =>
    nav.push({ key: `wiki:${ws.id}:${path}`, title, backLabel: "记忆", render: () => <WikiPageScreen ws={ws} path={path} onChanged={() => void load()} onDone={() => nav.pop()} /> });
  const openNew = (): void =>
    nav.push({ key: `wiki:${ws.id}:new`, title: "新建页", backLabel: "记忆", render: () => <WikiEditScreen ws={ws} page={null} onSaved={() => { void load(); nav.pop(); }} /> });

  if (state.kind === "loading") return <InsetGroup><InsetEmpty title="正在读 wiki…" /></InsetGroup>;
  if (state.kind === "absent") {
    return <InsetGroup><InsetEmpty title="这个团队的工作文件夹还没建起来" hint="第一次让水獭干活时会建；wiki 也在那时候生成。" /></InsetGroup>;
  }
  const groups = state.groups; // loading / absent 在上面已经 return，剩下的两态都带 groups
  return (
    <div className="flex flex-col">
      {state.kind === "error" && (
        <InsetGroup>
          <InsetEmpty title="这一刻读不到 wiki" hint={state.message} />
          <InsetRow title="再试一次" tone="action" onClick={() => void load()} />
        </InsetGroup>
      )}
      {state.kind === "ok" && state.nudge !== null && <InsetNote>{state.nudge}</InsetNote>}
      <InsetGroup>
        <InsetRow title="新建页" tone="action" onClick={openNew} />
      </InsetGroup>
      {groups !== null && groups.length === 0 && <InsetGroup><InsetEmpty title="wiki 里还没有页" hint="水獭记下第一条口径之后，这里就有了。" /></InsetGroup>}
      {(groups ?? []).map((g) => (
        <div key={g.name}>
          <InsetLabel>{g.name}</InsetLabel>
          <InsetGroup>
            {g.entries.map((e) => (
              <InsetRow key={e.path} title={e.title} label={e.title} subtitle={e.summary === "" ? e.path : e.summary} chevron onClick={() => openPage(e.path, e.title)} />
            ))}
          </InsetGroup>
        </div>
      ))}
      <InsetNote>
        wiki 住在团队工作文件夹的 <code>wiki/</code> 里，水獭每轮发言前会读索引 + 常驻页 + 它自己那页；其余页它按需读。
        你在这里改的和水獭改的走同一条路（盖章、索引、日志、备份）。
      </InsetNote>
    </div>
  );
}

function WikiPageScreen({ ws, path, onChanged, onDone }: { ws: WorkspaceSnapshot; path: string; onChanged: () => void; onDone: () => void }) {
  const nav = useNav();
  const confirm = useConfirm();
  const loadFiles = useChat((s) => s.workspaceFiles);
  const write = useChat((s) => s.workspaceWikiWrite);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const r = await loadFiles(ws.id, `${WIKI_DIR}/${path}`);
    if (!r.ok) { setError(r.message); return; }
    const text = textOf(r.value);
    if (text === null) { setError("这一页读不出来（不是文本）。"); return; }
    setError(null);
    setPage(parseWikiPage(path, text));
  };
  useEffect(() => { void load(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRemove = async (): Promise<void> => {
    const ok = await confirm({ title: `删掉「${page?.front.title ?? path}」？`, description: "这一页会从 wiki 里去掉；journal 里留着历史版本。", confirmLabel: "删除这一页", tone: "danger" });
    if (!ok) return;
    const r = await write(ws.id, { op: "remove", path });
    if (!r.ok) { setError(r.message); return; }
    onChanged();
    onDone();
  };

  if (page === null) {
    return <InsetGroup><InsetEmpty title={error ?? "正在读这一页…"} />{error && <InsetRow title="再试一次" tone="action" onClick={() => void load()} />}</InsetGroup>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 text-[11.5px] text-muted-foreground">
        {path} · {page.front.updatedBy || "—"} · {page.front.updatedAt.slice(0, 16).replace("T", " ") || "—"}{page.front.pinned ? " · 常驻" : ""}
      </div>
      {page.front.summary !== "" && <p className="px-1 text-[12.5px]">{page.front.summary}</p>}
      <InsetGroup>
        <div className="md min-w-0 overflow-auto px-[13px] py-[11px] text-[12.5px]">
          <Markdown remarkPlugins={REMARK_PLUGINS}>{page.body}</Markdown>
        </div>
      </InsetGroup>
      {error && <p className="px-1 text-xs text-err">{error}</p>}
      <div className="flex gap-2 pt-2">
        <Button className="flex-1" onClick={() => nav.push({ key: `wiki:${ws.id}:${path}:edit`, title: "编辑", backLabel: page.front.title, render: () => <WikiEditScreen ws={ws} page={page} onSaved={() => { onChanged(); void load(); nav.pop(); }} /> })}>编辑</Button>
        {isRemovableWikiPath(path) && <Button variant="outline" onClick={() => void onRemove()}>删除</Button>}
      </div>
    </div>
  );
}

function WikiEditScreen({ ws, page, onSaved }: { ws: WorkspaceSnapshot; page: WikiPage | null; onSaved: () => void }) {
  const write = useChat((s) => s.workspaceWikiWrite);
  const [path, setPath] = useState(page?.path ?? "");
  const [title, setTitle] = useState(page?.front.title ?? "");
  const [summary, setSummary] = useState(page?.front.summary ?? "");
  const [pinned, setPinned] = useState(page?.front.pinned ?? false);
  const [body, setBody] = useState(page?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    const p = path.trim();
    if (!isWikiPagePath(p)) { setError(`路径不合法：${p || "（空）"}。一层目录、小写英文 kebab、.md 结尾，例如 customers/acme.md`); return; }
    setBusy(true);
    setError(null);
    // write 是整页替换，而这张表没有编辑 sources 的地方——不把页头原来那份带回去，
    // 人每改一句正文就顺手删掉了它（新建页没有「原来那份」，那一格干脆不带）
    const req: CsWikiWriteReq = { op: "write", path: p, title, summary, pinned, body, ...(page ? { sources: page.front.sources } : {}) };
    const r = await write(ws.id, req);
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onSaved();
  };

  return (
    <div className="flex flex-col gap-2">
      <InsetGroup>
        <label className="flex items-center gap-2 px-[13px] py-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-muted-foreground">路径</span>
          <Input aria-label="路径" value={path} onChange={(e) => setPath(e.target.value)} disabled={page !== null || busy} placeholder="customers/acme.md" />
        </label>
        <label className="flex items-center gap-2 px-[13px] py-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-muted-foreground">标题</span>
          <Input aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
        <label className="flex items-center gap-2 px-[13px] py-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-muted-foreground">摘要</span>
          <Input aria-label="摘要" value={summary} onChange={(e) => setSummary(e.target.value)} disabled={busy} placeholder="一句话，索引里就这一行" />
        </label>
        <label className="flex items-center justify-between px-[13px] py-2 text-[12.5px]">
          <span>常驻（每轮都注入给所有智能体）</span>
          <Switch aria-label="常驻" checked={pinned} onCheckedChange={setPinned} disabled={busy} />
        </label>
      </InsetGroup>
      <InsetGroup>
        <Textarea aria-label="正文" className="min-h-[280px] border-0 bg-transparent px-[13px] py-[11px] font-mono text-[12.5px] shadow-none focus-visible:ring-0" value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
      </InsetGroup>
      {error && <p className="px-1 text-xs text-err">{error}</p>}
      <InsetNote>正文是 markdown，用 <code>[[路径]]</code> 链到别的页。常驻页合计有 {WIKI_PINNED_BUDGET} 字预算，超了保存会被拒并告诉你现有的常驻页。</InsetNote>
      <div className="pt-2">
        <Button className="w-full" onClick={() => void onSave()} disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
      </div>
    </div>
  );
}
