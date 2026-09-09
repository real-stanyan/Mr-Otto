// WorkspaceConnectorsTab —— 工作区设置里的「连接器」那一页（#1120 从 WorkspacePage 抽出）。
//
// 两组都在回答「这个工作区能够到外面的什么」：上面是 MCP 服务，下面是代码仓库的凭据。
// 它们走的是**完全不同的执行路径**——MCP 那半是 edge 的托管箱（ADR-0197），Git 这半是
// runtime 上一台一次性旁路容器（ADR-0200 决策②，凭据不进水獭那台容器）——所以分组标题
// 不是装饰，它是这一页上唯一说清「这两样不是一类」的地方。
//
// #1120 只改了三样：行的样子换成分组卡、两段解释从正文降为**组尾**（挨着它解释的那组
// 东西），以及「添加主机」从弹窗变成推入页（`AddGitHostScreen`）——420px 的抽屉里开一个
// `sm:max-w-[420px]` 的弹窗本来就不成立。判据、三态、令牌纪律一个字没动。

import { useEffect, useState } from "react";
import { Lock, Plug, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { InsetEmpty, InsetGroup, InsetIcon, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useNav } from "@/components/ui/nav-stack.js";
import { useChat } from "../store.js";
import { connectorRows, type ConnectorCloudState } from "../lib/workspaceView.js";
import { gitHostRows, gitHostsNotice } from "../lib/gitHostsView.js";
import { validateGitHost } from "../../../shared/remote/gitHost.js";
import { ContributeConnectorDialog } from "./ContributeConnectorDialog.js";
import type { CsGitHost } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** 云端状态的点：三档不能合并成两档——"unknown"（拿不到清单）与 "off"（清单里确实没有）
    是两件事，前者不该说成后者的负面措辞（同 px 一节 hostStatusLine 的纪律） */
function CloudStateDot({ state }: { state: ConnectorCloudState }) {
  if (state === "ready") {
    return <span className="size-[7px] shrink-0 rounded-full bg-ok" aria-label="云端可用" title="云端可用" />;
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

export function WorkspaceConnectorsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const withdraw = useChat((s) => s.withdrawWorkspaceConnector);
  // hostedServerIds 的渲染层来源目前只有 A 侧「云端可用」总览按 friendUid 聚合
  // （ProxyHostView.cloudReady），没有拆到 serverId 粒度的清单可复用——
  // TODO(#811): hostedServerIds 需要一条 IPC，届时这里换成真实来源
  const hostedServerIds: readonly string[] | null = null;
  const rows = connectorRows(ws, selfUid, hostedServerIds);
  const [contributeOpen, setContributeOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <InsetLabel className="pt-0">MCP 服务</InsetLabel>
      <InsetGroup sepInset={51}>
        {rows.length === 0 ? (
          <InsetEmpty
            icon={<Plug />}
            title="还没有人贡献连接器"
            hint="贡献一台，全体成员就能以你的身份用它的工具——凭证不会离开托管箱。"
          />
        ) : (
          rows.map((row) => (
            <InsetRow
              key={row.serverId}
              leading={<InsetIcon><Plug /></InsetIcon>}
              title={row.serverId}
              subtitle={`${row.hostLabel} · ${row.toolsSummary}`}
              trailing={
                <>
                  <CloudStateDot state={row.cloudState} />
                  {row.mine && (
                    <Button
                      variant="ghost" size="xs" className="text-err"
                      onClick={() => void withdraw(ws.id, row.serverId)}
                    >
                      撤回
                    </Button>
                  )}
                </>
              }
            />
          ))
        )}
        <InsetRow
          leading={<InsetIcon><Plus /></InsetIcon>}
          title="贡献我的连接器"
          tone="action"
          onClick={() => setContributeOpen(true)}
        />
      </InsetGroup>
      <InsetNote>
        全体成员（含以后加进来的人）会<b className="font-medium text-foreground">以你的身份</b>用这些工具，
        凭证托管在 Mr Otto 云端——你关机他们照样能用。绿点 = 云端此刻可用；灰点 = 本机暂时读不到这份清单，
        <b className="font-medium text-foreground">不是</b>不可用。
      </InsetNote>

      <ContributeConnectorDialog ws={ws} selfUid={selfUid} open={contributeOpen} onOpenChange={setContributeOpen} />

      <GitHostsSection ws={ws} selfUid={selfUid} />
    </div>
  );
}

/** 「代码仓库」那一组（#1104）。**token 从不下行**——这张表里一行 = 一台能认证的主机，
    那把钥匙只活在 runtime 那台 VPS 上。

    owner 才画 ＋ 与删除；非 owner 看到的是**同一份清单**、只是没有那两颗钮——不是整组
    藏起来（藏起来会让人以为这个工作区没配过，同 ADR-0243 对非 owner 的处置）。 */
function GitHostsSection({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const load = useChat((s) => s.workspaceCloudState);
  const save = useChat((s) => s.workspaceCloudGitCredential);
  const nav = useNav();
  const isOwner = ws.ownerUid === selfUid;

  const [hosts, setHosts] = useState<readonly CsGitHost[] | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void load(ws.id).then((r) => {
      if (!alive) return;
      // 拉不到整份 = 读不到（null），与「一台都没配」（[]）分开画
      setHosts(r.ok ? r.value.gitHosts : null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [ws.id, load]);

  const rows = gitHostRows(hosts ?? [], ws.members, isOwner, now);
  const notice = gitHostsNotice(hosts, loading);

  return (
    <>
      <InsetLabel>代码仓库</InsetLabel>
      <InsetGroup sepInset={51}>
        {/* 三种「空」由 `gitHostsNotice` 一处判（正在读 / 读不到 / 一台都没配），
            这里不再自己画一个空态——两处各判一次，迟早在「读不到」那一档上分家 */}
        {notice && (
          <InsetRow
            title={<span className={notice.tone === "err" ? "text-err" : "text-muted-foreground"}>{notice.text}</span>}
            label={notice.text}
          />
        )}
        {rows.map((row) => (
          <InsetRow
            key={row.host}
            leading={<InsetIcon><Lock /></InsetIcon>}
            title={row.host}
            subtitle={row.meta}
            trailing={
              row.canRemove ? (
                <Button
                  variant="ghost" size="xs" className="text-err"
                  onClick={() => {
                    // `token: ""` = 删掉这台主机（协议 15 的两态）。成功时服务端回的是
                    // **它此刻的**清单，直接换上——不本地推算，那会在「我删了但服务端
                    // 没删成」时画出一个假状态
                    void save(ws.id, row.host, "").then((r) => { if (r.ok) setHosts(r.value); });
                  }}
                >
                  删除
                </Button>
              ) : null
            }
          />
        ))}
        {isOwner && (
          <InsetRow
            leading={<InsetIcon><Plus /></InsetIcon>}
            title="添加主机"
            tone="action"
            disabled={loading}
            onClick={() => nav.push(addGitHostScreen(ws, (next) => setHosts(next)))}
          />
        )}
      </InsetGroup>
      <InsetNote>
        存一把访问令牌，水獭就能替你拉私有仓库。<b className="font-medium text-foreground">令牌只留在服务端</b>
        ——这张表里看得到有哪几台主机，看不到那把钥匙。
      </InsetNote>
    </>
  );
}

/** 「添加主机」从弹窗变成推入页（#1120）。

    **令牌框存完即清**——纪律照抄 `ProviderKeyDialog` 的原话：「输入框存完即清，渲染层
    不留 key 的任何副本；状态只有布尔」。这里连布尔都不留：存完这一页就被弹掉，本地 state
    跟着卸载。

    主机名**本地先过一遍 `validateGitHost`** 省掉一次明知会被拒的往返；服务端仍然自己
    校验一次——渲染层不是安全边界。 */
function addGitHostScreen(
  ws: WorkspaceSnapshot,
  onSaved: (hosts: readonly CsGitHost[] | null) => void
) {
  return {
    key: `git-host-add:${ws.id}`,
    title: "添加主机",
    backLabel: "连接器",
    render: () => <AddGitHostForm ws={ws} onSaved={onSaved} />,
  };
}

function AddGitHostForm({ ws, onSaved }: { ws: WorkspaceSnapshot; onSaved: (hosts: readonly CsGitHost[] | null) => void }) {
  const save = useChat((s) => s.workspaceCloudGitCredential);
  const nav = useNav();
  const [host, setHost] = useState("github.com");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doSave = async (): Promise<void> => {
    const valid = validateGitHost(host);
    if (!valid.ok) { setError(valid.message); return; }
    if (token.trim() === "") {
      // 空串在协议里是「删掉这台主机」，从「添加」这条路发出去就是南辕北辙
      setError("令牌不能为空。要删掉一台主机，用列表行上的「删除」。");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await save(ws.id, valid.host, token);
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    setToken("");            // 存完即清，不等这一页卸载
    onSaved(r.value);
    nav.pop();
  };

  return (
    <div className="flex flex-col">
      <InsetLabel className="pt-0">主机</InsetLabel>
      <InsetGroup>
        <InsetRow
          title={
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="github.com"
              disabled={busy}
              autoFocus
              className="h-auto border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
            />
          }
          label="主机名"
        />
        <InsetRow
          title={
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="访问令牌（Personal Access Token）"
              disabled={busy}
              className="h-auto border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
            />
          }
          label="访问令牌"
        />
      </InsetGroup>
      <InsetNote>
        同一台主机<b className="font-medium text-foreground">再存一次就是换新的那把</b>。
        令牌不会下发到任何人的客户端，成员在这一页只看得到主机名。
      </InsetNote>
      {error !== null && <p className="px-1 pt-2 text-xs text-err">{error}</p>}
      <div className="pt-4">
        <Button className="w-full" disabled={busy} onClick={() => void doSave()}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}
