// 型号选择器（输入框控件行 + 新会话卡共用）。
//
// 底层从自研的两级 DropdownMenu 换成了 assistant-ui 的 ModelSelector（registry 组件）。
// 换的理由不是"用上组件库"，是这个控件本来就到了两级菜单撑不住的规模：目录 30+ 款、
// 用户记得住的是型号名而不是它属于哪家，两级菜单逼人先答一个自己未必知道答案的问题。
// 厂商从二级菜单改成分组标题——一屏之内按家扫，不用先答"它是哪家的"。
//
// 搜索框和 thinking 挡位那一排都不画（searchable={false} / 不渲染 Effort）：
// 这个浮层只回答一个问题——用哪个型号。cmdk 的键盘导航照旧（Content 会补一个
// sr-only 的输入锚点），少的只是那个可见的输入框。
// 挡位在 components/ThinkingPicker.tsx，控件行上单独一枚浮窗钮。
//
// 运行时耦合：ModelSelector 有一个可选的 ModelSelectorModelContext 子组件，会把选择
// 注册进 assistant-ui 自己的 ModelContext。本仓不渲染它 —— 模型是主进程 agent 持有的
// 会话状态，切换要过 switchModel 落成 model_changed 事件（日志唯一事实来源），
// 让 assistant-ui 再持有一份等于开了第二条写入路径。

import { useMemo, useState } from "react";
import { SettingsIcon } from "lucide-react";

import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
  ModelSelectorValue,
  type ModelOption,
} from "@/components/assistant-ui/model-selector.js";
import { CommandGroup, CommandItem } from "@/components/ui/command.js";
import { describeModel, modelsByProvider, ollamaChoiceFrom } from "../../../shared/modelCatalog.js";
import type { ModelChoice } from "../../../shared/modelCatalog.js";
import { findProvider, type ProviderId } from "../../../shared/providerCatalog.js";
import {
  thinkingLabel,
  thinkingSwitchable,
  type ThinkingSpec,
} from "../../../shared/thinking.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProviderMark } from "./ProviderMark.js";

/** thinking 挡位 → ModelSelector 的 effort 选项。
    不可切换的型号（一档 / 零档）返回 undefined：Effort 那一排会整排消失。
    这和旧 ThinkingPicker「灰着并说明为什么」不同 —— 旧版是并排的独立控件，
    少一个控件像界面坏了；收进浮层之后，没有这回事的型号不长出那一排才是对的 */
function effortsOf(spec: ThinkingSpec): ModelOption["efforts"] {
  if (!thinkingSwitchable(spec)) return undefined;
  return spec.modes.map((m) => ({ id: m, name: thinkingLabel(m) }));
}

function optionOf(m: ModelChoice, provider: ProviderId, providerName: string): ModelOption {
  return {
    id: m.model,
    name: m.label,
    icon: <ProviderMark provider={provider} size={14} className="rounded-[3px]" />,
    // 搜索命中厂商名和裸型号 id：用户既可能打 "kimi"，也可能打 "moonshot"
    keywords: [providerName, m.model],
    ...(effortsOf(m.thinking) !== undefined ? { efforts: effortsOf(m.thinking)! } : {}),
  };
}

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
    // 只留会调工具的：这个 agent 的每一步都是工具调用，选一个不会调工具的型号
    // 等于选了一个只会聊天的搭档 —— 与其让它在会话里静默地什么也不做，
    // 不如现在就不出现在选单里（设置页会列出它并说明为什么被藏起来）。
    // 一个都没有就整组不出现：空的二级菜单比没有这一项更让人困惑
    const usable = ollamaModels.filter((m) => m.tools);
    const ollama =
      usable.length > 0
        ? [{ provider: "ollama" as ProviderId, models: usable.map(ollamaChoiceFrom) }]
        : [];
    return [...modelsByProvider(), ...ollama]
      .map((g) => ({ ...g, info: findProvider(g.provider)! }))
      // 没配 key 的厂商压根不进这个菜单：这里是"挑一个现在就能跑的型号"，
      // 十来行点进去只会撞上"需要 key"的死路。配 key 是另一件事，走底下那个入口。
      // 例外是当前选中的那家——key 被清掉之后菜单里也得能找到它，
      // 否则触发器显示着一个在菜单里不存在的型号
      .filter((g) => ready(g.provider) || g.provider === choice?.provider)
      .map((g) => ({
        ...g,
        options: g.models.map((m) => optionOf(m, g.provider, g.info.name)),
      }));
  }, [keyStatus, ollamaModels, choice?.provider]);

  // Root 要一份**平铺**的清单：选中项、以及它的挡位表都从这里查。
  // OTTER_MODEL 填了目录外的型号时补一条，否则触发器会显示 placeholder ——
  // "选择模型"这四个字会让人以为还没选，而其实正在用着它
  const models = useMemo(() => {
    const flat = groups.flatMap((g) => g.options);
    if (choice || flat.some((o) => o.id === value)) return flat;
    return [...flat, { id: value, name: value }];
  }, [groups, choice, value]);

  return (
    <ModelSelectorRoot
      models={models}
      value={value}
      onValueChange={onChange}
      open={open}
      onOpenChange={setOpen}
    >
      <ModelSelectorTrigger
        disabled={disabled}
        className={cn(
          // 版式沿用旧触发器：整块可点、按压回弹、悬停才长出边框
          "press-scale min-w-0 gap-[6px] rounded-md border border-transparent text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-border focus-visible:border-ring disabled:opacity-40 data-[state=open]:text-foreground data-[state=open]:border-border",
          className
        )}
        title="选择模型：打字搜，或按厂商找"
      >
        {/* showEffort={false}：挡位归 ThinkingPicker 那枚钮，
            两处都显示就成了同一件事说两遍（还得回答"点哪个才能改"） */}
        <ModelSelectorValue placeholder={value} showEffort={false} />
      </ModelSelectorTrigger>

      {/* searchable={false} 不只是"不画搜索框":Content 据此决定 cmdk 是否过滤,
          并补上一个 sr-only 的输入锚点 —— 没有它,方向键/回车在列表里就不工作了。
          border-0:浮层靠 bg-popover + 阴影浮起来,不靠一圈描边 */}
      <ModelSelectorContent align="end" searchable={false} className="w-[268px] border-0">
        <ModelSelectorList className="max-h-[320px]">
          <ModelSelectorEmpty>没有匹配的型号</ModelSelectorEmpty>
          {groups.map((g) => (
            <ModelSelectorGroup key={g.provider} heading={g.info.name}>
              {g.options.map((o, i) => (
                <ModelSelectorItem key={o.id} model={o} className="items-center">
                  {/* 厂商标记要自己摆:给了 children 就等于整块自绘,
                      上游那套 icon + name 的默认排版不会再出现(它在 children ?? 后面) */}
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {g.models[i]?.supportsVision && (
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">视觉</span>
                  )}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
          <ModelSelectorSeparator />
          {/* 目录里其余厂商都在这扇门后面：菜单只留能跑的，要加新的一家从这里进 */}
          <CommandGroup>
            <CommandItem
              value="__add_models__"
              className="gap-2"
              onSelect={() => {
                setOpen(false);
                void openSettings("keys");
              }}
            >
              <SettingsIcon className="size-[15px]" />
              添加更多模型…
            </CommandItem>
          </CommandGroup>
        </ModelSelectorList>
        {/* 挡位那一排不画了：这个浮层只回答"用哪个型号"。
            挡位搬去了 components/ThinkingPicker.tsx（输入框控件行上单独一枚浮窗钮）——
            它是型号的属性没错，但改它是一件独立的事，不该只能顺路在选型号时碰到。
            ModelOption.efforts 保留：那是"这个型号有哪几档"的事实描述 */}
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
