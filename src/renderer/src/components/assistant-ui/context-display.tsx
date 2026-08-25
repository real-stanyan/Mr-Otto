"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { cn } from "@/lib/utils.js";

// 本仓改动(registry 升级时人工合的依据):上游从 @assistant-ui/react-ai-sdk 取
// useThreadTokenUsage + ThreadTokenUsage。本仓不装 AI SDK —— 用量是事件日志的投影
// (shared/contextEstimate.ts 的 contextBreakdown),不是某个 SDK 的运行时状态。
// 好在上游的 ContextDisplayRoot 本来就有一条"外面把 usage 传进来"的分支,传了就
// 根本不会调那个 hook;于是这里:① 类型改成本地声明 ② 删掉只为调 hook 而存在的
// ContextDisplayRootInternal ③ usage 从可选改成必填(本仓永远算得出来)。
// 要恢复 AI SDK 那条路:装回包,把 hook 分支加回来即可
export type ThreadTokenUsage = {
  totalTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
};
import {
  createContext,
  useContext,
  useMemo,
  type FC,
  type ReactNode,
} from "react";

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
};

const getUsagePercent = (
  totalTokens: number | undefined,
  modelContextWindow: number,
): number => {
  if (!totalTokens) return 0;
  return Math.min((totalTokens / modelContextWindow) * 100, 100);
};

type UsageSeverity = "normal" | "warning" | "critical";

// 本仓改动:阈值和配色都换成 Mr Otto 自己的一套。
// 阈值 90/75 沿用被本组件替掉的那个环(App.tsx 原 CtxRing);
// 颜色从 stroke-red-500 / stroke-amber-500 / stroke-foreground 换成主题变量
// deny / warn / brand —— 那三个是全仓统一的语义色(审批拒绝、告警、主角),
// 写死 Tailwind 调色板会让这一个控件的红和别处的红不是同一个红
const getUsageSeverity = (percent: number): UsageSeverity => {
  if (percent > 90) return "critical";
  if (percent > 75) return "warning";
  return "normal";
};

const getStrokeColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "stroke-deny";
  if (severity === "warning") return "stroke-warn";
  return "stroke-brand";
};

const getBarColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "bg-deny";
  if (severity === "warning") return "bg-warn";
  return "bg-brand";
};

type ContextDisplayContextValue = {
  usage: ThreadTokenUsage | undefined;
  totalTokens: number;
  percent: number;
  modelContextWindow: number;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(
  null,
);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) {
    throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  }
  return ctx;
}

type PresetProps = {
  modelContextWindow: number;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** 本仓改动:同 ContextDisplayRootProps.usage */
  usage: ThreadTokenUsage;
};

type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  /** 本仓改动:从可选改成必填 —— 用量是事件日志的投影,调用方永远算得出来 */
  usage: ThreadTokenUsage;
};

// 本仓改动:上游这里有一整套 tokenState 状态机 —— 记住 threadListItem.id,
// 换线程就清零,并且"rawTokens 为 0 时保留上一次的值"。它是为 AI SDK 那条数据线
// 存在的:流式过程中 useThreadTokenUsage 会短暂报 0,不粘住就会闪回零。
// 本仓的 usage 是事件日志的纯投影(shared/contextEstimate.ts),不会中途变 0,
// 也不需要认线程 —— 换会话时 events 整个换掉,算出来的就是新会话的数。
// 于是整套状态机连同它对 useAuiState(s => s.threadListItem.id) 的依赖一起删掉:
// 留着不但是死重量,还给这个组件平添一个"必须挂在 thread list 作用域里"的前提
function ContextDisplayRootBase({
  modelContextWindow,
  children,
  usage,
}: {
  modelContextWindow: number;
  children: ReactNode;
  usage: ThreadTokenUsage | undefined;
}) {
  const totalTokens = usage?.totalTokens ?? 0;
  const percent = getUsagePercent(totalTokens, modelContextWindow);

  const contextValue = useMemo(
    () => ({ usage, totalTokens, percent, modelContextWindow }),
    [usage, totalTokens, percent, modelContextWindow],
  );

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      <TooltipProvider>
        <Tooltip>{children}</Tooltip>
      </TooltipProvider>
    </ContextDisplayContext.Provider>
  );
}

// 本仓改动:usage 必填,Root 直接就是 Base(上游那层"没传 usage 就去问 AI SDK"的
// 分发没有第二条路可分了)
function ContextDisplayRoot(props: ContextDisplayRootProps) {
  return (
    <ContextDisplayRootBase
      modelContextWindow={props.modelContextWindow}
      usage={props.usage}
    >
      {props.children}
    </ContextDisplayRootBase>
  );
}

function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <TooltipTrigger asChild>
      <button
        type="button"
        data-slot="context-display-trigger"
        className={cn(
          "inline-flex items-center rounded-md transition-colors",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </TooltipTrigger>
  );
}

type ContextSegment = {
  label: string;
  tokens: number;
};

const getContextSegments = (
  usage: ThreadTokenUsage | undefined,
): ContextSegment[] => {
  if (!usage) return [];
  return [
    { label: "Input", tokens: usage.inputTokens ?? 0 },
    { label: "Cached input", tokens: usage.cachedInputTokens ?? 0 },
    { label: "Output", tokens: usage.outputTokens ?? 0 },
    { label: "Reasoning", tokens: usage.reasoningTokens ?? 0 },
  ].filter((segment) => segment.tokens > 0);
};

function ContextDisplayContent({
  side = "top",
  className,
}: {
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const { usage, totalTokens, percent, modelContextWindow } =
    useContextDisplay();
  const segments = getContextSegments(usage);

  return (
    <TooltipContent
      side={side}
      sideOffset={8}
      data-slot="context-display-popover"
      arrow={false}
      className={cn(
        "bg-popover text-popover-foreground w-56 rounded-lg border p-3 text-left",
        className,
      )}
    >
      <div className="text-xs">
        <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
          <span className="font-medium">Context usage</span>
          <span className="text-muted-foreground tabular-nums">
            {formatTokenCount(Math.min(totalTokens, modelContextWindow))} of{" "}
            {formatTokenCount(modelContextWindow)}
          </span>
        </div>
        <div className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full w-(--usage-width) rounded-full transition-[width] duration-300",
              totalTokens > 0 && "min-w-1",
              getBarColor(percent),
            )}
            style={{ "--usage-width": `${percent}%` } as React.CSSProperties}
          />
        </div>
        {segments.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            {segments.map((segment) => (
              <div
                key={segment.label}
                className="flex items-baseline justify-between gap-6"
              >
                <span className="text-muted-foreground">{segment.label}</span>
                <span className="tabular-nums">
                  {formatTokenCount(segment.tokens)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </TooltipContent>
  );
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingVisual() {
  const { percent } = useContextDisplay();

  return (
    <svg
      aria-hidden="true"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-muted"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={
          RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE
        }
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          getStrokeColor(percent),
        )}
      />
    </svg>
  );
}

function RingPercentLabel() {
  const { percent } = useContextDisplay();
  return <span className="font-mono tabular-nums">{Math.round(percent)}%</span>;
}

const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage}>
    <ContextDisplayTrigger
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs",
        className,
      )}
      aria-label="Context usage"
    >
      <RingVisual />
      <RingPercentLabel />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function BarVisual() {
  const { percent, totalTokens } = useContextDisplay();

  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            getBarColor(percent),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[10px] tabular-nums">
        {formatTokenCount(totalTokens)} ({Math.round(percent)}%)
      </span>
    </div>
  );
}

const ContextDisplayBar: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage}>
    <ContextDisplayTrigger
      className={cn("px-2 py-1", className)}
      aria-label="Context usage"
    >
      <BarVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function TextVisual() {
  const { totalTokens, modelContextWindow } = useContextDisplay();

  return (
    <>
      {formatTokenCount(totalTokens)} / {formatTokenCount(modelContextWindow)}
    </>
  );
}

const ContextDisplayText: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage}>
    <ContextDisplayTrigger
      aria-label="Context usage"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground px-2 py-1 font-mono text-xs tabular-nums",
        className,
      )}
    >
      <TextVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

const ContextDisplay = {} as {
  Root: typeof ContextDisplayRoot;
  Trigger: typeof ContextDisplayTrigger;
  Content: typeof ContextDisplayContent;
  Ring: typeof ContextDisplayRing;
  Bar: typeof ContextDisplayBar;
  Text: typeof ContextDisplayText;
};

ContextDisplay.Root = ContextDisplayRoot;
ContextDisplay.Trigger = ContextDisplayTrigger;
ContextDisplay.Content = ContextDisplayContent;
ContextDisplay.Ring = ContextDisplayRing;
ContextDisplay.Bar = ContextDisplayBar;
ContextDisplay.Text = ContextDisplayText;

// 本仓改动:多导一个 RingVisual。上游只导出 Ring 预设(Root+Trigger+环+Content 打包),
// 而本仓要的是"上游的环 + 本仓的内容":内容那半边显示的是**上下文构成**
// (系统提示词/工具/对话消息 + 压缩次数,shared/contextEstimate.ts 的投影),
// 与上游 Content 显示的"上一次请求的 usage 分项"是两码事,换不得
export { RingVisual as ContextDisplayRingVisual };

export {
  ContextDisplay,
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayContent,
  ContextDisplayRing,
  ContextDisplayBar,
  ContextDisplayText,
};

