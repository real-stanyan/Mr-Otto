// ContributeConnectorDialog —— 「贡献我的连接器」那张勾选表（#1120 从 WorkspacePage 抽出，
// 一个字没改）。**仍然是弹窗不是推入页**：它是一次「选完就走」的确认，选完之后人要回到
// 刚才那份清单看结果；推入页在这里只会多一次返回。
//
// 部分失败的处置是这块的要害，别顺手简化：每一步都收返回值，失败的那台记进各自的清单
// ——撤回失败尤其不能被无条件关掉的弹窗盖过去（「我撤回了」与「我以为我撤回了」不能长
// 一个样）。

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { useChat } from "../store.js";
import { connectorBatchErrorText } from "../lib/workspaceView.js";
import {
  buildAllow, isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool, type ProxySelection,
} from "../lib/proxyShare.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

export function ContributeConnectorDialog({
  ws, selfUid, open, onOpenChange,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mcpServers = useChat((s) => s.mcpServers);
  const contribute = useChat((s) => s.contributeWorkspaceConnector);
  const withdraw = useChat((s) => s.withdrawWorkspaceConnector);
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  // 只有本机已接通的 http-transport server 能贡献进云端箱——同 escrowSync
  // 「进箱只收 live 的 https http-transport server」那条闸（ADR-0197）。
  // 进箱三条准入之一是 https（pxEscrow.buildEscrowDoc）——这里不滤，贡献
  // 出去就是一行永远「云端不可用」的死目录（终审 M3）。
  const eligible = mcpServers.servers.filter(
    (s) => s.config.kind === "http" && s.status === "connected" && s.config.url?.startsWith("https://")
  );
  const mine = ws.connectors.filter((c) => c.hostUid === selfUid);
  const [sel, setSel] = useState<ProxySelection>(() => selectionFromAllow(mine));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // 本地错误态，不订阅全局 workspaceGroupsError——理由同 AgentEditorDialog：
  // 那一格是整页共用的，弹窗刚打开可能还留着上一次跟这次批量操作毫不相干的
  // 旧错误。每一步的失败原因都落在那一格里，这里用 getState() 现取快照
  // （#957 C-C1：两个循环一个返回值都不看，是这条 finding 的根）
  const [error, setError] = useState<string | null>(null);

  // 每次开框重新从当前已贡献的那份回填——不带着上一次开框时的临时勾选状态，
  // 也不带上一次的失败提示
  const onDialogOpenChange = (o: boolean): void => {
    if (o) {
      setSel(selectionFromAllow(mine));
      setError(null);
    }
    onOpenChange(o);
  };

  const doConfirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const next = buildAllow(sel);
    const nextIds = new Set(next.map((a) => a.serverId));
    const prevIds = new Set(mine.map((c) => c.serverId));
    // 每一步都收返回值，失败的那台记进各自的清单——不再让下一步成功把
    // 上一步失败的痕迹抹掉（原 bug 的核心：两个循环一个返回值都不看）。
    // opts.refresh:false 关掉每步自带的 refreshWorkspaceGroups()，循环
    // 结束后统一刷一次：N 步不再是 2N 次往返，而且部分失败时也要刷出
    // 已经生效的那部分真实状态，不能靠本地草稿去猜
    const failedContribute: string[] = [];
    for (const a of next) {
      const ok = await contribute(ws.id, a.serverId, a.tools, { refresh: false });
      if (!ok) failedContribute.push(a.serverId);
    }
    const failedWithdraw: string[] = [];
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        const ok = await withdraw(ws.id, id, { refresh: false });
        if (!ok) failedWithdraw.push(id);
      }
    }
    await refreshWorkspaceGroups();
    setBusy(false);
    const batchError = connectorBatchErrorText(failedContribute, failedWithdraw);
    if (batchError !== null) {
      // 撤回失败尤其不能被无条件关掉的弹窗盖过去：那台连接器这一刻仍然
      // 共享给全体成员、凭证仍在 edge 的托管箱里——「我撤回了」与「我以为
      // 我撤回了」不能长一个样（house rule）
      setError(batchError);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onDialogOpenChange(o); }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>贡献连接器给「{ws.name}」</DialogTitle>
          <DialogDescription>
            工作区全体成员（含未来加入者）将以你的身份使用这些工具，凭证托管到 Mr Otto 云端——你下线成员照样能用。
          </DialogDescription>
        </DialogHeader>

        {eligible.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">还没有连上的 MCP 服务（只有 http 接入方式能贡献）。</p>
        ) : (
          <div className="max-h-[280px] overflow-y-auto rounded-md border border-border py-1">
            {eligible.map((srv) => {
              const toolNames = srv.tools.map((t) => t.name);
              const isOpen = expanded.has(srv.id);
              return (
                <div key={srv.id}>
                  <div className={ROW}>
                    <button
                      type="button"
                      className="bg-transparent p-0 text-muted-foreground hover:text-foreground"
                      aria-label={isOpen ? "收起工具" : "展开工具"}
                      onClick={() => setExpanded((prev) => {
                        const nextSet = new Set(prev);
                        if (nextSet.has(srv.id)) nextSet.delete(srv.id);
                        else nextSet.add(srv.id);
                        return nextSet;
                      })}
                    >
                      {isOpen ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
                    </button>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={isServerOn(sel, srv.id)}
                        onChange={() => setSel((p) => toggleServer(p, srv.id, !isServerOn(p, srv.id)))}
                        className="size-[13px] shrink-0 accent-[var(--brand)]"
                        aria-label={srv.id}
                      />
                      <span className="truncate">{srv.id}</span>
                    </label>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {srv.tools.length} 个工具
                    </span>
                  </div>
                  {isOpen && (
                    <div className="pb-1 pl-8">
                      {toolNames.map((tool) => (
                        <div key={tool} className={ROW}>
                          <label className="flex cursor-pointer items-center gap-2 select-none">
                            <input
                              type="checkbox"
                              checked={isToolOn(sel, srv.id, tool)}
                              onChange={() => setSel((p) => toggleTool(p, srv.id, tool, toolNames))}
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
          </div>
        )}

        {error && <p className="text-xs text-err whitespace-pre-wrap break-words">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" disabled={busy} onClick={() => void doConfirm()}>
            {busy ? "保存中…" : "确认贡献"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
