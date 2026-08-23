// 子智能体栏目（设置页）—— SkillsPage 的可写版兄弟：Skill 库是"看磁盘上有什么"，
// 这里是"编辑磁盘上的文件"。frontmatter 本来就是结构化数据，配控件正合适
// （模型/挡位直接复用 ModelPicker / ThinkingPicker，工具白名单是一排 checkbox）；
// 只有 instructions（正文）是自由文本，配 textarea。
//
// 头部那个作用域下拉决定这一页在编哪一层的文件：「用户」= ~/.mr-otto/agents，
// 选中某个工程 = 它自己的 <工程>/.mr-otto/agents（ADR-0048）。它不是筛选器，
// 是"当前编辑的那一层"——新建、保存、复制都落在它指的地方。
//
// 这一栏有三个视图：列表、「新建」整页（NewSubagentPage）、「编辑」整页
// （EditSubagentPage）。新建/编辑都不是弹窗也不是行内展开——九个字段弹窗装不下,
// 行内展开会把列表其它行推出屏幕（理由写在各自的头注里）。列表行只负责"挑哪一个"。
// 字段控件三处共用 SubagentFields。
//
// 一处退让的是后端已知、记录在案、故意不在这里治的限制：名字只能用 [A-Za-z0-9_-]
// （它要变成磁盘上的文件名，也是模型调 task 时要打出来的词）。真正的把关在主进程
// （IPC 边界之内，review I6），渲染层调同一个 shared 的 subagentNameError
// 只为"别让请求白跑一趟"。

import { useEffect, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { NewSubagentPage } from "./NewSubagentPage.js";
import { EditSubagentPage } from "./EditSubagentPage.js";
import { useSubagentDraft, ERR_TXT } from "./SubagentFields.js";
import { SubagentScopeSelect } from "./SubagentScopeSelect.js";
import { useChat } from "../store.js";
import type { SubagentDef } from "../../../shared/shellBridge.js";
import { initialSubagentScope } from "../lib/subagentScopes.js";
import { createSubagentFile, fileFieldsOf } from "../lib/createSubagentFile.js";
import { ModelPicker } from "./ModelPicker.js";
import { useSubagentScope, type SubagentScopeView } from "../lib/useSubagentScope.js";

export function SubagentSettings() {
  const subagents = useChat((s) => s.subagents);
  // 拉清单失败的说法住在 store 里(跟 subagents 同进同出),不再是这儿的 local state:
  // 组件摸不到"后来某次写入成功了"这件事,一条早就过期的报错会一直挂在一份已经好了的
  // 清单上头
  const listError = useChat((s) => s.subagentsError);
  const refreshSubagents = useChat((s) => s.refreshSubagents);
  const workspace = useChat((s) => s.workspace);
  const scope = useChat((s) => s.subagentScope);
  const view = useSubagentScope();
  const setScope = view.setScope;
  // 列表 / 新建 / 编辑。编辑页记的是 key 不是 def 对象:保存后清单重拉,def 会换引用,
  // 按 key 每次渲染重新从清单里找;找不到(被删了、切了作用域)就回列表
  const [page, setPage] = useState<{ kind: "list" } | { kind: "new" } | { kind: "edit"; key: string }>({
    kind: "list",
  });
  // 内置的和自己的分两栏:一份改得了、一份改不了,混在一起每行都得先看徽章
  const builtins = subagents.filter((d) => d.builtin);
  const own = subagents.filter((d) => !d.builtin);

  // 一个工作区的最后一条会话被删掉,它就从候选里消失了,但 store 里那个路径还留着:
  // 下拉框回落显示「用户」,底下的提示却还指着那条死路径,「新建」也落在用户级
  // (主进程不认一个不可信的路径)。而且这个错状态自己清不掉——选「用户」不触发
  // onChange,它已经是当前显示值了。所以查不到就把 store 拨回用户级。
  // 它得排在下面那个开页 effect **前面**:挂载这一轮它拿的是上一次开页留下的 scope,
  // 排在后面就会用那个陈旧值把开页刚落好的作用域又拨回用户级
  useEffect(() => {
    if (scope !== null && view.current.workspace !== scope) void setScope(null);
  }, [scope, view.current.workspace, setScope]);

  // 每次打开这一页都重新跟着"此刻在看的那个会话"落一次作用域(见 initialSubagentScope:
  // 恒定停在「用户」会把新建出来的文件推回全局命名空间)。
  // 只在挂载时跑一次:这是开页时的落点,不是一条跟着 workspace/候选表变的绑定——
  // 用户在这一页上手选过之后,不该被别处的会话切换把脚下这层抽走。
  // 两条拉清单的路都不抛,拉不到时把话写进 store 的 subagentsError
  useEffect(() => {
    const desired = initialSubagentScope(workspace, view.options);
    // 已经停在该停的那一层就只重扫一遍。setSubagentScope 会先把清单清空(换层时必须
    // 这么做,否则一瞬间显示的是上一层的内容),同一层也清一次的话,每次开页都要
    // 闪一下"还没定义任何子智能体"那张空卡
    if (desired === scope) void refreshSubagents();
    else void setScope(desired);
  }, []);

  const toList = () => setPage({ kind: "list" });
  if (page.kind === "new") {
    return <NewSubagentPage scope={view} onDone={toList} onCancel={toList} />;
  }
  if (page.kind === "edit") {
    const def = subagents.find((d) => rowKey(d) === page.key);
    if (def) return <EditSubagentPage key={page.key} def={def} scope={view} onBack={toList} />;
  }

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="agents" className="flex-1" />
        <label className="sr-only" htmlFor="subagent-scope">作用域</label>
        <SubagentScopeSelect scope={view} />
        <Button variant="outline" size="sm" onClick={() => setPage({ kind: "new" })}>
          <Plus className="size-3.5" />
          新建
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        {listError && <p className={ERR_TXT}>{listError}</p>}
        {/* 内置排在最上面:它是这一页唯一"打开就有东西"的那部分 —— 清单是空的新用户
            先看见的该是两个能用的,而不是一张"你还没定义任何子智能体"的空卡。
            同名的磁盘定义已经在 withBuiltins 里把它盖掉了,这里不会重复出现 */}
        {builtins.length > 0 && (
          <>
            <div className="flex items-baseline gap-2 pt-2">
              <h2 className="text-[13px] font-[650] text-foreground">内置子智能体</h2>
              <span className={HINT}>{builtins.length} 项</span>
            </div>
            <p className={HINT}>
              随 app 一起发的，不在磁盘上，删不掉也改不了；点开可以「改成我自己的一份」。
              审批档是「跟随主会话」：你开了免审批它就免审批，没开就把卡弹给你。
            </p>
            {builtins.map((def) => (
              <BuiltinSubagentRow
                key={rowKey(def)}
                def={def}
                scope={view}
                onOpen={() => setPage({ kind: "edit", key: rowKey(def) })}
              />
            ))}
          </>
        )}
        {/* 自己那一栏也带个标题:上面那栏有,这栏没有的话读起来像内置的续篇 */}
        <div className="flex items-baseline gap-2 pt-2">
          <h2 className="text-[13px] font-[650] text-foreground">我的子智能体</h2>
          <span className={HINT}>{own.length} 项</span>
        </div>
        {own.length === 0 && !listError && (
          <div className="border border-dashed border-border rounded-[10px] px-[18px] py-8 flex flex-col items-center gap-3 text-center">
            <p className="text-[13px] text-foreground">你还没定义自己的子智能体</p>
            <p className={cn(HINT, "max-w-[420px]")}>
              点右上角「新建」起一个，或者手写一份 <code>&lt;名字&gt;.md</code>
              （带 YAML frontmatter）放进 <code>{view.scopeDir}</code>。主 agent
              靠每个子智能体的 description 挑人——写清楚它是干什么的，模型才派得对。
            </p>
            <Button variant="outline" size="sm" onClick={() => setPage({ kind: "new" })}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
        )}
        {own.map((def) => (
          <SubagentRow
            key={rowKey(def)}
            def={def}
            scope={view}
            onOpen={() => setPage({ kind: "edit", key: rowKey(def) })}
          />
        ))}
      </section>
    </div>
  );
}


/** 列表行的身份:内置的没有 path,用名字;磁盘上的用 path(同名可以在两层各一份) */
function rowKey(def: SubagentDef): string {
  return def.builtin ? `builtin:${def.name}` : def.path;
}

const ROW =
  "w-full flex items-center gap-[10px] px-[14px] py-3 text-left border border-border rounded-[10px] transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function SubagentRow({
  def,
  scope,
  onOpen,
}: {
  def: SubagentDef;
  scope: SubagentScopeView;
  onOpen: () => void;
}) {
  const draft = useSubagentDraft(def);
  return (
    <button type="button" className={ROW} onClick={onOpen}>
      <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{def.name}</span>
      {scope.showScope && (
        <Badge variant="outline" className="shrink-0 text-muted-foreground" title={`来自 ${def.source}`}>
          {def.scope === "workspace" ? "工作区" : "用户"}
        </Badge>
      )}
      {def.readOnly && <Badge variant="secondary" className="shrink-0">只读</Badge>}
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
        {draft.modelLabel} · {def.tools.length} 把工具
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

/** 内置那一份的行。行上留一个模型下拉是快捷口:换模型 = 在当前作用域写出一份同名
    定义盖住内置那份(materialize)。一个下拉框顺手就在磁盘上留下了文件,是有代价的
    选择——换来的是内置这一层永远只有一种状态(代码里那份),而不是"代码里那份 +
    一张谁也推导不出来的模型覆盖表"(事件日志是唯一事实来源,那张表不在日志里)。
    所以换完必须当场说清楚发生了什么,底下那行提示不是客套 */
function BuiltinSubagentRow({
  def,
  scope,
  onOpen,
}: {
  def: SubagentDef;
  scope: SubagentScopeView;
  onOpen: () => void;
}) {
  const draft = useSubagentDraft(def);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState(false);

  const materialize = async (model: string) => {
    setBusy(true);
    setError(null);
    setWritten(false);
    const err = await createSubagentFile({
      name: def.name,
      fields: fileFieldsOf(def, { model }),
      scopeLabel: scope.current.label,
      scopeDir: scope.scopeDir,
    });
    setError(err);
    setWritten(!err);
    setBusy(false);
  };

  // 外层不是 <button>:行里嵌着 ModelPicker(本身是按钮),按钮套按钮是非法 DOM
  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        className={cn(ROW, "cursor-pointer")}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{def.name}</span>
        <Badge variant="secondary" className="shrink-0">内置</Badge>
        <span className="text-muted-foreground text-[12.5px] flex-1 min-w-0 truncate">
          {def.description}
        </span>
        <span className="text-muted-foreground text-[11px] shrink-0 font-mono">
          {def.tools.length} 把工具
        </span>
        {/* 行里的控件:点它不该进编辑页 */}
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <ModelPicker
            value={draft.effectiveModel}
            onChange={(m) => void materialize(m)}
            disabled={busy}
            placeholder="跟随主会话"
            className="border border-border rounded-md px-2 py-1"
          />
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      </div>
      {error && <p className={cn(ERR_TXT, "px-[14px] pt-1")}>{error}</p>}
      {written && (
        <p className={cn(HINT, "px-[14px] pt-1")}>
          已在{scope.current.label}这一层写出 <code>{def.name}.md</code>，盖住了内置那份
        </p>
      )}
    </div>
  );
}
