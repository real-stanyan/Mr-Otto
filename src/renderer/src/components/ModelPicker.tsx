// 型号选择器（输入框控件行 + 新会话卡共用）。
//
// 为什么从 Select 换成两级 DropdownMenu：目录从 4 款涨到 30 款后，平铺一列要滚三屏，
// 而用户的心智顺序本来就是先想"用哪家"再想"哪一档"。一级 = 厂商，二级 = 型号，
// 收起来的那一级正好也是 key 的粒度——没配 key 的那家在一级就能看出来，不用点进去。
//
// 末尾常驻「添加更多模型…」：目录里躺着一堆没配 key 的厂商，用户看见了得有地方去。

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, SettingsIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { describeModel, modelsByProvider } from "../../../shared/modelCatalog.js";
import { findProvider, type ProviderId } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProviderMark } from "./ProviderMark.js";

export function ModelPicker({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  /** 触发器的样式叠加层（状态条版 BAR_SELECT / 新会话卡版 NSC_SELECT） */
  className?: string;
}) {
  const keyStatus = useChat((s) => s.keyStatus);
  const ollamaModels = useChat((s) => s.ollamaModels);
  const openSettings = useChat((s) => s.openSettings);
  const [open, setOpen] = useState(false);

  const choice = describeModel(value);
  const groups = useMemo(() => {
    const ready = (id: ProviderId) => {
      // DeepSeek 没配 key 也能用（登录后走官方赠额，见 main/modelRoute.ts）
      if (id === "deepseek") return true;
      const info = findProvider(id);
      if (!info) return false;
      if (info.keyless) return true; // 本机 Ollama:能连上就能用
      return keyStatus[info.apiKeyEnv] ?? false;
    };
    // Ollama 的型号不在目录里（本机装了什么只有本机知道），现问现拼进来。
    // 一个都没装就整组不出现——空的二级菜单比没有这一项更让人困惑
    const ollama =
      ollamaModels.length > 0
        ? [{ provider: "ollama" as ProviderId, models: ollamaModels.map((m) => describeModel(m)!) }]
        : [];
    return [...modelsByProvider(), ...ollama]
      .map((g) => ({ ...g, info: findProvider(g.provider)!, ready: ready(g.provider) }))
      // 没配 key 的厂商压根不进这个菜单：这里是"挑一个现在就能跑的型号"，
      // 十来行点进去只会撞上"需要 key"的死路。配 key 是另一件事，走底下那个入口。
      // 例外是当前选中的那家——key 被清掉之后菜单里也得能找到它，
      // 否则触发器显示着一个在菜单里不存在的型号
      .filter((g) => g.ready || g.provider === choice?.provider)
      .sort((a, b) => Number(b.ready) - Number(a.ready));
  }, [keyStatus, ollamaModels, choice?.provider]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          "press-scale inline-flex min-w-0 items-center gap-[6px] rounded-md border border-transparent text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground hover:border-border focus-visible:border-ring disabled:opacity-40 data-[state=open]:text-foreground data-[state=open]:border-border",
          className
        )}
        title="选择模型：先挑厂商，再挑型号"
      >
        {choice && <ProviderMark provider={choice.provider} size={15} className="rounded-[4px]" />}
        <span className="min-w-0 truncate">{choice?.label ?? value}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="menu-pop w-[236px]">
        {groups.map((g) => (
          <DropdownMenuSub key={g.provider}>
            <DropdownMenuSubTrigger className="gap-[10px] py-[7px]">
              <ProviderMark provider={g.provider} size={18} />
              <span className="min-w-0 flex-1 truncate">{g.info.name}</span>
              {/* 选中的那家在收起状态下也要认得出——不然用户不知道该点开哪个 */}
              {choice?.provider === g.provider && (
                <CheckIcon className="size-[14px] shrink-0 text-primary" />
              )}
              {!g.ready && (
                <span className="shrink-0 text-[10.5px] text-muted-foreground">需 key</span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="menu-pop w-[248px]" sideOffset={6}>
              {g.models.map((m, i) => {
                // Ollama 那组的条目 id 带 ollama/ 前缀（日志里存的就是它），
                // 而 m.model 是要发给 API 的裸 tag——菜单选的是前者
                const id = g.provider === "ollama" ? ollamaModels[i]! : m.model;
                return (
                <DropdownMenuItem
                  key={id}
                  className="gap-2 py-[7px]"
                  onSelect={() => onChange(id)}
                >
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  {m.supportsVision && (
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">视觉</span>
                  )}
                  <CheckIcon
                    className={cn(
                      "size-[14px] shrink-0 text-primary",
                      id === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                </DropdownMenuItem>
                );
              })}
              {!g.ready && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="gap-2 py-[7px] text-muted-foreground"
                    onSelect={() => void openSettings("keys")}
                  >
                    填 {g.info.name} 的 API key
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}

        {/* OTTER_MODEL 填了目录外的型号：单列一项，不然触发器显示的东西在菜单里找不到 */}
        {!choice && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 py-[7px]" onSelect={() => onChange(value)}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{value}</span>
              <CheckIcon className="size-[14px] shrink-0 text-primary" />
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />
        {/* 目录里其余厂商都在这扇门后面：菜单只留能跑的，要加新的一家从这里进 */}
        <DropdownMenuItem className="gap-2 py-[7px]" onSelect={() => void openSettings("keys")}>
          <SettingsIcon className="size-[15px]" />
          添加更多模型…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
