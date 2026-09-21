// AgentFace / PartyAvatar —— 头像那一格的两个组件（#1345，ADR-0314）。
//
// `AgentFace` 只画内置的像素脸；`PartyAvatar` 是三选一的那一格（脸 / 真图 / 首字母），
// 绝大多数调用点用后者 —— 「这一格画什么」的判断在 `lib/agentAvatar.ts` 算好，
// 这里只负责把它画出来。
//
// **动不动由状态自己说，不另给一个开关**（`faceAnimates`，states.ts 的头注）：
// 名册与各种选人弹层传 `plain`，于是它们**由构造**就是静止的一帧 —— 不靠每个调用点
// 记得传 `animate={false}`。会动的只有「此刻正在看的那只」：聊天头部与通话里那几格。
//
// `prefers-reduced-motion` 下一律退回静止一帧（不是「慢一点」）。它与 `devicePixelRatio`
// 都是 effect 跑的那一下读的，不订阅变化 —— 中途改系统设置要下一次重绘才跟上（与
// ui/nav-stack.tsx 的取舍一致）；dpr 那条的表现更明显：把窗口从 Retina 拖到外接屏时
// 后备分辨率还停在旧的那一档，**像素画会糊**，等这一格因为别的原因重绘才恢复。

import { useEffect, useRef, type ComponentProps } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/lib/utils.js";
import { faceAnimates, paintFace, sizeFaceCanvas, type FaceState } from "../lib/ottoFace/index.js";
import type { AvatarRef } from "../lib/agentAvatar.js";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** 剩下的原样落到 canvas 上（调用点要挂的 `data-*` / `title` 走这里）。
    自己算的那几格（尺寸 / 无障碍 / data-face）排在 `{...rest}` 后面，改不掉 */
type FaceOwnProps = {
  /** 0..12，见 lib/agentAvatar.ts */
  slot: number;
  /** 缺省 `plain` = **我们不知道它此刻在干嘛**（不是「空闲」），不画角标也不动 */
  state?: FaceState;
  /** css 边长（px）。canvas 的实际像素按 dpr 放大 */
  size: number;
  className?: string;
  /** 给读屏的一句话。不给就是 `aria-hidden` —— 名字几乎总在旁边，念两遍是噪音 */
  label?: string;
  /** 宽高交给外面的 CSS（`size-full`），`size` 只当作画多少像素的上限。
      给那一格宽度本来就由容器决定的地方用（头像选择器、那张 `aspect-square` 的预览） */
  fill?: boolean;
};

export function AgentFace({
  slot,
  state = "plain",
  size,
  className,
  label,
  fill = false,
  ...rest
}: FaceOwnProps &
  Omit<
    ComponentProps<"canvas">,
    "ref" | "slot" | "className" | "style" | "width" | "height" | "role" | "aria-label" | "aria-hidden"
  >) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (cv === null) return;
    sizeFaceCanvas(cv, size, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    if (!faceAnimates(state) || prefersReducedMotion()) {
      paintFace(cv, slot, state, 0);
      return;
    }
    // 各自一条 rAF。会动的那几格总共不过个位数（聊天头部 1 格、通话最多 6 格），
    // 而各态的图案都是**绝对时刻**的函数，所以它们天然同步、不需要一口共用的钟
    let raf = 0;
    const tick = (): void => {
      paintFace(cv, slot, state, performance.now());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [slot, state, size]);

  return (
    <canvas
      {...rest}
      ref={ref}
      data-face={slot}
      data-face-state={state}
      {...(fill ? {} : { style: { width: size, height: size } })}
      className={cn("shrink-0 rounded-full [image-rendering:pixelated]", fill && "size-full", className)}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    />
  );
}

/**
 * 一格头像：内置像素脸 / 一张真图 / 什么都查不到时的首字母。
 *
 * 三条路各自的理由在 `lib/agentAvatar.ts` 的 `AvatarRef`。这里唯一要说的是
 * **`null` 画的是首字母不是一张空图**：画空图那一格会塌成一个白圈，看起来像加载失败。
 */
export function PartyAvatar({
  avatar,
  name,
  size,
  state,
  className,
  faceClassName,
  fallbackClassName,
  label,
}: {
  avatar: AvatarRef;
  /** 取首字母用；也是 `label` 缺席时读屏念的那个 */
  name: string;
  size: number;
  /** 只对 `kind: "face"` 有意义 */
  state?: FaceState;
  /** 加在外层（真图 / 首字母那两档是 Avatar，脸那档是 canvas 自己） */
  className?: string;
  /** 只加在脸那一档上（脸不走 Avatar，圆角 / ring 得直接落在 canvas 上） */
  faceClassName?: string;
  /** 只加在首字母那一档上。深色浮层上的那一格要自己的底色与字色 */
  fallbackClassName?: string;
  label?: string;
}) {
  if (avatar !== null && avatar.kind === "face") {
    return (
      <AgentFace
        slot={avatar.slot}
        {...(state === undefined ? {} : { state })}
        size={size}
        className={cn(className, faceClassName)}
        {...(label === undefined ? {} : { label })}
      />
    );
  }
  return (
    <Avatar className={className} style={{ width: size, height: size }}>
      {avatar !== null && <AvatarImage src={avatar.src} alt={label ?? ""} />}
      <AvatarFallback className={fallbackClassName} style={{ fontSize: Math.round(size * 0.42) }}>
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  );
}
