// nav-stack —— 抽屉里的推入式导航（#1120）。根页是一份目录，点一行**推进**一页，
// 左上角返回、左缘右划也返回。
//
// ## 为什么不是分段控件
//
// 团队设置原来把七格塞进一条 `TabsList`，而抽屉只有 420px 宽（`App.tsx` 的
// `w-[min(420px,92vw)]`）：真机上「智能体」「连接器」已经挤到快认不出，再加一格
// 就得开始截断。推入式换来的三件事：① 每格有多宽由它自己说了算，加第八格不影响
// 前七格；② 目录那一层能给每行写一句「里面有什么」，而 tab 只有两个字；③ 二级页
// 有完整的一屏，所以那三个原来必须开弹窗的编辑器（智能体 / 主机 / 记忆）可以直接
// 摊在页面上——420px 的抽屉里开一个 480px 的弹窗本来就不成立。
//
// 代价写在这儿：**换一格从一次点击变成两次**（返回 + 进另一格）。设置面是低频、
// 且人来这儿通常只为改一件事，这个代价换上面三条是划算的；如果哪天这一页变成
// 每天要在几格之间来回跳的东西，这个判断就该重判。
//
// ## 动效
//
// 全部走 `lib/spring.ts` 那层弹簧，不用 CSS transition：手势可以在**任何时刻**
// 抓住一页把它拖回去，而定时曲线在半路改目标时会把速度断掉。手指松开时把速度
// 交棒给弹簧（`velocity`），拖与动画之间因此没有接缝。
//
// 三条与 Apple 那套一致的细节：下面那页跟着往后退（视差 + 压暗，「栈」这件事
// 看得见）、越界拉动带阻尼（硬停读作卡住）、松手按**动量投影**判去留而不是按
// 松手那一刻的位置（轻轻一甩也该甩得动）。
//
// `prefers-reduced-motion` 下整层退化成瞬间切换——不是「快一点」，是不动。

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils.js";
import { Spring, clamp, projectMomentum, rubberband, velocityFrom, type Sample } from "../../lib/spring.js";

export interface NavScreen {
  /** 稳定键。同一个键推两次 = 同一页 */
  key: string;
  /** 导航条中间那行小字（滚上去之后大标题交给它） */
  title: string;
  /** 返回按钮上的文字 = 上一页叫什么。缺省「返回」 */
  backLabel?: string;
  /** 大标题；给了就在内容顶部画一遍，滚上去时交还给导航条 */
  largeTitle?: { title: string; subtitle?: ReactNode };
  /** 导航条左边。**只有根页给**——非根页那一格固定是返回 */
  leading?: ReactNode;
  /** 导航条右边 */
  trailing?: ReactNode;
  render: () => ReactNode;
}

interface NavApi {
  push: (screen: NavScreen) => void;
  pop: () => void;
  /** 栈深，根页 = 1 */
  depth: number;
}

const NavContext = createContext<NavApi | null>(null);

export function useNav(): NavApi {
  const api = useContext(NavContext);
  if (!api) throw new Error("useNav 必须在 <NavStack> 里用");
  return api;
}

/** 转场参数：临界阻尼（不过冲——这是界面转场不是甩出去的卡片），0.42s 到位 */
const TRANSITION = { response: 0.42, damping: 1 } as const;
/** 下面那页往后退多少（占容器宽度的比例）+ 压暗到多少 */
const PARALLAX = 0.24;
const DIM = 0.3;
/** 左缘多宽算「从边上开始划」 */
const EDGE_WIDTH = 26;
/** 方向判定的迟滞：走够这些像素才认定这是一次返回手势 */
const HYSTERESIS = 8;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

interface Live {
  key: string;
  spring: Spring;
  /** 正在退场（已从 stack 里摘掉，等动画跑完才卸载） */
  leaving: boolean;
}

export function NavStack({ root, className }: { root: NavScreen; className?: string }) {
  const [stack, setStack] = useState<NavScreen[]>([root]);
  const [leaving, setLeaving] = useState<NavScreen[]>([]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef(new Map<string, HTMLElement>());
  const lives = useRef(new Map<string, Live>());
  const raf = useRef<number | null>(null);
  const lastT = useRef(0);

  const rendered = useMemo(() => [...stack, ...leaving], [stack, leaving]);
  // rAF 循环从这只 ref 读栈，不从闭包读：push 的 kick 注册 tick 时还在重渲之前，
  // 闭包抓到的是推入前那一版 rendered（#1125——整段动画里新页一次都没被布局，
  // 停在画外；点第二下闭包换新才把它摆到正位）。同步发生在下面的 layout effect
  // 里，先于任何 rAF 回调。applyLayout 因此不依赖 rendered，身份稳定
  const renderedRef = useRef(rendered);

  /** 把每一页此刻的进度写进 transform。**每帧直接写 DOM**，不走 React state——
      一次转场 25 帧，25 次重渲整棵子树在这个尺寸上是看得见的卡 */
  const applyLayout = useCallback(() => {
    const width = hostRef.current?.clientWidth ?? 0;
    const list = renderedRef.current;
    list.forEach((screen, i) => {
      const el = pageEls.current.get(screen.key);
      if (!el) return;
      const p = i === 0 ? 1 : (lives.current.get(screen.key)?.spring.x ?? 0);
      el.style.transform = `translate3d(${(1 - p) * width}px,0,0)`;
      // 只有栈里有第二页时才画阴影：根页孤零零挂着一道左阴影是无中生有
      el.style.boxShadow = i > 0 && p > 0.001 ? "-14px 0 34px rgba(0,0,0,.34)" : "none";
      el.style.pointerEvents = i === list.length - 1 ? "auto" : "none";
      // 下面那页跟着往后退 + 压暗
      const below = pageEls.current.get(list[i - 1]?.key ?? "");
      if (below) {
        below.style.transform = `translate3d(${-p * width * PARALLAX}px,0,0)`;
        const dim = below.querySelector<HTMLElement>("[data-nav-dim]");
        if (dim) dim.style.opacity = String(p * DIM);
      }
    });
  }, []);

  const tick = useCallback(() => {
    const now = performance.now();
    // 掉帧封顶 34ms：切走标签页再回来时 dt 会是几秒，一大步积分会把弹簧炸出去
    const dt = Math.min(0.034, (now - lastT.current) / 1000 || 1 / 60);
    lastT.current = now;
    let busy = false;
    for (const live of lives.current.values()) {
      if (live.spring.x === live.spring.target && live.spring.v === 0) continue;
      if (!live.spring.step(dt)) busy = true;
    }
    applyLayout();
    // 退场跑完了才卸载：动画期间那一页还得在树上
    const done = [...lives.current.values()].filter((l) => l.leaving && l.spring.x === 0 && l.spring.v === 0);
    if (done.length > 0) {
      const keys = new Set(done.map((d) => d.key));
      for (const k of keys) lives.current.delete(k);
      setLeaving((prev) => prev.filter((s) => !keys.has(s.key)));
    }
    raf.current = busy ? requestAnimationFrame(tick) : null;
  }, [applyLayout]);

  const kick = useCallback(() => {
    if (raf.current !== null) return;
    lastT.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);

  // 栈的镜像。`push`/`pop` 要读「此刻栈里有什么」并同时**改两处 state + 起动画**，
  // 而这些副作用不能写在 setState 的 updater 里——StrictMode 会把 updater 跑两遍，
  // 一次返回就会推两条退场记录、起两条动画
  const stackRef = useRef(stack);
  useEffect(() => { stackRef.current = stack; }, [stack]);

  const push = useCallback((screen: NavScreen) => {
    // 同一个键推两次 = 同一页：连点两下「智能体」不该叠出两层
    if (stackRef.current.some((s) => s.key === screen.key)) return;
    const reduced = prefersReducedMotion();
    const spring = new Spring(reduced ? 1 : 0, TRANSITION);
    lives.current.set(screen.key, { key: screen.key, spring, leaving: false });
    stackRef.current = [...stackRef.current, screen];
    setStack(stackRef.current);
    if (!reduced) {
      spring.set(1);
      kick();
    }
  }, [kick]);

  const pop = useCallback(() => {
    const prev = stackRef.current;
    if (prev.length < 2) return;
    const top = prev[prev.length - 1]!;
    stackRef.current = prev.slice(0, -1);
    setStack(stackRef.current);
    const live = lives.current.get(top.key);
    if (prefersReducedMotion() || !live) {
      lives.current.delete(top.key);
      return;
    }
    live.leaving = true;
    live.spring.set(0);
    setLeaving((l) => (l.some((s) => s.key === top.key) ? l : [...l, top]));
    kick();
  }, [kick]);

  // 每次渲染后先同步栈的镜像、再重算布局：新页刚挂上（进度 0）时必须先落到画外，
  // 否则会先闪一帧在正位上。同步走 layout effect 是为了先于任何 rAF 回调（#1125）
  useLayoutEffect(() => {
    renderedRef.current = rendered;
    applyLayout();
  });

  useEffect(() => {
    const onResize = () => applyLayout();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyLayout]);

  const api = useMemo<NavApi>(() => ({ push, pop, depth: stack.length }), [push, pop, stack.length]);

  return (
    <NavContext.Provider value={api}>
      <div ref={hostRef} className={cn("relative flex-1 overflow-hidden", className)}>
        {rendered.map((screen, i) => (
          <NavPage
            key={screen.key}
            screen={screen}
            isRoot={i === 0}
            registerEl={(el) => {
              if (el) pageEls.current.set(screen.key, el);
              else pageEls.current.delete(screen.key);
            }}
            onBack={pop}
            gesture={
              i > 0 && i === rendered.length - 1
                ? { spring: lives.current.get(screen.key)?.spring ?? null, hostRef, applyLayout, kick, onCommit: pop }
                : null
            }
          />
        ))}
      </div>
    </NavContext.Provider>
  );
}

interface GestureCtx {
  spring: Spring | null;
  hostRef: React.RefObject<HTMLDivElement | null>;
  applyLayout: () => void;
  kick: () => void;
  onCommit: () => void;
}

function NavPage({
  screen, isRoot, registerEl, onBack, gesture,
}: {
  screen: NavScreen;
  isRoot: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onBack: () => void;
  gesture: GestureCtx | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const hasLarge = screen.largeTitle !== undefined;

  /** 大标题滚上去时把标题交给导航条那一行。没有大标题的页面，导航条这一行常驻 */
  const onScroll = useCallback(() => {
    const sc = scrollRef.current, t = titleRef.current, el = rootRef.current;
    if (!sc || !t || !el) return;
    const k = hasLarge ? clamp((sc.scrollTop - 4) / 26, 0, 1) : 1;
    t.style.opacity = String(k);
    t.style.transform = `translateX(-50%) translateY(${(1 - k) * 7}px)`;
    // 内容压到导航条底下时才让它显出材质与那道渐隐——没内容可压时画一条线是无中生有
    el.dataset.scrolled = sc.scrollTop > 2 ? "1" : "0";
  }, [hasLarge]);

  useLayoutEffect(() => { onScroll(); }, [onScroll]);

  // ── 左缘右划返回 ──
  const drag = useRef<{ id: number; x0: number; width: number; active: boolean; samples: Sample[] } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!gesture?.spring || drag.current) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    // 量不到宽度（还没布局 / jsdom）时整条手势不成立：0 宽度会让进度算出 Infinity
    if (rect.width <= 0) return;
    if (e.clientX - rect.left > EDGE_WIDTH) return;
    drag.current = { id: e.pointerId, x0: e.clientX, width: rect.width, active: false, samples: [] };
    // 这里**故意不**拿指针捕获——等手势成立（onPointerMove 里过了迟滞）再拿，#1137
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !gesture?.spring) return;
    let dx = e.clientX - d.x0;
    if (!d.active) {
      if (dx < HYSTERESIS) return;    // 迟滞：走够 8px 才认定这是返回，免得抢走点击
      d.active = true;
      // 捕获指针要等到**这一刻**（#1137）。在 pointerdown 就捕获的话，之后的 pointerup 被
      // 改派到这个 section，而 click 落在 pointerdown / pointerup 两个目标的公共祖先上——
      // 也是这个 section——按钮自己的 onClick 永远收不到。左缘 26px 里正好是返回按钮那枚
      // chevron，真机形态就是「点返回有时候没反应」：点箭头没反应，点「返回」两个字才有。
      // 捕获本身仍然要：手指划出这一页的边界也还跟着；拿不到就退化成「划出去即结束」，
      // 不让整条手势因此抛异常（jsdom 没实现它，老 Safari 也可能没有）
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 没有捕获也能用，只是没那么跟手 */ }
    }
    // 往左拉（越过起点）不硬停，给阻尼——硬停读作「卡住了」
    if (dx < 0) dx = -rubberband(-dx, d.width);
    const p = clamp(1 - dx / d.width, 0, 1);
    gesture.spring.jump(p);
    d.samples.push({ t: performance.now(), v: p });
    gesture.applyLayout();
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !gesture?.spring) return;
    drag.current = null;
    if (!d.active) return;
    const v = velocityFrom(d.samples);                    // 进度/秒
    // 落点按**动量投影**判，不按松手那一刻的位置：轻轻一甩也该甩得动
    const landed = gesture.spring.x + projectMomentum(v * d.width) / d.width;
    if (landed < 0.5) {
      gesture.spring.set(0, { velocity: v });             // 速度交棒，拖与动画之间没有接缝
      gesture.onCommit();
    } else {
      gesture.spring.set(1, { velocity: v });
    }
    gesture.kick();
  };

  return (
    <section
      ref={(el) => { rootRef.current = el; registerEl(el); }}
      data-scrolled="0"
      className="group/navpage absolute inset-0 flex flex-col will-change-transform"
      // 只有一页时透明——抽屉自己的材质在底下；一旦压了栈就得实底，
      // 不然下面那页会透上来（半透明叠半透明，两层都读不清）
      style={{ background: isRoot ? "transparent" : "var(--popover)" }}
      onPointerDown={gesture ? onPointerDown : undefined}
      onPointerMove={gesture ? onPointerMove : undefined}
      onPointerUp={gesture ? endDrag : undefined}
      onPointerCancel={gesture ? endDrag : undefined}
    >
      <div
        className={cn(
          "relative z-10 flex h-[46px] shrink-0 items-center gap-[6px] px-[6px]",
          // 滚动边缘效果：不是一条 1px 的线，是内容压到玻璃底下
          "group-data-[scrolled=1]/navpage:bg-popover/80 group-data-[scrolled=1]/navpage:backdrop-blur-xl",
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-[22px]",
          "after:bg-gradient-to-b after:from-popover/80 after:to-transparent after:opacity-0",
          "after:transition-opacity after:duration-150 group-data-[scrolled=1]/navpage:after:opacity-100"
        )}
      >
        {isRoot ? (
          screen.leading
        ) : (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "inline-flex h-8 items-center gap-[2px] rounded-[9px] pr-2 pl-1 text-[14px] tracking-[-0.01em] text-brand",
              "transition-[transform,background-color] duration-150 active:scale-[0.96] active:bg-foreground/[0.06]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            )}
          >
            <svg className="size-[19px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
            {screen.backLabel ?? "返回"}
          </button>
        )}
        <div
          ref={titleRef}
          className="pointer-events-none absolute left-1/2 max-w-[52%] truncate text-[14.5px] font-semibold tracking-[-0.012em]"
          style={{ transform: "translateX(-50%)", opacity: hasLarge ? 0 : 1 }}
        >
          {screen.title}
        </div>
        <div className="flex-1" />
        {screen.trailing}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scrollbar-stable min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-10"
      >
        {screen.largeTitle && (
          <div className="px-[2px] pt-[2px] pb-[14px]">
            <h1 className="text-[27px] leading-[1.1] font-[640] tracking-[-0.022em] break-words">
              {screen.largeTitle.title}
            </h1>
            {screen.largeTitle.subtitle !== undefined && (
              <div className="mt-1 text-[12.5px] text-muted-foreground">{screen.largeTitle.subtitle}</div>
            )}
          </div>
        )}
        {screen.render()}
      </div>

      {/* 被压在下面时的那层暗：不是装饰，它是「这一页此刻不是主角」的唯一信号 */}
      <div data-nav-dim aria-hidden className="pointer-events-none absolute inset-0 z-20 bg-black opacity-0" />
    </section>
  );
}
