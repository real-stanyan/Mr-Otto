// wx/ui —— 桌面微信式布局（#1386）的几样小零件：列表那一行、通讯录的入口格、可折叠的一段、
// 角标、搜索框、主区头部、空着的主区。版式照 `.demo/wechat/desktop.src.html`（维护者看过的那一版），
// 颜色一律走主题令牌（背景 = --background、列表 = --sidebar、选中 = --accent），不另起一套。
//
// 两条手感纪律（同 ui/inset-list 的头注）：一列行里用**高亮**不用缩放（某一行忽然缩小会打断
// 整列的基线）；独立的按钮反过来，按下去缩一点（`active:scale`）。

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { badgeText } from "../../../shared/wechatInbox.js";

/** 32px 的幽灵图标钮 */
export function WxIconButton({
  title,
  onClick,
  children,
  className,
  disabled,
  active,
  ...rest
}: {
  title: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** 此刻开着它管的那样东西（抽屉 / 面板） */
  active?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick" | "children">) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground",
        "transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.05] hover:text-foreground active:scale-[0.94]",
        "disabled:pointer-events-none disabled:opacity-35",
        active && "bg-foreground/[0.06] text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 角标：条数（99+）或一枚点。**不是红色**：这个 app 里红只用来说「出事了」（DESIGN.md），
    有新消息不是出事——点缀色，同手机那一份（mobile/src/wx/Badge.tsx）。`ring` 取它底下那块的颜色，压住边缘 */
export function WxBadge({
  count,
  dot,
  className,
  ringClass = "ring-sidebar",
}: {
  count?: number;
  dot?: boolean;
  className?: string;
  ringClass?: string;
}) {
  if (dot) {
    return <span aria-hidden className={cn("absolute -top-[3px] -right-[3px] size-2.5 rounded-full bg-brand ring-2", ringClass, className)} />;
  }
  if (count === undefined || count <= 0) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -top-1.5 -right-[7px] z-[1] h-[18px] min-w-[18px] rounded-full bg-brand px-[5px] text-center text-[11px] leading-[18px] font-semibold text-white tabular-nums ring-2",
        ringClass,
        className,
      )}
    >
      {badgeText(count)}
    </span>
  );
}

/** 列表头那格搜索框 */
export function WxSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-foreground/[0.055] px-2 text-muted-foreground transition-shadow duration-150 focus-within:ring-2 focus-within:ring-brand/35">
      <Search className="size-[15px] shrink-0" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.preventDefault();
            onChange("");
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

/** 会话列表的一行：头像（带角标）· 名字 + 时刻 · 第二行 */
export function WxChatRow({
  avatar,
  badge,
  name,
  time,
  preview,
  current,
  onClick,
  title,
}: {
  avatar: ReactNode;
  badge?: ReactNode;
  name: ReactNode;
  time: string;
  preview: ReactNode;
  current: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      {...(title === undefined ? {} : { title })}
      className={cn(
        "group/row relative flex h-[66px] w-full items-center gap-[11px] px-3.5 text-left transition-colors duration-100",
        current ? "bg-accent text-accent-foreground" : "hover:bg-foreground/[0.045]",
      )}
    >
      <span className="relative grid shrink-0">
        {avatar}
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{name}</span>
          {time !== "" && (
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{time}</span>
          )}
        </span>
        <span className="truncate text-[12.5px] text-muted-foreground">{preview}</span>
      </span>
    </button>
  );
}

/** 通讯录 / 我 那一列的入口格：方块图标 + 一个词 + 右边一格（数、值、角标） */
export function WxEntryRow({
  icon,
  label,
  right,
  current,
  onClick,
  tall = false,
}: {
  icon: ReactNode;
  label: ReactNode;
  right?: ReactNode;
  current: boolean;
  onClick: () => void;
  tall?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      className={cn(
        "relative flex w-full items-center gap-[11px] px-3.5 text-left transition-colors duration-100",
        tall ? "h-[66px]" : "h-14",
        current ? "bg-accent text-accent-foreground" : "hover:bg-foreground/[0.045]",
      )}
    >
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&>svg]:size-[18px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{label}</span>
      {right !== undefined && right !== null && <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{right}</span>}
    </button>
  );
}

/** 一段的小标题（「它们共用的一台电脑」「其他」） */
export function WxListLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** 可折叠的一段（通讯录的「智能体」「朋友」）。搜索时一律展开：折着的一段里有命中，人是找不到的 */
export function WxFold({
  label,
  count,
  action,
  forceOpen,
  children,
}: {
  label: string;
  count: number;
  action?: ReactNode;
  forceOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const shown = forceOpen || open;
  return (
    <div>
      <div className="flex items-center gap-1 px-2.5 pt-3 pb-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={shown}
          className="flex flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-200", !shown && "-rotate-90")}
            aria-hidden
          />
          <span>{label}</span>
          <span className="font-normal tabular-nums">{count}</span>
        </button>
        {action}
      </div>
      {shown && children}
    </div>
  );
}

/** 主区头部（58px）：窄窗时左边一颗返回；整条是拖窗口的地方（按钮自动 no-drag） */
export function WxPaneHeader({
  onBack,
  children,
  actions,
  bare = false,
}: {
  onBack?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  /** 资料页那种「头部只有一颗返回」：宽窗时整条不占地方 */
  bare?: boolean;
}) {
  return (
    <header
      className={cn(
        "drag-region flex h-[58px] shrink-0 items-center gap-2 pr-3.5 pl-6",
        bare ? "max-[560px]:flex hidden border-0" : "border-b border-foreground/[0.07]",
        "max-[760px]:pl-4",
      )}
    >
      {onBack !== undefined && (
        <WxIconButton title="返回" onClick={onBack} className="-ml-2 hidden max-[560px]:grid">
          <ChevronLeft className="size-5" aria-hidden />
        </WxIconButton>
      )}
      {children}
      <span className="flex-1" />
      {actions}
    </header>
  );
}

/** 主区什么都没开时：一张淡淡的脸 + MR OTTO。不写「请从左边选一条」——人一眼就知道 */
export function WxEmptyPane({ face }: { face: ReactNode }) {
  return (
    <div className="drag-region grid flex-1 place-items-center">
      <div className="flex flex-col items-center gap-2.5 opacity-55">
        <span className="opacity-80">{face}</span>
        <span className="text-[12px] tracking-[0.04em] text-foreground/40">MR OTTO</span>
      </div>
    </div>
  );
}
