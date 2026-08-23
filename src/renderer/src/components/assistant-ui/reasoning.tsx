"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  useScrollLock,
  useAuiState,
  type ReasoningMessagePartComponent,
  type ReasoningGroupComponent,
} from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/lib/utils.js";

const ANIMATION_DURATION = 200;

const ReasoningPreviewContext = createContext(false);

/**
 * 顶上那道渐变只在「上面真的还有被卷走的内容」时才画。
 * 原来是无条件画的：展开后还没滚动时，那 32px 的
 * linear-gradient(background → transparent) 正好压在第一段字上，看着像糊了一层。
 * 底下那道不动——预览态内容钉在底部，它是给最新一行做的软收边，跟滚动位置无关。
 */
const ReasoningScrolledContext = createContext<((scrolled: boolean) => void) | null>(null);

const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border px-3 py-2",
      ghost: "",
      muted: "bg-muted/50 rounded-lg px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /**
     * Whether the reasoning is currently streaming. While `true` the
     * disclosure is held open with a bottom-pinned live preview; when
     * streaming ends it returns to `defaultOpen`, and the first manual
     * toggle takes over the open/close state permanently. The live preview
     * keeps following the newest tokens while the disclosure is open during
     * streaming, even after a manual toggle, and pauses while the reader is
     * scrolled up.
     */
    streaming?: boolean;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  children,
  ...props
}: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const initialOpenRef = useRef(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled
    ? controlledOpen
    : (userOpen ?? (streaming || initialOpenRef.current));
  const isPreview = streaming === true && isOpen;

  const prevStreamingRef = useRef(streaming);
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return;
    prevStreamingRef.current = streaming;
    // A streaming transition only animates the panel when the resting state
    // is collapsed; with `defaultOpen` the disclosure stays open across it.
    if (!isControlled && userOpen === null && !initialOpenRef.current) {
      lockScroll();
    }
  }, [streaming, isControlled, userOpen, lockScroll]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUserOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root",
        reasoningVariants({ variant, className }),
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cn(
          "aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8",
          "bg-[linear-gradient(to_bottom,var(--color-background),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
          "transition-opacity duration-(--animation-duration) ease-strong starting:opacity-0",
          className,
        )}
        {...props}
      />
    );
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
        "bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
        "transition-opacity duration-(--animation-duration) ease-strong starting:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function ReasoningTrigger({
  active,
  duration,
  label,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
  /** 本仓加的:整段折叠头文案覆盖,优先于 duration 拼出的默认 "Reasoning (Xs)"。
      Otto 要复刻旧版"思考 823 字 · 1.2s"这种字数+耗时格式(见 lib/thinkingLabel.ts),
      duration 只会拼英文秒数,满足不了这个格式 —— 用 label 整体换掉。见 OttoThread.tsx */
  label?: string;
}) {
  const durationText = duration ? ` (${duration}s)` : "";
  const text = label ?? `Reasoning${durationText}`;

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] ease-strong active:scale-[0.98]",
        className,
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper relative inline-block leading-none tabular-nums"
      >
        <span>{text}</span>
        {active ? (
          <span
            aria-hidden
            data-slot="reasoning-trigger-shimmer"
            className="aui-reasoning-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {text}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          "aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-strong motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);
  const [scrolled, setScrolled] = useState(false);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-strong motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:[animation-fill-mode:forwards]",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <ReasoningFade side="top" className={scrolled ? "opacity-100" : "opacity-0"} />
      <ReasoningScrolledContext.Provider value={setScrolled}>{children}</ReasoningScrolledContext.Provider>
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reportScrolled = useContext(ReasoningScrolledContext);

  // 滚动、内容长高、展开动画改可视高度，三种都可能改变「上面还有没有内容」
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || !reportScrolled) return;
    const measure = () => reportScrolled(scrollEl.scrollTop > 1);
    measure();
    scrollEl.addEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(contentEl);
    observer.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [reportScrolled]);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => {
      if (!pinned) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is user intent.
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true;
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false;
      }
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-64 overflow-y-auto ps-6 pt-2 pb-2 leading-relaxed text-pretty",
        "transform-gpu ease-strong motion-reduce:animate-none",
        "group-data-open/collapsible-content:animate-content-reveal-in",
        "group-data-closed/collapsible-content:animate-content-reveal-out",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <div ref={contentRef} className="aui-reasoning-text-content space-y-4">
        {children}
      </div>
    </div>
  );
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const ReasoningGroupImpl: ReasoningGroupComponent = ({
  children,
  startIndex,
  endIndex,
}) => {
  const isReasoningStreaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    for (let index = startIndex; index <= endIndex; index++) {
      if (s.message.parts[index]?.status.type === "running") return true;
    }
    return false;
  });

  return (
    <ReasoningRoot streaming={isReasoningStreaming}>
      <ReasoningTrigger active={isReasoningStreaming} />
      <ReasoningContent aria-busy={isReasoningStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

const Reasoning = memo(
  ReasoningImpl,
) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
  Fade: typeof ReasoningFade;
};

Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

/**
 * @deprecated This wrapper targets the legacy `components.ReasoningGroup`
 * prop on `<MessagePrimitive.Parts>`. Use `<MessagePrimitive.GroupedParts>`
 * with a `groupBy` returning `"group-reasoning"` and compose `ReasoningRoot`
 * / `ReasoningTrigger` / `ReasoningContent` / `ReasoningText` directly.
 * See `thread.tsx` for an example.
 */
const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";

export {
  Reasoning,
  ReasoningGroup,
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
};
