// 子智能体栏目（设置页）—— SkillsPage 的可写版兄弟：Skill 库是"看磁盘上有什么"，
// 这里是"编辑磁盘上的文件"。frontmatter 本来就是结构化数据，配控件正合适
// （模型/挡位直接复用 ModelPicker / ThinkingPicker，工具白名单是一排 checkbox）；
// 只有 instructions（正文）是自由文本，配 textarea。
//
// 头部那个作用域下拉决定这一页在编哪一层的文件：「用户」= ~/.otter/agents，
// 选中某个工程 = 它自己的 <工程>/.otter/agents（ADR-0048）。它不是筛选器，
// 是"当前编辑的那一层"——新建、保存、复制都落在它指的地方。
//
// 两处退让的是后端已知、记录在案、故意不在这里治的限制（各自的注释里说明）：
//   ① 零工具的子智能体存不下来（序列化成空 tools: 行，解析器直接丢掉整行，
//      落地后变回缺省工具集）—— 这里挡在保存前，不让用户存出一个"看起来选了空、
//      实际读回来是缺省"的文件。
//   ② 名字只能用 [A-Za-z0-9_-]（它要变成磁盘上的文件名，也是模型调 task 时要
//      打出来的词）。真正的把关在主进程（IPC 边界之内，review I6），这里调
//      同一个 shared 的 subagentNameError 只为"别让请求白跑一趟"。

import { useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { ModelPicker } from "./ModelPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { useChat } from "../store.js";
import { useModelChoice, thinkingSpecOf } from "../lib/useModelChoice.js";
import { describeModel } from "../../../shared/modelCatalog.js";
import { clampThinking, thinkingSwitchable } from "../../../shared/thinking.js";
import type { SubagentDef } from "../../../shared/shellBridge.js";
import {
  subagentNameError,
  type SubagentApproval,
  type SubagentPreamble,
} from "../../../shared/subagent.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { subagentScopeOptions } from "../lib/subagentScopes.js";

const ERR_TXT = "text-err text-[13px]";

/** 一把工具都不选会撞上后端限制①：写出一行空 `tools:`，解析器读不到值就整行
    丢掉，落地后悄悄变回缺省工具集——跟用户在界面上看到的"我选了 0 把"对不上。
    选择是挡住，不是静默兜底：用户存的应该是他勾的那份，不是解析器猜的那份 */
function toolsWillCollapse(selected: string[]): boolean {
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
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 把勾选结果排成 CONTEXT_FILES 的顺序。顺序会进模型:readContextDocs 按数组序
    读盘,拼在正文前面的先后就是这个数组的先后。不归一的话它是点击顺序的副产品
    ——取消勾选再勾回来,内容一模一样却换了个次序,而 dirty 是按集合比的,
    这份被打乱的数组会搭着下一次无关的保存写进文件。
    界面外手写的 basename 解析器照样认(只是这里没有勾选框),原样接在后面,
    不能在保存时被吃掉 */
function canonicalContext(names: readonly string[]): string[] {
  const known: readonly string[] = CONTEXT_FILES;
  return [...known.filter((f) => names.includes(f)), ...names.filter((n) => !known.includes(n))];
}

export function SubagentSettings() {
  const subagents = useChat((s) => s.subagents);
  const refreshSubagents = useChat((s) => s.refreshSubagents);
  const refreshSubagentPreamble = useChat((s) => s.refreshSubagentPreamble);
  const closeSettings = useChat((s) => s.closeSettings);
  const sessions = useChat((s) => s.sessions);
  const scope = useChat((s) => s.subagentScope);
  const setScope = useChat((s) => s.setSubagentScope);
  const [newOpen, setNewOpen] = useState(false);
  // 拉清单/拉前置词失败要说出来。不说的话:清单失败 = 页面理直气壮地写"还没定义
  // 任何子智能体"(而工作区那一层永远并着用户级那些,空清单本身就可疑),
  // 前置词失败 = 整张卡凭空消失。这正是上一个提交刚修掉的那个形状
  const [listError, setListError] = useState<string | null>(null);
  const [preambleError, setPreambleError] = useState<string | null>(null);

  const scopeOptions = useMemo(() => subagentScopeOptions(sessions), [sessions]);
  const current = scopeOptions.find((o) => o.workspace === scope) ?? scopeOptions[0]!;
  // 页面上所有跟作用域有关的字都从 current 取,不从 store 里那个 scope 取:
  // 两者对不上时(见下面那个 effect)下拉显示的是 current,底下的路径也该是 current,
  // 不然这一帧里页面说的是一层、编的是另一层
  const scopeDir = current.workspace ? `${current.workspace}/.otter/agents` : "~/.otter/agents";

  const switchScope = (workspace: string | null) => {
    setListError(null);
    setScope(workspace).catch((e: unknown) => setListError(bridgeErrorMessage(e)));
  };

  // 一个工作区的最后一条会话被删掉,它就从候选里消失了,但 store 里那个路径还留着:
  // 下拉框回落显示「用户」,底下的提示却还指着那条死路径,「新建」也落在用户级
  // (主进程不认一个不可信的路径)。而且这个错状态自己清不掉——选「用户」不触发
  // onChange,它已经是当前显示值了。所以查不到就把 store 拨回用户级
  useEffect(() => {
    if (scope !== null && current.workspace !== scope) {
      setScope(null).catch((e: unknown) => setListError(bridgeErrorMessage(e)));
    }
  }, [scope, current.workspace, setScope]);

  useEffect(() => {
    setListError(null);
    setPreambleError(null);
    refreshSubagents().catch((e: unknown) => setListError(bridgeErrorMessage(e)));
    refreshSubagentPreamble().catch((e: unknown) => setPreambleError(bridgeErrorMessage(e)));
  }, [refreshSubagents, refreshSubagentPreamble]);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px] flex-1">子智能体</span>
        <label className="sr-only" htmlFor="subagent-scope">作用域</label>
        <select
          id="subagent-scope"
          value={current.workspace ?? ""}
          onChange={(e) => switchScope(e.target.value === "" ? null : e.target.value)}
          className="press-scale border border-border rounded-md bg-card px-2 py-1 text-[12.5px] text-foreground transition-colors duration-150"
          title={current.workspace ?? "所有工程都能用的那一层"}
        >
          {scopeOptions.map((o) => (
            <option key={o.workspace ?? "user"} value={o.workspace ?? ""}>
              {o.label}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="size-3.5" />
          新建
        </Button>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          主 agent 靠 <code>task</code> 工具把子任务派给这里定义的某一个子智能体。
          「用户」这一层处处可用；选中某个工程时看到的是它自己那一层（
          <code>&lt;工程&gt;/.otter/agents/</code>），只在该工程的会话里派得出去，
          同名时盖过用户级那份。子智能体没人盯着屏幕，审批档缺省是「直接拒绝」。
        </p>
        {current.workspace && (
          <p className={cn(HINT, "font-mono text-[11px]")}>{current.workspace}</p>
        )}
        {listError && <p className={ERR_TXT}>{listError}</p>}
        {preambleError && <p className={ERR_TXT}>读不到全局前置词：{preambleError}</p>}
        <GlobalPreambleCard />
        {subagents.length === 0 && !listError && (
          <div className="border border-dashed border-border rounded-[10px] px-[18px] py-8 flex flex-col items-center gap-3 text-center">
            <p className="text-[13px] text-foreground">还没定义任何子智能体</p>
            <p className={cn(HINT, "max-w-[420px]")}>
              点右上角「新建」起一个，或者手写一份 <code>&lt;名字&gt;.md</code>
              （带 YAML frontmatter）放进 <code>{scopeDir}</code>。主 agent
              靠每个子智能体的 description 挑人——写清楚它是干什么的，模型才派得对。
            </p>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
        )}
        {subagents.map((def) => (
          <SubagentRow key={def.path} def={def} scopeLabel={current.label} scopeDir={scopeDir} />
        ))}
      </section>
      <NewSubagentDialog open={newOpen} onOpenChange={setNewOpen} scopeLabel={current.label} />
    </div>
  );
}

function NewSubagentDialog({
  open,
  onOpenChange,
  scopeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前作用域的短名——建出来的文件落在哪一层，弹窗里得先说清楚，
      不然用户在工程 A 建的东西到了工程 B 就不见了，看上去像丢了 */
  scopeLabel: string;
}) {
  const createSubagent = useChat((s) => s.createSubagent);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开都是新鲜的草稿——上一次没提交完的名字不该在下一次弹出时还在
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    // 与主进程同一条规则（shared 的 subagentNameError）：两边各写一条正则
    // 迟早分家,曾经就是这么破的——渲染层挡住了中文,主进程那侧把中文 replace
    // 成 "-",于是"搜索员"塌成"---"照样建了出来
    const nameError = subagentNameError(trimmed);
    if (nameError) {
      setError(nameError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSubagent(trimmed);
      onOpenChange(false);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>新建子智能体</DialogTitle>
          <DialogDescription>
            先起个名字，其余字段（description / 工具 / 审批档 / 前置词 / 正文）建好之后在列表里展开填。
            建在<b>{scopeLabel}</b>这一层。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-[6px]">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 code-reviewer"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {error && <p className={ERR_TXT}>{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || name.trim() === ""} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubagentRow({
  def,
  scopeLabel,
  scopeDir,
}: {
  def: SubagentDef;
  /** 当前作用域的短名 —— 「复制到…」那颗按钮要说清文件会落在哪一层 */
  scopeLabel: string;
  /** 当前作用域对应的目录,进按钮的 title */
  scopeDir: string;
}) {
  const mainModel = useChat((s) => s.model);
  const toolDefs = useChat((s) => s.toolDefs);
  const saveSubagent = useChat((s) => s.saveSubagent);
  const createSubagent = useChat((s) => s.createSubagent);

  // task 不进选项:子 agent 不能再派子 agent 是设计边界(main/subagents.ts 解析时
  // 就已经把它从 tools 里剔除了),但 toolDefs 是"此刻挂载的工具表",task 本身
  // 只要清单不空就会挂在里头、混进这份表——这里显式滤掉
  const toolOptions = useMemo(() => toolDefs.filter((t) => t.name !== "task"), [toolDefs]);

  const [description, setDescription] = useState(def.description);
  const [instructions, setInstructions] = useState(def.instructions);
  const [tools, setTools] = useState<string[]>(def.tools);
  const [approval, setApproval] = useState<SubagentApproval>(def.approval);
  // "定过 = pin":没碰过就跟着主会话/型号默认走,碰过就是这个 subagent 自己的选择。
  // 用触碰状态代替一枚"跟随"复选框——设置页的克制原则,少一件要点的东西
  const [modelPinned, setModelPinned] = useState(def.model !== undefined);
  const [modelValue, setModelValue] = useState(def.model ?? mainModel);
  const [thinkingPinned, setThinkingPinned] = useState(def.thinking !== undefined);
  const [thinkingValue, setThinkingValue] = useState(def.thinking);
  const [preambleMode, setPreambleMode] = useState<SubagentPreamble["mode"]>(def.preamble.mode);
  const [preambleText, setPreambleText] = useState(
    def.preamble.mode === "custom" ? def.preamble.text : ""
  );
  const [context, setContext] = useState<string[]>(def.context);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copiedAs, setCopiedAs] = useState<string | null>(null);

  const effectiveModel = modelPinned ? modelValue : mainModel;
  const modelChoice = useModelChoice(effectiveModel);
  const spec = thinkingSpecOf(modelChoice);
  const effectiveThinking = thinkingPinned && thinkingValue
    ? clampThinking(thinkingValue, spec)
    : spec.default;

  // custom 但正文是空的 = 等同于没覆盖,存成 default——否则文件里会留一个空块标量,
  // 读回来又变成 default,界面上那个"自定义"档下次打开就自己跳回去了
  const preamble: SubagentPreamble =
    preambleMode === "custom" && preambleText.trim()
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

  const modelLabel = describeModel(effectiveModel)?.label ?? effectiveModel;

  const resetDraft = () => {
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
    setSaveError(null);
  };

  const save = async () => {
    if (blockedByEmptyTools) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSubagent({
        name: def.name,
        description,
        instructions,
        tools,
        unknownTools: def.unknownTools,
        approval,
        preamble,
        context: contextDraft,
        scope: def.scope,
        path: def.path,
        source: def.source,
        readOnly: def.readOnly,
        ...(modelPinned ? { model: modelValue } : {}),
        ...(thinkingPinned && thinkingSwitchable(spec) ? { thinking: effectiveThinking } : {}),
      });
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const copyToOtterAgents = async () => {
    // 复制目标名字加个后缀,不试图沿用原名——原名此刻已经被这份只读记录占着,
    // createSubagent 会因为撞名直接拒绝(main/index.ts 的查重就是照着"当前完整清单"查的)
    const copyName = `${def.name}-copy`;
    setCopying(true);
    setCopyError(null);
    setCopiedAs(null);
    try {
      await createSubagent(copyName);
      // path/source/readOnly 必须来自刚建出来那份的磁盘现状,不能沿用 def(那是原本
      // 那份只读记录的路径)。saveSubagent 的 IPC handler 会按 name 重新查一遍磁盘、
      // 拿查到的 path/source/readOnly 覆盖请求体里的同名字段,所以这里传什么值都不会
      // 被后端采信——但组件自己的代码不该装作"知道"一个它其实没查过的路径,
      // 那样的正确性系着一个类型契约没承诺过的后端实现细节,下一个读这段代码的人
      // 会学到错的教训。查不到就报错,不回退去用 def 的旧字段
      const created = useChat.getState().subagents.find((d) => d.name === copyName);
      if (!created) {
        setCopyError(`创建后没能在清单里找到「${copyName}」，请重试`);
        return;
      }
      await saveSubagent({
        name: copyName,
        description: def.description,
        instructions: def.instructions,
        tools: def.tools,
        unknownTools: def.unknownTools,
        approval: def.approval,
        preamble: def.preamble,
        context: def.context,
        scope: created.scope,
        path: created.path,
        source: created.source,
        readOnly: created.readOnly,
        ...(def.model ? { model: def.model } : {}),
        ...(def.thinking ? { thinking: def.thinking } : {}),
      });
      setCopiedAs(copyName);
    } catch (e) {
      setCopyError(bridgeErrorMessage(e));
    } finally {
      setCopying(false);
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(def.path);
    } catch {
      // 剪贴板权限被拒/不可用:静默失败——这只是个便利动作,不值得再弹一条错误
    }
  };

  return (
    <details
      className="border border-border rounded-[10px]"
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => {
        // 收起时把没保存的改动扔掉:草稿只活在展开期间,再打开是从磁盘现状重新开始,
        // 不是"上次编辑到一半的样子"——那样才不会有一份看不见的脏状态悬在关着的行里
        if (!e.currentTarget.open) resetDraft();
      }}
    >
      <summary className="flex items-baseline gap-[10px] px-[14px] py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{def.name}</span>
        {def.readOnly && (
          <Badge variant="secondary" className="shrink-0">只读</Badge>
        )}
        {def.unknownTools.length > 0 && (
          <Badge
            variant="outline"
            className="shrink-0 text-muted-foreground"
            title={`认不出的工具名：${def.unknownTools.join("、")}`}
          >
            {def.unknownTools.length} 个工具名无法识别
          </Badge>
        )}
        <span className="text-muted-foreground text-[12.5px] flex-1 min-w-0 truncate">
          {def.description || "（还没写 description）"}
        </span>
        <span className="text-muted-foreground text-[11px] shrink-0 font-mono">
          {modelLabel} · {def.tools.length} 把工具
        </span>
      </summary>

      <div className="flex flex-col gap-4 px-[14px] py-4 border-t border-border">
        {/* description:全表唯一写给模型看的字段——task 工具把它塞进 def 里,
            模型靠这句话挑人。用户当成给自己看的备注来写,模型就会挑错人 */}
        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
            Description
          </label>
          <Input
            value={description}
            disabled={def.readOnly}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个子智能体是干什么的、什么时候该派给它"
          />
          <p className={HINT}>这句话是写给模型看的——它靠这句话决定把活派给谁,不是写给你自己看的备注</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 flex flex-col gap-[6px]">
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">模型</label>
            <div className="flex items-center gap-2">
              <ModelPicker
                value={effectiveModel}
                onChange={(m) => {
                  setModelValue(m);
                  setModelPinned(true);
                }}
                disabled={def.readOnly}
                className="border border-border rounded-md px-2 py-1"
              />
              {modelPinned && !def.readOnly && (
                <button
                  type="button"
                  className="press-scale text-muted-foreground hover:text-foreground text-[11px] shrink-0"
                  onClick={() => {
                    setModelPinned(false);
                    setModelValue(mainModel);
                  }}
                >
                  跟随主会话
                </button>
              )}
            </div>
            <p className={HINT}>不碰 = 跟主会话当前用的型号走</p>
          </div>

          <div className="flex-1 flex flex-col gap-[6px]">
            <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">Thinking</label>
            <div className="flex items-center gap-2">
              <ThinkingPicker
                spec={spec}
                value={effectiveThinking}
                onChange={(m) => {
                  setThinkingValue(m);
                  setThinkingPinned(true);
                }}
                disabled={def.readOnly}
              />
              {!thinkingSwitchable(spec) && (
                <span className={HINT}>{modelLabel} 没有可换的挡位</span>
              )}
              {thinkingPinned && !def.readOnly && thinkingSwitchable(spec) && (
                <button
                  type="button"
                  className="press-scale text-muted-foreground hover:text-foreground text-[11px] shrink-0"
                  onClick={() => setThinkingPinned(false)}
                >
                  跟随型号默认档
                </button>
              )}
            </div>
            <p className={HINT}>不碰 = 跟这个型号的默认档走</p>
          </div>
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">工具</label>
          <div className="flex flex-wrap gap-[6px]">
            {toolOptions.map((t) => {
              const checked = tools.includes(t.name);
              return (
                <button
                  key={t.name}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={def.readOnly}
                  title={t.description}
                  className={cn(
                    "press-scale rounded-full border px-[10px] py-[3px] text-[12px] font-mono transition-colors duration-150 disabled:opacity-50",
                    checked
                      ? "border-transparent bg-foreground/[0.10] text-foreground font-[550]"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() =>
                    setTools((prev) =>
                      checked ? prev.filter((n) => n !== t.name) : [...prev, t.name]
                    )
                  }
                >
                  {t.name}
                </button>
              );
            })}
          </div>
          {blockedByEmptyTools ? (
            <p className={ERR_TXT}>至少留一把工具——一把都不选存下去,文件里那行 tools: 会是空的,解析器读不到值,下次打开又变回缺省工具集</p>
          ) : (
            <p className={HINT}>{tools.length} 把已选</p>
          )}
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">审批</label>
          <div
            role="radiogroup"
            aria-label="审批档"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1 w-fit"
          >
            {APPROVAL_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={approval === o.value}
                disabled={def.readOnly}
                className={cn(
                  "press-scale rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors duration-150 disabled:opacity-50",
                  approval === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setApproval(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className={HINT}>子智能体没人盯着,默认拒绝——「问我」会把危险操作的审批卡弹给你,「自动放行」全部放行</p>
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
            前置词
          </label>
          <div
            role="radiogroup"
            aria-label="前置词"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1 w-fit"
          >
            {PREAMBLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={preambleMode === o.value}
                disabled={def.readOnly}
                className={cn(
                  "press-scale rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors duration-150 disabled:opacity-50",
                  preambleMode === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setPreambleMode(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {preambleMode === "custom" ? (
            <Textarea
              value={preambleText}
              disabled={def.readOnly}
              onChange={(e) => setPreambleText(e.target.value)}
              className="font-mono text-[12.5px] min-h-24"
              placeholder="这一段会替代全局前置词，只对这个子智能体生效"
            />
          ) : (
            <p className={HINT}>
              {preambleMode === "off"
                ? "一段前置词都不加——它连「最终一段文本就是返回值」这条都不知道，正文里要自己写清楚"
                : "用上面那份全局前置词"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
            工作区文档
          </label>
          <div className="flex flex-wrap gap-[6px]">
            {CONTEXT_FILES.map((f) => {
              const checked = context.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={def.readOnly}
                  className={cn(
                    "press-scale rounded-full border px-[10px] py-[3px] text-[12px] font-mono transition-colors duration-150 disabled:opacity-50",
                    checked
                      ? "border-transparent bg-foreground/[0.10] text-foreground font-[550]"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() =>
                    setContext((prev) => (checked ? prev.filter((n) => n !== f) : [...prev, f]))
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

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">正文</label>
          <Textarea
            value={instructions}
            disabled={def.readOnly}
            onChange={(e) => setInstructions(e.target.value)}
            className="font-mono text-[12.5px] min-h-40"
            placeholder="system prompt 本体（前置词在上面单独配，这里不用重复写「你是一个子智能体」之类的话）"
          />
        </div>

        {saveError && <p className={ERR_TXT}>{saveError}</p>}
        {copyError && <p className={ERR_TXT}>{copyError}</p>}
        {copiedAs && (
          <p className={HINT}>已复制为「{copiedAs}」，在下面的列表里可以找到并编辑</p>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={def.readOnly || !dirty || saving || blockedByEmptyTools}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : dirty ? "保存" : "已保存"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void copyPath()} title={def.path}>
            复制路径
          </Button>
          {def.readOnly && (
            <Button
              variant="outline"
              size="sm"
              disabled={copying}
              title={scopeDir}
              onClick={() => void copyToOtterAgents()}
            >
              {copying ? "复制中…" : `复制到${scopeLabel}这一层`}
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}

/** 全局前置词 —— 拼在每个子智能体正文前面的那一段。单个子智能体可以覆盖它。
    「恢复默认」是删文件不是写一份等于默认的内容:以后内置默认那段改了,
    只有真的删掉文件的人才会跟着更新 */
function GlobalPreambleCard() {
  const state = useChat((s) => s.subagentPreamble);
  const savePreamble = useChat((s) => s.saveSubagentPreamble);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 后端回来的状态是这个输入框的真相来源；用户改到一半时不要被它冲掉,
  // 所以只在"这一份状态是新的"时同步（用 isDefault + text 一起当身份）
  useEffect(() => {
    if (state) setDraft(state.text);
  }, [state?.text, state?.isDefault]);

  if (!state) return null;

  const dirty = draft.trim() !== state.text.trim();

  const run = async (text: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await savePreamble(text);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border rounded-[10px] px-[14px] py-4 flex flex-col gap-[6px]">
      <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
        全局前置词
      </label>
      <p className={HINT}>
        拼在每个子智能体正文前面；单个子智能体可以在下面覆盖它。存在{" "}
        <code>~/.otter/subagent-preamble.md</code>，也可以直接用编辑器改。
      </p>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="font-mono text-[12.5px] min-h-32"
      />
      {error && <p className={ERR_TXT}>{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || busy} onClick={() => void run(draft)}>
          {busy ? "保存中…" : dirty ? "保存" : "已保存"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.isDefault || busy}
          onClick={() => void run(null)}
        >
          恢复默认
        </Button>
        <span className={HINT}>{state.isDefault ? "用的是内置默认" : "已自定义"}</span>
      </div>
    </div>
  );
}
