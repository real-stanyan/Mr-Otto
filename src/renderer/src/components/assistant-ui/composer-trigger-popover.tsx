"use client";

import { memo, useRef, type ComponentPropsWithoutRef, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { ChevronLeftIcon, ChevronRightIcon, SparklesIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/lib/utils.js";

type IconComponent = FC<{ className?: string }>;

/**
 * 本仓改动:条目可以是「一个人」而不是「一条指令」(issue #831)。
 *
 * 判据放在 item.metadata 上,跟上游既有的 `metadata.icon` 同一个路子 —— 由
 * adapter(数据那头)决定这一行长什么样,组件不认识"好友"这个概念,也就不用
 * 为第二种 trigger 再开一个组件。三个键都是可选的,`$skill` / `/指令` 一个
 * 都不给,渲染逐字节不变。
 *
 * - `avatar`     有这个键 = 人行:最左那格从图标换成头像(空串也算,走首字母兜底)
 * - `avatarLabel` 头像的 alt 与首字母兜底取自它(显示名),不从 label 猜 ——
 *                label 带着 sigil(`@张三`),按字符剥前缀在中文名上会剥过头
 * - `trailing`   贴右边缘的那格(好友这里是邮箱)。它和 description 的区别不是
 *                样式而是职责:description 是"这条是干什么的",trailing 是
 *                "这条到底是谁" —— 后者要能一眼扫一列,所以必须靠右对齐
 */
function personBits(item: Unstable_TriggerItem): {
  avatar: string | undefined;
  avatarLabel: string;
  trailing: string | undefined;
} {
  const m = item.metadata;
  const avatar = typeof m?.avatar === "string" ? m.avatar : undefined;
  const avatarLabel = typeof m?.avatarLabel === "string" ? m.avatarLabel : item.label;
  const trailing =
    typeof m?.trailing === "string" && m.trailing !== "" ? m.trailing : undefined;
  return { avatar, avatarLabel, trailing };
}

type DirectiveBehaviorProps = {
  /** Formatter used to serialize the selected item into composer text. */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Called after the directive text has been inserted into the composer. */
  onInserted?: ((item: Unstable_TriggerItem) => void) | undefined;
};

type ActionBehaviorProps = {
  /** Formatter used to serialize the audit-trail chip (when `removeOnExecute` is false). */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Invoked with the selected item at the moment of selection. */
  onExecute: (item: Unstable_TriggerItem) => void;
  /** If `true`, strip the trigger text from the composer after executing. @default false */
  removeOnExecute?: boolean | undefined;
};

type ComposerTriggerPopoverBaseProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover>,
  "children"
> & {
  /**
   * Maps icon keys to components. Items look up via `item.metadata?.icon`
   * (string); categories look up via their `id`.
   */
  iconMap?: Record<string, IconComponent>;
  /** Fallback icon when no entry in `iconMap` matches. */
  fallbackIcon?: IconComponent;
  /** Label shown on the back button. @default "Back" */
  backLabel?: string;
  /** Label shown when no categories are available. @default "No items available" */
  emptyCategoriesLabel?: string;
  /** Label shown when no items match. @default "No matching items" */
  emptyItemsLabel?: string;
  /** Label shown while an async adapter is resolving items. @default "Loading…" */
  loadingLabel?: string;
};

type ComposerTriggerPopoverProps = ComposerTriggerPopoverBaseProps &
  (
    | {
        /** Insert-directive behavior. */
        directive: DirectiveBehaviorProps;
        action?: never;
      }
    | {
        /** Action behavior. */
        action: ActionBehaviorProps;
        directive?: never;
      }
  );

function resolveIcon(
  iconKey: string | undefined,
  iconMap: Record<string, IconComponent> | undefined,
  fallback: IconComponent,
): IconComponent {
  if (iconKey && iconMap?.[iconKey]) return iconMap[iconKey]!;
  return fallback;
}

type CategoriesProps = {
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  emptyLabel: string;
};

const Categories: FC<CategoriesProps> = ({
  iconMap,
  fallbackIcon,
  emptyLabel,
}) => (
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => (
      <div
        data-slot="composer-trigger-popover-categories"
        className="flex flex-col py-1"
      >
        {categories.map((cat) => {
          const Icon = resolveIcon(cat.id, iconMap, fallbackIcon);
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
              className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm transition-colors outline-none"
            >
              <span className="flex items-center gap-2">
                <Icon className="text-muted-foreground size-4" />
                {cat.label}
              </span>
              <ChevronRightIcon className="text-muted-foreground size-4" />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          );
        })}
        {categories.length === 0 && (
          <div className="text-muted-foreground px-3 py-2 text-sm">
            {emptyLabel}
          </div>
        )}
      </div>
    )}
  </ComposerPrimitive.Unstable_TriggerPopoverCategories>
);

type ItemsProps = {
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  backLabel: string;
  emptyLabel: string;
  loadingLabel: string;
};

const Items: FC<ItemsProps> = ({
  iconMap,
  fallbackIcon,
  backLabel,
  emptyLabel,
  loadingLabel,
}) => {
  const { isLoading } = unstable_useTriggerPopoverScopeContext();
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items) => (
        <div
          data-slot="composer-trigger-popover-items"
          className="flex flex-col gap-0.5"
        >
          <ComposerPrimitive.Unstable_TriggerPopoverBack className="text-muted-foreground hover:bg-accent flex cursor-pointer items-center gap-1.5 border-b px-3 py-2 text-xs tracking-wide uppercase transition-colors">
            <ChevronLeftIcon className="size-3.5" />
            {backLabel}
          </ComposerPrimitive.Unstable_TriggerPopoverBack>

          <div className="flex flex-col gap-0.5">
            {items.map((item, index) => {
              const iconKey =
                typeof item.metadata?.icon === "string"
                  ? item.metadata.icon
                  : undefined;
              const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
              const { avatar, avatarLabel, trailing } = personBits(item);
              return (
                // 本仓改动:一条一行(图标 · 名字 · 描述 · ↵),版式照
                // elements/composer 的 ComposerMenuItem —— 输入框上方弹出的菜单
                // 在本仓有两个(这个 + element 那套),长得不一样就像两个东西。
                // 上游是两行(名字一行、描述折行在下),一屏放不下三条
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  className="group/item data-[highlighted]:bg-foreground/[0.06] hover:bg-foreground/[0.04] flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-start text-[13.5px] transition-colors outline-none"
                >
                  {avatar === undefined ? (
                    <Icon className="text-foreground/35 size-3.5 shrink-0" />
                  ) : (
                    // 头像挤在图标那一格里(20px):行高不变,只是"是谁"从一枚
                    // 所有人共用的闪光换成了这个人的脸
                    <Avatar className="size-5">
                      <AvatarImage src={avatar} alt={avatarLabel} referrerPolicy="no-referrer" />
                      <AvatarFallback className="text-[10px]">
                        {avatarLabel.charAt(0).toUpperCase() || "?"}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  {/* 名字:没有靠右那格时照旧不缩(长 skill 名整条读得到);
                      有的话得让位 —— 两边都 shrink-0 的话行会顶破弹层 */}
                  <span
                    className={cn(
                      "font-medium",
                      trailing === undefined ? "shrink-0" : "min-w-0 truncate"
                    )}
                  >
                    {item.label}
                  </span>
                  {item.description && (
                    // 描述截成一行:skill 的 description 常有三五行,
                    // 整段摊开的话补全菜单变成了阅读材料
                    <span className="text-foreground/45 min-w-0 flex-1 truncate text-xs">
                      {item.description}
                    </span>
                  )}
                  {trailing && (
                    // 贴右边缘(ms-auto):一列扫下来对齐,而不是跟着名字长短漂。
                    // 放不下就截,原文进 title —— 邮箱截断了还能悬停看全
                    <span
                      className="text-foreground/45 ms-auto min-w-0 truncate text-xs"
                      title={trailing}
                    >
                      {trailing}
                    </span>
                  )}
                  {/* 选中那条才出现的回车提示:告诉人"现在按回车选的是这一条"。
                      靠右那格已经把剩余空间吃掉了,这里再来一个 ms-auto 会跟它
                      对半分 —— 于是邮箱一被高亮就往左跳一下。有 trailing 就不加 */}
                  <kbd
                    className={cn(
                      "bg-foreground/[0.06] text-foreground/45 hidden shrink-0 rounded px-1 font-mono text-[10px] group-data-[highlighted]/item:inline",
                      trailing === undefined && "ms-auto"
                    )}
                  >
                    ↵
                  </kbd>
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              );
            })}
            {items.length === 0 && (
              <div className="text-foreground/40 px-2.5 py-2 text-[13.5px]">
                {isLoading ? loadingLabel : emptyLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
};

/**
 * Pre-built popover UI for a trigger-driven picker (mentions, slash commands, etc).
 * Pass exactly one of `directive` (inserts a chip) or `action` (fires a handler).
 */
const ComposerTriggerPopoverImpl: FC<ComposerTriggerPopoverProps> = ({
  iconMap,
  fallbackIcon = SparklesIcon,
  backLabel = "Back",
  emptyCategoriesLabel = "No items available",
  emptyItemsLabel = "No matching items",
  loadingLabel = "Loading…",
  className,
  directive,
  action,
  ...props
}) => {
  const warnedRef = useRef(false);
  if (
    process.env.NODE_ENV !== "production" &&
    !warnedRef.current &&
    Boolean(directive) === Boolean(action)
  ) {
    warnedRef.current = true;
    console.warn(
      "[assistant-ui] ComposerTriggerPopover requires exactly one of `directive` or `action` props.",
    );
  }

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      data-slot="composer-trigger-popover"
      className={cn(
        "aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 bottom-full z-50 mb-2 w-64 overflow-hidden rounded-xl border",
        className,
      )}
      {...props}
    >
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive
          formatter={directive.formatter ?? unstable_defaultDirectiveFormatter}
          onInserted={directive.onInserted}
        />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action
          formatter={action.formatter ?? unstable_defaultDirectiveFormatter}
          onExecute={action.onExecute}
          removeOnExecute={action.removeOnExecute}
        />
      ) : null}
      <Categories
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        emptyLabel={emptyCategoriesLabel}
      />
      <Items
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        backLabel={backLabel}
        emptyLabel={emptyItemsLabel}
        loadingLabel={loadingLabel}
      />
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
ComposerTriggerPopoverImpl.displayName = "ComposerTriggerPopover";

export const ComposerTriggerPopover = memo(
  ComposerTriggerPopoverImpl,
) as FC<ComposerTriggerPopoverProps>;

