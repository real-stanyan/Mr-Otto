// SectionRail — 会话分区目录。悬浮在消息滚动区右缘的半透明轨，**不占任何布局宽度**。
//
// 前一版是一条常驻 184px 的竖栏，设计评审毙掉了，三条理由（详见
// docs/superpowers/specs/2026-08-19-conversation-sections-design.md 的「UI」一节）：
// ① 刻度等距 = 撒谎。分区长短差好几倍，等距的几何在宣称一个不存在的关系。
//    控件的形状必须映射它所控制的东西 —— 所以现在刻度按分区在内容里的真实位置摆。
// ② 邻近性断了。目录离它索引的内容几百像素远，没有任何东西把标题连回某条消息。
//    所以现在它压在内容右缘上，内容从它底下穿过去。
// ③ 偶尔用一次的东西不配一条常驻长条。常驻装饰应该是内容穿行其下的半透明层。
//
// 展开态**不是一张面板**：每条标题各自一枚宽度随字走的贴边小胶囊，胶囊之间毫无表面。
// 中途做过一张横跨全高的玻璃面板，评审毙掉，三条：两行字撑一整块玻璃（尺寸和内容量对不上）、
// 大面积 backdrop-filter 把背后的蓝气泡放大成两坨光斑、左缘一条硬边把正文拦腰切断。
// 没 hover 也没滚动时，屏幕上一个表面都不存在，只剩刻度。
//
// 保留自 react-bits LineSidebar（MIT）：单条 rAF 循环 + 帧率无关的指数平滑，
// 颜色读 --effect、几何读 --motion，减动效时只把 --motion 归零（可读性不是动效）。
//
// 组件是纯展示件：只收「比例」不收事件/分区/store。位置怎么算是 App 的事。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";

const RAIL_WIDTH = 180; // px：展开态命中区/胶囊排布的宽度（没有一张同宽的表面）
// 收起态命中带宽度。20 = 消息区的 px-5，正好贴着正文右缘外侧收住：
// 再宽一点就会盖住每行最后几个字，选中/点击都被这条看不见的带子截走
const STRIP_WIDTH = 20;
const PROXIMITY_RADIUS = 90; // px：指针的影响半径
const MAX_SHIFT = 8; // px：文字最大位移
const ROW_HEIGHT = 16; // px：一行的命中高度
const EDGE_PAD = 10; // px：首尾刻度离轨端的最小距离（保证整根刻度在屏内）
const SMOOTHING_MS = 100; // 指数平滑的时间常数
const SCROLL_IDLE_MS = 1200; // 滚动停下多久后收起
const FLASH_HOLD_MS = 1200; // 换区提示停留时长
const FLASH_EXIT_MS = 240; // 换区提示退场时长（要 ≥ CSS 里的过渡时长）

/** smoothstep：比线性更像物理 */
const ease = (p: number) => p * p * (3 - 2 * p);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface SectionRailProps {
  items: string[];
  /**
   * 每条分区起点在可滚动内容里的位置比例（0–1），与 items 同序等长。
   * 这是本组件唯一的几何输入 —— 刻度按它摆，而不是按下标等分。
   */
  offsets: number[];
  /** 当前所在分区；null = 还没滚进任何分区 */
  activeIndex: number | null;
  onJump: (index: number) => void;
  /**
   * 消息滚动容器。轨要在「用户正在滚」的时候自己浮现，
   * 走 prop 传计数器会让每一帧滚动都触发 App 重渲染，代价太大，
   * 所以直接拿元素挂一个 passive 监听 —— 仍然不碰事件/分区/store。
   */
  scrollRef: RefObject<HTMLElement | null>;
}

export function SectionRail({ items, offsets, activeIndex, onJump, scrollRef }: SectionRailProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const targets = useRef<number[]>([]);
  const current = useRef<number[]>([]);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const activeRef = useRef<number | null>(activeIndex);
  /** 指针在轨上 = 用户要操作它（命中区放宽到整条轨） */
  const [hovered, setHovered] = useState(false);
  /** 正在滚动 = 用户要「我在哪」（只浮现，不抢内容的点击） */
  const [scrolling, setScrolling] = useState(false);
  /** 收起态换区时闪一下的标题；leaving = 正在退场 */
  const [flash, setFlash] = useState<{ index: number; leaving: boolean } | null>(null);

  activeRef.current = activeIndex;
  const expanded = hovered || scrolling;

  // ——— 临近效果（沿用旧版）———
  // 单条 rAF：每个 item 的 --effect 朝目标做帧率无关的指数逼近。
  // reduced 每帧现读（不缓存在模块级常量）：这是活的系统设置，运行中可能被用户改掉
  const frame = useCallback((now: number) => {
    const dt = Math.min((now - last.current) / 1000, 0.05);
    last.current = now;
    const k = 1 - Math.exp(-dt / (SMOOTHING_MS / 1000));
    const reduced = reducedMotion();
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
      el.style.setProperty("--motion", reduced ? "0" : value.toFixed(4));
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
    (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return;
      if (reducedMotion()) return; // 减动效：不做临近效果，颜色仍跟 active 走
      const list = listRef.current;
      if (!list) return;
      const y = e.clientY - list.getBoundingClientRect().top;
      itemRefs.current.forEach((el, i) => {
        if (!el) return;
        // 行盒 top 定位 + translateY(-50%)，所以视觉中心正好落在 offsetTop 上
        targets.current[i] = ease(Math.max(0, 1 - Math.abs(y - el.offsetTop) / PROXIMITY_RADIUS));
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

  useEffect(() => {
    start();
  }, [activeIndex, start]);
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  // ——— 滚动触发的浮现 ———
  // setState 只在 false→true 那一下发生（用 ref 挡住重复），idle 计时器每次滚动重置
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let live = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (!live) {
        live = true;
        setScrolling(true);
      }
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        live = false;
        setScrolling(false);
      }, SCROLL_IDLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer != null) clearTimeout(timer);
    };
  }, [scrollRef]);

  // ——— 换区提示 ———
  // 20px 的收起带塞不下文字，旧版「当前分区标题常驻」没法照搬。
  // 换成瞬时反馈：换区时在带子旁边把新标题闪一下就走。
  // null→n 不算换区（那是首次落位，不是用户走到了新的一段），不闪。
  const prevActive = useRef<number | null>(activeIndex);
  useEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activeIndex;
    // 滚回顶部会让 activeIndex 退回 null。此时上一轮的计时器已被清掉，
    // 不顺手把提示收走它就永远挂在那儿了
    if (activeIndex === null) {
      setFlash(null);
      return;
    }
    if (prev === null || prev === activeIndex) return;
    setFlash({ index: activeIndex, leaving: false });
    const hold = setTimeout(() => {
      setFlash((f) => (f && f.index === activeIndex ? { index: activeIndex, leaving: true } : f));
    }, FLASH_HOLD_MS);
    const gone = setTimeout(() => {
      setFlash((f) => (f && f.index === activeIndex ? null : f));
    }, FLASH_HOLD_MS + FLASH_EXIT_MS);
    // 卸载/再次换区都要把两个计时器收干净，不留悬空的 setState
    return () => {
      clearTimeout(hold);
      clearTimeout(gone);
    };
  }, [activeIndex]);

  /** 比例 → CSS top。clamp 保证首尾刻度整根都在轨内，不被切掉半根 */
  const topOf = (i: number) => {
    const r = Math.min(1, Math.max(0, offsets[i] ?? 0));
    return `clamp(${EDGE_PAD}px, ${(r * 100).toFixed(3)}%, calc(100% - ${EDGE_PAD}px))`;
  };

  const flashLabel = flash ? items[flash.index] : undefined;

  return (
    <nav
      aria-label="会话分区"
      // absolute = 零布局宽度：消息区仍是满宽，内容从轨底下穿过去。
      // right 让开 11px 的滚动条槽，免得刻度和滚动条挤在一起。
      // 整块 pointer-events-none，只有命中带自己打开——收起时轨不该拦住内容的点击
      className="pointer-events-none absolute inset-y-0 right-[11px] z-20 hidden lg:block"
      style={{ width: `${RAIL_WIDTH}px`, "--max-shift": `${MAX_SHIFT}px` } as CSSProperties}
    >
      {/* 刻度带和正文之间的过渡：一层很窄的渐变遮罩，常驻。
          不是"表面"——它从全透明起步，只是把贴边那几像素安静下来 */}
      <div aria-hidden className="section-rail-edge pointer-events-none absolute inset-y-0 right-0 w-[28px]" />

      {/* 命中带：收起 20px（只够摸到刻度），指针进来后放宽到整条轨。
          注意宽度只跟 hovered 走、不跟 expanded 走：滚动触发的浮现是「告诉你在哪」，
          不该顺手把内容的点击也接管了 */}
      <div
        className="pointer-events-auto absolute inset-y-0 right-0"
        style={{ width: `${hovered ? RAIL_WIDTH : STRIP_WIDTH}px` }}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <ul
          ref={listRef}
          data-expanded={expanded ? "true" : "false"}
          className="section-rail-list absolute inset-y-0 right-0 m-0 list-none p-0"
          style={{ width: `${RAIL_WIDTH}px` }}
        >
          {items.map((label, i) => (
            <li
              key={`${label}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              aria-current={activeIndex === i ? "true" : undefined}
              onClick={() => onJump(i)}
              title={label}
              // 收起时整行不可命中：行盒有 180px 宽，漏出去就会挡住底下的消息
              className={`absolute right-0 w-full ${
                hovered ? "pointer-events-auto cursor-pointer active:opacity-70" : "pointer-events-none"
              }`}
              style={{ top: topOf(i), height: `${ROW_HEIGHT}px`, transform: "translateY(-50%)" }}
            >
              <span
                aria-hidden
                // 刻度：颜色走 --effect（当前分区 = brand），长度走 --motion。
                // 减动效时 --motion 归零，长度差由 app.css 里的静态兜底规则补上——
                // 收起态没有文字，「我在哪」全靠这根刻度的颜色 + 长度
                data-active={activeIndex === i ? "true" : "false"}
                className="section-rail-tick absolute top-1/2 right-0 h-[2px] w-[10px] origin-right rounded-full [background-color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*100%),var(--border))] [transform:translateY(-50%)_scaleX(calc(1+var(--motion,0)*0.8))]"
              />
              <span
                // 标题只在展开态出现，而且各自是一枚宽度随字走的小胶囊——
                // 没有横跨全高的面板，胶囊之间不留任何表面。
                // 压在正文上，所以比普通 muted 文字更实：foreground 打底 + 500 字重。
                // 主色只混到 65%：深色主题下 --brand(#0071e3) 压在玻璃底上只有 3:1，
                // 11px 的字读不动——刻度是 2px 的图形可以用纯主色，文字不行
                className="section-rail-chip section-rail-title absolute top-1/2 right-[24px] max-w-[150px] truncate rounded-md border border-border/50 px-2 py-[2px] text-[11px] font-medium leading-[1.4] [color:color-mix(in_srgb,var(--brand)_calc(var(--effect,0)*65%),var(--foreground))]"
              >
                {label}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* 收起态的换区提示，和展开态的标题是同一种胶囊。展开时不渲染——
          标题都摆出来了，再飘一个小标签就是两个东西抢同一件事 */}
      {flashLabel !== undefined && flash && !expanded && (
        <div
          aria-hidden
          data-leaving={flash.leaving ? "true" : "false"}
          className="section-rail-chip section-rail-flash pointer-events-none absolute right-[24px] max-w-[150px] truncate rounded-md border border-border/50 px-2 py-[2px] text-[11px] font-medium leading-[1.4] text-foreground"
          style={{ top: topOf(flash.index) }}
        >
          {flashLabel}
        </div>
      )}
    </nav>
  );
}
