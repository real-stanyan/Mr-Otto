// 终端面板 —— 纯人用的旁路工具:输出不进事件日志、不进模型上下文(ADR-0031)。
// 想让 Otto 看某段输出,用户自己复制粘贴。
//
// 面板宿主复用 Protocol/GitGraph 那套右侧槽位(半屏可拖 / 可全屏 / 记位置),
// 这里只管标签行 + xterm 的挂载。

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, X, Maximize2, Minimize2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useChat } from "../store.js";
import { createXtermRegistry } from "../lib/xtermRegistry.js";
import { Button } from "./ui/button.js";
import type { TerminalInfo } from "../../../shared/shellBridge.js";

/** 一个终端在渲染层的全部家当:实例 + fit 插件 + 是否已经灌过快照 */
interface Slot {
  term: Terminal;
  fit: FitAddon;
  attached: boolean;
  dispose(): void;
}

// 模块级:组件卸载不带走它(见 xtermRegistry 顶部注释)
const registry = createXtermRegistry<Slot>(() => {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    // 取当前主题的底色/前景,别用 xterm 默认的纯黑——深色四色底盘里会显得脏
    theme: {
      background: "transparent",
      foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground") || "#e5e5e5",
    },
    allowTransparency: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit, attached: false, dispose: () => term.dispose() };
});

export function TerminalView() {
  const sessionId = useChat((s) => s.sessionId);
  const closePanel = useChat((s) => s.closeTerminalPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 开面板:先看这个会话有没有已经在跑的终端(关面板不杀进程,大概率有),
  // 没有才开新的
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      const existing = await window.otter.terminalList(sessionId);
      if (!alive) return;
      if (existing.length > 0) {
        setTabs(existing);
        setActiveId(existing[0]!.id);
        return;
      }
      try {
        const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
        if (!alive) return;
        setTabs(await window.otter.terminalList(sessionId));
        setActiveId(id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  // 挂载当前标签的 xterm 到 DOM,并把回滚缓冲灌进去(只灌一次)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const slot = registry.get(activeId);
    host.replaceChildren();
    slot.term.open(host);
    slot.fit.fit();
    window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows);

    if (!slot.attached) {
      slot.attached = true;
      void window.otter
        .terminalAttach(activeId)
        .then(({ snapshot }) => { if (snapshot) slot.term.write(snapshot); })
        .catch(() => { /* 终端已经关了,标签行随后会刷新掉 */ });
      slot.term.onData((data) => void window.otter.terminalInput(activeId, data));
    }
    slot.term.focus();
  }, [activeId]);

  // 输出直播:所有终端的都收,按 id 写进各自的实例(后台标签也在攒输出)
  useEffect(() => {
    const offData = window.otter.onTerminalData(({ id, data }) => {
      registry.get(id).term.write(data);
    });
    const offExit = window.otter.onTerminalExit(({ id, exitCode }) => {
      registry.get(id).term.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`);
      if (sessionId) void window.otter.terminalList(sessionId).then(setTabs);
    });
    return () => { offData(); offExit(); };
  }, [sessionId]);

  // 面板宽度变了(拖拽 / 展开全屏)要重算行列,否则 vim 之类的会画歪
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const ro = new ResizeObserver(() => {
      const slot = registry.get(activeId);
      slot.fit.fit();
      void window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [activeId]);

  const newTab = async () => {
    if (!sessionId) return;
    try {
      const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
      setTabs(await window.otter.terminalList(sessionId));
      setActiveId(id);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeTab = async (id: string) => {
    await window.otter.terminalClose(id);
    registry.dispose(id); // 关标签才 dispose——这是唯一该 dispose 的时机
    const rest = sessionId ? await window.otter.terminalList(sessionId) : [];
    setTabs(rest);
    if (activeId === id) setActiveId(rest[0]?.id ?? null);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
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
          <Button variant="ghost" size="sm" onClick={() => void newTab()} title="新终端">
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
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
