// WorkspaceAgentsTab —— 工作区设置页「智能体」tab：建/改/删 @ 得着的那几只
// 水獭（issue #932 切片 1b，Task 7）。骨架照抄 WorkspacePage.tsx 的
// ConnectorsTab + ContributeConnectorDialog（同一份 ROW/SECTION_LABEL 令牌、
// 同一套 confirm() 二次确认惯例，不新造视觉语言）。
//
// 权限矩阵钉在 workspaceView.ts 的 agentRows（spec §9）：canEdit = 建的人或
// owner，canDelete = canEdit 且不是种子管理员——admin 是每个工作区开箱自带
// 的那份，这里没有删除钮。

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { useChat } from "../store.js";
import { agentRows, type AgentRowView } from "../lib/workspaceView.js";
import {
  connectorChoices, modeFromTools, staleSelections, toolsDraftError, toolsFromDraft, type ToolsMode,
} from "../lib/agentToolsForm.js";
import {
  isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool, type ProxySelection,
} from "../lib/proxyShare.js";
import { validateAgentName, parseModelList, validateRelayMaxDepth } from "../../../shared/workspaceAgents.js";
import { sameAgentTools } from "../../../shared/agentToolAllow.js";
import type { WorkspaceSnapshot, WorkspaceAgentRow } from "../../../shared/workspaces.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

/** 型号数组是不是真的变了——不能拿 join(" ") 比，["a b", "c"] 和 ["a", "b c"]
    join 出来一样但其实是两组不同的型号 */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

export function WorkspaceAgentsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const deleteAgent = useChat((s) => s.deleteWorkspaceAgent);
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  const rows = agentRows(ws, selfUid);
  const [editorState, setEditorState] = useState<
    { mode: "create" } | { mode: "edit"; agent: WorkspaceAgentRow } | null
  >(null);
  // 删除成功、但紧跟着那次 refreshWorkspaceGroups() 挂了（#938①，同 AgentEditorDialog
  // 那半）——这一行没有弹窗可以留着显示，单独在名单上方挂一条横幅
  const [deleteStale, setDeleteStale] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <RelayMaxDepthRow ws={ws} isOwner={ws.ownerUid === selfUid} />
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditorState({ mode: "create" })}>新建智能体…</Button>
      </div>
      {deleteStale && (
        <div className={cn(ROW, "border border-border")}>
          <span className="min-w-0 flex-1">已删除，但列表没刷出来——点『刷新』。</span>
          <Button
            size="xs" variant="secondary" className="shrink-0"
            onClick={() => { void refreshWorkspaceGroups(); setDeleteStale(false); }}
          >
            刷新
          </Button>
        </div>
      )}
      {/* 名单空只发生在"还没读到"——每个工作区至少种了一份管理员，真出现这句
          说的是拿不到，不是没有（同 CloudStateDot 的"拿不到 ≠ 不可用"纪律）*/}
      {ws.agents.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">还没读到这个工作区的智能体名单。</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <AgentRow
              key={row.agentId}
              row={row}
              onEdit={() => setEditorState({ mode: "edit", agent: ws.agents.find((a) => a.agentId === row.agentId)! })}
              onDelete={() => {
                if (
                  confirm(
                    `删除智能体「${row.name}」？它的提示词和型号配置会一起消失，正在排队的消息会被标成没人接。`
                  )
                ) {
                  void (async () => {
                    const result = await deleteAgent(ws.id, row.agentId);
                    if (result === "ok_stale") setDeleteStale(true);
                  })();
                }
              }}
            />
          ))}
        </div>
      )}
      <AgentEditorDialog
        ws={ws}
        state={editorState}
        onOpenChange={(open) => { if (!open) setEditorState(null); }}
      />
    </div>
  );
}

/** 名单上方那一行「接力上限」（#950 Task 9）：agent 互相 @ 的棒数上限，
    落在 workspaces.relay_max_depth，owner 才能改——非 owner 只读一句人话。
    存/取都走 validateRelayMaxDepth（同 normalizeRelayMaxDepth 口径），不新造校验规则 */
function RelayMaxDepthRow({ ws, isOwner }: { ws: WorkspaceSnapshot; isOwner: boolean }) {
  const setRelayMaxDepth = useChat((s) => s.setWorkspaceRelayMaxDepth);
  const [raw, setRaw] = useState(String(ws.relayMaxDepth));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存成功后 1.5s 内显示「已保存」（M12）——存 6 回 6 时 ws.relayMaxDepth
  // 不变、下面那条 useEffect 也不会重置输入框，是这一行唯一的成功信号
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ws.relayMaxDepth 变了（别人改的，或本页保存成功后 refreshWorkspaceGroups
  // 拉回的新值）——输入框跟着重置，不留着刚保存前的旧草稿
  useEffect(() => {
    setRaw(String(ws.relayMaxDepth));
    setError(null);
  }, [ws.relayMaxDepth]);

  // 卸载时清掉挂起的定时器，否则组件已经不在了还 setState
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  if (!isOwner) {
    return (
      <p className="px-2 text-xs text-muted-foreground">
        接力上限 {ws.relayMaxDepth} 棒（所有者可改）
      </p>
    );
  }

  const validated = validateRelayMaxDepth(raw);

  const submit = async (): Promise<void> => {
    if (!validated.ok || busy) return;
    setBusy(true);
    setError(null);
    const ok = await setRelayMaxDepth(ws.id, validated.value);
    setBusy(false);
    if (!ok) {
      setError(useChat.getState().workspaceGroupsError);
      return;
    }
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className={cn(ROW, "border border-border")}>
        <span className="shrink-0 text-muted-foreground">接力上限</span>
        <Input
          type="number"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="h-7 w-16 shrink-0"
          disabled={busy}
        />
        <span className="shrink-0 text-muted-foreground">棒</span>
        {saved && <span className="shrink-0 text-xs text-muted-foreground">已保存</span>}
        <Button
          size="xs" variant="secondary" className="ml-auto shrink-0"
          disabled={busy || !validated.ok} onClick={() => void submit()}
        >
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
      {!validated.ok && <p className="px-2 text-xs text-err">{validated.error}</p>}
      {validated.ok && error && <p className="px-2 text-xs text-err">{error}</p>}
    </div>
  );
}

function AgentRow({
  row, onEdit, onDelete,
}: {
  row: AgentRowView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={cn(ROW, "border border-border")}>
      <span className="min-w-0 flex-1 truncate">
        <b className="font-medium">{row.name}</b>
        {/* 「管理员不能删除」挂在这枚徽标上，不挂在「编辑」钮上（终审 Minor）：
            那句话解释的是**这一行为什么没有删除钮**，挂在编辑钮上等于说
            「编辑这个动作不能删除」 */}
        {row.isAdmin && (
          <span className="ml-1 text-[10.5px] text-muted-foreground" title="管理员不能删除">
            · 管理员
          </span>
        )}
        <span className="block text-[10.5px] text-muted-foreground">
          {row.description || "没有写职责"} · {row.modelsSummary} · {row.toolsSummary} · {row.creatorLabel}
        </span>
      </span>
      {row.canEdit && (
        <Button
          variant="ghost" size="xs" className="shrink-0"
          onClick={onEdit}
        >
          编辑
        </Button>
      )}
      {row.canDelete && (
        <Button variant="ghost" size="xs" className="shrink-0 text-err" onClick={onDelete}>
          删除
        </Button>
      )}
    </div>
  );
}

function AgentEditorDialog({
  ws, state, onOpenChange,
}: {
  ws: WorkspaceSnapshot;
  state: { mode: "create" } | { mode: "edit"; agent: WorkspaceAgentRow } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const createAgent = useChat((s) => s.createWorkspaceAgent);
  const updateAgent = useChat((s) => s.updateWorkspaceAgent);
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  const choices = connectorChoices(ws);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelsRaw, setModelsRaw] = useState("");
  const [toolsMode, setToolsMode] = useState<ToolsMode>("all");
  const [toolsSel, setToolsSel] = useState<ProxySelection>({});
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

  const open = state !== null;

  useEffect(() => {
    if (state === null) return;
    if (state.mode === "edit") {
      setName(state.agent.name);
      setDescription(state.agent.description);
      setInstructions(state.agent.instructions);
      setModelsRaw(state.agent.models.join(", "));
      setToolsMode(modeFromTools(state.agent.tools));
      setToolsSel(selectionFromAllow(state.agent.tools));
    } else {
      setName("");
      setDescription("");
      setInstructions("");
      setModelsRaw("");
      setToolsMode("all");
      setToolsSel({});
    }
    setExpanded(new Set());
    setError(null);
    setStale(false);
  }, [state]);

  const nameError = validateAgentName(name);
  const toolsError = toolsDraftError(toolsMode, toolsSel);
  const staleIds = staleSelections(toolsSel, choices);
  const canSave = nameError === null && toolsError === null && !busy;

  const submit = async (): Promise<void> => {
    if (!canSave || state === null) return;
    setBusy(true);
    setError(null);
    setStale(false);
    const models = parseModelList(modelsRaw);
    const tools = toolsFromDraft(toolsMode, toolsSel);
    const result =
      state.mode === "create"
        ? await createAgent(ws.id, {
            name: name.trim(), description: description.trim(), instructions, models, tools,
          })
        : await updateAgent(ws.id, state.agent.agentId, {
            // edit 只发变了的字段——同 CloudRepoConfigDialog 那份三态：省略 = 不动
            ...(name.trim() !== state.agent.name ? { name: name.trim() } : {}),
            ...(description.trim() !== state.agent.description ? { description: description.trim() } : {}),
            ...(instructions !== state.agent.instructions ? { instructions } : {}),
            ...(sameModels(models, state.agent.models) ? {} : { models }),
            ...(sameAgentTools(tools, state.agent.tools) ? {} : { tools }),
          });
    setBusy(false);
    if (result === "ok") {
      onOpenChange(false);
    } else if (result === "ok_stale") {
      // 弹窗照旧开着——已经存进去了，关掉等于让用户以为要再存一次
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
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{state?.mode === "edit" ? `编辑「${state.agent.name}」` : `新建智能体`}</DialogTitle>
          <DialogDescription>
            工作区里 @ 得到的那几只——名字、职责一句话、提示词、型号白名单都在这儿建改。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
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

          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>提示词</span>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={onInstructionsKeyDown}
              className="min-h-[120px] font-normal text-[13px]"
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>型号</span>
            <Input
              value={modelsRaw}
              onChange={(e) => setModelsRaw(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="逗号分隔，第一个是默认；留空用工作区的型号"
              disabled={busy}
            />
            <p className="text-[10.5px] text-muted-foreground">
              型号 id 得是工作区所配那家提供商认得的——这里不校验。
            </p>
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
                <p className="text-[10.5px] text-muted-foreground">这个工作区还没有人贡献连接器。</p>
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
                  {/* 存量白名单里点着名、但这台连接器已经从工作区撤回的条目——不能悄悄
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
                        已撤回 · 这台连接器已不在工作区里
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

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
