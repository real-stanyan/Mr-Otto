import { useEffect, useState } from "react";
import ottoLogo from "../assets/otto.png";
import { useChat } from "../store.js";
import { splashProgress } from "../lib/splashProgress.js";
import { DitherBackground } from "./DitherBackground.js";

/** 挂载时刻即"app 打开"时刻：模块级取一次，StrictMode 双挂载不会把它拨回去 */
const OPENED_AT = performance.now();
const FADE_MS = 360;

/**
 * 冷启动画面：Dither 背景 + 居中 logo + 进度条。
 * 盖在整个 app 上面（不是替换 connecting 占位），这样主界面在底下照常挂载，
 * 画面收起时不用再付一次首屏渲染；进度 = 真实 boot 完成数 × 最短停留时间，
 * 两边都满才淡出、卸载（见 lib/splashProgress.ts）。
 */
export function Splash() {
  const bootDone = useChat((s) => s.bootDone);
  const bootTotal = useChat((s) => s.bootTotal);
  // connecting 阶段 bootTotal 还是 0（boot() 没跑到 Promise.all），不能当"没东西要等"
  const connecting = useChat((s) => s.phase === "connecting");
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);
  const [dark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    if (gone) return;
    let raf = 0;
    const tick = () => {
      const p = splashProgress({
        done: connecting ? 0 : bootDone,
        total: connecting ? 1 : bootTotal,
        elapsedMs: performance.now() - OPENED_AT,
      });
      setProgress(p);
      if (p >= 1) setFading(true);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bootDone, bootTotal, connecting, gone]);

  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [fading]);

  if (gone) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-background transition-opacity ease-out"
      style={{ opacity: fading ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
      data-testid="splash"
    >
      <DitherBackground className="absolute inset-0 h-full w-full" dark={dark} />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
        <img src={ottoLogo} alt="Mr Otto" className="size-24 rounded-3xl shadow-2xl" draggable={false} />
        <div
          className="h-[3px] w-40 overflow-hidden rounded-full bg-foreground/15"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full rounded-full bg-foreground/80 transition-[width] duration-150 ease-out"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
