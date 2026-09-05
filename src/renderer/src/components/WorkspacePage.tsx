// WorkspacePage —— 工作区详情页：四 tab（会话 / 智能体 / 连接器 / 成员）（Task 12，ADR-0198 切片 3）。
//
// 页而不是弹窗（照 McpConnectorPage 的换页惯例，ADR-0185）：三张表加起来随时
// 超过一屏，弹窗只会滚动条套滚动条；而且这里挂了好几个二次确认，弹窗里嵌
// 二次确认的视觉层级会很怪。
//
// 没有推送通道（workspaceList 无 onChanged，见 Task 11 report）：每次改动
// 成功后 store 那十一个 action 都会自己重拉一次整份快照，这一页只管拿最新的
// ws 传进来的那份画，不自己维护本地缓存。
//
// 危险动作（踢人 / 解散工作区 / 撤回发布 / 退出工作区）走 `confirm()`——同
// FriendsSection「删除好友」、侧栏「删除会话」一样的原生确认，不新造一套
// AlertDialog 视觉语言（本仓这一类判定至今都是这么做的）。
//
// 云会话（Task 13，ADR-0199）曾经也归这一页：顶部一节列清单 + 一颗「新建云会话」，
// 点开整页换成 CloudSessionPage。**issue #919 把这两件事都搬走了**——建会话走侧栏
// 工作区组头那颗 ＋（同本地工程组），开会话在主区（同本地会话）。这一页只剩
// 「管理」：成员、连接器、已发布会话，外加**已归档**的云会话（同本地那批归档的
// 会话不在侧栏里一样，它们得有个去处，而这里就是这个工作区的那个去处）。
//
// 智能体 tab（#932 切片 1b）：@ 得着的那几只在这儿建改删。

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, LogOut, Trash2, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useChat } from "../store.js";
import {
  cloudSessionRows, connectorRows, memberRows, sessionRows,
  type ConnectorCloudState, type CloudSessionListRow,
} from "../lib/workspaceView.js";
import { WorkspaceAgentsTab } from "./WorkspaceAgentsTab.js";
import {
  buildAllow, isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool,
  formatProxyTime, type ProxySelection,
} from "../lib/proxyShare.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

// 云会话清单没拉过时的兜底：模块级常量而非每次渲染 `?? []`，保证 selector
// 每次返回同一引用，不触发 zustand 无谓重渲（仓库 selector 约定，同
// FriendChatView 的 EMPTY 先例）
const EMPTY_CLOUD_SESSIONS: CloudSessionListRow[] = [];

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

export function WorkspacePage({
  ws,
  selfUid,
  onBack,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  onBack: () => void;
}) {
  const deleteGroup = useChat((s) => s.deleteWorkspaceGroup);
  const leaveGroup = useChat((s) => s.leaveWorkspaceGroup);
  const error = useChat((s) => s.workspaceGroupsError);
  const isOwner = ws.ownerUid === selfUid;

  const onDelete = async (): Promise<void> => {
    if (!confirm(`解散工作区「${ws.name}」？全体成员的连接器授权与已发布会话会立即失效，且不可撤销。`)) return;
    if (await deleteGroup(ws.id)) onBack();
  };

  const onLeave = async (): Promise<void> => {
    if (!confirm(`退出工作区「${ws.name}」？你贡献的连接器授权会立即失效。`)) return;
    if (await leaveGroup(ws.id)) onBack();
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          "press-scale -ml-1 inline-flex w-fit items-center gap-1.5 rounded-[7px] px-1.5 py-1",
          "text-[12.5px] text-muted-foreground transition-colors duration-150",
          "hover:bg-foreground/[0.06] hover:text-foreground"
        )}
      >
        <ArrowLeft className="size-[13px]" aria-hidden />
        工作区
      </button>

      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="min-w-0 truncate text-[17px] leading-tight font-medium">{ws.name}</h3>
          <p className="text-[12px] text-muted-foreground">
            {ws.members.length} 人 · {isOwner ? "你是所有者" : "成员"}
          </p>
        </div>
        <Button
          variant="destructive" size="sm"
          onClick={() => void (isOwner ? onDelete() : onLeave())}
        >
          {isOwner ? <Trash2 className="size-[13px]" /> : <LogOut className="size-[13px]" />}
          {isOwner ? "解散工作区" : "退出工作区"}
        </Button>
      </header>

      {error && <p className="text-xs text-err">{error}</p>}

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">会话</TabsTrigger>
          {/* 智能体排在会话之后、连接器之前——智能体是用得最多的一页，
              连接器/成员是配一次的东西 */}
          <TabsTrigger value="agents">智能体</TabsTrigger>
          <TabsTrigger value="connectors">连接器</TabsTrigger>
          <TabsTrigger value="members">成员</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="pt-3">
          <SessionsTab ws={ws} selfUid={selfUid} />
        </TabsContent>
        <TabsContent value="agents" className="pt-3">
          <WorkspaceAgentsTab ws={ws} selfUid={selfUid} />
        </TabsContent>
        <TabsContent value="connectors" className="pt-3">
          <ConnectorsTab ws={ws} selfUid={selfUid} />
        </TabsContent>
        <TabsContent value="members" className="pt-3">
          <MembersTab ws={ws} selfUid={selfUid} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── 会话 tab ─────────────────────────────────────────────────────────

function SessionsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const importSession = useChat((s) => s.importWorkspaceSession);
  const unpublish = useChat((s) => s.unpublishWorkspaceSession);
  const rows = sessionRows(ws);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className={SECTION_LABEL}>已发布会话</span>
        {rows.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">还没有人发布会话到这个工作区。</p>
        ) : (
          rows.map((row) => {
            const raw = ws.sessions.find((s) => s.id === row.id)!;
            const mine = raw.publisherUid === selfUid;
            return (
              <div key={row.id} className={cn(ROW, "border border-border")}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 bg-transparent text-left"
                  onClick={() => void importSession(raw.publisherUid, raw.pkgId)}
                  title="导入到本机成为一个新会话"
                >
                  <span className="min-w-0 truncate font-medium">{row.title}</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    {row.publisherLabel} · {formatProxyTime(row.updatedTs)}
                  </span>
                </button>
                {mine && (
                  <Button
                    variant="ghost" size="xs" className="shrink-0 text-err"
                    onClick={() => {
                      if (confirm(`撤回会话「${row.title}」？其他成员将不能再导入它。`)) {
                        void unpublish(ws.id, row.id);
                      }
                    }}
                  >
                    撤回
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
      {/* 归档的云会话垫在最底下：翻旧账的东西不该排在还有用的东西前面 */}
      <CloudSessionsSection ws={ws} />
    </div>
  );
}

/** 归档了的云会话（issue #919，前身是这一页顶部那节「云会话」，Task 13/ADR-0199）。
    与上面「已发布会话」（一次性快照，导入即 fork 成本机新会话）是两种不同的东西，
    分开一节，不混进同一张表。列表本身没有推送通道（同 workspaceGroups 的十一个
    action，workspaceCloudList 无 onChanged），挂载时拉一次。活着的那些在侧栏工作区组里，新建也在那儿——
    这里只是归档的去处，同本地会话的「已归档会话」那一屏。云端没有"恢复归档"
    （daemon 启动只捞 archived=false 的会话重开房间），所以这些行只读，点进去
    也只是看：openCloudSession 对归档会话仍然连得上房间读历史。一条归档的都没有
    时整节不出——这一页是管理面，不该为一件没发生过的事留一行空态。 */
function CloudSessionsSection({ ws }: { ws: WorkspaceSnapshot }) {
  const list = useChat((s) => s.cloudSessionList[ws.id]) ?? EMPTY_CLOUD_SESSIONS;
  const refresh = useChat((s) => s.refreshCloudSessions);
  const openCloud = useChat((s) => s.openCloudSession);

  useEffect(() => {
    void refresh(ws.id);
  }, [ws.id, refresh]);

  const rows = cloudSessionRows(list, ws).filter((r) => r.archived);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className={SECTION_LABEL}>已归档的云会话</span>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={cn(ROW, "border border-border bg-transparent text-left")}
          onClick={() => void openCloud(ws.id, row.id)}
        >
          <span className="min-w-0 flex-1 truncate">
            <b className="font-medium">{row.title}</b>
            <span className="text-muted-foreground"> · {row.creatorLabel} · {formatProxyTime(row.updatedTs)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── 连接器 tab ───────────────────────────────────────────────────────

/** 云端状态的点：三档不能合并成两档——"unknown"（拿不到清单）与 "off"
    （清单里确实没有）是两件事，前者不该说成后者的负面措辞（同 px 一节
    hostStatusLine 的纪律：拿不到 ≠ 不可用，审查 round 1 finding）*/
function CloudStateDot({ state }: { state: ConnectorCloudState }) {
  if (state === "ready") {
    return <span className="size-[7px] shrink-0 rounded-full bg-brand" aria-label="云端可用" title="云端可用" />;
  }
  if (state === "unknown") {
    return (
      <span
        className="size-[7px] shrink-0 rounded-full bg-muted-foreground/40"
        aria-label="云端状态未知"
        title="云端状态未知——本机暂时拿不到这份清单"
      />
    );
  }
  return <span className="size-[7px] shrink-0 rounded-full bg-border" aria-label="云端不可用" />;
}

function ConnectorsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const withdraw = useChat((s) => s.withdrawWorkspaceConnector);
  // hostedServerIds 的渲染层来源目前只有 A 侧「云端可用」总览按 friendUid 聚合
  // （ProxyHostView.cloudReady），没有拆到 serverId 粒度的清单可复用——
  // TODO(#811): hostedServerIds 需要一条 IPC，届时这里换成真实来源
  const hostedServerIds: readonly string[] | null = null;
  const rows = connectorRows(ws, selfUid, hostedServerIds);
  const [contributeOpen, setContributeOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setContributeOpen(true)}>贡献连接器…</Button>
      </div>
      {rows.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">还没有人贡献连接器。</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.serverId} className={cn(ROW, "border border-border")}>
              <CloudStateDot state={row.cloudState} />
              <span className="min-w-0 flex-1 truncate">
                <b className="font-medium">{row.serverId}</b>
                <span className="text-muted-foreground"> · {row.hostLabel} · {row.toolsSummary}</span>
              </span>
              {row.mine && (
                <Button
                  variant="ghost" size="xs" className="shrink-0 text-err"
                  onClick={() => void withdraw(ws.id, row.serverId)}
                >
                  撤回
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <ContributeConnectorDialog ws={ws} selfUid={selfUid} open={contributeOpen} onOpenChange={setContributeOpen} />
    </div>
  );
}

function ContributeConnectorDialog({
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

  // 每次开框重新从当前已贡献的那份回填——不带着上一次开框时的临时勾选状态
  const onDialogOpenChange = (o: boolean): void => {
    if (o) setSel(selectionFromAllow(mine));
    onOpenChange(o);
  };

  const doConfirm = async (): Promise<void> => {
    setBusy(true);
    const next = buildAllow(sel);
    const nextIds = new Set(next.map((a) => a.serverId));
    const prevIds = new Set(mine.map((c) => c.serverId));
    for (const a of next) await contribute(ws.id, a.serverId, a.tools);
    for (const id of prevIds) if (!nextIds.has(id)) await withdraw(ws.id, id);
    setBusy(false);
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

// ─── 成员 tab ─────────────────────────────────────────────────────────

function MembersTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const kick = useChat((s) => s.kickWorkspaceGroupMember);
  const addMember = useChat((s) => s.addWorkspaceGroupMember);
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const rows = memberRows(ws, selfUid);

  const memberUids = new Set(ws.members.map((m) => m.uid));
  const candidates = friends.filter((f) => !memberUids.has(f.profile.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.uid} className={cn(ROW, "border border-border")}>
            <span className="min-w-0 flex-1 truncate">
              {row.label}
              {row.role === "owner" && <span className="ml-1 text-[10.5px] text-muted-foreground">· 所有者</span>}
            </span>
            {row.canKick && (
              <Button
                variant="ghost" size="xs" className="shrink-0 text-err"
                onClick={() => {
                  if (confirm(`把 ${row.label} 移出工作区？TA 借用/贡献的连接器授权会立即失效。`)) {
                    void kick(ws.id, row.uid);
                  }
                }}
              >
                移出
              </Button>
            )}
          </div>
        ))}
      </div>

      {ws.ownerUid === selfUid && (
        <div className="flex flex-col gap-1">
          <span className={SECTION_LABEL}>拉好友加入</span>
          {candidates.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">好友都已经在这个工作区里了。</p>
          ) : (
            candidates.map((f) => (
              <div key={f.profile.id} className={ROW}>
                <span className="min-w-0 flex-1 truncate">{f.profile.name || f.profile.email}</span>
                <Button
                  variant="ghost" size="xs" className="shrink-0"
                  onClick={() => void addMember(ws.id, f.profile.id)}
                >
                  <UserPlus className="size-[12px]" /> 加入
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
