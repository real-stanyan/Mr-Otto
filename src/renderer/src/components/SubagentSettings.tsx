// 子智能体栏目（设置页）—— SkillsPage 的可写版兄弟：Skill 库是"看磁盘上有什么"，
// 这里是"编辑磁盘上的文件"。frontmatter 本来就是结构化数据，配控件正合适
// （模型/挡位直接复用 ModelPicker / ThinkingPicker，工具白名单是一排 checkbox）；
// 只有 instructions（正文）是自由文本，配 textarea。
//
// 头部那个作用域下拉决定这一页在编哪一层的文件：「用户」= ~/.otter/agents，
// 选中某个工程 = 它自己的 <工程>/.otter/agents（ADR-0048）。它不是筛选器，
// 是"当前编辑的那一层"——新建、保存、复制都落在它指的地方。
//
// 这一栏有两个视图：列表，和「新建」整页（NewSubagentPage）。新建不是弹窗——
// 它要填的是和列表行展开后一模一样的九个字段，弹窗装不下，也不该装（理由写在
// NewSubagentPage 的头注里）。字段控件两处共用 SubagentFields。
//
// 一处退让的是后端已知、记录在案、故意不在这里治的限制：名字只能用 [A-Za-z0-9_-]
// （它要变成磁盘上的文件名，也是模型调 task 时要打出来的词）。真正的把关在主进程
// （IPC 边界之内，review I6），渲染层调同一个 shared 的 subagentNameError
// 只为"别让请求白跑一趟"。

import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { NewSubagentPage } from "./NewSubagentPage.js";
import { SubagentFields, useSubagentDraft, ERR_TXT } from "./SubagentFields.js";
import { SubagentScopeSelect } from "./SubagentScopeSelect.js";
import { useChat } from "../store.js";
import type { SubagentDef } from "../../../shared/shellBridge.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { freeCopyName, initialSubagentScope } from "../lib/subagentScopes.js";
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
  const closeSettings = useChat((s) => s.closeSettings);
  const workspace = useChat((s) => s.workspace);
  const scope = useChat((s) => s.subagentScope);
  const view = useSubagentScope();
  const setScope = view.setScope;
  const [creating, setCreating] = useState(false);
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

  if (creating) {
    return (
      <NewSubagentPage
        scope={view}
        onDone={() => setCreating(false)}
        onCancel={() => setCreating(false)}
      />
    );
  }

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px] flex-1">子智能体</span>
        <label className="sr-only" htmlFor="subagent-scope">作用域</label>
        <SubagentScopeSelect scope={view} />
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          新建
        </Button>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
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
              随 app 一起发的，不在磁盘上，删不掉也改不了。想改就点「改成我自己的一份」——
              会在<b>{view.current.label}</b>这一层写出一份同名定义盖住它，
              从此它是你的（代价：以后升级改了内置的正文或工具集，你这份跟不上）。
              审批档是「跟随主会话」：你开了免审批它就免审批，没开就把卡弹给你。
            </p>
            {builtins.map((def) => (
              <BuiltinSubagentRow key={`builtin:${def.name}`} def={def} scope={view} />
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
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
        )}
        {own.map((def) => (
          <SubagentRow key={def.path} def={def} scope={view} />
        ))}
      </section>
    </div>
  );
}

function SubagentRow({ def, scope }: { def: SubagentDef; scope: SubagentScopeView }) {
  const saveSubagent = useChat((s) => s.saveSubagent);
  const draft = useSubagentDraft(def);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copiedAs, setCopiedAs] = useState<string | null>(null);

  const save = async () => {
    if (draft.blocked) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSubagent({
        name: def.name,
        ...draft.payload(),
        scope: def.scope,
        path: def.path,
        source: def.source,
        readOnly: def.readOnly,
      });
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const copyToOtterAgents = async () => {
    // 复制目标名字加个后缀。同名其实建得出来了——9a28e84 之后查重只问"落点那一层
    // 占了没",不问合并清单(工作区盖住同名的用户级那份正是覆盖规则的用法)。
    // 这里仍然加后缀,是个选择不是限制:「复制到本层」的意思是多一份能改的副本,
    // 不是把眼前这份从清单里顶掉;顶掉该是用户明说的动作,不是点了「复制」的副作用
    // 名字挑一个当前没被占的:第一次点击可能已经把 -copy 建出来了(内容还没抄过去,
    // 比如中途切了作用域),写死 -copy 的话"再点一次"撞的就是自己刚建的那个空壳,
    // 是一条走不通的路
    const copyName = freeCopyName(def.name, useChat.getState().subagents.map((d) => d.name));
    setCopying(true);
    setCopyError(null);
    setCopiedAs(null);
    // 抄的是**磁盘现状**(def)而不是草稿:这一行是只读的,展开时那些控件也是只读的,
    // 用户没有过"改了但没存"这种状态
    const err = await createSubagentFile({
      name: copyName,
      fields: fileFieldsOf(def),
      scopeLabel: scope.current.label,
      scopeDir: scope.scopeDir,
    });
    setCopyError(err);
    if (!err) setCopiedAs(copyName);
    setCopying(false);
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
        if (!e.currentTarget.open) {
          draft.reset();
          setSaveError(null);
        }
      }}
    >
      <summary className="flex items-baseline gap-[10px] px-[14px] py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{def.name}</span>
        {scope.showScope && (
          <Badge
            variant="outline"
            className="shrink-0 text-muted-foreground"
            title={`来自 ${def.source}`}
          >
            {def.scope === "workspace" ? "工作区" : "用户"}
          </Badge>
        )}
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
          {draft.modelLabel} · {def.tools.length} 把工具
        </span>
      </summary>

      <div className="flex flex-col gap-4 px-[14px] py-4 border-t border-border">
        <SubagentFields draft={draft} readOnly={def.readOnly} />

        {saveError && <p className={ERR_TXT}>{saveError}</p>}
        {copyError && <p className={ERR_TXT}>{copyError}</p>}
        {copiedAs && (
          <p className={HINT}>已复制为「{copiedAs}」，在下面的列表里可以找到并编辑</p>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={def.readOnly || !draft.dirty || saving || draft.blocked}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : draft.dirty ? "保存" : "已保存"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void copyPath()} title={def.path}>
            复制路径
          </Button>
          {def.readOnly && (
            <Button
              variant="outline"
              size="sm"
              disabled={copying}
              title={scope.scopeDir}
              onClick={() => void copyToOtterAgents()}
            >
              {copying ? "复制中…" : `复制到${scope.current.label}这一层`}
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}

/** 内置那一份的行。改不了，只有两个出口：换个模型，或者「改成我自己的一份」——
    两个都走同一条 materialize（在当前作用域写出一份同名定义盖住内置那份）。
    换模型也 materialize 是有代价的选择：一个下拉框顺手就在磁盘上留下了文件。
    换来的是内置这一层永远只有一种状态——代码里那份——而不是"代码里那份 + 一张
    谁也推导不出来的模型覆盖表"（事件日志是唯一事实来源，那张表不在日志里）。
    所以换完必须当场说清楚发生了什么，下面那句提示不是客套 */
function BuiltinSubagentRow({ def, scope }: { def: SubagentDef; scope: SubagentScopeView }) {
  const draft = useSubagentDraft(def);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const materialize = async (model?: string) => {
    setBusy(true);
    setError(null);
    setError(
      await createSubagentFile({
        name: def.name,
        ...(model ? { fields: fileFieldsOf(def, { model }) } : { fields: fileFieldsOf(def) }),
        scopeLabel: scope.current.label,
        scopeDir: scope.scopeDir,
      })
    );
    setBusy(false);
  };

  return (
    <details className="border border-border rounded-[10px]">
      <summary className="flex items-baseline gap-[10px] px-[14px] py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{def.name}</span>
        <Badge variant="secondary" className="shrink-0">内置</Badge>
        <span className="text-muted-foreground text-[12.5px] flex-1 min-w-0 truncate">
          {def.description}
        </span>
        <span className="text-muted-foreground text-[11px] shrink-0 font-mono">
          {def.tools.length} 把工具
        </span>
        {/* 摘要行里的控件:点它不该把这一行展开/收起（summary 的默认动作） */}
        <span
          className="shrink-0"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <ModelPicker
            value={draft.effectiveModel}
            onChange={(m) => void materialize(m)}
            disabled={busy}
            placeholder="跟随主会话"
            className="border border-border rounded-md px-2 py-1"
          />
        </span>
      </summary>

      <div className="flex flex-col gap-4 px-[14px] py-4 border-t border-border">
        <SubagentFields draft={draft} readOnly />
        {error && <p className={ERR_TXT}>{error}</p>}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void materialize()}>
            {busy ? "写入中…" : "改成我自己的一份"}
          </Button>
          <span className={HINT}>
            会在{scope.current.label}这一层写出 <code>{def.name}.md</code>，盖住内置那份
          </span>
        </div>
      </div>
    </details>
  );
}
