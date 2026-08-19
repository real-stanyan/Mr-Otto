// 「模型配置」页的主体：市面主流厂商各一行，用户要做的只有一件事——挑一家、贴 key。
//
// 版式取自 Apple 设置页的 grouped inset list：整组一张圆角卡，行间发丝线，
// 行首一枚品牌色方块当扫读锚点。展开行内编辑（不弹窗）——填 key 是"给这一行补个字段"，
// 不是一次要打断上下文的任务，弹窗会把它演得比它重。
//
// 不变量沿用 keyVault：输入框存完即清，渲染层不留 key 的任何副本；状态只有布尔。

import { useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { MODEL_CATALOG } from "../../../shared/modelCatalog.js";
import { PROVIDER_CATALOG, type ProviderId, type ProviderInfo } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProviderMark } from "./ProviderMark.js";

const REGION_LABEL: Record<ProviderInfo["region"], string> = { cn: "国内直连", global: "海外" };

/** 一家厂商一行。收起时只说"是谁、配没配"，展开才谈 key */
function ProviderRow({
  info,
  open,
  onToggle,
}: {
  info: ProviderInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const configured = useChat((s) => s.keyStatus[info.apiKeyEnv] ?? false);
  const saveApiKey = useChat((s) => s.saveApiKey);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const models = useMemo(() => MODEL_CATALOG.filter((m) => m.provider === info.id), [info.id]);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    await saveApiKey(info.apiKeyEnv, key);
    setDraft(""); // 存完即清:渲染层不留副本
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          onToggle();
          // 展开 = 用户要填 key,光标直接落进去,省一次点击
          if (!open) window.setTimeout(() => inputRef.current?.focus(), 60);
        }}
        className="flex w-full items-center gap-3 px-4 py-[11px] text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
      >
        <ProviderMark provider={info.id} className="size-7 rounded-[8px]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-[550]">{info.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {info.blurb}
          </span>
        </span>
        {configured ? (
          <span className="flex shrink-0 items-center gap-[5px] text-[11.5px] text-ok">
            <span className="size-[6px] rounded-full bg-ok" />
            已配置
          </span>
        ) : (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{REGION_LABEL[info.region]}</span>
        )}
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-strong)]",
            open && "rotate-90"
          )}
        />
      </button>

      <div className="disclose" data-open={open}>
        <div>
          <div className="flex flex-col gap-[10px] px-4 pt-1 pb-[14px]">
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="h-9 flex-1 font-mono text-[13px]"
                placeholder={configured ? `输入新 key 覆盖（${info.keyHint}）` : `粘贴 API key（${info.keyHint}）`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
              <Button size="sm" className="h-9" disabled={!draft.trim()} onClick={() => void save()}>
                保存
              </Button>
              {configured && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 bg-transparent text-destructive border-destructive/60 hover:bg-destructive/10 hover:text-destructive dark:bg-transparent dark:hover:bg-destructive/10"
                  onClick={() => void saveApiKey(info.apiKeyEnv, "")}
                >
                  清除
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-[6px] text-[11.5px]">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                onClick={() => void window.otter.openProviderConsole(info.id)}
              >
                去 {info.name} 控制台领 key
                <ExternalLinkIcon className="size-[11px]" />
              </button>
              <code className="text-muted-foreground">{info.apiKeyEnv}</code>
              {saved && (
                <span className="saved-hint inline-flex items-center gap-1 text-ok">
                  <CheckIcon className="size-[11px]" />
                  已保存
                </span>
              )}
            </div>

            {/* 型号清单:填完 key 之后下拉框里会多出哪几款,当场看得见 */}
            <div className="flex flex-wrap gap-[6px]">
              {models.map((m) => (
                <span
                  key={m.model}
                  title={m.model}
                  className="rounded-md border border-border px-[7px] py-[2px] text-[11px] text-muted-foreground"
                >
                  {m.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 一张圆角卡 = 一组。组标题走 Apple 的小号全大写行,不进卡里 */
function ProviderGroup({
  title,
  providers,
  openId,
  setOpenId,
}: {
  title: string;
  providers: ProviderInfo[];
  openId: ProviderId | null;
  setOpenId: (id: ProviderId | null) => void;
}) {
  if (providers.length === 0) return null;
  return (
    <section className="flex flex-col gap-[6px]">
      <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{title}</h2>
      <div className="overflow-hidden rounded-[14px] border border-border bg-card divide-y divide-border">
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            info={p}
            open={openId === p.id}
            // 同时只开一行:一次只填一把 key,开着五个输入框只会让人找不到刚才那个
            onToggle={() => setOpenId(openId === p.id ? null : p.id)}
          />
        ))}
      </div>
    </section>
  );
}

export function ModelProviderSettings() {
  const keyStatus = useChat((s) => s.keyStatus);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<ProviderId | null>(null);

  const q = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      PROVIDER_CATALOG.filter((p) =>
        q === ""
          ? true
          : [p.name, p.blurb, p.id, p.apiKeyEnv].some((f) => f.toLowerCase().includes(q)) ||
            MODEL_CATALOG.some((m) => m.provider === p.id && m.label.toLowerCase().includes(q))
      ),
    [q]
  );

  const configured = matched.filter((p) => keyStatus[p.apiKeyEnv]);
  const rest = matched.filter((p) => !keyStatus[p.apiKeyEnv]);

  return (
    <>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-9 rounded-[10px] pl-9 text-[13px]"
          placeholder="搜索厂商或型号"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ProviderGroup title="已配置" providers={configured} openId={openId} setOpenId={setOpenId} />
      <ProviderGroup
        title={configured.length > 0 ? "可添加" : "全部厂商"}
        providers={rest}
        openId={openId}
        setOpenId={setOpenId}
      />

      {matched.length === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">没有匹配「{query}」的厂商或型号。</p>
      )}

      <p className="px-1 text-[12px] leading-[1.6] text-muted-foreground">
        key 存在本机 <code>keys.json</code>（仅当前用户可读），不进会话日志，不回传界面；
        此处配置的 key 优先于 <code>.env</code>。DeepSeek 不填 key 也能用——登录后走官方赠额。
      </p>
    </>
  );
}
