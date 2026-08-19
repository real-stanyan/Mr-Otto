// SectionRail — 会话分区目录的竖轨。
// 改自 react-bits LineSidebar（MIT）。保留：单条 rAF 循环 + 帧率无关的指数平滑，
// 颜色/位移/刻度缩放同步移动，不用一堆 CSS transition 各跑各的。
// 三处改动（设计出处 docs/superpowers/specs/2026-08-19-conversation-sections-design.md）：
// ① activeIndex 受控——亮哪条由滚动位置决定，不是点击驱动的内部 state
// ② 收起态只亮当前分区标题，其余只剩刻度线；轨宽全程不变（hover 不让消息栏重排）
// ③ prefers-reduced-motion 下关掉位移，只保留颜色

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

const PROXIMITY_RADIUS = 90;  // px：指针的影响半径
const MAX_SHIFT = 8;          // px：文字最大右移
const MARKER_LENGTH = 24;     // px：刻度线长度
const MARKER_GAP = 10;        // px：刻度线到文字的距离
const SMOOTHING_MS = 100;     // 指数平滑的时间常数
/** 标题淡入用的强 ease-out。CSS 内置那几档太软，没有"立刻响应"的手感 */
const REVEAL_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** smoothstep：比线性更像物理 */
const ease = (p: number) => p * p * (3 - 2 * p);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface SectionRailProps {
  items: string[];
  /** 当前所在分区；null = 还没滚进任何分区 */
  activeIndex: number | null;
  onJump: (index: number) => void;
}

export function SectionRail({ items, activeIndex, onJump }: SectionRailProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const targets = useRef<number[]>([]);
  const current = useRef<number[]>([]);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const activeRef = useRef<number | null>(activeIndex);
  const [hovered, setHovered] = useState(false);

  activeRef.current = activeIndex;

  // 单条 rAF：每个 item 的 --effect 朝目标做帧率无关的指数逼近。
  // 全部效果都读这一个变量 → 颜色、位移、刻度缩放永远同步，不会互相错拍
  const frame = useCallback((now: number) => {
    const dt = Math.min((now - last.current) / 1000, 0.05);
    last.current = now;
    const k = 1 - Math.exp(-dt / (SMOOTHING_MS / 1000));
    let moving = false;
    itemRefs.current.forEach((el, i) => {
      if (!el) return;
      const target = Math.max(targets.current[i] ?? 0, activeRef.current === i ? 1 : 0);
      const cur = current.current[i] ?? 0;
      const next = cur + (target - cur) * k;
      const settled = Math.abs(target - next) < 0.0015;
      const value = settled ? target : next;
      current.current[i] = value;
      el.style.setProperty("--effect", value.toFixed(4));
      if (!settled) moving = true;
    });
    raf.current = moving ? requestAnimationFrame(frame) : null;
  }, []);

  const start = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    last.current = performance.now();
    raf.current = requestAnimationFrame(frame);
  }, [frame]);

  // 触屏点一下会派发 pointerenter 并把轨永久卡在展开态（没有 leave）——
  // 临近效果本来就只对真实指针有意义，两处都只认 mouse
  const onPointerEnter = useCallback((e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") setHovered(true);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLUListElement>) => {
      if (e.pointerType !== "mouse") return;
      if (reducedMotion()) return; // 减动效：不做临近效果，颜色仍跟 active 走
      const list = listRef.current;
      if (!list) return;
      const y = e.clientY - list.getBoundingClientRect().top;
      itemRefs.current.forEach((el, i) => {
        if (!el) return;
        const center = el.offsetTop + el.offsetHeight / 2;
        targets.current[i] = ease(Math.max(0, 1 - Math.abs(y - center) / PROXIMITY_RADIUS));
      });
      start();
    },
    [start]
  );

  const onPointerLeave = useCallback(() => {
    setHovered(false);
    targets.current = targets.current.map(() => 0);
    start();
  }, [start]);

  useEffect(() => { start(); }, [activeIndex, start]);
  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  return (
    <nav
      aria-label="会话分区"
      // 宽度写死：收起/展开都是这个宽度，hover 只改文字透明度——
      // 轨一变宽消息栏就得重排，那一下抖动比目录本身还显眼
      className="hidden lg:block shrink-0 w-[184px] self-start sticky top-0 max-h-full overflow-y-auto py-4 pr-4"
      style={
        {
          "--max-shift": `${MAX_SHIFT}px`,
          paddingLeft: `${MARKER_LENGTH + MARKER_GAP}px`,
        } as CSSProperties
      }
    >
      <ul
        ref={listRef}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        className="m-0 flex list-none flex-col gap-[18px] p-0"
      >
        {items.map((label, i) => (
          <li
            key={`${label}-${i}`}
            ref={(el) => { itemRefs.current[i] = el; }}
            aria-current={activeIndex === i ? "true" : undefined}
            onClick={() => onJump(i)}
            title={label}
            // 按下时整条压暗一点：可点的东西必须对按压有反应，
            // 但这是一行文字不是按钮，用不着 scale
            className="relative cursor-pointer active:opacity-70"
          >
            <span
              aria-hidden
              className="absolute top-1/2 h-px origin-left [background-color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*100%),var(--border))] [transform:translateY(-50%)_scaleX(calc(0.7+var(--effect,0)*0.5))]"
              style={{ left: `-${MARKER_LENGTH + MARKER_GAP}px`, width: `${MARKER_LENGTH}px` }}
            />
            <span
              className="block truncate text-[11px] leading-[1.35] duration-200 [transition-property:opacity] [color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*100%),var(--muted-foreground))] [transform:translateX(calc(var(--effect,0)*var(--max-shift)))]"
              // 收起态只有当前分区的标题看得见；其余留在原位但透明——
              // 用 opacity 不用 display:none，布局才不会跟着 hover 跳
              style={{ opacity: hovered || activeIndex === i ? 1 : 0, transitionTimingFunction: REVEAL_EASE }}
            >
              {label}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
