// WorkspaceAgentsTab —— 团队设置页「智能体」tab：建/改/删 @ 得着的那几只
// 水獭（issue #932 切片 1b，Task 7）。骨架照抄 WorkspacePage.tsx 的
// ConnectorsTab + ContributeConnectorDialog（同一份 ROW/SECTION_LABEL 令牌、
// 同一套二次确认惯例）。
//
// 权限矩阵钉在 workspaceView.ts 的 agentRows（spec §9）：canEdit = 建的人或
// owner，canDelete = canEdit 且不是种子管理员——admin 是每个团队开箱自带
// 的那份，这里没有删除钮。
//
// **编辑器 #1120 从弹窗变成推入页**：抽屉只有 420px，而那张弹窗写着
// `sm:max-w-[480px]`——它从来就装不下，靠 `92vw` 勉强缩着用。摊成一页之后
// #997/#998 那套「DialogContent 没有 max-h/overflow 兜底」的账在这一处自动清掉
// （页自己就是一个 `min-h-0` 的滚动区），头像也从 popover 摊回一整排。
//
// 保存钮**在页脚不在导航条**：导航条那一格由 `NavScreen.trailing` 给，而它是在
// 表单组件外面渲染的——要让它读得到 `canSave/busy` 得给 NavStack 加一层「每页
// 自己的 provider」。那是个说得通但更大的改动，这次没做（写在 ADR 的已知代价里）。

import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { InsetEmpty, InsetGroup, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useNav } from "@/components/ui/nav-stack.js";
import { useChat } from "../store.js";
import { agentRows } from "../lib/workspaceView.js";
import { AGENT_AVATARS, agentAvatarSrc, avatarPreviewSrc } from "../lib/agentAvatar.js";
import {
  AUTO_MODEL, agentModelOptions, chainWarning, modelsFromSelection, selectedModelValue,
} from "../lib/agentModelChoice.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { ProviderMark } from "./ProviderMark.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  connectorChoices, modeFromTools, staleSelections, toolsDraftError, toolsFromDraft, type ToolsMode,
} from "../lib/agentToolsForm.js";
import {
  isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool, type ProxySelection,
} from "../lib/proxyShare.js";
import { validateAgentName } from "../../../shared/workspaceAgents.js";
import { sameAgentTools } from "../../../shared/agentToolAllow.js";
import type { WorkspaceSnapshot, WorkspaceAgentRow } from "../../../shared/workspaces.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
/** 每次 render 都新建一个 [] 会让下面几个 useMemo/依赖数组白白变身份 */
const EMPTY_MODELS: readonly string[] = [];
const EMPTY_PLATFORMS: Readonly<Record<string, string>> = {};

/** 提示词收起时那一行摘要：首行 + 字数。合上之后还得看得出里面有没有东西、
    大概是什么——只写「已折叠」的话这颗按钮就是个盲盒 */
function promptSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "还没写提示词";
  const first = trimmed.split("\n", 1)[0]!;
  return `${first}（共 ${[...trimmed].length} 字）`;
}

const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

/** 型号数组是不是真的变了——不能拿 join(" ") 比，["a b", "c"] 和 ["a", "b c"]
    join 出来一样但其实是两组不同的型号 */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

export function WorkspaceAgentsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const confirm = useConfirm();
  const nav = useNav();
  const deleteAgent = useChat((s) => s.deleteWorkspaceAgent);
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  const rows = agentRows(ws, selfUid);
  // 删除成功、但紧跟着那次 refreshWorkspaceGroups() 挂了（#938①，同编辑页那半）——
  // 这一行没有弹窗可以留着显示，单独在名单上方挂一条
  const [deleteStale, setDeleteStale] = useState(false);

  const openEditor = (state: { mode: "create" } | { mode: "edit"; agent: WorkspaceAgentRow }): void => {
    nav.push({
      // key 带上 agentId：连点两只不同的 agent 要推出两页，而同一只连点两下只推一页
      key: state.mode === "create" ? `agent-new:${ws.id}` : `agent-edit:${state.agent.agentId}`,
      title: state.mode === "edit" ? `编辑「${state.agent.name}」` : "新建智能体",
      backLabel: "智能体",
      render: () => <AgentEditorScreen ws={ws} state={state} onDone={() => nav.pop()} />,
    });
  };

  return (
    <div className="flex flex-col">
      {deleteStale && (
        <div className="mb-2">
          <InsetGroup>
            <InsetRow
              title="已删除，但列表没刷出来"
              subtitle="点右边「刷新」把这份名单重拉一次。"
              trailing={
                <Button
                  size="xs" variant="secondary"
                  onClick={() => { void refreshWorkspaceGroups(); setDeleteStale(false); }}
                >
                  刷新
                </Button>
              }
            />
          </InsetGroup>
        </div>
      )}

      <InsetGroup sepInset={58}>
        {/* 名单空只发生在「还没读到」——每个团队至少种了一份管理员，真出现这句
            说的是拿不到，不是没有（同 CloudStateDot 的「拿不到 ≠ 不可用」纪律）*/}
        {ws.agents.length === 0 ? (
          <InsetEmpty
            title="还没读到这个团队的智能体名单"
            hint="每个团队开箱都带一只管理员，所以这句话说的是「这一刻拿不到」，不是「一只都没有」。"
          />
        ) : (
          rows.map((row) => (
            <InsetRow
              key={row.agentId}
              leading={<img src={agentAvatarSrc(ws, row.agentId)} alt="" aria-hidden className="size-[34px] shrink-0 rounded-full" />}
              title={
                <span className="inline-flex items-center gap-1">
                  <b className="font-medium">{row.name}</b>
                  {/* 「管理员不能删除」挂在这枚徽标上，不挂在别处（终审 Minor）：
                      那句话解释的是**这一行为什么没有删除钮** */}
                  {row.isAdmin && (
                    <span className="rounded-[5px] bg-foreground/[0.09] px-[5px] py-[2px] text-[10px] leading-none text-muted-foreground" title="管理员不能删除">
                      管理员
                    </span>
                  )}
                </span>
              }
              label={row.name}
              subtitle={`${row.description || "没有写职责"} · ${row.modelsSummary} · ${row.toolsSummary}`}
              chevron={row.canEdit}
              // 改不了的那几只不给点：给一颗点了什么都不发生的行，就是 #722 那个撒谎的勾
              {...(row.canEdit
                ? { onClick: () => openEditor({ mode: "edit", agent: ws.agents.find((a) => a.agentId === row.agentId)! }) }
                : {})}
              trailing={
                row.canDelete ? (
                  <Button
                    variant="ghost" size="xs" className="text-err"
                    onClick={() => {
                      void (async () => {
                        const ok = await confirm({
                          title: `删除智能体「${row.name}」？`,
                          description: "它的提示词和模型配置会一起消失，正在排队的消息会被标成没人接。",
                          confirmLabel: "删除",
                          tone: "danger",
                        });
                        if (ok) {
                          const result = await deleteAgent(ws.id, row.agentId);
                          if (result === "ok_stale") setDeleteStale(true);
                        }
                      })();
                    }}
                  >
                    删除
                  </Button>
                ) : null
              }
            />
          ))
        )}
        <InsetRow
          leading={<span aria-hidden className="grid size-[34px] shrink-0 place-items-center rounded-full bg-foreground/[0.09] text-muted-foreground"><Plus className="size-[16px]" /></span>}
          title="新建智能体"
          tone="action"
          onClick={() => openEditor({ mode: "create" })}
        />
      </InsetGroup>
      <InsetNote>
        群里 <b className="font-medium text-foreground">@ 名字</b> 就能点它干活。管理员那只是开箱自带的、删不掉——
        没 @ 谁的时候由它接。
      </InsetNote>
    </div>
  );
}

function AgentEditorScreen({
  ws, state, onDone,
}: {
  ws: WorkspaceSnapshot;
  state: { mode: "create" } | { mode: "edit"; agent: WorkspaceAgentRow };
  /** 存好了 / 用户主动退出：由调用方把这一页弹掉 */
  onDone: () => void;
}) {
  const createAgent = useChat((s) => s.createWorkspaceAgent);
  const updateAgent = useChat((s) => s.updateWorkspaceAgent);
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  const choices = connectorChoices(ws);

  const edit = state.mode === "edit" ? state.agent : null;
  const [name, setName] = useState(edit?.name ?? "");
  const [description, setDescription] = useState(edit?.description ?? "");
  const [instructions, setInstructions] = useState(edit?.instructions ?? "");
  // 下拉选中的那一项（AUTO_MODEL 或某个 logical_model）。存回去的仍然是
  // workspace_agents.models 那条有序链，映射规则在 agentModelChoice.ts
  const [model, setModel] = useState<string>(edit ? selectedModelValue(edit.models) : AUTO_MODEL);
  // 挑中的头像坑位。null = 没挑过 = 按 agentId 哈希派生（#1007）
  const [avatarSlot, setAvatarSlot] = useState<number | null>(edit?.avatarSlot ?? null);
  // 提示词默认收起（#1005）：它是这张表单里唯一会长到几百字的一块，展开着
  // 就把型号、连接器挤到折叠线以下——而那两样正是人开这张表单最常来改的。
  // **只管显示不管内容**：收起时 instructions 照旧在 state 里，保存照发
  const [promptOpen, setPromptOpen] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [toolsMode, setToolsMode] = useState<ToolsMode>(edit ? modeFromTools(edit.tools) : "all");
  const [toolsSel, setToolsSel] = useState<ProxySelection>(edit ? selectionFromAllow(edit.tools) : {});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // 本地校验和 create/update 失败共用这一格，理由同 CloudRepoConfigDialog：
  // **不**用 useChat((s) => s.workspaceGroupsError) 订阅式地读——那一格是
  // 整页共用的，弹窗刚打开那一刻可能还留着上一次跟这个表单毫不相干的旧
  // 错误，改成失败那一刻用 getState() 现取一次快照存进本地状态
  const [error, setError] = useState<string | null>(null);
  // IPC 成功、紧跟着那次 refreshWorkspaceGroups() 挂了（#938①）——数据已经
  // 落库，不是失败，弹窗照旧开着，只是换一句话 + 一颗手动刷新钮
  const [stale, setStale] = useState(false);

  // 网关此刻供着的型号。billing 还没拉到时是空数组——「读不到」与「一款都没有」
  // 在界面上要说不同的话，判断留给下面那两句文案
  const availableModels = useChat((s) => s.billing?.me?.models) ?? EMPTY_MODELS;
  const modelPlatforms = useChat((s) => s.billing?.me?.modelPlatforms) ?? EMPTY_PLATFORMS;
  const loadBilling = useChat((s) => s.loadBilling);
  // 弹窗打开时**真刷一次**（#1011）。原来这里写的是「只在没有快照时补一次、
  // 不带 refresh」，理由写的是「这是填空不是刷新」——那句话对**额度**成立，
  // 对**目录**不成立：hostedQuota 的快照没有 TTL，只有三个更新源（开机 /
  // 设置页点刷新 / 网关响应头，而响应头只带额度不带 models）。于是一台开着
  // 不关的 app 手里那份目录可以是几小时前的，而目录是服务端随时会变的东西
  // （2026-09-07 一天就变了两次：加了三款、改了一次价）。真机症状就是下拉里
  // 少三款而界面什么都不说。
  // 失败保留旧快照（hostedQuota.refresh 本来就是这个纪律），所以断网时下拉照旧能用
  useEffect(() => { void loadBilling(true); }, [loadBilling]);
  const currentModels = edit?.models ?? EMPTY_MODELS;
  const modelOptions = agentModelOptions(availableModels, currentModels, modelPlatforms);
  const chainNote = chainWarning(currentModels);
  // 头像那一格画什么：挑过就画挑的，没挑过画派生的；新建且没挑回 null
  // （agentId 还没铸出来，见 avatarPreviewSrc 的头注）
  const avatarPreview = avatarPreviewSrc(ws, edit?.agentId ?? null, avatarSlot);

  const nameError = validateAgentName(name);
  const toolsError = toolsDraftError(toolsMode, toolsSel);
  const staleIds = staleSelections(toolsSel, choices);
  const canSave = nameError === null && toolsError === null && !busy;

  const submit = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setStale(false);
    const models = modelsFromSelection(model);
    const tools = toolsFromDraft(toolsMode, toolsSel);
    const result =
      state.mode === "create"
        ? await createAgent(ws.id, {
            name: name.trim(), description: description.trim(), instructions, models, tools,
            avatarSlot,
          })
        : await updateAgent(ws.id, state.agent.agentId, {
            // edit 只发变了的字段——同 CloudRepoConfigDialog 那份三态：省略 = 不动
            ...(name.trim() !== state.agent.name ? { name: name.trim() } : {}),
            ...(description.trim() !== state.agent.description ? { description: description.trim() } : {}),
            ...(instructions !== state.agent.instructions ? { instructions } : {}),
            ...(sameModels(models, state.agent.models) ? {} : { models }),
            ...(sameAgentTools(tools, state.agent.tools) ? {} : { tools }),
            ...(avatarSlot === state.agent.avatarSlot ? {} : { avatarSlot }),
          });
    setBusy(false);
    if (result === "ok") {
      onDone();
    } else if (result === "ok_stale") {
      // 这一页照旧留着——已经存进去了，弹掉等于让用户以为要再存一次
      setStale(true);
    } else {
      setError(useChat.getState().workspaceGroupsError);
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onInstructionsKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex flex-col gap-3">
        {/* 滚动归这一页自己（NavStack 的每页都是一个 min-h-0 的滚动区），
            所以这里不再套第二层 overflow —— 套了就是滚动条里的滚动条 */}
        <div className="flex flex-col gap-3">
          {/* 身份那一行（#1013）：头像在左占 40%，名字与职责竖排在右。
              头像那一格**只画此刻在用的那一张**，点开才挑——13 张平铺会占掉表单
              顶部一大块，而「此刻用的是哪张」还得靠找那个高亮框。

              选择面板用 **Popover 不用嵌套 Dialog**：嵌套 modal 的失败模式是
              「按 Esc 把外层也关了」，代价是整张表单的草稿一起没；而这一格只有
              13 个方块，一个锚在头像上的小面板本来就够。Popover portal 到 body，
              所以不会被表单那层 overflow-y-auto 裁掉（同 ADR-0220 @ 选人那条教训）*/}
          <div className="flex items-center gap-3">
            <div className="flex basis-[40%] flex-col gap-1">
              <span className={SECTION_LABEL}>头像</span>
              <Popover open={avatarPickerOpen} onOpenChange={setAvatarPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="更换头像"
                    title="点一下换头像"
                    className={cn(
                      "aspect-square w-full max-w-[128px] self-center overflow-hidden rounded-xl",
                      "border border-border bg-transparent p-0 transition-colors",
                      "hover:border-[var(--brand)] focus-visible:border-[var(--brand)] focus-visible:outline-none",
                      "disabled:opacity-50"
                    )}
                  >
                    {avatarPreview !== null ? (
                      <img src={avatarPreview} alt="" aria-hidden className="size-full object-cover" />
                    ) : (
                      /* 新建且没挑：派生用的 agentId 是主进程落库那一刻才铸的，
                         表单里无从得知将来分到哪张脸。随便挑一张顶上是撒谎——
                         人会以为已经定了 */
                      <span className="flex size-full items-center justify-center px-2 text-center text-[10.5px] text-muted-foreground">
                        保存后自动分配
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[248px] p-2">
                  <div className="grid grid-cols-5 gap-1">
                    {/* 第一格是「自动分配」，取代原来那条「再点一次挑中的那张可以
                        取消」——一个说得出名字的选项，好过一条要背下来的手势 */}
                    <button
                      type="button"
                      aria-label="自动分配"
                      aria-pressed={avatarSlot === null}
                      title="按名字自动分配一张"
                      onClick={() => { setAvatarSlot(null); setAvatarPickerOpen(false); }}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-full border-2 bg-transparent p-0 text-[9px] leading-tight text-muted-foreground transition-colors",
                        avatarSlot === null ? "border-[var(--brand)]" : "border-transparent hover:border-border"
                      )}
                    >
                      自动
                    </button>
                    {AGENT_AVATARS.map((src, i) => (
                      <button
                        key={i}
                        type="button"
                        aria-label={`头像 ${i + 1}`}
                        aria-pressed={avatarSlot === i}
                        onClick={() => { setAvatarSlot(i); setAvatarPickerOpen(false); }}
                        className={cn(
                          "rounded-full border-2 bg-transparent p-0 transition-colors",
                          avatarSlot === i ? "border-[var(--brand)]" : "border-transparent hover:border-border"
                        )}
                      >
                        <img src={src} alt="" aria-hidden className="size-full rounded-full" />
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className={SECTION_LABEL}>名字</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="运营"
                  disabled={busy}
                />
                {nameError && <p className="text-xs text-err">{nameError}</p>}
              </div>

              <div className="flex flex-col gap-1">
                <span className={SECTION_LABEL}>职责</span>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="一句话，进别人 @ 它时的名册"
                  disabled={busy}
                />
              </div>
            </div>
          </div>

          {/* 提示词默认收起（#1005）。收起时**只是不画那个框**，instructions
              仍在 state 里、保存照发——「收起」不能变成「清空」。
              摘要行给的是首行 + 字数：合上之后还得看得出里面有没有东西、
              大概是什么，否则这颗按钮就成了盲盒 */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className={SECTION_LABEL}>提示词</span>
              <Button
                type="button" variant="ghost" size="xs" className="h-5 px-1 text-[11px]"
                aria-expanded={promptOpen}
                onClick={() => setPromptOpen((v) => !v)}
              >
                {promptOpen ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
                {promptOpen ? "收起" : "展开"}
              </Button>
              {!promptOpen && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {promptSummary(instructions)}
                </span>
              )}
            </div>
            {promptOpen && (
              /* max-h 是这里的正事：ui/textarea.tsx 带 field-sizing-content
                 （内容多高框多高），只给 min-h 就等于没有上限——几百字的提示词
                 会把框铺成八百多像素高。封顶之后长提示词在框内自己滚（#997） */
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onKeyDown={onInstructionsKeyDown}
                className="max-h-[220px] min-h-[120px] overflow-y-auto font-normal text-[13px]"
                disabled={busy}
                autoFocus
              />
            )}
          </div>

          {/* 型号下拉（#1005）：清单来自 `billing.me.models`——那不是「我的订阅
              供哪几款」，而是网关从**全局** model_route 表去重出来的 logical_model
              （worker.ts:632），对每个用户都一样，所以这一格不需要动 cs 帧协议。
              拉不到时只剩 Auto 与存量选项，下面那句话说的是「读不到」不是「没有」 */}
          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>模型</span>
            <Select value={model} onValueChange={setModel} disabled={busy}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {/* Auto 也给一枚记号（#1015）：它和下面那几款是同一列里的同类
                        选项，只有它光着会读成「这一行还没配好」。用的不是厂商字形
                        ——Auto 不是一家厂——而是同尺寸同圆角的中性方块，只求这一列
                        对得齐。认不出平台的那几款仍然留空位（同上一条理由：一列
                        有图标一列没有，文字会参差不齐） */}
                    {o.value === AUTO_MODEL ? (
                      <span
                        aria-hidden
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground ring-1 ring-black/10 ring-inset dark:ring-white/[0.14]"
                      >
                        <Sparkles className="size-[10px]" />
                      </span>
                    ) : o.provider ? (
                      <ProviderMark provider={o.provider} size={16} className="rounded-[4px]" />
                    ) : (
                      <span aria-hidden className="inline-block size-4 shrink-0" />
                    )}
                    {o.label}
                    {o.stale && <span className="ml-1 text-[10px] text-muted-foreground">已下架</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10.5px] text-muted-foreground">
              {model === AUTO_MODEL
                ? "Auto：每次起跑前先用最便宜那款读一遍你的请求，判简单还是复杂，再据此挑模型。判不出来时按最便宜那款走。"
                : "云会话统一走团队所有者的订阅额度；这一款网关哪天不供了，会自动退回首选款。"}
            </p>
            {availableModels.length === 0 && (
              <p className="text-[10.5px] text-muted-foreground">
                还没读到网关供着的模型清单（不是「一款都没有」）。到账号页看一眼订阅信息就会拉一次。
              </p>
            )}
            {chainNote !== null && <p className="text-[10.5px] text-warn">{chainNote}</p>}
          </div>

          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>连接器</span>
            <div className="flex gap-1">
              <Button
                type="button" size="xs" variant={toolsMode === "all" ? "secondary" : "ghost"}
                disabled={busy} onClick={() => setToolsMode("all")}
              >
                全部连接器
              </Button>
              <Button
                type="button" size="xs" variant={toolsMode === "some" ? "secondary" : "ghost"}
                disabled={busy} onClick={() => setToolsMode("some")}
              >
                只用勾选的
              </Button>
            </div>
            {toolsMode === "some" && (
              choices.length === 0 && staleIds.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground">这个团队还没有人贡献连接器。</p>
              ) : (
                <div className="max-h-[220px] overflow-y-auto rounded-md border border-border py-1">
                  {choices.map((srv) => {
                    const isOpen = expanded.has(srv.serverId);
                    return (
                      <div key={srv.serverId}>
                        <div className={ROW}>
                          {/* title 挂在包住按钮的 span 上，不挂在 disabled 的 button 本身——
                              Chromium 对 disabled 表单控件屏蔽指针事件，title 挂在 button 上
                              的话灰掉的那颗永远不会弹出提示 */}
                          <span
                            title={srv.toolNames === null ? "贡献者整台放行，本机没有工具清单——只能整台勾" : undefined}
                          >
                            <button
                              type="button"
                              className="bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
                              aria-label={isOpen ? "收起工具" : "展开工具"}
                              disabled={srv.toolNames === null}
                              onClick={() => setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(srv.serverId)) next.delete(srv.serverId);
                                else next.add(srv.serverId);
                                return next;
                              })}
                            >
                              {isOpen ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
                            </button>
                          </span>
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
                            <input
                              type="checkbox"
                              checked={isServerOn(toolsSel, srv.serverId)}
                              onChange={() => setToolsSel((p) => toggleServer(p, srv.serverId, !isServerOn(p, srv.serverId)))}
                              className="size-[13px] shrink-0 accent-[var(--brand)]"
                              aria-label={srv.serverId}
                            />
                            <span className="truncate">{srv.serverId}</span>
                          </label>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                            {srv.hostLabels.join("、")} · {srv.toolNames === null ? "全部工具" : `${srv.toolNames.length} 个工具`}
                          </span>
                        </div>
                        {isOpen && srv.toolNames !== null && (
                          <div className="pb-1 pl-8">
                            {srv.toolNames.map((tool) => (
                              <div key={tool} className={ROW}>
                                <label className="flex cursor-pointer items-center gap-2 select-none">
                                  <input
                                    type="checkbox"
                                    checked={isToolOn(toolsSel, srv.serverId, tool)}
                                    onChange={() => setToolsSel((p) => toggleTool(p, srv.serverId, tool, srv.toolNames!))}
                                    className="size-[13px] shrink-0 accent-[var(--brand)]"
                                    aria-label={tool}
                                  />
                                  <span className="truncate">{tool}</span>
                                </label>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* 存量白名单里点着名、但这台连接器已经从团队撤回的条目——不能悄悄
                      丢掉：静默丢弃 = 替用户把一份他没碰过的授权收窄了；藏起来更糟，
                      那就成了一枚勾选表上看不见却仍然生效的「撒谎的勾」（同 #722）。
                      只给一个取消勾选的出口，重新勾不需要——撤回之后这行本来就不该再有 */}
                  {staleIds.map((id) => (
                    <div key={id} className={ROW}>
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => setToolsSel((p) => toggleServer(p, id, false))}
                          className="size-[13px] shrink-0 accent-[var(--brand)]"
                          aria-label={id}
                        />
                        <span className="truncate">{id}</span>
                      </label>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        已撤回 · 这台连接器已不在团队里
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}
            {toolsError && <p className="text-xs text-err">{toolsError}</p>}
          </div>

          {error && <p className="text-xs text-err">{error}</p>}
          {stale && (
            <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
              <span className="min-w-0 flex-1">已保存，但列表没刷出来——点『刷新』。</span>
              <Button
                size="xs" variant="secondary" className="shrink-0"
                onClick={() => { void refreshWorkspaceGroups(); setStale(false); }}
              >
                刷新
              </Button>
            </div>
          )}
        </div>

        {/* 页脚：通栏一颗保存。取消不另给钮——导航条左上角那颗返回就是取消，
            再摆一颗「取消」等于同一件事在一屏上有两个入口 */}
        <div className="flex flex-col gap-2 pt-2">
          <Button className="w-full" disabled={!canSave} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
    </div>
  );
}
