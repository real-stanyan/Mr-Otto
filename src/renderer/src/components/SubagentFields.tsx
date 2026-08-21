// 子智能体的字段编辑器 —— 列表里展开那一行、和「新建」整页，用的是同一份。
//
// 抽出来不是为了少写字：这九个字段每一个都会落进磁盘上的 frontmatter，两份各自
// 演化的表单迟早在某个字段上分家（一边挡住了空工具、另一边没挡，用户从哪个入口
// 进来决定他能不能存出一个坏文件）。控件、校验、说明文字都只有一处。
//
// 草稿状态住在 useSubagentDraft 里，落盘那一步不在这里：列表行是「保存回原路径」，
// 新建页是「先 create 拿到真路径再 save」，两条路的落点不同（见各自的调用处）。

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/lib/utils.js";
import { HINT } from "../App.js";
import { ModelPicker } from "./ModelPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { useChat } from "../store.js";
import { useModelChoice, thinkingSpecOf } from "../lib/useModelChoice.js";
import { describeModel } from "../../../shared/modelCatalog.js";
import { clampThinking, thinkingSwitchable, type ThinkingMode } from "../../../shared/thinking.js";
import type { ToolDefinition } from "../../../model/adapter.js";
import type {
  SubagentApproval,
  SubagentDef,
  SubagentPreamble,
} from "../../../shared/subagent.js";

export const ERR_TXT = "text-err text-[13px]";
const LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const FIELD = "flex flex-col gap-[6px]";
/** 分段控件（审批档 / 前置词）——同一种"三选一"，两处必须长得一样 */
const SEG_GROUP = "inline-flex gap-1 rounded-[10px] border border-border bg-card p-1 w-fit";
const SEG_ITEM =
  "press-scale rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors duration-150 disabled:opacity-50";
const SEG_ON = "bg-foreground/[0.10] font-[550] text-foreground";
const SEG_OFF = "text-muted-foreground hover:text-foreground";
/** 药丸开关（工具 / 工作区文档） */
const PILL =
  "press-scale rounded-full border px-[10px] py-[3px] text-[12px] font-mono transition-colors duration-150 disabled:opacity-50";
const PILL_ON = "border-transparent bg-foreground/[0.10] text-foreground font-[550]";
const PILL_OFF = "border-border text-muted-foreground hover:text-foreground";

/** 一把工具都不选会撞上后端限制：写出一行空 `tools:`，解析器读不到值就整行
    丢掉，落地后悄悄变回缺省工具集——跟用户在界面上看到的"我选了 0 把"对不上。
    选择是挡住，不是静默兜底：用户存的应该是他勾的那份，不是解析器猜的那份 */
function toolsWillCollapse(selected: readonly string[]): boolean {
  return selected.length === 0;
}

const APPROVAL_OPTIONS: { value: SubagentApproval; label: string }[] = [
  { value: "ask", label: "问我" },
  { value: "auto", label: "自动放行" },
  { value: "deny", label: "直接拒绝" },
];

const PREAMBLE_OPTIONS: { value: SubagentPreamble["mode"]; label: string }[] = [
  { value: "default", label: "用全局" },
  { value: "off", label: "不加" },
  { value: "custom", label: "自定义" },
];

/** 可勾选的工作区文档。只给这两个:frontmatter 里手写任意 basename 照样认,
    但界面上摊开一个自由输入框等于邀请用户去踩 basename 那条限制 */
export const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 把勾选结果排成 CONTEXT_FILES 的顺序。顺序会进模型:readContextDocs 按数组序
    读盘,拼在正文前面的先后就是这个数组的先后。不归一的话它是点击顺序的副产品
    ——取消勾选再勾回来,内容一模一样却换了个次序,而 dirty 是按集合比的,
    这份被打乱的数组会搭着下一次无关的保存写进文件。
    界面外手写的 basename 解析器照样认(只是这里没有勾选框),原样接在后面,
    不能在保存时被吃掉 */
export function canonicalContext(names: readonly string[]): string[] {
  const known: readonly string[] = CONTEXT_FILES;
  return [...known.filter((f) => names.includes(f)), ...names.filter((n) => !known.includes(n))];
}

/** useSubagentDraft 的返回值。字段/setter 给控件，派生量给按钮和校验 */
export interface SubagentDraft {
  description: string;
  setDescription: (v: string) => void;
  instructions: string;
  setInstructions: (v: string) => void;
  tools: string[];
  setTools: (f: (prev: string[]) => string[]) => void;
  approval: SubagentApproval;
  setApproval: (v: SubagentApproval) => void;
  modelPinned: boolean;
  modelValue: string;
  pinModel: (m: string) => void;
  unpinModel: () => void;
  thinkingPinned: boolean;
  pinThinking: (m: ThinkingMode) => void;
  unpinThinking: () => void;
  preambleMode: SubagentPreamble["mode"];
  setPreambleMode: (v: SubagentPreamble["mode"]) => void;
  preambleText: string;
  setPreambleText: (v: string) => void;
  context: string[];
  setContext: (f: (prev: string[]) => string[]) => void;
  /** 派生：此刻这份草稿要写进文件的前置词 */
  preamble: SubagentPreamble;
  effectiveModel: string;
  /** 该型号的 thinking 规格（可选挡位 + 默认档）——控件和落盘判断共用一份 */
  spec: ReturnType<typeof thinkingSpecOf>;
  effectiveThinking: ThinkingMode;
  modelLabel: string;
  /** 型号有没有可换的挡位——没有的话 thinking 不落盘 */
  thinkingSwitchable: boolean;
  /** 跟 def 比有没有改动。新建页用不上（种子是空的，一直是"有改动"） */
  dirty: boolean;
  /** 存不下去的两种草稿：一把工具都不选 / 选了自定义却一个字没写 */
  blockedByEmptyTools: boolean;
  blockedByBlankPreamble: boolean;
  blocked: boolean;
  /** 回到 def 的样子 */
  reset: () => void;
  /** 草稿里那些"写进文件"的字段。身份字段（name/path/source/scope/readOnly）
      由调用方补——它们的来源两条路不同，不该由草稿假装知道 */
  payload: () => Omit<SubagentDef, "name" | "path" | "source" | "scope" | "readOnly">;
}

/**
 * 一份草稿的全部状态。def 是它的起点，也是 dirty / reset 的参照系。
 *
 * 模型和 thinking 用"定过 = pin"表达：没碰过就跟着主会话/型号默认走，碰过就是这个
 * 子智能体自己的选择。用触碰状态代替一枚「跟随」复选框——设置页的克制原则。
 */
export function useSubagentDraft(def: SubagentDef): SubagentDraft {
  const mainModel = useChat((s) => s.model);

  const [description, setDescription] = useState(def.description);
  const [instructions, setInstructions] = useState(def.instructions);
  const [tools, setTools] = useState<string[]>(def.tools);
  const [approval, setApproval] = useState<SubagentApproval>(def.approval);
  const [modelPinned, setModelPinned] = useState(def.model !== undefined);
  const [modelValue, setModelValue] = useState(def.model ?? mainModel);
  const [thinkingPinned, setThinkingPinned] = useState(def.thinking !== undefined);
  const [thinkingValue, setThinkingValue] = useState(def.thinking);
  const [preambleMode, setPreambleMode] = useState<SubagentPreamble["mode"]>(def.preamble.mode);
  const [preambleText, setPreambleText] = useState(
    def.preamble.mode === "custom" ? def.preamble.text : ""
  );
  const [context, setContext] = useState<string[]>(def.context);

  const effectiveModel = modelPinned ? modelValue : mainModel;
  const modelChoice = useModelChoice(effectiveModel);
  const spec = thinkingSpecOf(modelChoice);
  const effectiveThinking =
    thinkingPinned && thinkingValue ? clampThinking(thinkingValue, spec) : spec.default;

  // 草稿如实按用户选的那一档算,空白的"自定义"**不**在这里悄悄折叠成 default。
  // 折叠过一次:preamble:off 的定义,点一下「自定义」还没打字,草稿就成了 default,
  // dirty 跟着变真、按钮亮起「保存」,一按写进文件的是"用全局"——用户刚刚明确关掉的
  // 那段前置词又回到模型眼前了,而单选组还停在「自定义」(它是 local state,行没重挂),
  // 按钮转头说「已保存」。控件、按钮、落进文件的东西三个说法各不相同。
  // 空白的自定义不是一种可存的状态,跟"一把工具都不选"同一个处理:挡在保存前,
  // 不替用户改主意
  const preamble: SubagentPreamble =
    preambleMode === "custom"
      ? { mode: "custom", text: preambleText.trim() }
      : preambleMode === "off"
        ? { mode: "off" }
        : { mode: "default" };

  const contextDraft = canonicalContext(context);
  const contextSaved = canonicalContext(def.context);

  const dirty =
    description !== def.description ||
    instructions !== def.instructions ||
    approval !== def.approval ||
    preamble.mode !== def.preamble.mode ||
    (preamble.mode === "custom" &&
      def.preamble.mode === "custom" &&
      preamble.text !== def.preamble.text) ||
    contextDraft.length !== contextSaved.length ||
    contextDraft.some((c, i) => c !== contextSaved[i]) ||
    tools.length !== def.tools.length ||
    tools.some((t) => !def.tools.includes(t)) ||
    modelPinned !== (def.model !== undefined) ||
    (modelPinned && modelValue !== def.model) ||
    thinkingPinned !== (def.thinking !== undefined) ||
    (thinkingPinned && effectiveThinking !== def.thinking);

  const blockedByEmptyTools = toolsWillCollapse(tools);
  const blockedByBlankPreamble = preamble.mode === "custom" && preamble.text === "";
  const switchable = thinkingSwitchable(spec);

  return {
    description,
    setDescription,
    instructions,
    setInstructions,
    tools,
    setTools,
    approval,
    setApproval,
    modelPinned,
    modelValue,
    pinModel: (m) => {
      setModelValue(m);
      setModelPinned(true);
    },
    unpinModel: () => {
      setModelPinned(false);
      setModelValue(mainModel);
    },
    thinkingPinned,
    pinThinking: (m) => {
      setThinkingValue(m);
      setThinkingPinned(true);
    },
    unpinThinking: () => setThinkingPinned(false),
    preambleMode,
    setPreambleMode,
    preambleText,
    setPreambleText,
    context,
    setContext,
    preamble,
    effectiveModel,
    spec,
    effectiveThinking,
    // 会话还没开起来时主会话型号是空的。空字符串会进行头摘要（「 · 4 把工具」）
    // 和「…没有可换的挡位」那句提示,两处都渲染成半句话——这里给它一句人话
    modelLabel: describeModel(effectiveModel)?.label ?? (effectiveModel || "跟随主会话"),
    thinkingSwitchable: switchable,
    dirty,
    blockedByEmptyTools,
    blockedByBlankPreamble,
    blocked: blockedByEmptyTools || blockedByBlankPreamble,
    reset: () => {
      setDescription(def.description);
      setInstructions(def.instructions);
      setTools(def.tools);
      setApproval(def.approval);
      setModelPinned(def.model !== undefined);
      setModelValue(def.model ?? mainModel);
      setThinkingPinned(def.thinking !== undefined);
      setThinkingValue(def.thinking);
      setPreambleMode(def.preamble.mode);
      setPreambleText(def.preamble.mode === "custom" ? def.preamble.text : "");
      setContext(def.context);
    },
    payload: () => ({
      description,
      instructions,
      tools,
      unknownTools: def.unknownTools,
      approval,
      preamble,
      context: contextDraft,
      ...(modelPinned ? { model: modelValue } : {}),
      ...(thinkingPinned && switchable ? { thinking: effectiveThinking } : {}),
    }),
  };
}

/** 当前挂载的工具表，减掉 task。
    子 agent 不能再派子 agent 是设计边界（main/subagents.ts 解析时就把 task 从
    tools 里剔除了），但 toolDefs 是"此刻挂载的工具表"，task 只要清单不空就在里头 */
export function useToolOptions(): ToolDefinition[] {
  const toolDefs = useChat((s) => s.toolDefs);
  return useMemo(() => toolDefs.filter((t) => t.name !== "task"), [toolDefs]);
}

/** 九个字段的控件本体。name 不在这里：列表行的名字是不可改的标题，
    新建页的名字是要校验、要查撞名的输入框——两处是两件事 */
export function SubagentFields({
  draft,
  readOnly = false,
}: {
  draft: SubagentDraft;
  readOnly?: boolean;
}) {
  const toolOptions = useToolOptions();

  return (
    <>
      {/* description:全表唯一写给模型看的字段——task 工具把它塞进 def 里,
          模型靠这句话挑人。用户当成给自己看的备注来写,模型就会挑错人 */}
      <div className={FIELD}>
        <label className={LABEL}>Description</label>
        <Input
          value={draft.description}
          disabled={readOnly}
          onChange={(e) => draft.setDescription(e.target.value)}
          placeholder="这个子智能体是干什么的、什么时候该派给它"
        />
        <p className={HINT}>
          这句话是写给模型看的——它靠这句话决定把活派给谁,不是写给你自己看的备注
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className={cn(FIELD, "flex-1")}>
          <label className={LABEL}>模型</label>
          <div className="flex items-center gap-2">
            <ModelPicker
              value={draft.effectiveModel}
              onChange={draft.pinModel}
              disabled={readOnly}
              placeholder="跟随主会话"
              className="border border-border rounded-md px-2 py-1"
            />
            {draft.modelPinned && !readOnly && (
              <button
                type="button"
                className="press-scale text-muted-foreground hover:text-foreground text-[11px] shrink-0"
                onClick={draft.unpinModel}
              >
                跟随主会话
              </button>
            )}
          </div>
          <p className={HINT}>不碰 = 跟主会话当前用的型号走</p>
        </div>

        <div className={cn(FIELD, "flex-1")}>
          <label className={LABEL}>Thinking</label>
          <div className="flex items-center gap-2">
            <ThinkingPicker
              spec={draft.spec}
              value={draft.effectiveThinking}
              onChange={draft.pinThinking}
              disabled={readOnly}
            />
            {!draft.thinkingSwitchable && (
              <span className={HINT}>{draft.modelLabel} 没有可换的挡位</span>
            )}
            {draft.thinkingPinned && !readOnly && draft.thinkingSwitchable && (
              <button
                type="button"
                className="press-scale text-muted-foreground hover:text-foreground text-[11px] shrink-0"
                onClick={draft.unpinThinking}
              >
                跟随型号默认档
              </button>
            )}
          </div>
          <p className={HINT}>不碰 = 跟这个型号的默认档走</p>
        </div>
      </div>

      <div className={FIELD}>
        <label className={LABEL}>工具</label>
        <div className="flex flex-wrap gap-[6px]">
          {toolOptions.map((t) => {
            const checked = draft.tools.includes(t.name);
            return (
              <button
                key={t.name}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={readOnly}
                title={t.description}
                className={cn(PILL, checked ? PILL_ON : PILL_OFF)}
                onClick={() =>
                  draft.setTools((prev) =>
                    checked ? prev.filter((n) => n !== t.name) : [...prev, t.name]
                  )
                }
              >
                {t.name}
              </button>
            );
          })}
        </div>
        {draft.blockedByEmptyTools ? (
          <p className={ERR_TXT}>
            至少留一把工具——一把都不选存下去,文件里那行 tools: 会是空的,解析器读不到值,下次打开又变回缺省工具集
          </p>
        ) : (
          <p className={HINT}>{draft.tools.length} 把已选</p>
        )}
      </div>

      <div className={FIELD}>
        <label className={LABEL}>审批</label>
        <div role="radiogroup" aria-label="审批档" className={SEG_GROUP}>
          {APPROVAL_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={draft.approval === o.value}
              disabled={readOnly}
              className={cn(SEG_ITEM, draft.approval === o.value ? SEG_ON : SEG_OFF)}
              onClick={() => draft.setApproval(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className={HINT}>
          子智能体没人盯着,默认拒绝——「问我」会把危险操作的审批卡弹给你,「自动放行」全部放行
        </p>
      </div>

      <div className={FIELD}>
        <label className={LABEL}>前置词</label>
        <div role="radiogroup" aria-label="前置词" className={SEG_GROUP}>
          {PREAMBLE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={draft.preambleMode === o.value}
              disabled={readOnly}
              className={cn(SEG_ITEM, draft.preambleMode === o.value ? SEG_ON : SEG_OFF)}
              onClick={() => draft.setPreambleMode(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {draft.preambleMode === "custom" ? (
          <>
            <Textarea
              value={draft.preambleText}
              disabled={readOnly}
              onChange={(e) => draft.setPreambleText(e.target.value)}
              className="font-mono text-[12.5px] min-h-24"
              placeholder="这一段会替代全局前置词，只对这个子智能体生效"
            />
            {draft.blockedByBlankPreamble && (
              <p className={ERR_TXT}>
                自定义前置词不能是空的——空的存下去读回来是「用全局」，等于把全局那段又加了回去。要一段都不加就选「不加」
              </p>
            )}
          </>
        ) : (
          <p className={HINT}>
            {draft.preambleMode === "off"
              ? "一段前置词都不加——它连「最终一段文本就是返回值」这条都不知道，正文里要自己写清楚"
              : "用上面那份全局前置词"}
          </p>
        )}
      </div>

      <div className={FIELD}>
        <label className={LABEL}>工作区文档</label>
        <div className="flex flex-wrap gap-[6px]">
          {CONTEXT_FILES.map((f) => {
            const checked = draft.context.includes(f);
            return (
              <button
                key={f}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={readOnly}
                className={cn(PILL, checked ? PILL_ON : PILL_OFF)}
                onClick={() =>
                  draft.setContext((prev) =>
                    checked ? prev.filter((n) => n !== f) : [...prev, f]
                  )
                }
              >
                {f}
              </button>
            );
          })}
        </div>
        <p className={HINT}>
          派活时按会话所在的工程读这些文件，拼在正文前面；读不到就跳过。
          用户级的子智能体也能勾——它在哪个工程里被派出去，读的就是哪个工程的。
        </p>
      </div>

      <div className={FIELD}>
        <label className={LABEL}>正文</label>
        <Textarea
          value={draft.instructions}
          disabled={readOnly}
          onChange={(e) => draft.setInstructions(e.target.value)}
          className="font-mono text-[12.5px] min-h-40"
          placeholder="system prompt 本体（前置词在上面单独配，这里不用重复写「你是一个子智能体」之类的话）"
        />
      </div>
    </>
  );
}
