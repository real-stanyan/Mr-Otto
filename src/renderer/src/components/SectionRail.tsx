// SectionRail — 会话分区目录。正文列左侧留白里的一小撮紧凑刻度堆，悬停才弹卡片。
//
// 三版形态，每一版都是被上一版的毛病逼出来的（设计出处
// docs/superpowers/specs/2026-08-19-conversation-sections-design.md）：
// ① 常驻 184px 竖栏 → 等距刻度在撒谎、离内容太远、偶尔用一次的东西占了一条常驻长条
// ② 右缘浮层 + 按滚动比例定位 → 映射诚实了，但玻璃面板大得离谱、贴着滚动条、
//    每条标题一枚常驻胶囊仍然是一片长期占着视线的文字
// ③（现在）左侧留白里的紧凑刻度堆 —— 默认状态屏幕上一个字都没有，只有一小撮短横线
//
// 等距排列会丢掉「刻度位置 = 内容位置」那层映射，所以**位置信息换成体量信息**：
// 刻度宽度 ∝ 分区的事件条数（deriveSections 的 eventCount）。映射照样诚实，而且紧凑。
//
// 上一版那套 rAF 临近效果这里删掉了：12px 的行距上做"指针附近变亮"只会让邻居一起糊，
// 而离散的悬停卡片本来就把"你指的是哪一条"说得很清楚。颜色交给 150ms 的 CSS 过渡。

import { useCallback, useState, type CSSProperties, type PointerEvent } from "react";

const PITCH = 12;        // px：刻度行距（紧凑成簇，不沿滚动区散开）
const TICK_LEFT = 6;     // px：刻度左端离轨左缘
const TICK_MIN = 12;     // px：最短刻度——下限保证再小的分区也看得见
const TICK_MAX = 36;     // px：最长刻度——上限保证它横不穿留白
const HIT_WIDTH = TICK_LEFT + TICK_MAX + 8;
const CARD_LEFT = TICK_LEFT + TICK_MAX + 14; // px：卡片贴在刻度右侧
const CARD_WIDTH = 240;
/** 只用于底边夹紧的保守上界（卡片标题一行 + 预览三行 + 内边距），不是实际高度 */
const CARD_MAX_H = 104;
/** 卡片锚点：刻度落在卡片上沿往下这么多——transform-origin 就钉在这里，
    卡片是"从那条刻度上长出来"的，不是从自己的中心缩放出来的 */
const ORIGIN_Y = 14;
const EDGE_PAD = 8;      // px：卡片离容器上下边的最小距离
const NAV_WIDTH = CARD_LEFT + CARD_WIDTH;

export interface SectionRailItem {
  title: string;
  /** 正文预览（deriveSections 已压平空白并截断），可能是空串 */
  preview: string;
  /** 分区体量：事件条数。刻度宽度按它编码 */
  weight: number;
}

export interface SectionRailProps {
  items: SectionRailItem[];
  /** 当前所在分区；null = 还没滚进任何分区 */
  activeIndex: number | null;
  onJump: (index: number) => void;
}

/** 体量 → 刻度宽度。按最大值归一化，宽度真的正比于体量；MIN 只是可见性下限 */
function tickWidth(weight: number, max: number): number {
  if (max <= 0) return TICK_MIN;
  return TICK_MIN + (TICK_MAX - TICK_MIN) * Math.min(1, Math.max(0, weight / max));
}

export function SectionRail({ items, activeIndex, onJump }: SectionRailProps) {
  // hovered = 现在指着哪一条；lastHovered = 卡片该显示谁。
  // 分开存是为了让离场动画有内容可演：指针移开只把 hovered 清掉，
  // 卡片留在原地按同一条路径缩回去，不需要任何计时器
  const [hovered, setHovered] = useState<number | null>(null);
  const [lastHovered, setLastHovered] = useState<number | null>(null);

  // 触屏点一下会派发 pointerenter 却没有配对的 leave，卡片会永久卡在屏幕上
  const onEnter = useCallback((e: PointerEvent<HTMLLIElement>, i: number) => {
    if (e.pointerType !== "mouse") return;
    setHovered(i);
    setLastHovered(i);
  }, []);

  const maxWeight = items.reduce((m, it) => Math.max(m, it.weight), 0);

  // 刻度堆的高度：正常就是 n × 行距，但分区多到撑破视口时按比例压扁，
  // 而不是让头尾几条滑出屏幕外。等距关系不变，只是行距变密
  const stackHeight = `min(${items.length * PITCH}px, 70%)`;

  /** 第 i 条刻度在刻度堆里的相对位置（0–1 中点） */
  const fraction = (i: number) => (i + 0.5) / items.length;

  /** 卡片上沿：钉在刻度上（ORIGIN_Y 就是 transform-origin 的 y），
      再用 clamp 夹住上下边——靠近容器边缘的刻度不该把卡片切掉 */
  const cardTop = (i: number) => {
    const k = fraction(i) - 0.5;
    const anchor = `calc(50% ${k < 0 ? "-" : "+"} ${Math.abs(k).toFixed(4)} * ${stackHeight} - ${ORIGIN_Y}px)`;
    return `clamp(${EDGE_PAD}px, ${anchor}, calc(100% - ${CARD_MAX_H + EDGE_PAD}px))`;
  };

  const card = lastHovered === null ? null : items[lastHovered];

  return (
    <nav
      aria-label="会话分区"
      // absolute = 零布局宽度。整簇垂直居中、随视口固定，不跟着内容滚
      // （轨挂在滚动元素外面）。整块 pointer-events-none，只有刻度行自己打开
      className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden lg:block"
      style={{ width: `${NAV_WIDTH}px` }}
    >
      <ul
        className="absolute left-0 top-1/2 m-0 list-none p-0 [transform:translateY(-50%)]"
        style={{ width: `${HIT_WIDTH}px`, height: stackHeight }}
        onPointerLeave={() => setHovered(null)}
      >
        {items.map((item, i) => (
          <li
            key={`${item.title}-${i}`}
            aria-current={activeIndex === i ? "true" : undefined}
            onPointerEnter={(e) => onEnter(e, i)}
            onClick={() => onJump(i)}
            className="pointer-events-auto absolute inset-x-0 cursor-pointer [transform:translateY(-50%)]"
            style={{ top: `${(fraction(i) * 100).toFixed(3)}%`, height: `${PITCH}px` }}
          >
            {/* 屏幕上只有横线，读屏器上得有字：地标里不能全是没名字的刻度 */}
            <span className="sr-only">{item.title}</span>
            <span
              aria-hidden
              data-active={activeIndex === i ? "true" : "false"}
              data-hovered={hovered === i ? "true" : "false"}
              className="section-rail-tick absolute top-1/2 h-[2px] rounded-full"
              style={{
                left: `${TICK_LEFT}px`,
                width: `${tickWidth(item.weight, maxWeight).toFixed(1)}px`,
              }}
            />
          </li>
        ))}
      </ul>

      {/* 卡片常驻挂载（只在有过悬停之后），靠 data-visible 进退——
          两端同一条路径，也就不需要任何离场计时器 */}
      {card && lastHovered !== null && (
        <div
          aria-hidden
          data-visible={hovered !== null ? "true" : "false"}
          className="section-rail-card pointer-events-none absolute rounded-lg border border-border/50 px-3 py-2.5"
          style={
            {
              left: `${CARD_LEFT}px`,
              width: `${CARD_WIDTH}px`,
              top: cardTop(lastHovered),
              transformOrigin: `left ${ORIGIN_Y}px`,
              // 悬停的正好是当前分区时标题带主色。只混到 65%：深色主题下
              // --brand(#0071e3) 压在玻璃底上只有 3:1，12px 的字读不动
              "--card-accent": lastHovered === activeIndex ? "1" : "0",
            } as CSSProperties
          }
        >
          {/* 标题限一行：卡片高度得可预测，上面那个 clamp 才夹得准 */}
          <div className="truncate text-[12px] font-semibold leading-[1.35] [color:color-mix(in_srgb,var(--brand)_calc(var(--card-accent,0)*65%),var(--foreground))]">
            {card.title}
          </div>
          {card.preview !== "" && (
            // 压在正文上的字要比普通 muted 更实：--muted-foreground 只有 56%，
            // 11px 压在半透明玻璃上就到读不动的边缘了
            <p className="mt-1 line-clamp-3 text-[11px] leading-[1.5] [color:color-mix(in_srgb,var(--foreground)_72%,transparent)]">
              {card.preview}
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
