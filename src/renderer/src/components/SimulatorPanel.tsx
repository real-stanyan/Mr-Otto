// iOS 模拟器面板 —— 人和 agent 共用的那台设备(issue #401)。
//
// 与浏览器面板的根本区别:这里显示的不是一块浮在 React 之上的原生视图,
// 而是一张普通 <img>——画面是主进程按 500ms 轮询截下来的帧。所以这个
// 组件不需要量位置报矩形,但多了一件浏览器面板没有的事:**把点击换算回
// 设备坐标**。换算的分母是那一帧的像素尺寸(全系统统一的坐标系,
// 见 shared/simulator.ts 文件头),不是 <img> 在屏幕上被 CSS 拉成多大。
//
// 状态不进 zustand:设备列表/画面住在主进程的 hub 里,这里挂载时拉一次快照
// 再订推送(同 BrowserPanel 的做法)——store 里只留"面板开没开"这一个布尔。

import { useCallback, useEffect, useRef, useState } from "react";
import { HEADER_H } from "../settingsShell.js";
import { Maximize2, Minimize2, Play, Power, Smartphone, X } from "lucide-react";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import type { SimButton, SimFrame, SimState } from "../../../shared/simulator.js";

/** 按下到抬起超过这个距离(帧像素)算划动,否则算点一下。
    12px 是在 480 宽的帧上定的:手抖那一两像素不该把点击变成划动 */
const SWIPE_THRESHOLD = 12;

const BUTTONS: { id: SimButton; label: string; title: string }[] = [
  { id: "home", label: "Home", title: "回主屏(⇧⌘H)" },
  { id: "lock", label: "锁屏", title: "锁屏/解锁(⌘L)" },
  { id: "siri", label: "Siri", title: "唤起 Siri" },
  { id: "shake", label: "摇一摇", title: "摇动设备(⌃⌘Z)" },
];

export function SimulatorPanel() {
  const closePanel = useChat((s) => s.closeSimPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [state, setState] = useState<SimState | null>(null);
  const [frame, setFrame] = useState<SimFrame | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 按下的位置。ref 而不是 state:抬起时要读它,重渲染一次没有意义
  const downAt = useRef<{ x: number; y: number } | null>(null);

  // 挂载:拉快照 + 开画面轮询;卸载:停轮询(没人看的时候不该一直截图)
  useEffect(() => {
    let alive = true;
    void window.otter.simState().then((s) => alive && setState(s));
    void window.otter.simStartStream();
    return () => {
      alive = false;
      void window.otter.simStopStream();
    };
  }, []);

  useEffect(() => window.otter.onSimState(setState), []);
  useEffect(() => window.otter.onSimFrame(setFrame), []);

  /** 包一层:跑主进程那边的动作,期间禁按钮,回来刷新一次状态。
      失败不吞——lastError 由 hub 推回来显示在横幅上 */
  const act = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } catch {
      // 人话已经在 hub 的 lastError 里,这里不重复弹
    } finally {
      setBusy(null);
      void window.otter.simState().then(setState);
    }
  }, []);

  /** 屏幕上的鼠标位置 → 那一帧的像素坐标。
      <img> 是等比缩放显示的,所以两个轴的比例相同;仍分轴算,免得
      将来给容器加了别的约束时无声地歪掉 */
  const toFramePixels = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img || !frame) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: ((e.clientX - r.left) / r.width) * frame.width,
      y: ((e.clientY - r.top) / r.height) * frame.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toFramePixels(e);
    if (p) downAt.current = p;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const from = downAt.current;
    downAt.current = null;
    const to = toFramePixels(e);
    if (!from || !to) return;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < SWIPE_THRESHOLD) {
      void act("tap", () => window.otter.simTap(from.x, from.y));
    } else {
      void act("swipe", () => window.otter.simSwipe(from.x, from.y, to.x, to.y, 300));
    }
  };

  const devices = state?.devices ?? [];
  const selected = state?.selectedUdid ?? "";
  const booted = state?.booted ?? false;
  const inputReady = state?.inputReady ?? false;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className={`flex ${HEADER_H} items-center gap-1 border-b px-2 drag-region`}>
        <Smartphone className="size-4 shrink-0 opacity-60" />
        <select
          aria-label="模拟器设备"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none"
          value={selected}
          onChange={(e) => void act("select", () => window.otter.simSelect(e.target.value || null))}
        >
          {devices.length === 0 && <option value="">没有可用设备</option>}
          {devices.map((d) => (
            <option key={d.udid} value={d.udid}>
              {d.booted ? "● " : "○ "}
              {d.name} — {d.runtime}
            </option>
          ))}
        </select>
        {booted ? (
          <Button
            variant="ghost" size="icon" disabled={!!busy}
            title="关机(设备状态保留,下次开机还在这儿)"
            onClick={() => void act("shutdown", () => window.otter.simShutdown())}
          >
            <Power className="size-4" />
          </Button>
        ) : (
          <Button
            variant="ghost" size="icon" disabled={!!busy || !selected}
            title="开机(顺带把 Simulator.app 切到这台设备)"
            onClick={() => void act("boot", () => window.otter.simBoot())}
          >
            <Play className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={togglePanelWide}
          title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={closePanel} title="关闭面板(设备继续开着)">
          <X className="size-4" />
        </Button>
      </div>

      {state?.lastError && (
        <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {state.lastError}
        </div>
      )}

      {/* 没授权时这条横幅是唯一出口:点击和打字全靠「辅助功能」,
          静默不响应会让人以为是坏了 */}
      {!inputReady && (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1">
            还不能点:点击/打字要「辅助功能」权限(画面不要)。授权后可能需要重开 app。
          </span>
          <Button size="sm" variant="secondary"
            onClick={() => void act("perm", () => window.otter.simRequestInputPermission())}>
            去授权
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-3">
        {frame ? (
          // 帧是 JPEG base64。key 不给 ts:换 key 会让 <img> 重新挂载,
          // 每帧闪一下白;同一个元素换 src 是无缝的
          <img
            ref={imgRef}
            src={`data:${frame.mime};base64,${frame.image}`}
            alt="iOS 模拟器画面"
            draggable={false}
            className="max-h-full max-w-full select-none rounded-[18px] shadow-lg"
            style={{ cursor: inputReady ? "pointer" : "not-allowed" }}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
          />
        ) : (
          <div className="text-sm text-muted-foreground">
            {booted ? "等第一帧画面…" : "这台设备没开机——按上面那颗 ▶ 开机"}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        {BUTTONS.map((b) => (
          <Button key={b.id} size="sm" variant="ghost" title={b.title} disabled={!inputReady || !!busy}
            onClick={() => void act(b.id, () => window.otter.simButton(b.id))}>
            {b.label}
          </Button>
        ))}
        <input
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1"
          placeholder={inputReady ? "打字(回车送进当前焦点)" : "需要辅助功能权限"}
          disabled={!inputReady}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || text === "") return;
            const t = text;
            setText("");
            void act("type", () => window.otter.simType(t));
          }}
        />
      </div>
    </div>
  );
}
