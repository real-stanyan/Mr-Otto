// 连接器详情页 —— 目录卡点开之后的那一屏（issue #745）。
//
// 为什么是页而不是弹窗：这一屏要装下工具清单（已装的那台可能有二三十个），
// 弹窗要么滚动条套滚动条，要么把上下文整个盖住；而用户点进来正是为了
// "先看清楚再决定"，盖住他刚才在看的东西是反的。
//
// 主行动那一格复用 installSlot——跟目录卡上那颗按钮是同一把尺子。两处各写
// 一份判据的话，「装上了但没授权」这种状态迟早会在两个地方说两句话
// （issue #722 就是一格勾撒谎撒出来的）。
import { ArrowLeft, Check, Loader2, Plus, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { HINT } from "../settingsShell.js";
import type { CatalogEntry } from "../../../shared/mcpCatalog.js";
import {
  installSlot,
  type DirectoryItem,
  type InstalledServer,
} from "../lib/mcpDirectory.js";
import {
  connectorFacts,
  paramSuffix,
  sourceNote,
  toolCountLabel,
} from "../lib/mcpDetail.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

export function McpConnectorPage({
  item,
  installedServer,
  busy,
  icon,
  onBack,
  onAdd,
  onAuthorize,
}: {
  item: DirectoryItem;
  /** 已装的话是它此刻在盘上的样子（状态 + 工具清单）；没装是 undefined */
  installedServer: InstalledServer | undefined;
  busy: boolean;
  /** 图标由目录页渲染后传进来 —— 那边的 EntryIcon 认得 vite 的资源表，
      这一页不该为了画个标再复制一份 glob */
  icon: React.ReactNode;
  onBack: () => void;
  onAdd: () => void;
  onAuthorize: () => void;
}) {
  const { entry, verified } = item;
  const slot = installSlot(item, busy);
  const facts = connectorFacts(entry);
  const tools = toolCountLabel(installedServer?.tools);

  return (
    <div className="connector-page flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          "press-scale -ml-1 inline-flex w-fit items-center gap-1.5 rounded-[7px] px-1.5 py-1",
          "text-[12.5px] text-muted-foreground transition-colors duration-150",
          "hover:bg-foreground/[0.06] hover:text-foreground"
        )}
      >
        <ArrowLeft className="size-[13px]" aria-hidden />
        连接器
      </button>

      <header className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 text-[17px] leading-tight font-medium">{entry.name}</h3>
            {verified ? (
              <span className="inline-flex shrink-0 items-center gap-[3px] text-[11px] text-muted-foreground">
                <ShieldCheck className="size-[12px]" aria-hidden />
                已核验
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground/70">未核验</span>
            )}
          </div>
          {/* 卡片上这行是截断的，这一页不截——用户点进来就是为了看全 */}
          <p className="text-[13px] leading-[1.6] text-muted-foreground">{entry.description}</p>
        </div>
        <MainAction slot={slot} entry={entry} onAdd={onAdd} onAuthorize={onAuthorize} />
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[10px] border border-border bg-card px-[14px] py-3">
        {facts.map((f) => (
          <div key={f.label} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="shrink-0 text-[12px] whitespace-nowrap text-muted-foreground">
              {f.label}
            </dt>
            <dd
              className={cn(
                "min-w-0 text-[12.5px] leading-[1.6] break-words",
                f.mono === true && "font-mono text-[12px]"
              )}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {entry.params.length > 0 && (
        <section className="flex flex-col gap-2">
          <span className={SECTION_LABEL}>要填的</span>
          <ul className="flex flex-col gap-2.5">
            {entry.params.map((p) => (
              <li key={p.name} className="flex flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <code className="font-mono text-[12.5px]">{p.name}</code>
                  <span className="text-[11px] text-muted-foreground">
                    {paramSuffix(p.required)}
                  </span>
                </span>
                <span className={cn(HINT, "leading-[1.6]")}>{p.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tools !== null && (
        <section className="flex flex-col gap-2">
          <span className={SECTION_LABEL}>它提供的工具 · {tools}</span>
          {installedServer !== undefined && installedServer.tools !== undefined && (
            <div className="flex flex-wrap gap-1.5">
              {installedServer.tools.map((t) => (
                <code
                  key={t}
                  className="rounded-[6px] bg-muted/60 px-[7px] py-[3px] font-mono text-[11.5px]"
                >
                  {t}
                </code>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <span className={SECTION_LABEL}>来路</span>
        <p className={cn(HINT, "leading-[1.6]")}>{sourceNote(verified)}</p>
      </section>
    </div>
  );
}

/** 右上角那一格。四档跟目录卡完全一致（installSlot），差别只在这一页有地方
    写字：卡片上是一颗 24px 的图标钮，这儿可以把动词说出来 */
function MainAction({
  slot,
  entry,
  onAdd,
  onAuthorize,
}: {
  slot: ReturnType<typeof installSlot>;
  entry: CatalogEntry;
  onAdd: () => void;
  onAuthorize: () => void;
}) {
  const base = cn(
    "press-scale inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 py-1.5",
    "text-[12.5px] font-medium transition-colors duration-150"
  );
  if (slot.kind === "done") {
    return (
      <span className={cn(base, "text-ok")}>
        <Check className="size-[15px]" aria-hidden />
        已连接
      </span>
    );
  }
  if (slot.kind === "authorize") {
    return (
      <button
        type="button"
        aria-label={`授权 ${entry.name}`}
        className={cn(base, "text-foreground ring-1 ring-border hover:bg-foreground/[0.06]")}
        onClick={onAuthorize}
      >
        授权
      </button>
    );
  }
  if (slot.kind === "note") {
    return (
      <span className={cn(base, "text-muted-foreground")} title={slot.title}>
        {slot.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={slot.kind === "busy"}
      aria-label={`添加 ${entry.name}`}
      className={cn(
        base,
        "text-foreground ring-1 ring-border hover:bg-foreground/[0.06] disabled:opacity-50"
      )}
      onClick={onAdd}
    >
      {slot.kind === "busy" ? (
        <Loader2 className="size-[15px] animate-spin" aria-hidden />
      ) : (
        <Plus className="size-[15px]" aria-hidden />
      )}
      添加
    </button>
  );
}
