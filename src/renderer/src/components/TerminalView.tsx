// 终端面板 —— 纯人用的旁路工具:输出不进事件日志、不进模型上下文(ADR-0031)。
// 想让 Otto 看某段输出,用户自己复制粘贴。
//
// 面板宿主复用 Protocol/GitGraph 那套右侧槽位(半屏可拖 / 可全屏 / 记位置),
// 这里只管标签行 + xterm 的挂载。

import { useEffect, useRef, useState } from "react";
import { HEADER_H } from "../App.js";
import { Plus, X, Maximize2, Minimize2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useChat } from "../store.js";
import { terminalRegistry as registry, rememberActiveTerminal, recallActiveTerminal } from "../lib/terminalRegistry.js";
import { Button } from "./ui/button.js";
import type { TerminalInfo } from "../../../shared/shellBridge.js";

export function TerminalView() {
  const sessionId = useChat((s) => s.sessionId);
  const closePanel = useChat((s) => s.closeTerminalPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 开面板 / 切会话:先看这个会话有没有已经在跑的终端(关面板不杀进程,大概率有),
  // 没有才开新的。
  //
  // 同步阶段先把 activeId/tabs/error 摘掉(在任何 await 之前)——不这样做的话,
  // 在 terminalList 的 IPC 往返期间,挂载 effect 还认着上一个会话的 activeId,
  // 宿主 DOM 里挂的还是上一个会话那个 xterm 实例,它的 onData 还接着
  // terminalInput(旧 sessionId 的终端 id, ...):这段窗口期间用户如果打字,
  // 敲的字会进错会话的 PTY(Task 6 review finding 1)。activeId 变 null 后,
  // 下面的挂载 effect 会把宿主清空,断开旧实例的键盘绑定
  useEffect(() => {
    setActiveId(null);
    setTabs([]);
    setError("");
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      const existing = await window.otter.terminalList(sessionId);
      if (!alive) return;
      if (existing.length > 0) {
        setTabs(existing);
        // 优先找回上次停留的标签(展开/收起面板会卸载重挂这棵子树,
        // 状态归零——见 terminalRegistry.ts 里 rememberActiveTerminal 的注释)。
        // 记忆里的 id 有可能已经不在这批标签里了(标签在面板关着的时候被关掉/
        // 会话被删过又重建),这时候不能硬恢复一个不存在的标签——退回 existing[0]
        const remembered = recallActiveTerminal(sessionId);
        const seed = existing.find((t) => t.id === remembered) ?? existing[0]!;
        setActiveId(seed.id);
        rememberActiveTerminal(sessionId, seed.id);
        return;
      }
      try {
        const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
        if (!alive) return;
        setTabs(await window.otter.terminalList(sessionId));
        setActiveId(id);
        rememberActiveTerminal(sessionId, id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  // 挂载当前标签的 xterm 到 DOM,并把回滚缓冲灌进去(只灌一次)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!activeId) {
      // 没有活跃标签(切会话过渡期 / 这个会话还没终端):清空宿主,
      // 别把上一个 activeId 挂过的 DOM 节点留在页面上
      host.replaceChildren();
      return;
    }
    const slot = registry.get(activeId);
    // 标签有可能在被点开之前就已经退出——那样这里是第一次 get(),
    // factory 给的 exited 默认是 false,但 tabs 列表已经是后端刷新过的事实
    // (onTerminalExit 处理器每次都会重拉一遍 terminalList)。只在它说"退了"
    // 的时候才纠正,不然会把"活跃标签退出时由 live 事件直接置 true"的结果盖掉
    const tabInfo = tabs.find((t) => t.id === activeId);
    if (tabInfo?.exited) slot.exited = true;
    host.replaceChildren();
    if (slot.term.element) {
      // 这个终端之前在别的宿主(甚至别的挂载周期)里 open() 过——
      // xterm 的 open() 是"第一次初始化",对已经 open 过的实例再调一次是未定义行为
      // (node_modules/@xterm/xterm/typings/xterm.d.ts 里 open() 的文档写明这点)。
      // 已经 open 过就把它现成的 DOM 节点搬进新宿主,而不是再 open 一次
      host.appendChild(slot.term.element);
    } else {
      slot.term.open(host);
    }
    slot.fit.fit();
    void window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows).catch(() => {
      /* 终端可能刚好在这一刻被关了,resize 打空不算错误 */
    });

    if (!slot.attached) {
      slot.attached = true;
      void window.otter
        .terminalAttach(activeId)
        .then(({ snapshot }) => { if (snapshot) slot.term.write(snapshot); })
        .catch(() => { /* 终端已经关了,标签行随后会刷新掉 */ });
      slot.term.onData((data) => {
        if (slot.exited) return; // 进程已经死了,敲字没有意义,也别再往 IPC 里扔
        void window.otter.terminalInput(activeId, data).catch(() => {
          /* 竞态:这条输入发出去的瞬间进程正好退出,静默吞掉 */
        });
      });
    }
    slot.term.focus();
  }, [activeId]);

  // 写数据/标退出这两下已经搬到 startTerminalLiveFeed(store.boot() 里订阅一次,
  // 跟 app 同生共死)——这里再订一遍会导致同一段字节被两条订阅各写一次,
  // 屏幕上每个字符都会重复。这个组件级 effect 只剩"标签行要跟着刷新"这一件事:
  // 退出时把哪一行画删除线是组件自己的状态,活不过 startTerminalLiveFeed
  // 那种模块级订阅管不到,只能靠还挂载着的 TerminalView 自己去拉
  useEffect(() => {
    const offExit = window.otter.onTerminalExit(() => {
      if (sessionId) void window.otter.terminalList(sessionId).then(setTabs);
    });
    return () => { offExit(); };
  }, [sessionId]);

  // 面板宽度变了(拖拽 / 展开全屏)要重算行列,否则 vim 之类的会画歪
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const ro = new ResizeObserver(() => {
      // peek 不 get:activeId 可能是 closeTab 摘掉之后还残留在闭包里的旧值
      // (下一次渲染才会把它换成 null/新 id)——用 get() 会把已经 dispose 掉的
      // 槽位重新造一个出来,造出个没人挂载、也没人会去 dispose 的孤儿 Terminal
      const slot = registry.peek(activeId);
      if (!slot || slot.exited) return; // 实例没了,或进程死了,尺寸都没意义
      slot.fit.fit();
      void window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows).catch(() => {
        /* 同上:关闭竞态,静默吞掉 */
      });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [activeId]);

  // 用户主动点标签切换——跟挂载 effect 里的"自动选一个"共用同一份记忆写入,
  // 保证展开/收起面板重挂时找回的是用户真正停留过的那个标签
  const selectTab = (id: string) => {
    setActiveId(id);
    if (sessionId) rememberActiveTerminal(sessionId, id);
  };

  const newTab = async () => {
    if (!sessionId) return;
    try {
      const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
      setTabs(await window.otter.terminalList(sessionId));
      selectTab(id);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeTab = async (id: string) => {
    await window.otter.terminalClose(id);
    registry.dispose(id); // 关标签才 dispose——这是唯一该 dispose 的时机(会话删除见 store.deleteSession)
    const rest = sessionId ? await window.otter.terminalList(sessionId) : [];
    setTabs(rest);
    if (activeId === id) {
      const next = rest[0]?.id ?? null;
      setActiveId(next);
      // next 为 null 时也要写进去(清掉记忆):关掉的正好是记忆里那个标签,
      // 留着旧值下次重挂会去找一个已经不存在的 id
      if (sessionId) rememberActiveTerminal(sessionId, next);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className={`flex ${HEADER_H} items-center gap-1 border-b border-border px-2 drag-region`}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={`group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ${
                t.id === activeId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <span className={t.exited ? "line-through opacity-60" : ""}>{t.title}</span>
              <X
                className="h-3 w-3 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); void closeTab(t.id); }}
              />
            </button>
          ))}
          {/* 没会话时这颗按钮点了也开不出终端(terminalOpen 要 sessionId)——
              早先是静默 no-op,一块死面板还看不出为什么。跟 Welcome 页
              「先选工程文件夹」那颗按钮同一个模式:disabled + title 说明原因,
              而不是让用户点半天没反应自己猜 */}
          <Button variant="ghost" size="sm" onClick={() => void newTab()} disabled={!sessionId} title={sessionId ? "新终端" : "先选一个会话"}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={togglePanelWide} title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={closePanel} title="关闭面板">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      {sessionId ? (
        <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
      ) : (
        // 从欢迎页(没有会话)也能把面板开出来(⌃` 全局快捷键不看 phase)——
        // 这里给个说明,别让用户面对一块空面板猜发生了什么
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-2 text-xs text-muted-foreground">
          先选一个会话
        </div>
      )}
    </div>
  );
}
