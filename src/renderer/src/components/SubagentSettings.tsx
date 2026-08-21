// Subagent 栏目（设置页）—— SkillsPage 的可写版兄弟：Skill 库是"看磁盘上有什么"，
// 这里是"编辑磁盘上的文件"。frontmatter 本来就是结构化数据，配控件正合适
// （模型/挡位直接复用 ModelPicker / ThinkingPicker，工具白名单是一排 checkbox）；
// 只有 instructions（正文）是自由文本，配 textarea。
//
// 两处退让的是后端已知、记录在案、故意不在这里治的限制（各自的注释里说明）：
//   ① 零工具的 subagent 存不下来（序列化成空 tools: 行，解析器直接丢掉整行，
//      落地后变回缺省工具集）—— 这里挡在保存前，不让用户存出一个"看起来选了空、
//      实际读回来是缺省"的文件。
//   ② createSubagent 把名字里非 [A-Za-z0-9_-] 的字符全部换成 "-"，中文名会
//      整个塌成一串"-"——新建对话框里先用同一条正则挡一遍，不让请求打到后端才发现。

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
import type { SubagentApproval } from "../../../shared/subagent.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";

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

export function SubagentSettings() {
  const subagents = useChat((s) => s.subagents);
  const refreshSubagents = useChat((s) => s.refreshSubagents);
  const closeSettings = useChat((s) => s.closeSettings);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    void refreshSubagents();
  }, [refreshSubagents]);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px] flex-1">Subagent</span>
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
          主 agent 靠 <code>task</code> 工具把子任务派给这里定义的某一个 subagent；
          每个都是 <code>~/.otter/agents/</code> 下的一份 <code>&lt;名字&gt;.md</code>
          （加 <code>~/.claude/agents/</code> 里只读的那些）。子 agent 没人盯着屏幕，
          审批档缺省是"直接拒绝"，不是"问我"。
        </p>
        {subagents.length === 0 && (
          <div className="border border-dashed border-border rounded-[10px] px-[18px] py-8 flex flex-col items-center gap-3 text-center">
            <p className="text-[13px] text-foreground">还没定义任何 subagent</p>
            <p className={cn(HINT, "max-w-[420px]")}>
              点右上角「新建」起一个，或者手写一份 <code>&lt;名字&gt;.md</code>
              （带 YAML frontmatter）放进 <code>~/.otter/agents</code>。主 agent 靠每个
              subagent 的 description 挑人——写清楚它是干什么的，模型才派得对。
            </p>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
        )}
        {subagents.map((def) => (
          <SubagentRow key={def.path} def={def} />
        ))}
      </section>
      <NewSubagentDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function NewSubagentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    // 后端限制②:createSubagent 会把非 [A-Za-z0-9_-] 的字符全换成 "-",中文名
    // 会整个塌成一串"-"。名字是模型派活时要打出来的那个词,必须先在这挡住,
    // 而不是让请求打过去、拿回一个塌成"---"的结果才发现
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      setError("名字只能用英文字母、数字、下划线、连字符——这是模型调 task 工具时要打出来的名字，中文会被后端整个改写成一串「-」");
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
          <DialogTitle>新建 subagent</DialogTitle>
          <DialogDescription>
            先起个名字，其余字段（description / 工具 / 审批档 / 正文）建好之后在列表里展开填。
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

function SubagentRow({ def }: { def: SubagentDef }) {
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

  const dirty =
    description !== def.description ||
    instructions !== def.instructions ||
    approval !== def.approval ||
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
            placeholder="这个 subagent 是干什么的、什么时候该派给它"
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
          <p className={HINT}>子 agent 没人盯着,默认拒绝——「问我」会把危险操作的审批卡弹给你,「自动放行」全部放行</p>
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">正文</label>
          <Textarea
            value={instructions}
            disabled={def.readOnly}
            onChange={(e) => setInstructions(e.target.value)}
            className="font-mono text-[12.5px] min-h-40"
            placeholder="system prompt 本体（runner 会在它前面拼一段内置前言，这里不用重复写「你是一个 subagent」之类的话）"
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
            <Button variant="outline" size="sm" disabled={copying} onClick={() => void copyToOtterAgents()}>
              {copying ? "复制中…" : "复制到 ~/.otter/agents"}
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}
