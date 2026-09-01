// CloudSessionPage —— 云会话页：桌面当显示器，接 VPS 上常驻的 runtime（Task 13，ADR-0199）。
//
// 页而不是弹窗：WorkspacePage 打开它时整页替换 Tabs（同 ADR-0185 的教训），
// 这里是聊天式的长内容，弹窗只会滚动条套滚动条。挂载它的 Drawer（App.tsx
// 的工作区抽屉）本身就是"整块内容一起滚"的窄侧栏，不是独立的全高面板
// （FriendChatView 那种 sticky 头/footer + 内部滚动区在这个容器里用不上，
// 这里跟 WorkspacePage 一样走简单的堆叠流：composer 就在事件流下面，
// 跟着页面一起滚，不额外开一层嵌套滚动容器）。
//
// 事件流复用 EventRow + TimelineProjectionContext（同 OttoThread 的用法，
// 见 aui/OttoThread.tsx:938 附近）：chat_message 是云会话独有的事件类型，
// EventRow 的 switch 里没有这个 case（也没有 default），落到这个类型时
// 隐式 return undefined——不会崩，只是不渲染，所以在这一层单独渲一行
// （label + content）。approval_request 同样不走 EventRow，是因为它的
// 呈现不是"时间线上的一行"，而是"贴着输入区的一张可操作的卡"（同本地
// 会话 App.tsx 的 ApprovalCard 紧贴 composer 的既有位置约定）。
//
// user_message / assistant_message 也单独渲（复审 Rejected #1 补齐，brief
// 原稿的设计漏洞，不是实现偏离）：EventRow 的 switch 里同样没有这两个
// case（该文件注释原话"这两个分支从此到不了"——本地会话里它们由
// assistant-ui 的主渲染管线接管，EventRow 只兜审计层）。但云会话真正点火
// 一个 turn 时，`services/runtime/src/sessionService.ts` 的 say() 走的是
// `engine.runTurn(\`[${label}]: ${text}\`)`，落盘的是 user_message（不是
// chat_message——chat_message 只在 `logged_only` 分支，即没点火的插话），
// Agent 的回复落 assistant_message。只认 chat_message 会让"@Agent 之后
// 那句话和 Agent 的回答"整段静默消失，只剩闲聊和被拒的审批——spec 里
// "云会话在 UI 里就是一个 session"这句话就不成立了。
// user_message.content 是 `"[label]: text"` 这个人工拼的前缀（协议没有
// 独立 fromUid/label 字段），parseUserMessageLabel 做尽力而为的解析，解析
// 不出就原样显示全文当正文。assistant_message.content 在纯工具调用的
// turn 里可能是空串（events.ts 的字段注释）——AssistantMessageRow 据此
// 只在有正文时才画气泡，同时无条件把 toolCalls 摊成一行行工具活动
// （ToolActivityLine，复用 timelineProjection.index 查执行状态），这样
// 一次纯工具 turn 依旧看得见"发生过什么"，不会全程无声。
//
// 审批卡不搬 App.tsx 那套 ApprovalCardBody——那一套是围着本地 decide()
// 的五种意志（批/拒/中止/授权档位/改过的参数）与 diff 分块取舍搭的，云端
// 协议只认 approved/denied 两种（cloudSessionClient.ts deliverEvent 的
// availableDecisions 写死 ["approve","deny"]），硬套只会引入一堆点了也没
// 效果的按钮。这里另起一张更薄的卡，可视觉语言（圆角边框、pill 按钮）不
// 新造。

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, AtSign } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useChat, type CloudSessionState } from "../store.js";
import { EventRow, TimelineProjectionContext } from "./Timeline.js";
import { buildToolIndex, type ToolIndex } from "../lib/toolIndex.js";
import { groupSubagentSpawns } from "../lib/subagentTimeline.js";
import { formatProxyTime } from "../lib/proxyShare.js";
import { labelOf } from "../lib/workspaceView.js";
import { EMBEDDED_CREDENTIAL_MESSAGE, repoUrlHasEmbeddedCredential } from "../lib/cloudRepoUrl.js";
import { toolSummary } from "../../../shared/toolSummary.js";
import type {
  ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent, ChatMessageEvent,
  SessionEvent, ToolCallRequest, ToolResultEvent, UserMessageEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CsRepoState } from "../../../shared/remote/cloudSession.js";

// cs 还没到位时兜底（正常路径下 WorkspacePage 只在 cloudSession 非空时才
// 挂载这个组件，但 hooks 不能条件调用，events 得先算出一个稳定引用——
// 同 FriendChatView 的 EMPTY 先例，模块级常量避免每次渲染新建 []）
const EMPTY_EVENTS: SessionEvent[] = [];

/** sessionService.ts 的 say() 点火一个 turn 时拼的前缀:`\`[${label}]: ${text}\``。
    协议没有给 user_message 配独立的 fromUid/label 字段（这个事件本来就是
    "普通会话的一条用户消息"，云会话群聊只是把发言人编进了正文），只能在
    渲染层尽力而为地把它解析回来：非贪婪匹配第一个 "]: " 之前的内容当
    label，其余原样当正文。解析不出（旧日志 / 前缀被破坏）就把 label 记
    null、正文原样显示全文，不装作解析成功了 */
function parseUserMessageLabel(content: string): { label: string | null; text: string } {
  const m = /^\[(.*?)\]: ([\s\S]*)$/.exec(content);
  return m ? { label: m[1]!, text: m[2]! } : { label: null, text: content };
}

/** join() 之后持续状态的 deniedCode → 人话（渲染层自己的翻译）。
    main/cloudSessionClient.ts 的 deniedMessage() 只服务 create() 那一次性
    RPC 失败，该函数注释原话："这里不重复造一份会跟渲染层文案走岔的翻译"——
    持续状态（join 之后经 onCloudSessionStatus 推来的 deniedCode）由这一份
    负责。五个码逐一给人话，version_mismatch 特别提示升级；认不出的码原样
    带出来兜底，不装死 */
function cloudDeniedMessage(code: string | undefined): string {
  switch (code) {
    case "bad_jwt":
      return "登录状态已过期，请重新登录后再试";
    case "not_member":
      return "你不是这个工作区的成员";
    case "version_mismatch":
      return "客户端版本与云端不匹配，请更新 Mr Otto 后再试";
    case "no_session":
      return "云会话不存在或已归档";
    case "not_authorized":
      return "没有权限执行此操作";
    default:
      return code ? `无法加入云会话（${code}）` : "无法加入云会话";
  }
}

/** 状态条文案（口径同 T4「云端状态三态化」：拿不到状态说"未知"不说"不可用"）。
    connecting/gone 都不是"连不上"的断言，只是"这一刻还没有可展示的事实"——
    gone 时 wsTransport 会自动重连，不代表这次云会话失败（main/cloudSessionClient.ts
    文件头注释）。ready 没有横幅：一切正常不值得占一行 */
function statusBanner(cs: CloudSessionState): { tone: "muted" | "err"; text: string } | null {
  switch (cs.state) {
    case "connecting":
      return { tone: "muted", text: "连接中…" };
    case "gone":
      return { tone: "muted", text: "云端连接已断开，正在自动重连…" };
    case "denied":
      return { tone: "err", text: cloudDeniedMessage(cs.deniedCode) };
    case "ready":
      return null;
  }
}

export function CloudSessionPage({
  ws,
  selfUid,
  onBack,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  onBack: () => void;
}) {
  const cs = useChat((s) => s.cloudSession);
  const cloudSay = useChat((s) => s.cloudSay);
  const cloudApprove = useChat((s) => s.cloudApprove);
  // 发送/审批失败落这一格（复审 Medium：这条错误此前只在 WorkspacePage
  // 原来那条 return 路径里渲染，云会话走的是提前 return，根本到不了）
  const actionError = useChat((s) => s.workspaceGroupsError);

  const [draft, setDraft] = useState("");
  const [mentionOn, setMentionOn] = useState(false);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // hooks 不能条件调用：cs 可能是 null 的这一拍(WorkspacePage 换页与
  // cloudSession 置空之间那一帧)也得让下面这些 Hook 正常跑完
  const events = cs?.events ?? EMPTY_EVENTS;

  // 时间线行共读的日志投影,同 OttoThread 顶层的算法(aui/OttoThread.tsx:957)
  const timelineProjection = useMemo(
    () => ({ index: buildToolIndex(events), groups: groupSubagentSpawns(events), events }),
    [events]
  );

  // 未决审批:approval_request 事件里,还没有一条 toolCallId 匹配的
  // approval_decision 的那些(ApprovalRequestEvent.callId 与
  // ApprovalDecisionEvent.toolCallId 是同一个 id,同本地 ToolCallRequest.id
  // 的口径)
  const pendingApprovals = useMemo(() => {
    const decided = new Set(
      events
        .filter((e): e is ApprovalDecisionEvent => e.type === "approval_decision")
        .map((e) => e.toolCallId)
    );
    return events.filter(
      (e): e is ApprovalRequestEvent => e.type === "approval_request" && !decided.has(e.callId)
    );
  }, [events]);

  // 输入框跟着内容长高(到 5 行封顶),同 FriendChatView 的既有约定
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  }, [draft]);

  if (!cs) return null;

  const ready = cs.state === "ready";
  const banner = statusBanner(cs);
  // user_message.content 只有 "[label]: text" 这一个可解析的身份信号（协议
  // 没给这个事件独立的 fromUid），只能拿它跟"我自己的展示名"比对来判断
  // "这句是不是我说的"——同一个 uid 在 ws.members 里查到的 label，跟
  // sessionService.say() 落盘时传的 label 理应是同一份 profiles 数据
  const myLabel = labelOf(ws, selfUid);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending || !ready) return;
    setSending(true);
    // 复审 Medium：草稿在发送成功之后才清——失败时原样留在输入框里，
    // 不用另外找地方把文字塞回去；workspaceGroupsError 在 footer 上方
    // 露出来说明失败原因
    const ok = await cloudSay(text, mentionOn);
    if (ok) {
      setDraft("");
      setMentionOn(false);
    }
    setSending(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
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
          {ws.name}
        </button>
        <CloudRepoConfigEntry isOwner={selfUid === cs.ownerUid} ready={ready} repo={cs.repo} />
      </div>

      {banner && (
        <p className={cn("text-xs", banner.tone === "err" ? "text-err" : "text-muted-foreground")}>
          {banner.text}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <TimelineProjectionContext.Provider value={timelineProjection}>
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有消息。</p>
          ) : (
            events.map((e, i) => {
              if (e.type === "chat_message") {
                return <ChatMessageRow key={e.seq} event={e} mine={e.fromUid === selfUid} />;
              }
              if (e.type === "user_message") {
                const parsed = parseUserMessageLabel(e.content);
                return (
                  <UserMessageRow
                    key={e.seq}
                    ts={e.ts}
                    label={parsed.label}
                    text={parsed.text}
                    mine={parsed.label === myLabel}
                  />
                );
              }
              if (e.type === "assistant_message") {
                return <AssistantMessageRow key={e.seq} event={e} index={timelineProjection.index} />;
              }
              return <EventRow key={e.seq} event={e} isLast={i === events.length - 1} />;
            })
          )}
        </TimelineProjectionContext.Provider>
      </div>

      {pendingApprovals.length > 0 && (
        <div className="flex flex-col gap-2">
          {pendingApprovals.map((req) => (
            <ApprovalRow
              key={req.callId}
              event={req}
              waitingLabel={labelOf(ws, req.initiatorUid)}
              canDecide={selfUid === req.initiatorUid || selfUid === cs.ownerUid}
              onApprove={() => void cloudApprove(req.callId, "approved")}
              onDeny={() => void cloudApprove(req.callId, "denied")}
            />
          ))}
        </div>
      )}

      {actionError && <p className="text-xs text-err">{actionError}</p>}

      <footer className="flex items-end gap-2 border-t border-border/60 pt-3">
        <textarea
          ref={boxRef}
          rows={1}
          disabled={!ready}
          className="min-h-[34px] flex-1 min-w-0 resize-none rounded-2xl border border-border bg-transparent px-3 py-[7px] text-[13px] leading-relaxed transition-colors duration-150 placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none disabled:opacity-50"
          placeholder={ready ? "给云会话发消息" : "还没连上，暂时发不了消息"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行;输入法组词途中的 Enter 是"选词",不是"发送"
            // (同 FriendChatView 的既有约定)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          type="button"
          variant={mentionOn ? "default" : "outline"}
          size="sm"
          disabled={!ready}
          aria-pressed={mentionOn}
          onClick={() => setMentionOn((v) => !v)}
          title="@Agent：把这句话标成对 Agent 说的"
        >
          <AtSign className="size-[13px]" aria-hidden />
          Agent
        </Button>
        <Button size="sm" disabled={!draft.trim() || sending || !ready} onClick={() => void submit()}>
          发送
        </Button>
      </footer>
    </div>
  );
}

/** 云仓库配置入口（issue #821 slice 2）：只有 owner 能配（服务端也拦——
    services/runtime/src/frameHandler.ts 的 "config" 分支非 owner 回
    `denied not_authorized`），而 `denied` 帧一旦收到会把**整条云会话连接**
    标成 denied（main/cloudSessionClient.ts 的 markDenied，同一个状态位
    是"云会话被拒绝加入"和"这次操作被拒"共用的），不是"这次操作失败"那么
    轻——非 owner 点了会直接把自己踢出这条云会话。所以这里不做"点了才
    报错的按钮"，非 owner 从一开始就只看见只读说明，压根摸不到能触发
    config 帧的控件。ready 是弱一档的门（cs.state !=="ready" 时 config()
    在本地 requireReady() 就短路回错，不会真的发帧出去），沿用 composer
    disabled={!ready} 的同一条约定，用 title 说明而不是另起一行文案 */
/** 仓库那一格的状态文字（issue #834）。**给所有人看，不只是 owner**：
    "这个工作区的水獭到底在哪个仓库上干活、拉下来没有"是每个成员都该
    看得见的事实，而在这之前它只存在于 owner 那一次保存的瞬间和恰好
    开着会话的人的聊天流里。`repo === null` 与"还没 welcome"合并成同一句
    ——这一格在 connecting 期间不必当真，同 initiatorUid/ownerUid 的约定。 */
function repoStatusText(repo: CsRepoState | null): { short: string; full: string } {
  if (!repo) return { short: "未配仓库", full: "这个工作区还没有配仓库，水獭的工作目录是空的。" };
  let host = repo.url;
  try {
    const u = new URL(repo.url);
    host = `${u.host}${u.pathname}`.replace(/\.git$/, "");
  } catch {
    /* 服务端校验过才存得进来，这里只是显示层的尽力而为 */
  }
  if (!repo.clone) {
    return { short: `${host} · 待克隆`, full: `${repo.url}\n还没克隆——下一次工具调用时才会去拉。` };
  }
  const bad = repo.clone.kind === "failed" || repo.clone.kind === "refused";
  return {
    short: `${host} · ${bad ? "未拉下来" : "已克隆"}`,
    full: `${repo.url}\n${repo.clone.text}`,
  };
}

function CloudRepoConfigEntry({
  isOwner,
  ready,
  repo,
}: {
  isOwner: boolean;
  ready: boolean;
  repo: CsRepoState | null;
}) {
  const [open, setOpen] = useState(false);
  // 保存成功后短暂显示在钮上的确认(同 ProviderKeyDialog 的"已保存"手法:
  // 弹窗这时已经关了,提示得留在用户看得见的地方)。放在这个外层组件而不是
  // 弹窗内部,是为了让它在弹窗关闭之后还能继续显示 2 秒
  const [saved, setSaved] = useState(false);
  const status = repoStatusText(repo);

  const onSaved = (): void => {
    setOpen(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <span className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={status.full}>
        {status.short}
      </span>
      {isOwner ? (
        <>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={!ready}
            title={ready ? undefined : "连接就绪后才能配置"}
            onClick={() => setOpen(true)}
          >
            {saved ? "已保存" : repo ? "改仓库…" : "配置云仓库…"}
          </Button>
          <CloudRepoConfigDialog open={open} onOpenChange={setOpen} onSaved={onSaved} repo={repo} />
        </>
      ) : null}
    </div>
  );
}

/** 配置表单本体：repo URL(必填)+ PAT(可选)。PAT 纪律照抄 ProviderKeyDialog
    的不变量原话——"输入框存完即清,渲染层不留 key 的任何副本;状态只有布尔"
    (ProviderKeyDialog.tsx:8)。保存成功就关窗口(同 ProviderKeyDialog/
    ContributeConnectorDialog 的既有约定),PAT 草稿在关窗口前先清空,不
    回显、不缓存,store 的 cloudConfig 也不落它到任何字段(只是这一次 IPC
    调用的参数)——关窗口这一步本身也会让 React 卸载这两个输入框,但"存完
    即清"不能指望卸载去兜底,得在那一刻显式清。失败(含本地校验拦下来的)
    不关窗口,原样留着让人改了重试,同 cloudSay/cloudApprove 的既有约定。
    地址栏每次打开都从**服务端此刻的真实配置**预填（issue #834 加了读路径，
    welcome 就带着它——原来那句"空白比显示一个可能过期的旧草稿更诚实"是在
    协议没有读路径时的将就，现在预填的是服务端刚说的事实，不是本地草稿）。
    token 栏仍然永远是空的：那是 ProviderKeyDialog 的不变量，服务端也只回
    一个 hasPat 布尔，token 本身不下行。 */
function CloudRepoConfigDialog({
  open,
  onOpenChange,
  onSaved,
  repo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  repo: CsRepoState | null;
}) {
  const cloudConfig = useChat((s) => s.cloudConfig);

  const [repoUrl, setRepoUrl] = useState("");
  const [pat, setPat] = useState("");
  /** 显式清除已存的 token（issue #834）。没有这一格的话，"留空 = 清掉
      token"是个静默陷阱：地址栏预填了、密码框天生是空的，owner 顺手改个
      地址就把私有仓库的凭据清了，下次 clone 静默失败。语义因此变成三态：
      省略 = 不动，`""` = 清除（只有这个开关能产生），非空 = 换新的 */
  const [clearPat, setClearPat] = useState(false);
  const [busy, setBusy] = useState(false);
  // 本地校验(URL 里嵌了凭据)和 cloudConfig 失败共用这一格——都是"这次
  // 提交没成"，人话没必要分两条通道。**不**用 useChat((s) => s.workspaceGroupsError)
  // 订阅式地读:那一格是整页共用的,弹窗刚打开那一刻可能还留着上一次跟这个
  // 表单毫不相干的旧错误(比如刚才发消息失败),订阅式读会让这个错误原样
  // 出现在一个用户还没点过保存的新表单里——改成失败那一刻用 getState()
  // 现取一次快照存进本地状态,不随全局字段之后的变化联动
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRepoUrl(repo?.url ?? "");
      setPat("");
      setClearPat(false);
      setError(null);
    }
  }, [open, repo]);

  const submit = async (): Promise<void> => {
    const url = repoUrl.trim();
    if (!url || busy) return;
    if (repoUrlHasEmbeddedCredential(url)) {
      setError(EMBEDDED_CREDENTIAL_MESSAGE);
      return;
    }
    setError(null);
    setBusy(true);
    const typed = pat.trim();
    // 三态，见 clearPat 的注释：清除 > 新值 > 不动
    const patArg = clearPat ? "" : typed === "" ? undefined : typed;
    const ok = await cloudConfig(url, patArg);
    setBusy(false);
    if (ok) {
      setPat(""); // 存完即清——即使紧接着 onSaved() 就要把整个弹窗关掉
      onSaved();
    } else {
      setError(useChat.getState().workspaceGroupsError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>配置云仓库</DialogTitle>
          <DialogDescription>
            云端 agent 干活的工作目录会 clone 这个仓库。保存不会立刻触发 clone——
            要等下一次工具调用才会用这份配置去拉代码。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-[10px]">
          <Input
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder="https://github.com/x/y.git"
            value={repoUrl}
            onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
          />
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={clearPat}
            className="font-mono text-[13px]"
            placeholder={
              repo?.hasPat
                ? "已存了一个 token（留空 = 不改动）"
                : "Personal Access Token（可选，私有仓库需要）"
            }
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            私有仓库的 token 请填在这一栏——不要拼进上面的仓库地址。
          </p>
          {repo?.hasPat && (
            <button
              type="button"
              className="w-fit text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setClearPat((v) => !v);
                setPat("");
              }}
            >
              {clearPat ? "取消清除（保留已存的 token）" : "清除已存的 token"}
            </button>
          )}
          {repo?.clone && (
            <p className="text-[11px] text-muted-foreground">最近一次：{repo.clone.text}</p>
          )}
        </div>

        {error && <p className="text-xs text-err">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={busy || !repoUrl.trim()} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 群聊一行:自己发的靠右(align="end"),标签行只在别人发的那边显示——
    自己发的一眼就能从靠右的位置认出来,再挂一遍自己的名字是噪音
    (同典型群聊 UI 的既有约定,如 FriendChatView 两人 DM 靠头像位置区分,
    这里人数不定,靠文字标签)。event.mention 为真时补一个 "@Agent" 角标——
    它是发送那一刻"这句话是对 Agent 说的"这个事实的展示,不分是谁发的 */
function ChatMessageRow({ event, mine }: { event: ChatMessageEvent; mine: boolean }) {
  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-col gap-0.5",
        mine ? "self-end items-end" : "self-start items-start"
      )}
    >
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {mine ? "" : `${event.label} · `}
        {formatProxyTime(event.ts)}
        {event.mention ? " · @Agent" : ""}
      </span>
      <Bubble align={mine ? "end" : "start"} variant={mine ? "tinted" : "muted"}>
        <BubbleContent className="whitespace-pre-wrap break-words">{event.content}</BubbleContent>
      </Bubble>
    </div>
  );
}

/** 点火了一个 turn 的那句话（复审 Rejected #1 补齐）：user_message 本体，
    可视觉语言照抄 ChatMessageRow——群聊里这就是"有人说了一句话"，只是
    这一句额外触发了 Agent 干活。label 解析不出时（旧日志/前缀被破坏）就
    不画标签行，只显示时间，正文原样兜底显示全文（含没剥掉的前缀，宁可
    多显示一点也不假装解析成功了） */
function UserMessageRow({
  ts,
  label,
  text,
  mine,
}: {
  ts: number;
  label: string | null;
  text: string;
  mine: boolean;
}) {
  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-col gap-0.5",
        mine ? "self-end items-end" : "self-start items-start"
      )}
    >
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {!mine && label ? `${label} · ` : ""}
        {formatProxyTime(ts)}
      </span>
      <Bubble align={mine ? "end" : "start"} variant={mine ? "tinted" : "muted"}>
        <BubbleContent className="whitespace-pre-wrap break-words">{text}</BubbleContent>
      </Bubble>
    </div>
  );
}

/** Agent 的回复（复审 Rejected #1 补齐）：恒左对齐（Agent 不可能是"我"）。
    content 在纯工具调用的 turn 里可能是空串（events.ts 的字段注释）——
    这时不画空气泡，改成无条件把 toolCalls 摊成一行行 ToolActivityLine，
    这样即使模型这一轮一个字没说，用户也能看见"它干了什么"，不是全程无声。
    有正文又有工具调用时两者都画（events.ts 原话："文本和工具调用请求可以
    同时出现"）*/
function AssistantMessageRow({ event, index }: { event: AssistantMessageEvent; index: ToolIndex }) {
  const hasText = event.content.trim() !== "";
  const toolCalls = event.toolCalls ?? [];
  return (
    <div className="flex max-w-[85%] flex-col items-start gap-1 self-start">
      <span className="px-1 text-[10.5px] text-muted-foreground">
        Agent · {formatProxyTime(event.ts)}
      </span>
      {hasText && (
        <Bubble align="start" variant="muted">
          <BubbleContent className="whitespace-pre-wrap break-words">{event.content}</BubbleContent>
        </Bubble>
      )}
      {toolCalls.map((call) => (
        <ToolActivityLine key={call.id} call={call} result={index.results.get(call.id)} />
      ))}
    </div>
  );
}

/** 一次工具调用的一行可见提示（复审 Rejected #1 补齐）：不用 ToolRow——那
    是折叠展开的重组件，围着本地会话的详情面板设计；这里只要"看得见发生过
    什么"，`toolSummary` 已经把 verb/target 提炼好了，状态从
    `timelineProjection.index`（同一份，OttoThread 顶层算法同款）里查，
    没查到 = 还在执行中（tool_execution_started 落了、tool_result 还没落） */
function ToolActivityLine({ call, result }: { call: ToolCallRequest; result: ToolResultEvent | undefined }) {
  const { verb, target } = toolSummary(call);
  const statusText = !result
    ? "执行中…"
    : result.status === "ok"
      ? "完成"
      : result.status === "denied"
        ? "被拒绝"
        : "出错";
  return (
    <span className="px-1 text-[11px] text-muted-foreground">
      {verb}
      {target ? ` ${target}` : ""} · {statusText}
    </span>
  );
}

/** 未决审批卡(贴着输入区,不是时间线上的一行)。selfUid ∈ {initiatorUid,ownerUid}
    才有按钮——这个人要么是触发这次审批的那个操作的发起人,要么是这条云会话
    的 owner(据此复审别人的操作);其余成员只读一句"等待谁审批",不能替别人
    按下批准/拒绝(main/cloudSessionClient.ts deliverEvent 的资格判断在推送
    那一层就已经把卡只发给够格的人,这里的 canDecide 是同一条判据在渲染层
    的镜像——群聊场景大家共读同一份 events,不是每个人各收各的) */
function ApprovalRow({
  event,
  waitingLabel,
  canDecide,
  onApprove,
  onDeny,
}: {
  event: ApprovalRequestEvent;
  waitingLabel: string;
  canDecide: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <span className="text-xs font-medium">{event.toolName}</span>
        <p className="mt-0.5 text-[12px] whitespace-pre-wrap break-words text-muted-foreground">
          {event.argsSummary}
        </p>
      </div>
      {canDecide ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" className="text-err" onClick={onDeny}>
            拒绝
          </Button>
          <Button size="xs" onClick={onApprove}>
            批准
          </Button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">等待 {waitingLabel} 审批</p>
      )}
    </div>
  );
}
