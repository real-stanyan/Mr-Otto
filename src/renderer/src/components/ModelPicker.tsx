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

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ImageIcon, SettingsIcon, Sparkles, TypeIcon } from "lucide-react";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { imageModelLabel, imageModelVendor, isImageAuto, pickImageModel } from "../../../shared/imageModel.js";
import { modelLabel } from "../../../shared/modelCatalog.js";
import { laneValue, parseLaneValue, type ModelLane } from "../../../shared/modelLane.js";
import type { ModelChoice } from "../../../shared/modelCatalog.js";
import { findProvider } from "../../../shared/providerCatalog.js";
import {
  thinkingLabel,
  thinkingSwitchable,
  type ThinkingSpec,
} from "../../../shared/thinking.js";
import { cn } from "@/lib/utils.js";
import { AUTO_MODEL } from "../../../shared/autoModel.js";
import { hostedModels, isSubscribed } from "../lib/billingView.js";
import { AUTO_MIN_MODELS, modelMenuGroups, type ModelMenuItem } from "../lib/modelMenu.js";
import { useChat } from "../store.js";
import { ImageVendorMark, ProviderMark } from "./ProviderMark.js";

/** thinking 挡位 → ModelSelector 的 effort 选项。
    不可切换的型号（一档 / 零档）返回 undefined：Effort 那一排会整排消失。
    这和旧 ThinkingPicker「灰着并说明为什么」不同 —— 旧版是并排的独立控件，
    少一个控件像界面坏了；收进浮层之后，没有这回事的型号不长出那一排才是对的 */
function effortsOf(spec: ThinkingSpec): ModelOption["efforts"] {
  if (!thinkingSwitchable(spec)) return undefined;
  return spec.modes.map((m) => ({ id: m, name: thinkingLabel(m) }));
}

function optionOf(it: ModelMenuItem): ModelOption {
  const m = it.choice;
  const providerName = it.provider ? (findProvider(it.provider)?.name ?? it.provider) : "";
  return {
    id: it.id,
    // 目录外的型号原样显示 id：比空白多一点信息，至少看得出是哪一款（`modelLabel`，
    // 这条兜底规则的唯一一份；团队设置页那两处 #1247 之前各自画着裸 id）
    name: it.auto ? "Auto" : modelLabel(it.id),
    ...(it.auto
      ? { icon: AUTO_MARK }
      : it.provider
        ? { icon: <ProviderMark provider={it.provider} size={14} className="rounded-[3px]" /> }
        : {}),
    // 搜索命中厂商名和裸型号 id：用户既可能打 "kimi"，也可能打 "moonshot"
    keywords: [providerName, it.id].filter((k) => k !== ""),
    ...(m && effortsOf(m.thinking) !== undefined ? { efforts: effortsOf(m.thinking)! } : {}),
  };
}


/** 一组选项。订阅那一组和厂商那几组同一个形状，渲染那一段因此只有一条路径 */
interface PickerGroup {
  key: string;
  /** `null` = 这一组不画组头（判据与理由在 lib/modelMenu.ts 的 ModelMenuGroup） */
  heading: string | null;
  options: ModelOption[];
}

/** Auto 那一行的说明。**不画在行里**（#1058）：ADR-0244 当初写成第二行正文，
    维护者看过真机后要求撤掉。降级成 `title` 是这里唯一还剩的位置 —— 触发器只有一行
    字宽，而浮层底下已经没有脚注那一栏了（#1095） */
const AUTO_HINT = "每轮起跑前先用最便宜那款判一手难度，再据此挑贵的还是便宜的；判不出来时按原样走。";

/** Auto 那一枚记号。用的不是厂商字形——Auto 不是一家厂——而是同尺寸同圆角的
    中性方块，只求这一列对得齐（同 WorkspaceAgentsTab 的那一枚，#1015） */
const AUTO_MARK = (
  <span
    aria-hidden
    className="inline-flex size-[14px] shrink-0 items-center justify-center rounded-[3px] bg-muted text-muted-foreground ring-1 ring-black/10 ring-inset dark:ring-white/[0.14]"
  >
    <Sparkles className="size-[9px]" />
  </span>
);

/** 出图那一格的 Auto 是什么。**与文字那格不是同一套机制**，所以话也不一样：
    文字那边每轮起跑前真打一次分类调用判难度（ADR-0237），这边只是「由系统挑」。
    降级成 `title` 的理由同 ADR-0249：这一列每天要扫很多遍，Auto 只需读懂一次 */
const IMAGE_AUTO_HINT = "由系统挑一款（当前规则：网关清单里最便宜那款）。不选就是这一档。";

/** 出图型号那一格的厂商标。认不出的**不画**，也不占位 —— 那一行左边空着，
    比给一个陌生型号安一家厂好（同 ADR-0254） */
function ImageVendorIcon({ id }: { id: string }) {
  const vendor = imageModelVendor(id);
  return vendor === null ? null : (
    <ImageVendorMark vendor={vendor} size={14} className="rounded-[3px]" />
  );
}

/** 图像那一格的一行。**不走 `ModelSelectorItem`**（理由在渲染处那段注释），所以
    类名是照它抄的一份 —— 抽成组件是因为 Auto 与各款必须逐像素同款：一行两个样子，
    人会以为 Auto 是另一种东西 */
function ImageRow({
  id, label, icon, checked, title, onPick,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  title?: string;
  onPick: () => void;
}) {
  return (
    <CommandItem
      value={id}
      keywords={[label]}
      className="relative items-center gap-2 rounded-lg py-2 ps-3 pe-9"
      // 「这一行是不是当前那一档」写成一个可寻址的状态：行里本来就有厂商标那枚 svg，
      // 靠「有没有 svg」认勾会在加了标的那天全部认成选中（真发生过）
      data-picked={checked ? "true" : undefined}
      onSelect={onPick}
      {...(title === undefined ? {} : { title })}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && (
        <span className="absolute end-3 top-2.5 flex size-4 items-center justify-center">
          <CheckIcon className="size-4" />
        </span>
      )}
    </CommandItem>
  );
}

export function ModelPicker({
  value,
  lane = "auto",
  auto = false,
  allowAuto = false,
  onChange,
  disabled = false,
  className,
  placeholder,
  filter,
  imageModels = [],
  imageModel = null,
  onImageChange,
}: {
  value: string;
  /** 当前走哪条路。选单里赠额那一份和自己 key 那一份是同一个型号的两个条目 */
  lane?: ModelLane;
  /** 这一格此刻选的是 Auto（#1042）。`value` 仍然是**上一轮真跑的那一款** ——
      两者不是二选一：上下文窗口、挡位表、缓存量照旧问那一款要，只是触发器上
      显示的是 Auto */
  auto?: boolean;
  /** 这个入口允不允许选 Auto。默认不允许：代读员 / 小模型 / 子智能体那几处换的
      不是「这一 turn 用哪款」，Auto 那套「先判难度」对它们没有意义 */
  allowAuto?: boolean;
  /** `model` 可能是 `AUTO_MODEL`（选中了 Auto）——调用方自己认这个口令 */
  onChange: (model: string, lane: ModelLane) => void;
  disabled?: boolean;
  /** 触发器的样式叠加层（状态条版 BAR_SELECT / 新会话卡版 NSC_SELECT） */
  className?: string;
  /** value 是空的时候显示什么。子智能体那边不定型号 = 跟主会话走,
      而主会话可能还没开起来（设置页不需要一个活着的会话）—— 那时"跟随主会话"
      比"选择模型"更贴事实：这个控件不选也有确定的结果 */
  placeholder?: string;
  /** 只列一部分型号（看图设置那格只列 supportsVision 的款）。滤空的组整组不出现 */
  filter?: (m: ModelChoice) => boolean;
  /** 网关此刻供的出图型号（`billing.me.imageModels`，从便宜到贵）。**空 = 整枚开关不画**
      （#1086）：没订阅 / 还没查到 / 网关不供出图，三种情形给同一个答案 —— 整块退回
      改动前的样子，同 `modelMenu` 对 `hosted` 的处置。一行的清单照画：它至少回答了
      「我这张图是谁画的」，而第二款上线那天零改动就变成真选择 */
  imageModels?: readonly string[];
  /** 这条会话选着的出图型号（`image_model_changed` 的投影）。`null` = 没选过 */
  imageModel?: string | null;
  /** 缺席 = 这个入口不给出图那一格（设置页那几处换的不是这条会话的笔） */
  onImageChange?: ((model: string) => void) | undefined;
}) {
  const keyStatus = useChat((s) => s.keyStatus);
  const ollamaModels = useChat((s) => s.ollamaModels);
  const openSettings = useChat((s) => s.openSettings);
  const signedIn = useChat((s) => s.account.signedIn);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // 「文字 / 图像」那枚开关（#1086）。**每次打开都回到「文字」那一格**：触发器上写的
  // 是文字模型，开出来却停在图像那一格，就是按钮说一件事、浮层说另一件事。代价是
  // 连着改两次出图型号要各点一下「图像」——比让人怀疑「我这按钮什么时候变的」便宜
  const [tab, setTab] = useState<"text" | "image">("text");
  useEffect(() => {
    if (open) setTab("text");
  }, [open]);

  // 浮层打开、版面定下来之后，把滚动位置重新算一遍（#1049）。
  //
  // 为什么需要：`ModelSelectorContent` 给 cmdk 的 `Command` 传了 `defaultValue`，
  // cmdk 挂载时就对选中项调了一次 `scrollIntoView({block:"nearest"})` —— 而那一刻
  // Radix 还没把浮层量完位、列表高度不是最终值，于是「nearest」把选中项顶到了列表
  // **最上方**，它上面的 Auto 与「订阅」那个组头一起被滚出视野。真机上就是这样：
  // #1042 做的那件事，人人都有一个选中的型号，于是人人在打开的第一眼里都看不见 Auto。
  //
  // 先回顶再 `nearest`，两件事都要，`scrollTop = 0` 一句是二选一：选中项就在前几行
  // 时留在顶上（Auto 可见），真在下面很远时才最小幅度滚过去（「我现在用的是哪款」
  // 照旧找得到）。
  //
  // 这条判据**故意没写成断言**：jsdom 没有布局，`scrollIntoView` 是空实现、`scrollTop`
  // 恒为 0，写出来的断言只会钉住「调了这个函数」，而真正会坏的是时序（同 ADR-0236
  // 第 1 条那笔 `pb-14` 的账）。保鲜期就在这段注释里。
  useEffect(() => {
    if (!open) return;
    // 等一帧：Radix 定位与列表布局都在这一帧里落定，早于它做等于重演上面那个 bug
    const id = requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = 0;
      el.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // 出图那一格：清单空 / 这个入口不给回调 = 整枚开关不画，下面一切照旧
  const showsImageTab = imageModels.length > 0 && onImageChange !== undefined;
  // 勾画在**真正会被用到的那一款**上，不是画在 `imageModel` 上：没选过时用户看到的
  // 该是网关会替他挑的那款（最便宜那款），而不是一行都不勾；选过但网关下架了它时，
  // 勾也该落在真会跑的那款上 —— 与主进程解路共用 `pickImageModel` 这一份判据
  // Auto 至少要有两款可挑才成立（同文字那格的 `AUTO_MIN_MODELS`）：只有一款时
  // 「Auto」与那一款是同一件事，画两行只是让人多读一遍
  const showsImageAuto = showsImageTab && imageModels.length >= AUTO_MIN_MODELS;
  const imageAuto = showsImageAuto && isImageAuto(imageModel);
  // 勾画在**真正会被用到的那一款**上，不是画在 `imageModel` 上：选过但网关下架了它时，
  // 勾也该落在真会跑的那款上 —— 与主进程解路共用 `pickImageModel` 这一份判据。
  // Auto 那一档的勾归 Auto 那一行（`imageAuto`），下面各款一个都不勾：那一格此刻
  // 由系统挑，勾一款会读成「我选了它」
  const effectiveImage = showsImageTab && !imageAuto ? pickImageModel(imageModels, imageModel) : null;

  // 网关此刻供着哪几款（从便宜到贵，ADR-0237 那条排序键）。没订阅 / 还没查到 = 空，
  // 于是下面整块退回改动前的样子（判据与取舍在 billingView.hostedModels）
  const hosted = useChat((s) => hostedModels(s.billing));
  // 订阅用户不许自带 key（#1051）：厂商那几组一个都不列，底下那条「添加更多模型…」
  // 也跟着撤——它通往的正是被收起来的那一页
  const subscribed = useChat((s) => isSubscribed(s.billing));

  // 列哪几款是纯逻辑，住在 lib/modelMenu.ts —— 判据留在这个 useMemo 里就没有保鲜期，
  // 它渲染不出错、只是少几行（这正是 #1042 那次答错的样子）
  const menu = useMemo(
    () =>
      modelMenuGroups({
        hosted,
        allowAuto,
        subscribed,
        keyStatus,
        ollamaModels,
        currentModel: value,
        filter,
      }),
    [keyStatus, ollamaModels, hosted, allowAuto, subscribed, value, filter]
  );
  const groups = useMemo<PickerGroup[]>(
    () =>
      menu.map((g) => ({
        key: g.key,
        heading: g.heading,
        options: g.items.map((it) => optionOf(it)),
      })),
    [menu]
  );

  // Root 要一份**平铺**的清单：选中项、以及它的挡位表都从这里查。
  // OTTER_MODEL 填了目录外的型号时补一条，否则触发器会显示 placeholder ——
  // "选择模型"这四个字会让人以为还没选，而其实正在用着它
  const models = useMemo(() => {
    const flat = groups.flatMap((g) => g.options);
    // Auto 开着但清单里没有它（订阅刚失效 / 还没查到）：补一条，否则触发器会退回
    // placeholder —— 那读起来像「这一格还没选」，而其实 Auto 正开着
    const withAuto =
      auto && !flat.some((o) => o.id === AUTO_MODEL)
        ? [...flat, { id: AUTO_MODEL, name: "Auto", icon: AUTO_MARK }]
        : flat;
    if (withAuto.some((o) => o.id === value)) return withAuto;
    // 选着的那一款不在菜单里（订阅用户手上留着一款网关不供的老型号，#1051）：
    // 补一条**只给触发器看**的条目，名字取目录里那份而不是裸 id —— 触发器空着
    // 读起来像「这一格还没选」，而它其实正生效着（只是 routeModel 会 blocked 并
    // 让他在这枚选单里换一款）
    return [...withAuto, { id: value, name: modelLabel(value) }];
  }, [groups, value, auto]);

  return (
    <ModelSelectorRoot
      models={models}
      // Auto 是这一格的一个取值，不是并排的第二个控件：选中它，触发器上写 Auto
      value={auto ? AUTO_MODEL : laneValue(value, lane)}
      onValueChange={(v) => {
        const picked = parseLaneValue(v);
        onChange(picked.model, picked.lane);
      }}
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
        {/* 认不出的型号 id 原样显示(比"Select model"多一点信息:至少看得出是哪个)。
            value 是空的时候必须换一句话——空字符串渲染出来是个只剩箭头的空盒子,
            看着像控件坏了。会话还没开起来时主会话型号就是空的,设置页照样能打开 */}
        <ModelSelectorValue placeholder={value || placeholder || "选择模型"} showEffort={false} />
      </ModelSelectorTrigger>

      {/* searchable={false} 不只是"不画搜索框":Content 据此决定 cmdk 是否过滤,
          并补上一个 sr-only 的输入锚点 —— 没有它,方向键/回车在列表里就不工作了。
          border-0:浮层靠 bg-popover + 阴影浮起来,不靠一圈描边 */}
      <ModelSelectorContent align="end" searchable={false} className="w-[268px] border-0">
        {/* 「文字 / 图像」（#1086）。摆在 `ModelSelectorList` **外面**：列表是可滚的
            （max-h-320），开关跟着滚走的话，翻到底下就不知道自己在哪一格了。
            用的是侧栏「任务 / 项目」那一套同一个组件 —— 同一种交互在两处长一样，
            这件事共用骨架才不会漂移 */}
        {showsImageTab && (
          <div className="px-1.5 pt-1.5">
            <Tabs value={tab} onValueChange={(v) => setTab(v as "text" | "image")}>
              <TabsList className="w-full">
                <TabsTrigger value="text">
                  <TypeIcon aria-hidden />
                  文字
                </TabsTrigger>
                <TabsTrigger value="image">
                  <ImageIcon aria-hidden />
                  图像
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}
        <ModelSelectorList ref={listRef} className="max-h-[320px]">
          <ModelSelectorEmpty>没有匹配的模型</ModelSelectorEmpty>

          {/* 图像那一格：**不走 `ModelSelectorItem`**。那个组件的选中态与 `setValue`
              都挂在 Root 的 `value` 上，而 Root 的 `value` 是文字模型 —— 借它画出图
              清单，触发器上那行字会跟着变成出图型号，也就是那颗按钮开始说假话。
              所以这一段自己用 `CommandItem`（类名抄 ModelSelectorItem，两格看起来
              是一列），勾自己画在 `effectiveImage` 上 */}
          {tab === "image" && (
            <CommandGroup>
              {/* Auto（#1086）。与文字那格**不是同一套机制**，所以文案也不同：文字那边
                  每轮起跑前真打一次分类调用判难度（ADR-0237），出图这边只是「由系统挑」
                  ——今天的规则就是网关清单里最便宜那款，也就是没选过时的行为。
                  写成一行而不是留白，是因为「没选过」本来就是这一档：不画它，一个从没
                  碰过这一格的人会看到「一行都没勾」，而他其实正在 Auto 里 */}
              {showsImageAuto && (
                <ImageRow
                  id={AUTO_MODEL}
                  label="Auto"
                  icon={AUTO_MARK}
                  checked={imageAuto}
                  title={IMAGE_AUTO_HINT}
                  onPick={() => {
                    setOpen(false);
                    onImageChange?.(AUTO_MODEL);
                  }}
                />
              )}
              {imageModels.map((id) => (
                <ImageRow
                  key={id}
                  id={id}
                  label={imageModelLabel(id)}
                  icon={<ImageVendorIcon id={id} />}
                  checked={id === effectiveImage}
                  onPick={() => {
                    setOpen(false);
                    onImageChange?.(id);
                  }}
                />
              ))}
            </CommandGroup>
          )}

          {tab === "text" && groups.map((g) => (
            <ModelSelectorGroup key={g.key} {...(g.heading !== null ? { heading: g.heading } : {})}>
              {g.options.map((o) => (
                <ModelSelectorItem
                  key={o.id}
                  model={o}
                  className="items-center"
                  {...(o.id === AUTO_MODEL ? { title: AUTO_HINT } : {})}
                >
                  {/* 厂商标记要自己摆:给了 children 就等于整块自绘,
                      上游那套 icon + name 的默认排版不会再出现(它在 children ?? 后面) */}
                  {o.icon}
                  {/* Auto 与下面那几款**同一个排版**（#1058）：ADR-0244 当初给它加了
                      第二行说明（「只写一个词的话点它的人只能靠猜」），维护者看过真机
                      后要求撤掉——一行两层会把这一列的基线打断，而这枚选单本来就靠
                      「每行长得一样」扫得快。那句话降级成 `title`，不占版面也没丢 */}
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
          {/* 目录里其余厂商都在这扇门后面：菜单只留能跑的，要加新的一家从这里进。
              **订阅用户没有这一行**（#1051）：它通往「模型配置」，而那一页对订阅
              用户已经收起来了——留着就是一条点了跳去一个不存在的页面的路 */}
          {tab === "text" && !subscribed && (
            <>
              <ModelSelectorSeparator />
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
            </>
          )}
        </ModelSelectorList>
        {/* 挡位那一排不画了：这个浮层只回答"用哪个型号"。
            挡位搬去了 components/ThinkingPicker.tsx（输入框控件行上单独一枚浮窗钮）——
            它是型号的属性没错，但改它是一件独立的事，不该只能顺路在选型号时碰到。
            ModelOption.efforts 保留：那是"这个型号有哪几档"的事实描述 */}
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
