// 「模型配置」页的主体：市面主流厂商各一行，用户要做的只有一件事——挑一家、贴 key。
//
// 版式取自 Apple 设置页的 grouped inset list：整组一张圆角卡，行间发丝线，
// 行首一枚品牌色方块当扫读锚点。
//
// 展开体里放的是**这家的账**（用量图 + 余额）；填 key 收在一枚入口钮后面的弹窗里
// （components/ProviderKeyDialog.tsx）。原来是行内常驻一个输入框——那是在展开体
// 长出用量图之前：看账是天天的事，改 key 是一次性的事，常驻位置该给前者。
//
// 不变量沿用 keyVault：key 存完即清，渲染层不留任何副本；状态只有布尔。

import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { MODEL_CATALOG } from "../../../shared/modelCatalog.js";
import { PROVIDER_CATALOG, type ProviderId, type ProviderInfo } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProviderKeyDialog } from "./ProviderKeyDialog.js";
import { ProviderMark } from "./ProviderMark.js";
import { HelperModelSetting } from "./HelperModelSetting.js";
import { fmtBalance, ProviderUsage, USAGE_DAYS, useProviderBalance } from "./ProviderUsage.js";

const REGION_LABEL: Record<ProviderInfo["region"], string> = { cn: "国内直连", global: "海外", local: "本机" };

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
  // 遮罩本身就是"配没配"：空串 = 没配（keyStatus 的口径，见 shared/keyMask.ts）
  const mask = useChat((s) => s.keyStatus[info.apiKeyEnv] ?? "");
  const configured = mask !== "";

  // 本机 Ollama 的型号不在目录里（用户 pull 了什么就有什么），现问现取
  const ollamaModels = useChat((s) => s.ollamaModels);
  const ollamaError = useChat((s) => s.ollamaError);
  const ollamaBaseUrl = useChat((s) => s.ollamaBaseUrl);
  const refreshOllama = useChat((s) => s.refreshOllamaModels);
  const models = useMemo(() => MODEL_CATALOG.filter((m) => m.provider === info.id), [info.id]);
  const balance = useProviderBalance(info.id);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-[11px] text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
      >
        <ProviderMark provider={info.id} size={28} className="rounded-[8px]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-[550]">{info.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {info.blurb}
          </span>
        </span>
        {/* 余额贴在状态前面:这一行是扫读用的,"哪家快没钱了"正是扫的时候想知道的事。
            只有四家有余额 API,其余厂商这里什么都不长出来(不是长一个 0) */}
        {balance?.ok && (
          <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
            {fmtBalance(balance.amount, balance.currency)}
          </span>
        )}
        {info.keyless ? (
          <span className="flex shrink-0 items-center gap-[5px] text-[11.5px] text-ok">
            <span className="size-[6px] rounded-full bg-ok" />
            免 key
          </span>
        ) : configured ? (
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
            {/* 用量/余额放最上面:已经配好的厂商，展开多半是来看账的，不是来改 key 的。
                没用过、也查不到余额的厂商这里整块不出现 */}
            <ProviderUsage provider={info.id} />
            {/* 免 key 的一家没有输入框可填：它要的不是凭据，是"服务开着没" */}
            {info.keyless ? (
              <p className="text-[12.5px] leading-[1.6] text-muted-foreground">
                装好 Ollama 并让它跑着（<code>ollama serve</code>），
                <code>ollama pull</code> 过的型号会自动出现在下面和型号下拉框里，不用配任何东西。
                端点跟着 Ollama 自己的 <code>OLLAMA_HOST</code> 走（默认{" "}
                <code>127.0.0.1:11434</code>）
                {ollamaBaseUrl && <>，当前连的是 <code>{ollamaBaseUrl}</code></>}。
              </p>
            ) : (
              <ProviderKeyDialog info={info} mask={mask} />
            )}

            {info.keyless && (
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1 text-[11.5px] text-primary hover:underline"
                onClick={() => void window.otter.openProviderConsole(info.id)}
              >
                下载 {info.name}
                <ExternalLinkIcon className="size-[11px]" />
              </button>
            )}

            {/* 型号清单:填完 key 之后下拉框里会多出哪几款,当场看得见。
                Ollama 那一行列的是本机实际装了什么（现问 Ollama），
                每款还标出它能不能调工具——不能调的不会出现在型号下拉框里，
                得说清楚为什么，不然那是一次静默的消失 */}
            {info.keyless ? (
              <div className="flex flex-wrap items-center gap-[6px]">
                {ollamaModels.map((m) => (
                  <span
                    key={m.id}
                    title={`${m.tag}｜上下文 ${m.contextLength.toLocaleString("en-US")}${m.vision ? "｜可看图" : ""}`}
                    className={cn(
                      "rounded-md border px-[7px] py-[2px] text-[11px]",
                      m.tools
                        ? "border-border text-muted-foreground"
                        : "border-dashed border-border text-muted-foreground/60"
                    )}
                  >
                    {m.tag}
                    {!m.tools && "（不支持工具·已隐藏）"}
                  </span>
                ))}
                {ollamaModels.length === 0 && (
                  <span className="text-[11.5px] text-muted-foreground">
                    {ollamaError
                      ? `没连上 Ollama —— ${ollamaError}`
                      : "连上了，但一个型号都没装 —— 先 ollama pull 一个"}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => void refreshOllama()}
                >
                  重新检测
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-[6px]">
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
            )}
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

  const refreshProviderStats = useChat((s) => s.refreshProviderStats);
  // 开页取一次。用量读的是本地 SQLite（毫秒级），余额要出网（各家 60s 缓存）——
  // 不做轮询：这一页是"改配置"的地方，不是仪表盘，多刷一次只会多打几趟外网
  useEffect(() => {
    void refreshProviderStats(USAGE_DAYS);
  }, [refreshProviderStats]);

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

  // "可用" = 填了 key 的 + 免 key 的本机服务。分组问的是"我现在能不能选它",
  // 不是"我有没有给过它凭据"——Ollama 从来不要凭据，却一直可用
  const ready = (p: ProviderInfo) => p.keyless === true || (keyStatus[p.apiKeyEnv] ?? "") !== "";
  const configured = matched.filter(ready);
  const rest = matched.filter((p) => !ready(p));

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

      <ProviderGroup title="可用" providers={configured} openId={openId} setOpenId={setOpenId} />
      <ProviderGroup
        title={configured.length > 0 ? "可添加" : "全部厂商"}
        providers={rest}
        openId={openId}
        setOpenId={setOpenId}
      />

      {/* 后台小模型（issue #112）：三个 turn 外挂共用的那一款。摆在厂商列表之后
          ——它是"配完 key 之后的一个选择"，不是"先答这个才能开始" */}
      <HelperModelSetting />

      {matched.length === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">没有匹配「{query}」的厂商或型号。</p>
      )}

      <p className="px-1 text-[12px] leading-[1.6] text-muted-foreground">
        key 存在本机 <code>keys.json</code>（仅当前用户可读），不进会话日志，不回传界面；
        此处配置的 key 优先于 <code>.env</code>。
      </p>
    </>
  );
}
