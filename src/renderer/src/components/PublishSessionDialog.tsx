// PublishSessionDialog —— 会话头部「更多」菜单里的「发布到工作区…」（Task 12，
// ADR-0198 切片 3，issue #811）。
//
// 跟 `@好友` 分享是两条不同的路：分享是一次性给一个人，发布是常驻挂在工作区里
// 给全体成员（含未来加入者）反复导入（workspace_sessions 那张表，Task 9）。
//
// 两步走，同一个 Dialog：① 选工作区 + 起标题 → 发布；② 发布成功后，如果这个
// 会话用过此刻还连着的 MCP 服务，弹一屏跟 ShareGrantDialog 同款的确认——
// 复用同一个 `serversUsedInSession` 纯函数选候选，但文案是这里独有的：
// 「工作区全体成员（含未来加入者）将以你的身份使用这些工具」——比 DM 分享的
// 后果更大（不是给一个人，是给一整个会不断加人的组），必须单独说清楚。

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useChat } from "../store.js";
import { serversUsedInSession } from "../../../shared/shareGrant.js";
import type { SessionEvent } from "../../../session/events.js";

export function PublishSessionDialog({
  open,
  onOpenChange,
  sessionId,
  events,
  defaultTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  events: SessionEvent[];
  defaultTitle: string;
}) {
  const groups = useChat((s) => s.workspaceGroups);
  const refreshGroups = useChat((s) => s.refreshWorkspaceGroups);
  const publish = useChat((s) => s.publishWorkspaceSession);
  const contribute = useChat((s) => s.contributeWorkspaceConnector);
  const error = useChat((s) => s.workspaceGroupsError);

  const [wsId, setWsId] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);
  // 非 null = 发布已成功，进第二步：这个会话用过的服务要不要连带贡献
  const [grant, setGrant] = useState<{ wsId: string; servers: readonly string[] } | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!open) return;
    void refreshGroups();
    setTitle(defaultTitle);
    setWsId("");
    setBusy(false);
    setGrant(null);
  }, [open, defaultTitle, refreshGroups]);

  const doPublish = async (): Promise<void> => {
    const t = title.trim();
    if (!wsId || !t) return;
    setBusy(true);
    const ok = await publish(wsId, sessionId, t);
    if (!ok) {
      setBusy(false);
      return;
    }
    const candidates = serversUsedInSession(
      events,
      useChat.getState().mcpServers.servers.map((m) => ({ id: m.id, live: m.status === "connected", tools: m.tools }))
    );
    setBusy(false);
    if (candidates.length > 0) {
      setSelected(candidates);
      setGrant({ wsId, servers: candidates });
    } else {
      onOpenChange(false);
    }
  };

  const doGrant = async (): Promise<void> => {
    if (!grant) return;
    setBusy(true);
    // 只到「服务」这一层（同 DM 分享的 shareAllow），想再圈到单个工具走
    // 连接器 tab 的「贡献连接器…」——那边有 proxyShare.ts 的完整勾选表
    for (const serverId of selected) await contribute(grant.wsId, serverId, []);
    setBusy(false);
    onOpenChange(false);
  };

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (grant) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>连带贡献这个会话用过的服务？</DialogTitle>
            <DialogDescription>
              工作区全体成员（含未来加入者）将以你的身份使用这些工具，凭证托管到 Mr Otto 云端——
              你下线成员照样能用。不勾就只发布对话本身。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            {grant.servers.map((id) => (
              <label
                key={id}
                className="flex items-center gap-2 px-2 py-[6px] rounded-md text-xs cursor-pointer select-none hover:bg-foreground/[0.04]"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  onChange={() => toggle(id)}
                  className="size-[13px] shrink-0 accent-[var(--brand)]"
                  aria-label={id}
                />
                <span className="truncate">{id}</span>
              </label>
            ))}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
              不用了，只发布对话
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void doGrant()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {busy ? "贡献中…" : selected.length === 0 ? "确认" : `贡献 ${selected.length} 项服务`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>发布到工作区</DialogTitle>
          <DialogDescription>
            工作区里的成员可以随时导入这份会话继续接力——跟 @好友 分享不同，这是常驻挂在工作区里的，
            以后加入的成员也能看见。
          </DialogDescription>
        </DialogHeader>

        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有工作区。先在侧栏「工作区」里建一个，再回来发布。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select value={wsId} onValueChange={setWsId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一个工作区" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="给这次发布起个标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        )}

        {error && <p className="text-xs text-err">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" disabled={busy || !wsId || !title.trim()} onClick={() => void doPublish()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? "发布中…" : "发布"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
