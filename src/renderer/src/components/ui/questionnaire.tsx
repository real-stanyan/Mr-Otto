// Questionnaire — 多步问卷（单选/多选/自填/可跳过）。
//
// 形状照 shadcn/ui 的 Questionnaire（ui.shadcn.com/docs/components/base/questionnaire）：
// 同名的 14 个零件、同样的 items + onSubmit 契约。为什么是手写而不是
// `shadcn add questionnaire`：该条目文档已发布但注册表尚未上线（2026-08，
// r/styles/new-york-v4/questionnaire.json 一律 404），CLI 装不下来；
// 而它的 Base UI 变体会给仓库引进第二套 primitive（现有全是 radix-ui）。
// 于是按文档的 API 自己实现，将来注册表上线可以原地替换，调用方不用改。
//
// 交互取舍：
//   · 数字键 1-4 直接选，Enter 进下一题/交卷——问卷是打断流程的东西，越快答完越好
//   · 单选选中即翻页（少一次点击），但最后一题不翻——交卷得是个明确动作
//   · 多选永远要显式推进：不然点第二项时题目已经跑了
//   · 步骤切换只做淡入，不做位移：它可能被键盘连按触发，位移会让人晕

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { Button } from "./button.js";
import { cn } from "@/lib/utils.js";

/** 一道题的配置。name 是答案表的 key；multiple = 多选；required = 不许跳过 */
export interface QuestionnaireItemConfig {
  name: string;
  required?: boolean;
  multiple?: boolean;
}

/** 交卷结果：每题 name → { selected, custom }。跳过的题 selected 为空数组 */
export interface QuestionnaireValue {
  selected: string[];
  custom: string;
}

export type QuestionnaireValues = Record<string, QuestionnaireValue>;

interface QuestionnaireContextValue {
  items: QuestionnaireItemConfig[];
  step: number;
  values: QuestionnaireValues;
  error: string | null;
  current: QuestionnaireItemConfig | undefined;
  isLast: boolean;
  choose(name: string, value: string, multiple: boolean): void;
  setCustom(name: string, text: string): void;
  advance(): void;
  /** Choice 挂载时登记自己的数字快捷键，卸载时撤销 */
  registerShortcut(name: string, shortcut: number, value: string): () => void;
  back(): void;
  skip(): void;
  submit(): void;
}

const Ctx = createContext<QuestionnaireContextValue | null>(null);

function useQuestionnaire(): QuestionnaireContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Questionnaire 的零件必须放在 <Questionnaire> 里面");
  return ctx;
}

/** 当前题的身份。Item 往下传，Choice/Input 从这拿 name */
const ItemCtx = createContext<QuestionnaireItemConfig | null>(null);

function useItem(): QuestionnaireItemConfig {
  const item = useContext(ItemCtx);
  if (!item) throw new Error("这个零件必须放在 <QuestionnaireItem> 里面");
  return item;
}

const EMPTY: QuestionnaireValue = { selected: [], custom: "" };

function answered(v: QuestionnaireValue | undefined): boolean {
  return !!v && (v.selected.length > 0 || v.custom.trim().length > 0);
}

export function Questionnaire({
  items,
  onSubmit,
  className,
  children,
}: {
  items: QuestionnaireItemConfig[];
  onSubmit: (values: QuestionnaireValues) => void;
  className?: string;
  children: ReactNode;
}) {
  const [step, setStep] = useState(0);
  // 数字键 → 选项值的活登记簿。用 ref 不用 state：它只在键盘事件里被读，
  // 变了不需要重渲染（放 state 会让每个 Choice 挂载都刷一次全表）
  const shortcuts = useRef(new Map<string, string>());
  const [values, setValues] = useState<QuestionnaireValues>({});
  const [error, setError] = useState<string | null>(null);

  const current = items[step];
  const isLast = step === items.length - 1;

  const finish = useCallback(
    (final: QuestionnaireValues) => {
      // 没碰过的题也要出现在结果里（空答案 = 跳过），下游才不用猜"缺 key 是什么意思"
      onSubmit(Object.fromEntries(items.map((i) => [i.name, final[i.name] ?? EMPTY])));
    },
    [items, onSubmit]
  );

  const stepForward = useCallback(
    (next: QuestionnaireValues) => {
      setError(null);
      if (isLast) finish(next);
      else setStep((s) => s + 1);
    },
    [finish, isLast]
  );

  const ctx = useMemo<QuestionnaireContextValue>(() => {
    const guard = (): QuestionnaireValues | null => {
      if (!current) return null;
      const v = values[current.name];
      if (current.required && !answered(v)) {
        setError("这题得选一个再往下走");
        return null;
      }
      return values;
    };
    return {
      items,
      step,
      values,
      error,
      current,
      isLast,
      choose(name, value, multiple) {
        setError(null);
        const old = values[name] ?? EMPTY;
        const selected = multiple
          ? old.selected.includes(value)
            ? old.selected.filter((v) => v !== value)
            : [...old.selected, value]
          : [value];
        const next = { ...values, [name]: { ...old, selected } };
        setValues(next);
        // 单选选中即翻页：少一次点击。三条限制——
        //   多选不行：点第二项时题目已经跑了
        //   最后一题不行：手一抖就把整份卷交了，得留一步反悔（显式点提交）
        //   推进只能在这算好 next 之后同步做，不能塞进 setValues 的 updater：
        //     updater 必须是纯函数，StrictMode 下会跑两遍，塞进去就翻两页
        if (!multiple && !isLast) stepForward(next);
      },
      setCustom(name, text) {
        setError(null);
        setValues((prev) => ({ ...prev, [name]: { ...(prev[name] ?? EMPTY), custom: text } }));
      },
      registerShortcut(name, shortcut, value) {
        const key = `${name}:${shortcut}`;
        shortcuts.current.set(key, value);
        return () => shortcuts.current.delete(key);
      },
      advance() {
        const ok = guard();
        if (ok) stepForward(ok);
      },
      back() {
        setError(null);
        setStep((s) => Math.max(0, s - 1));
      },
      skip() {
        if (!current) return;
        setError(null);
        const next = { ...values, [current.name]: EMPTY };
        setValues(next);
        stepForward(next);
      },
      submit() {
        const ok = guard();
        if (ok) finish(ok);
      },
    };
  }, [current, error, finish, isLast, items, step, stepForward, values]);

  // 键盘直达：数字键选项、Enter 推进。输入框里打字时让位——
  // 自填的 "1" 是内容不是命令，自填的 Enter 归输入框
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      ctx.advance();
      return;
    }
    if (!current || !/^[1-9]$/.test(e.key)) return;
    const value = shortcuts.current.get(`${current.name}:${e.key}`);
    if (value === undefined) return;
    e.preventDefault();
    ctx.choose(current.name, value, current.multiple === true);
  };

  // 卡片一出现就接管键盘：此刻整条管线正停着等人回答，数字键/Enter 才用得上。
  // 不抢焦点的话，用户得先点一下卡片，那"键盘直达"就名存实亡
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  return (
    <Ctx.Provider value={ctx}>
      <div
        ref={rootRef}
        className={cn("flex flex-col gap-3 outline-none", className)}
        role="group"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** 进度。只有一题时不出现——「1/1」是纯噪音 */
export function QuestionnaireProgress({ className }: { className?: string }) {
  const { items, step } = useQuestionnaire();
  if (items.length < 2) return null;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {items.map((item, i) => (
        <span
          key={item.name}
          className={cn(
            "h-[3px] flex-1 rounded-full transition-colors duration-200",
            i < step ? "bg-primary/45" : i === step ? "bg-primary" : "bg-border"
          )}
        />
      ))}
      <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
        {step + 1}/{items.length}
      </span>
    </div>
  );
}

/** 一道题。只有轮到它才渲染——多步问卷一次只见一屏 */
export function QuestionnaireItem({
  name,
  required,
  multiple,
  className,
  children,
}: QuestionnaireItemConfig & { className?: string; children: ReactNode }) {
  const { current } = useQuestionnaire();
  const config = useMemo(
    () => ({ name, ...(required ? { required } : {}), ...(multiple ? { multiple } : {}) }),
    [multiple, name, required]
  );
  if (current?.name !== name) return null;
  return (
    <ItemCtx.Provider value={config}>
      {/* key 换 = 重挂载 = starting 样式重放。只淡入不位移（可能被连按触发） */}
      <div
        key={name}
        className={cn(
          "flex flex-col gap-2 transition-opacity duration-150 ease-strong starting:opacity-0",
          className
        )}
      >
        {children}
      </div>
    </ItemCtx.Provider>
  );
}

export function QuestionnaireTitle({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <h3 className={cn("text-[15px] leading-snug font-medium text-foreground", className)}>
      {children}
    </h3>
  );
}

export function QuestionnaireDescription({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <p className={cn("text-[12.5px] leading-relaxed text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function QuestionnaireChoices({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { multiple } = useItem();
  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      role={multiple ? "group" : "radiogroup"}
    >
      {children}
    </div>
  );
}

export function QuestionnaireChoice({
  value,
  shortcut,
  className,
  children,
}: {
  value: string;
  /** 数字快捷键（1-4）。给了就显示并绑定 */
  shortcut?: number;
  className?: string;
  children: ReactNode;
}) {
  const { values, choose, registerShortcut } = useQuestionnaire();
  const item = useItem();
  const multiple = item.multiple === true;
  const checked = (values[item.name] ?? EMPTY).selected.includes(value);

  useEffect(() => {
    if (shortcut === undefined) return;
    return registerShortcut(item.name, shortcut, value);
  }, [item.name, registerShortcut, shortcut, value]);

  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={checked}
      data-checked={checked || undefined}
      onClick={() => choose(item.name, value, multiple)}
      onKeyDown={(e) => {
        // Enter 交给外层推进；空格才是"选中这一项"
        if (e.key === " ") {
          e.preventDefault();
          choose(item.name, value, multiple);
        }
      }}
      className={cn(
        "group/choice flex w-full items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-left",
        "transition-[border-color,background-color,transform] duration-150 ease-strong",
        "hover:border-ring/60 hover:bg-accent/50 active:scale-[0.99] motion-reduce:active:scale-100",
        "focus-visible:outline-none focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_15%,transparent)]",
        "data-checked:border-primary data-checked:bg-primary/[0.07]",
        className
      )}
    >
      <span
        className={cn(
          "mt-[3px] flex size-[15px] shrink-0 items-center justify-center border border-border text-primary-foreground",
          multiple ? "rounded-[4px]" : "rounded-full",
          "transition-colors duration-150",
          "group-data-checked/choice:border-primary group-data-checked/choice:bg-primary"
        )}
      >
        {multiple ? (
          <Check className="size-2.5 opacity-0 group-data-checked/choice:opacity-100" />
        ) : (
          <span className="size-[5px] rounded-full bg-current opacity-0 group-data-checked/choice:opacity-100" />
        )}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {shortcut !== undefined && (
        <kbd className="mt-px shrink-0 rounded border border-border px-1 text-[10px] leading-[15px] text-muted-foreground tabular-nums">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

/** 选项标题 + 副说明的排版位（Choice 的 children 里用） */
export function QuestionnaireChoiceLabel({ children }: { children: ReactNode }) {
  return <span className="block text-[13.5px] leading-snug text-foreground">{children}</span>;
}

export function QuestionnaireChoiceDescription({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
      {children}
    </span>
  );
}

/** 自填框。选项永远列不全，留一个口子给人写真话 */
export function QuestionnaireInput({
  placeholder = "输入你的答案",
  className,
}: {
  placeholder?: string;
  className?: string;
}) {
  const { values, setCustom, advance } = useQuestionnaire();
  const item = useItem();
  const value = (values[item.name] ?? EMPTY).custom;

  return (
    <div className={cn("flex items-center gap-2 pt-0.5", className)}>
      <PenLine className="size-[13px] shrink-0 text-muted-foreground" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        placeholder={placeholder}
        value={value}
        aria-label={placeholder}
        onChange={(e) => setCustom(item.name, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            advance();
          }
        }}
      />
    </div>
  );
}

export function QuestionnaireError({ className }: { className?: string }) {
  const { error } = useQuestionnaire();
  if (!error) return null;
  return (
    <p className={cn("text-[12px] text-deny", className)} role="alert">
      {error}
    </p>
  );
}

export function QuestionnaireActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("flex items-center gap-2 pt-0.5", className)}>{children}</div>;
}

export function QuestionnairePrevious({ className }: { className?: string }) {
  const { step, back } = useQuestionnaire();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={step === 0}
      onClick={back}
      className={cn("px-2 text-muted-foreground disabled:opacity-35", className)}
      aria-label="上一题"
    >
      <ChevronLeft className="size-4" />
    </Button>
  );
}

/** 跳过。必答题上不出现——一个点了没反应的按钮比没有按钮更糟 */
export function QuestionnaireSkip({ className }: { className?: string }) {
  const { current, skip } = useQuestionnaire();
  if (current?.required) return null;
  return (
    <Button variant="ghost" size="sm" onClick={skip} className={cn("text-muted-foreground", className)}>
      跳过本题
    </Button>
  );
}

export function QuestionnaireNext({ className }: { className?: string }) {
  const { isLast, advance } = useQuestionnaire();
  if (isLast) return null;
  return (
    <Button size="sm" onClick={advance} className={cn("ml-auto", className)}>
      下一题
      <ChevronRight className="size-4" />
    </Button>
  );
}

export function QuestionnaireSubmit({
  className,
  children = "提交",
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { isLast, submit } = useQuestionnaire();
  if (!isLast) return null;
  return (
    <Button size="sm" onClick={submit} className={cn("ml-auto", className)}>
      {children}
    </Button>
  );
}
