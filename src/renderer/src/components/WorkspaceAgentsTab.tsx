// WorkspaceAgentsTab —— 工作区设置页「智能体」tab：建/改/删 @ 得着的那几只
// 水獭（issue #932 切片 1b，Task 7）。骨架照抄 WorkspacePage.tsx 的
// ConnectorsTab + ContributeConnectorDialog（同一份 ROW/SECTION_LABEL 令牌、
// 同一套 confirm() 二次确认惯例，不新造视觉语言）。
//
// 权限矩阵钉在 workspaceView.ts 的 agentRows（spec §9）：canEdit = 建的人或
// owner，canDelete = canEdit 且不是种子管理员——admin 是每个工作区开箱自带
// 的那份，这里没有删除钮。

import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { useChat } from "../store.js";
import { agentRows, type AgentRowView } from "../lib/workspaceView.js";
import { validateAgentName, parseModelList } from "../../../shared/workspaceAgents.js";
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
  const rows = agentRows(ws, selfUid);
  const [editorState, setEditorState] = useState<
    { mode: "create" } | { mode: "edit"; agent: WorkspaceAgentRow } | null
  >(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditorState({ mode: "create" })}>新建智能体…</Button>
      </div>
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
                  void deleteAgent(ws.id, row.agentId);
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
          {row.description || "没有写职责"} · {row.modelsSummary} · {row.creatorLabel}
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

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelsRaw, setModelsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  // 本地校验和 create/update 失败共用这一格，理由同 CloudRepoConfigDialog：
  // **不**用 useChat((s) => s.workspaceGroupsError) 订阅式地读——那一格是
  // 整页共用的，弹窗刚打开那一刻可能还留着上一次跟这个表单毫不相干的旧
  // 错误，改成失败那一刻用 getState() 现取一次快照存进本地状态
  const [error, setError] = useState<string | null>(null);

  const open = state !== null;

  useEffect(() => {
    if (state === null) return;
    if (state.mode === "edit") {
      setName(state.agent.name);
      setDescription(state.agent.description);
      setInstructions(state.agent.instructions);
      setModelsRaw(state.agent.models.join(", "));
    } else {
      setName("");
      setDescription("");
      setInstructions("");
      setModelsRaw("");
    }
    setError(null);
  }, [state]);

  const nameError = validateAgentName(name);
  const canSave = nameError === null && !busy;

  const submit = async (): Promise<void> => {
    if (!canSave || state === null) return;
    setBusy(true);
    setError(null);
    const models = parseModelList(modelsRaw);
    const ok =
      state.mode === "create"
        ? await createAgent(ws.id, { name: name.trim(), description: description.trim(), instructions, models })
        : await updateAgent(ws.id, state.agent.agentId, {
            // edit 只发变了的字段——同 CloudRepoConfigDialog 那份三态：省略 = 不动
            ...(name.trim() !== state.agent.name ? { name: name.trim() } : {}),
            ...(description.trim() !== state.agent.description ? { description: description.trim() } : {}),
            ...(instructions !== state.agent.instructions ? { instructions } : {}),
            ...(sameModels(models, state.agent.models) ? {} : { models }),
          });
    setBusy(false);
    if (ok) {
      onOpenChange(false);
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

          {error && <p className="text-xs text-err">{error}</p>}
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
