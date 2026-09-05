// WorkspaceMemoryTab —— 工作区设置页「记忆」tab：共享档 + 每只 agent 的私有档，
// 能看能编（#949，spec §6）。骨架照抄 WorkspaceUsageTab 的三态（loading/error/ok），
// 纯逻辑（顺序/占用/stale 判定）全在 workspaceMemoryView.ts 的 memoryDocs。
//
// 每份档一块：标题行（title + used/limit 字符，stale 的档标「（已删除）」）+
// 一个 Textarea（值是磁盘原文，含 "\n§\n" 分隔符，不重排格式）+ 保存按钮。
// 保存中禁用输入与按钮；失败画 text-err。
//
// fix round 1（review）：单块保存成功后**只替换那一行**（workspaceMemoryView.ts
// 的 replaceRow），不整份重拉——原来的 refresh() 会先把所有 MemoryDocBlock 卸载
// 再重装，用户在共享档打到一半的字会被另一只 agent 那块的保存悄悄冲掉，且不报警。
// 「刷新」按钮仍然整份重拉，但若任何一块此刻有未保存的草稿，先用 confirm 问一句
// ——那才是用户主动要放弃草稿的时刻，不该在别的块保存时顺带发生。
// 「重拉会先卸载所有 MemoryDocBlock 再重装」这句话之所以成立，是因为 loadAll()
// 先 setState({kind:"loading"}) ——那一分支的 return 是一个 <p>，state.kind 从
// "ok" 变成 "loading" 的这一帧，docs.map 出来的整棵 MemoryDocBlock 子树跟着卸载，
// 新数据回来后 "loading"→"ok" 再整棵重装。这一步是这条注释成立的关键跳转：将来
// 谁想给「刷新」去掉转圈（比如改成 loading 与 ok 数据共存、原地替换），如果漏掉
// 这一跳会静默地把「重拉=丢草稿」变成「重拉=悄悄覆盖草稿」——本文件顶部与
// handleSaved 依赖的正是「卸载过一次」这个前提，不只是「数据变新」这个结果。
// 归一化用的是与主进程落库前同一步纯函数（formatEntries(parseEntries(text))），
// 本地直接算，不必整份重拉才能知道存下去的是什么样子。

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useChat } from "../store.js";
import { memoryDocs, replaceRow, type MemoryDocView } from "../lib/workspaceMemoryView.js";
import { charCount, formatEntries, parseEntries } from "../../../shared/memoryStore.js";
import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

function MemoryDocBlock({
  ws,
  doc,
  onSaved,
  onDirtyChange,
}: {
  ws: WorkspaceSnapshot;
  doc: MemoryDocView;
  /** 只更新本地那一行，不触发整份重拉——见文件头注 */
  onSaved: (agentId: string, content: string) => void;
  /** 草稿 !== 磁盘内容 时上报，父组件靠它决定「刷新」要不要弹确认框 */
  onDirtyChange: (agentId: string, dirty: boolean) => void;
}) {
  const save = useChat((s) => s.saveWorkspaceMemory);
  const [text, setText] = useState(doc.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = text !== doc.content;
  // 打字时的占用算本地草稿，不是 doc.used（那是上一次保存成功时服务端算出来的数，
  // 冻在那儿直到下一次成功保存——用户敲字时超没超限完全看不出来）。归一化用与落库
  // 前同一步纯函数（同 onSave 那句），所以这个数就是「现在按保存会存成什么样」。
  // 手编本身不做上限校验（onSave 的落库路径不拦），这个计数器是唯一的信号
  const used = charCount(formatEntries(parseEntries(text)));
  const overLimit = used > doc.limit;
  useEffect(() => {
    onDirtyChange(doc.agentId, dirty);
    // 这一档从渲染里消失（理论上不会——docs 名单只增不减，除非工作区快照变了）
    // 时清掉自己的脏标记，不留一个再也没人能清的 true
    return () => onDirtyChange(doc.agentId, false);
    // onDirtyChange 是父组件每次渲染新建的箭头函数，不进依赖——它只读写一个 ref，
    // 引用变化不代表语义变化，跟着它重跑只会产生多余调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, doc.agentId]);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    // baseline = 这一块打开时读到的磁盘原文（doc.content，不是此刻的草稿 text）——
    // 桌面手编 vs agent 写档共用同一个 daemon，saveMemoryRow 用它做乐观前置条件
    // （#949 review finding 2）：这一档若在我们编辑期间被别人（agent 或另一个标签页）
    // 改过，保存会拒绝并回 MEMORY_CONFLICT，而不是悄悄用我们的草稿覆盖对方的改动。
    const r = await save(ws.id, doc.agentId, text, doc.content);
    setBusy(false);
    if (!r.ok) {
      // 冲突文案已经是人话（"这一档刚被别人改过，刷新后再改"），原样显示即可，
      // 不额外分支处理——用户要看到最新内容就会点「刷新」，不在这里代劳
      setError(r.message);
      return;
    }
    // 主进程落库前做的正是这一步归一化——本地直接算出同一个结果
    const normalized = formatEntries(parseEntries(text));
    setText(normalized);
    onSaved(doc.agentId, normalized);
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {doc.title}
          {doc.stale && <span className="ml-1 text-muted-foreground">（已删除）</span>}
        </span>
        <span className={overLimit ? "text-xs text-err" : "text-xs text-muted-foreground"}>
          {used}/{doc.limit} 字符
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
  // 每只 agent 此刻是否有未保存的草稿——只用来决定「刷新」按钮要不要弹确认框，
  // 不影响渲染；用 ref 而不是 state：这份标记随便哪个块一按键就变，跟着它重渲染
  // 整个父组件毫无必要（子组件已经各自管自己的 text）
  const dirtyRef = useRef<Record<string, boolean>>({});

  const loadAll = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    setState(r.ok ? { kind: "ok", rows: r.value } : { kind: "error", message: r.message });
  };

  // ws.id 变化才重拉；load 是 store 里的稳定引用，跟着它一起标依赖只会造成无意义的重跑
  useEffect(() => { void loadAll(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 「刷新」按钮：整份重拉会卸载所有 MemoryDocBlock，没保存的草稿跟着消失——
  // 真有未保存的档时先问一句，同意了才重拉。单块保存成功不走这条路（见 handleSaved）
  const refresh = async (): Promise<void> => {
    const anyDirty = Object.values(dirtyRef.current).some(Boolean);
    if (anyDirty && !window.confirm("有未保存的修改，刷新会丢掉它们，继续吗？")) return;
    await loadAll();
  };

  // 单块保存成功：只替换那一行，不重拉整份列表——其它块的草稿原封不动
  const handleSaved = (agentId: string, content: string): void => {
    setState((s) => (s.kind === "ok" ? { kind: "ok", rows: replaceRow(s.rows, agentId, content, Date.now()) } : s));
  };

  const handleDirtyChange = (agentId: string, dirty: boolean): void => {
    dirtyRef.current = { ...dirtyRef.current, [agentId]: dirty };
  };

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
        <MemoryDocBlock key={d.agentId} ws={ws} doc={d} onSaved={handleSaved} onDirtyChange={handleDirtyChange} />
      ))}
    </div>
  );
}
