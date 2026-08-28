// 「好友代理」弹窗（issue #657，ADR-0151 / ADR-0162）。
//
// 三件事各一页：
//   分享 —— A 圈白名单（哪些服务、每个服务里的哪些工具）→ 生成邀请码 → 复制发给好友；
//   已授权 —— A 看自己授出去了什么、一键撤销、翻这个好友的调用记录；
//   接受邀请 —— B 把收到的邀请码粘进来，连上对方。
//
// 两条要说给用户听的实话，都写在界面上而不是只写在这儿：
//   1. **邀请码等于钥匙**：谁拿到谁就能以你的身份调你圈的那些工具，只发给本人。
//   2. 圈定的是「工具」不是「一次调用」——白名单内是全自动的，没有逐次审批。
//
// 勾选表 ↔ 线上白名单的换算全在 lib/proxyShare.ts（`tools: []` = 整服务放行
// 这条约定很容易踩反，钉在那层的纯函数与测试里）。状态走 store，不直接摸 window.otter。

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useChat } from "../store.js";
import {
  auditLine, borrowStatusLine, buildAllow, describeAllow, hostStatusLine,
  isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool,
  type ProxySelection, type ProxyStatusLine,
} from "../lib/proxyShare.js";

const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

/** 状态点：四档配四种样子（档位的含义见 proxyShare.ProxyStatusLine） */
const DOT: Record<ProxyStatusLine["dot"], string> = {
  live: "bg-brand animate-pulse",
  on: "bg-brand",
  off: "bg-border",
  dead: "bg-err",
};

function StatusDot({ line }: { line: ProxyStatusLine }) {
  return <span className={`size-[7px] rounded-full shrink-0 ${DOT[line.dot]}`} aria-label={line.text} />;
}

/** 朴素勾选框：shadcn 那套没装 checkbox，这里就地用原生的（尺寸/配色对齐主题） */
function Check({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none min-w-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="size-[13px] shrink-0 accent-[var(--brand)]"
        aria-label={label}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

export function ProxyDialog({
  open, onOpenChange, friend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 「分享」页的对象。没有就只剩另外两页可用 */
  friend: { id: string; label: string } | null;
}) {
  const mcpServers = useChat((s) => s.mcpServers);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const grants = useChat((s) => s.proxyGrants);
  const borrows = useChat((s) => s.proxyBorrows);
  const hosts = useChat((s) => s.proxyHosts);
  const audits = useChat((s) => s.proxyAudits);
  const friendError = useChat((s) => s.friendError);
  const refreshProxyGrants = useChat((s) => s.refreshProxyGrants);
  const createProxyInvite = useChat((s) => s.createProxyInvite);
  const acceptProxyInvite = useChat((s) => s.acceptProxyInvite);
  const revokeProxy = useChat((s) => s.revokeProxy);
  const loadProxyAudits = useChat((s) => s.loadProxyAudits);
  const refreshProxyStatus = useChat((s) => s.refreshProxyStatus);
  const disconnectProxy = useChat((s) => s.disconnectProxy);
  const updateProxyGrant = useChat((s) => s.updateProxyGrant);

  const [tab, setTab] = useState(friend ? "share" : "grants");
  const [sel, setSel] = useState<ProxySelection>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [invite, setInvite] = useState("");
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [auditOf, setAuditOf] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 每次打开都重置 + 拉一次台账：授权是本机状态，主进程不推
  useEffect(() => {
    if (!open) return;
    setTab(friend ? "share" : "grants");
    setSel({});
    setExpanded(new Set());
    setInvite("");
    setCopied(false);
    setPaste("");
    setAccepted(false);
    setSaved(false);
    setAuditOf(null);
    void (async () => {
      await refreshProxyGrants();
      // **把现有授权预勾上**（issue #680）：不预填的话「把 read 改成 read+write」
      // 要用户把原来勾过的全部重勾一遍，一步都不能漏，漏了就是静默降权。
      // 拉完再读 store 而不是把 grants 进依赖数组——那样每次台账刷新
      // 都会把用户正在改的勾选覆盖掉
      if (!friend) return;
      const g = useChat.getState().proxyGrants.find((x) => x.friendUid === friend.id);
      if (g) setSel(selectionFromAllow(g.allow));
    })();
    // 代理全景是推送式更新的（onProxyChanged），这里拉一次补齐重载后的空白
    void refreshProxyStatus();
  }, [open, friend, refreshProxyGrants, refreshProxyStatus]);

  // 只圈得动连上的服务：没连上的给了对方也调不动，反而误导（同 buildGrantedServers 的口径）。
  // 展示名就是 server id —— 那是 mcp.json 里的键，也是用户自己起的名字
  const live = useMemo(
    () => mcpServers.servers.filter((s) => s.status === "connected"),
    [mcpServers]
  );
  const friendNameOf = useMemo(() => {
    const byUid = new Map(snapshot.friends.map((e) => [e.profile.id, e.profile.name || e.profile.email]));
    return (uid: string): string => byUid.get(uid) ?? uid;
  }, [snapshot]);

  const allow = buildAllow(sel);
  /** 这个好友已经授过了没有——决定「更新授权」这条路走不走得通 */
  const existing = friend ? grants.find((g) => g.friendUid === friend.id) : undefined;

  const save = async () => {
    if (!friend || allow.length === 0) return;
    setSaved(await updateProxyGrant(friend.id, allow));
  };

  const generate = async () => {
    if (!friend || allow.length === 0) return;
    const code = await createProxyInvite(friend.id, allow);
    if (code) {
      setInvite(code);
      setCopied(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(invite);
    setCopied(true);
  };

  const accept = async () => {
    const text = paste.trim();
    if (!text) return;
    const ok = await acceptProxyInvite(text);
    setAccepted(ok);
    if (ok) setPaste("");
  };

  const showAudits = async (uid: string) => {
    setAuditOf(uid);
    await loadProxyAudits(uid);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>好友代理</DialogTitle>
          <DialogDescription>
            让好友以你的身份用你已经接通的服务。凭证留在你这台机器上，对方拿到的是调用结果。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="share" disabled={!friend}>
              分享{friend ? ` 给 ${friend.label}` : ""}
            </TabsTrigger>
            <TabsTrigger value="grants">已授权</TabsTrigger>
            <TabsTrigger value="accept">接受邀请</TabsTrigger>
          </TabsList>

          {/* ─── 分享：圈白名单 → 生成邀请码 ─────────────────────────── */}
          <TabsContent value="share" className="space-y-2">
            {live.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">
                还没有连上的 MCP 服务。先在设置里接一个（比如 Shopify），才有东西可分享。
              </p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto border border-border rounded-md py-1">
                {live.map((srv) => {
                  const toolNames = srv.tools.map((t) => t.name);
                  const isOpen = expanded.has(srv.id);
                  return (
                    <div key={srv.id}>
                      <div className={ROW}>
                        <button
                          type="button"
                          className="p-0 bg-transparent text-muted-foreground hover:text-foreground"
                          aria-label={isOpen ? "收起工具" : "展开工具"}
                          onClick={() => setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(srv.id)) next.delete(srv.id);
                            else next.add(srv.id);
                            return next;
                          })}
                        >
                          {isOpen ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
                        </button>
                        <Check
                          checked={isServerOn(sel, srv.id)}
                          onChange={() => setSel((p) => toggleServer(p, srv.id, !isServerOn(p, srv.id)))}
                          label={srv.id}
                        />
                        <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                          {srv.tools.length} 个工具
                        </span>
                      </div>
                      {isOpen && (
                        <div className="pl-8 pb-1">
                          {toolNames.map((tool) => (
                            <div key={tool} className={ROW}>
                              <Check
                                checked={isToolOn(sel, srv.id, tool)}
                                onChange={() => setSel((p) => toggleTool(p, srv.id, tool, toolNames))}
                                label={tool}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              圈中的工具，对方<strong className="font-medium text-foreground">随时能调、不再逐次问你</strong>
              ——只圈你愿意让他直接动的那些。已经发生的每一笔都记在「已授权 → 查看记录」里。
            </p>

            {invite ? (
              <div className="space-y-2">
                <Textarea readOnly value={invite} className="text-[11px] font-mono h-[72px]" />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copy()}>
                    <Copy className="size-[13px]" />
                    {copied ? "已复制" : "复制邀请码"}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    10 分钟内有效 · 只发给本人（谁拿到谁就能用）
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {/* 已经授过的：改白名单是**改**，不是重新配一次对（issue #680）。
                    重发邀请码会换一张邀请、重开房间、逼对方再接受一遍，
                    而「把 read 改成 read+write」根本不需要那些 */}
                {existing && (
                  <Button size="sm" disabled={allow.length === 0} onClick={() => void save()}>
                    {saved ? "已更新" : "更新授权"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={existing ? "secondary" : "default"}
                  disabled={!friend || allow.length === 0}
                  onClick={() => void generate()}
                >
                  <KeyRound className="size-[13px]" />
                  {existing ? "重发邀请码" : "生成邀请码"}
                </Button>
              </div>
            )}
            {allow.length > 0 && !invite && (
              <p className="text-[11px] text-muted-foreground">
                {existing ? "改成" : "将授权"}：{describeAllow(allow)}
                {existing && "（已按现有授权预勾选）"}
              </p>
            )}
          </TabsContent>

          {/* ─── 已授权：看 / 撤销 / 翻记录 ──────────────────────────── */}
          <TabsContent value="grants" className="space-y-2">
            {grants.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">还没有授权给任何人。</p>
            ) : (
              grants.map((g) => {
                // 台账里有、状态表里还没有 = 主进程刚起来还没推。按「没连上」显示，
                // 那也是事实（同 hostStatus 的口径：授权是底本，状态往上贴）
                const h = hosts.find((x) => x.friendUid === g.friendUid);
                const line = hostStatusLine(h ?? { connected: false, inflight: 0, lastCallAt: null });
                return (
                <div key={g.friendUid} className="border border-border rounded-md px-2 py-[6px] text-xs">
                  <div className="flex items-center gap-2">
                    <StatusDot line={line} />
                    <span className="flex-1 min-w-0 truncate">{friendNameOf(g.friendUid)}</span>
                    <Button variant="ghost" size="sm" className="px-2 text-xs"
                      onClick={() => void showAudits(g.friendUid)}>
                      查看记录
                    </Button>
                    <Button variant="ghost" size="sm" className="px-2 text-xs text-err"
                      onClick={() => void revokeProxy(g.friendUid)}>
                      撤销
                    </Button>
                  </div>
                  {/* 白名单内是全自动的——「此刻正在用我的凭证」只有这一行说得出口 */}
                  <p className="text-[11px] text-muted-foreground truncate">{line.text}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{describeAllow(g.allow)}</p>
                </div>
                );
              })
            )}

            {auditOf !== null && (
              <div className="pt-1">
                <div className="text-[11px] text-muted-foreground pb-1">
                  {friendNameOf(auditOf)} 的调用记录（新→旧）
                </div>
                {audits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">还没有调用过。</p>
                ) : (
                  <div className="max-h-[180px] overflow-y-auto border border-border rounded-md py-1">
                    {audits.map((a, i) => {
                      const line = auditLine(a);
                      return (
                        <div key={`${a.ts}-${i}`} className="px-2 py-[6px] text-xs">
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground shrink-0">{line.time}</span>
                            <span className="flex-1 min-w-0 truncate">{line.target}</span>
                            <span className="shrink-0 text-muted-foreground">{line.verdict}</span>
                          </div>
                          {/* 参数是防线 1 点名要的那一段：白名单内的写操作全自动，
                              事后「到底动了什么」只有这里答得上来（ADR-0151） */}
                          {line.args && (
                            <div className="text-[10px] font-mono text-muted-foreground/80 break-all pt-[2px]">
                              {line.args}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* ─── 接受邀请 + 我借来的：B 侧 ────────────────────────────── */}
          <TabsContent value="accept" className="space-y-2">
            {borrows.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-muted-foreground">我在用的服务</div>
                {borrows.map((b) => {
                  const line = borrowStatusLine(b);
                  return (
                  <div key={b.hostUid} className="border border-border rounded-md px-2 py-[6px] text-xs flex items-center gap-2">
                    <StatusDot line={line} />
                    <span className="flex-1 min-w-0 truncate">{b.label || b.hostUid.slice(0, 8)}</span>
                    {/* 「没连上」「被撤销了」「连上了但没授权」是三件事，
                        对应的下一步完全不同（等 / 重走邀请码 / 找对方要授权） */}
                    <span className="shrink-0 text-[11px] text-muted-foreground max-w-[180px] truncate">
                      {line.text}
                    </span>
                    <Button variant="ghost" size="sm" className="px-2 text-xs text-err"
                      onClick={() => void disconnectProxy(b.hostUid)}>
                      {b.revokedReason ? "移除" : "断开"}
                    </Button>
                  </div>
                  );
                })}
              </div>
            )}
            <Textarea
              value={paste}
              onChange={(e) => { setPaste(e.target.value); setAccepted(false); }}
              placeholder="把好友发来的邀请码粘在这里（otto-proxy: 开头的一串）"
              className="text-[11px] font-mono h-[72px]"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!paste.trim()} onClick={() => void accept()}>接受</Button>
              {accepted && (
                <span className="text-[11px] text-muted-foreground">
                  已接受，上面那行会显示接上没有
                </span>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {friendError && <p className="text-xs text-err">{friendError}</p>}
      </DialogContent>
    </Dialog>
  );
}
