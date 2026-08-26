import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { displacementMapUri, filterIdFromReactId } from "@/lib/liquidGlass.js";

/**
 * 液态玻璃卡片（做法参考 rdev/liquid-glass-react，实现是本仓自己的）。
 *
 * 一张玻璃在这里由三件事凑成，缺一件就退回"半透明白块"：
 *   1. **折射**——`backdrop-filter: url(#filter)`，靠 feDisplacementMap 把背后的画面
 *      在四边推歪（贴图见 lib/liquidGlass.ts）。这是"像玻璃"的唯一来源。
 *   2. **模糊 + 饱和**——背后安静下来，正文才读得清。
 *   3. **高光边**——一圈内投影，模拟光打在玻璃的倒角上。没有它，玻璃没有厚度。
 *
 * 材质本身全在 CSS（app.css 的 `.liquid-glass`），这里只负责两件 CSS 干不了的事：
 * 量出真实尺寸，和把对应的滤镜挂上去。**尺寸必须真量**：贴图被拉伸的话，
 * 圆角处的折射会跟着拉成椭圆，一个胶囊形的状态条上尤其明显。
 *
 * 只在 Chromium 上成立（`backdrop-filter` 吃 `url()` 滤镜是 Chromium 的能力）——
 * 本仓是 Electron，这是已知前提，不是赌运气。不支持时整条 backdrop-filter 被丢掉，
 * 剩下底色和高光边，仍然是一张能读的卡片。
 */
export function LiquidGlass({
  radius = 16,
  edge = 8,
  mapBlur = 5,
  strength = 24,
  className,
  children,
  style,
  ...rest
}: {
  /** 圆角（px）。要和 className 里的圆角对上，否则折射带跟卡片边缘错位 */
  radius?: number;
  /** 边缘折射带的厚度（px） */
  edge?: number;
  /** 折射带的柔化半径（px） */
  mapBlur?: number;
  /** 折射强度（px）：背后的画面在边缘最多被推这么远 */
  strength?: number;
} & ComponentProps<"div">) {
  const filterId = filterIdFromReactId(useId());
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // ResizeObserver 而不是量一次：状态条的文案会变（"思考中…" → "执行中…"），
    // 宽度跟着变，贴图不重算就会落在旧尺寸上
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.contentRect;
      setSize((prev) =>
        // 四舍五入后没变就不 setState：滚动时的亚像素抖动会变成每帧一次重渲染
        Math.round(prev.width) === Math.round(box.width) &&
        Math.round(prev.height) === Math.round(box.height)
          ? prev
          : { width: box.width, height: box.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = size.width > 1 && size.height > 1;
  const map = ready
    ? displacementMapUri({ width: size.width, height: size.height, radius, edge, blur: mapBlur })
    : null;

  return (
    <div
      ref={ref}
      className={cn("liquid-glass", className)}
      style={{
        borderRadius: radius,
        // 折射走 CSS 变量而不是直接写 backdrop-filter：材质的最终配方留在 app.css 里，
        // 「降低透明度」偏好那条 media query 才盖得住（内联样式优先级压过类）
        ...(map ? { ["--lg-refract" as string]: `url(#${filterId})` } : null),
        ...style,
      }}
      {...rest}
    >
      {map ? (
        <svg aria-hidden className="pointer-events-none absolute size-0" focusable="false">
          <defs>
            {/* userSpaceOnUse + 显式 x/y/width/height：backdrop-filter 下滤镜区域按元素
                自身坐标算，用默认的 objectBoundingBox 会把区域算到背景图上去 */}
            <filter
              id={filterId}
              filterUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={size.width}
              height={size.height}
              colorInterpolationFilters="sRGB"
            >
              <feImage
                href={map}
                x="0"
                y="0"
                width={size.width}
                height={size.height}
                preserveAspectRatio="none"
                result="map"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale={strength}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      ) : null}
      {children}
    </div>
  );
}
