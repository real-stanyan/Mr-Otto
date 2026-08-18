// Protocol 仪表盘(只读) — gearbox 协议可视化第一刀:ADR / issues / handoff。
// 全部数据从 store 取(store 背后是 ShellBridge);本组件零 IPC、零业务逻辑,纯投影。
// 降级哲学(spec §3):每块独立坏、独立给指引,任何一块坏不拖垮整页。

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { RefreshCw, FolderOpen, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Separator } from "@/components/ui/separator.js";
import { useChat } from "../store.js";
import { parseHandoff, type IssueRole, type IssuesResult } from "../../../shared/protocol.js";

/** 角色标签:gearbox 三角色的视觉词汇。染色只用语义令牌,不写裸色 */
const ROLE_BADGE: Record<IssueRole, { label: string; cls: string }> = {
  task: { label: "Task", cls: "bg-muted text-muted-foreground" },
  memory: { label: "Handoff", cls: "bg-brand/15 text-brand" },
  gap: { label: "Protocol gap", cls: "bg-destructive/15 text-destructive" },
};

function RoleBadge({ role }: { role: IssueRole }) {
  const b = ROLE_BADGE[role];
  return <span className={`shrink-0 rounded px-[6px] py-px text-[11px] ${b.cls}`}>{b.label}</span>;
}

/** issues 面板的降级指引:按错误 kind 给能行动的下一步,不甩原始报错 */
function IssuesError({ result }: { result: Extract<IssuesResult, { ok: false }> }) {
  const guide: Record<string, string> = {
    "gh-missing": "未找到 gh CLI。安装:brew install gh,然后 gh auth login。",
    "no-repo": "此目录不是 git 仓库或未连 GitHub remote。ADR 面板不受影响。",
    "gh-auth": "gh 未登录。终端跑一次:gh auth login。",
    "gh-error": "GitHub 请求失败(网络/限流?)。可点刷新重试。",
  };
  return (
    <div className="px-3 py-6 text-sm text-muted-foreground">
      <p>{guide[result.kind]}</p>
      <p className="mt-2 font-mono text-xs opacity-70 break-all">{result.detail}</p>
    </div>
  );
}

/** handoff 评论:五段式解析成卡片;解析不出整条回退原文渲染(宁可不解析,不猜) */
function CommentBody({ body }: { body: string }) {
  const parts = parseHandoff(body);
  if (!parts)
    return (
      <div className="md max-w-full">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {body}
        </Markdown>
      </div>
    );
  const rows: { label: string; text: string }[] = [
    { label: "① 做完了什么", text: parts.done },
    { label: "② 什么被阻塞", text: parts.blocked },
    { label: "③ 下一步", text: parts.next },
    { label: "④ 关单情况", text: parts.closed },
    { label: "⑤ 决策与理由", text: parts.rationale },
  ];
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <div key={r.label} className="rounded border border-border bg-muted/40 px-3 py-2">
          <div className="text-[11px] font-semibold text-brand">{r.label}</div>
          <div className="text-sm whitespace-pre-wrap">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

export function ProtocolView() {
  const {
    protocolRepo, adrs, adrView, issues, issueView,
    closeProtocol, pickProtocolRepo, refreshProtocol, openAdr, openIssue,
  } = useChat();
  const tab = useChat((s) => s.protocolTab);
  const setTab = useChat((s) => s.setProtocolTab);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  if (!protocolRepo) {
    return (
      <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>还没有目标仓库——选一个含 docs/adr 或连着 GitHub 的文件夹。</p>
        <Button onClick={() => void pickProtocolRepo()}>
          <FolderOpen /> 选择仓库
        </Button>
      </main>
    );
  }

  // 右栏内容:没选中时不渲染占位文案,整栏收起让列表占满(半屏下空栏太浪费)
  const detail = adrView ? (
    <article className="md max-w-[760px]">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {adrView.markdown}
      </Markdown>
    </article>
  ) : issueView ? (
    !issueView.ok ? (
      <IssuesError result={issueView} />
    ) : (
      <article className="max-w-[760px]">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            <span className="font-mono text-muted-foreground">#{issueView.issue.number}</span> {issueView.issue.title}
          </h2>
          <RoleBadge role={issueView.issue.role} />
          <span className="text-xs text-muted-foreground">{issueView.issue.state}</span>
        </div>
        <div className="md mt-3">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {issueView.issue.body || "_(无正文)_"}
          </Markdown>
        </div>
        {issueView.issue.comments.map((c, idx) => (
          <div key={idx} className="mt-4 rounded border border-border bg-card px-4 py-3">
            <div className="mb-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{c.author}</span>
              {" · "}{c.createdAt ? new Date(c.createdAt).toLocaleString() : ""}
            </div>
            <CommentBody body={c.body} />
          </div>
        ))}
      </article>
    )
  ) : null;

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      {/* 头部:仓库路径 + 换目录/刷新/关闭 */}
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        {/* min-w-0 + shrink-0 的分工见 GitGraphView 同处注释:少了它们,
            窄面板下这排按钮(含关闭)会被路径文字挤出可视区 */}
        <span className="min-w-0 flex-1 font-mono text-xs text-muted-foreground truncate" title={protocolRepo}>
          {protocolRepo}
        </span>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="sm" onClick={() => void pickProtocolRepo()} title="换目标仓库">
            <FolderOpen />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refreshProtocol()} title="重新拉取 ADR 与 issues">
            <RefreshCw />
          </Button>
          {/* 半屏/全屏切换:面板默认半屏叠在会话旁,要沉浸再撑满 */}
          <Button variant="ghost" size="sm" onClick={togglePanelWide} title={panelWide ? "收回半屏" : "展开全屏"}>
            {panelWide ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button variant="ghost" size="sm" onClick={closeProtocol} title="关闭仪表盘">
            <X />
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* 左列:ADR / Issues 列表(无 shadcn Tabs,两颗 Button 拼分段开关);没选详情时占满整宽 */}
        <div className={detail ? "w-[300px] shrink-0 border-r border-border flex flex-col" : "flex-1 min-w-0 flex flex-col"}>
          <div className="flex gap-1 p-2">
            <Button variant={tab === "adr" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => setTab("adr")}>
              ADR
            </Button>
            <Button variant={tab === "issues" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => setTab("issues")}>
              Issues
            </Button>
          </div>
          <Separator />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tab === "adr" ? (
              adrs.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">此仓库没有 docs/adr 或 docs/gearbox-adr。</p>
              ) : (
                adrs.map((a) => (
                  <button
                    key={a.path}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-accent ${adrView?.path === a.path ? "bg-accent" : ""}`}
                    onClick={() => void openAdr(a.path)}
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {a.source === "gearbox-adr" ? "GX-" : ""}{a.id}
                    </span>
                    <span className="block truncate">{a.title}</span>
                  </button>
                ))
              )
            ) : issues === null ? (
              <div className="grid gap-2 p-3">
                <Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" />
              </div>
            ) : !issues.ok ? (
              <IssuesError result={issues} />
            ) : (
              // spec §1:open/closed 两组列表,closed 组前加分隔标题(镜像 App.tsx 侧栏"史前会话"的样式)
              (() => {
                const open = issues.issues.filter((i) => i.state === "open");
                const closed = issues.issues.filter((i) => i.state === "closed");
                const row = (i: (typeof issues.issues)[number]) => (
                  <button
                    key={i.number}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${i.state === "closed" ? "opacity-55" : ""}`}
                    onClick={() => void openIssue(i.number)}
                  >
                    <span className="font-mono text-xs text-muted-foreground shrink-0">#{i.number}</span>
                    <span className="flex-1 min-w-0 truncate">{i.title}</span>
                    <RoleBadge role={i.role} />
                  </button>
                );
                return (
                  <>
                    {open.map(row)}
                    {closed.length > 0 && (
                      <>
                        <div className="text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]">已关闭</div>
                        {closed.map(row)}
                      </>
                    )}
                  </>
                );
              })()
            )}
          </div>
        </div>

        {/* 右区:选中的 ADR 全文或 issue 详情;没选中整栏不渲染 */}
        {detail && <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">{detail}</div>}
      </div>
    </main>
  );
}
