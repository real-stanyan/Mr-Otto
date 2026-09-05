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
import { Archive, ArrowLeft, AtSign } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useChat, type CloudSessionState } from "../store.js";
import { EventRow, TimelineProjectionContext } from "./Timeline.js";
import { buildToolIndex, type ToolIndex } from "../lib/toolIndex.js";
import { groupSubagentSpawns } from "../lib/subagentTimeline.js";
import { formatProxyTime } from "../lib/proxyShare.js";
import { agentNameOf, labelOf } from "../lib/workspaceView.js";
import { applyAgentMention, filterAgentCandidates, mentionQueryAt } from "../lib/agentMentionInput.js";
import { EMBEDDED_CREDENTIAL_MESSAGE, repoUrlHasEmbeddedCredential } from "../lib/cloudRepoUrl.js";
import { assistantLabel, hiddenFromCloudTimeline, relayLineText, userRowIdentity } from "../lib/cloudTimeline.js";
import { openTurns } from "../../../shared/turnLedger.js";
import { toolSummary } from "../../../shared/toolSummary.js";
import { parseMentions } from "../../../shared/remote/agentMention.js";
import type {
  AgentBriefedEvent, AgentRelayEvent, ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent,
  ChatMessageEvent, SessionEvent, ToolCallRequest, ToolResultEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CsModelRoute, CsModelState, CsRepoState } from "../../../shared/remote/cloudSession.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";

// cs 还没到位时兜底（正常路径下 WorkspacePage 只在 cloudSession 非空时才
// 挂载这个组件，但 hooks 不能条件调用，events 得先算出一个稳定引用——
// 同 FriendChatView 的 EMPTY 先例，模块级常量避免每次渲染新建 []）
const EMPTY_EVENTS: SessionEvent[] = [];

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
  /** 省掉 = 不画返回键（issue #919：这一页搬进主区之后没有"上一层"可回——
      离开云会话的方式和离开本地会话一样，点侧栏里别的一行）。抽屉时代它是
      唯一的出口，所以那时是必填 */
  onBack?: () => void;
}) {
  const cs = useChat((s) => s.cloudSession);
  const cloudSay = useChat((s) => s.cloudSay);
  const cloudApprove = useChat((s) => s.cloudApprove);
  const cloudArchive = useChat((s) => s.cloudArchive);
  // 建这条会话的人（issue #822）：清单那一行本来就带 publisherUid，不用为
  // 这个再往协议里加字段。清单还没拉到时查不到 → 按钮不显示（服务端才是
  // 判据，这里少显示一颗按钮的代价远小于显示一颗按了被拒的）
  const creatorUid = useChat((s) =>
    s.cloudSession
      ? s.cloudSessionList[s.cloudSession.workspaceId]?.find((r) => r.id === s.cloudSession?.sessionId)?.publisherUid
      : undefined
  );
  // 发送/审批失败落这一格（复审 Medium：这条错误此前只在 WorkspacePage
  // 原来那条 return 路径里渲染，云会话走的是提前 return，根本到不了）
  const actionError = useChat((s) => s.workspaceGroupsError);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // 光标位置（#932 切片 1b）：「正在打 @ 吗」是 draft × caret 的函数，光标
  // 不跟着走的话，把光标挪回一个旧的 @ 后面时弹层不会出来。textarea 自己的
  // selectionStart 是 DOM 状态，读不进渲染——所以四个入口（改字/选区/键起/
  // 点击）都往这一格里抄一次
  const [caret, setCaret] = useState(0);
  // Escape 关掉的是**这一个** @（记它的下标）：记成布尔的话，同一句话里
  // 再打一个 @ 会因为上一次的关闭而不弹
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [hi, setHi] = useState(0); // 弹层高亮下标
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

  // ── @ 选人（#932 切片 1b）────────────────────────────────────────────
  // 名单第一只 = 这个工作区的管理员（服务端按 created_at 升序给，见 Task 3）
  const candidates = useMemo(
    () => ws.agents.map((a) => ({ agentId: a.agentId, name: a.name, description: a.description })),
    [ws.agents]
  );
  // 「此刻是不是停在一个没打完的 @ 后面」——只决定弹不弹层，**不**决定这句
  // 话点了谁（那是下面 parseMentions 的事，两个问题，见 agentMentionInput 头注）
  const rawPicking = mentionQueryAt(draft, caret);
  const picking = rawPicking !== null && rawPicking.at === dismissedAt ? null : rawPicking;
  // 光标离开这个 @（打完空格 / 退掉那个 @ / 挪到别处）就把关闭记号擦掉。
  // 不擦的话「打 @ → Escape → 退格删掉 → 在同一个位置再打一个 @」会因为
  // 下标撞上而永远不弹——一个只能靠换行躲开的死角
  const pickingAt = rawPicking?.at ?? null;
  useEffect(() => {
    if (pickingAt === null) setDismissedAt(null);
  }, [pickingAt]);
  const options = picking ? filterAgentCandidates(candidates, picking.query) : [];
  // 发送时点了谁：与 chip 行**同一次**调用算出来的同一份 —— 界面上写着发给
  // 谁，服务端就跑谁。两边各算各的就会分家（坑 ④）
  const mentions = useMemo(() => parseMentions(draft, candidates), [draft, candidates]);
  // 候选变了高亮归零：不归零的话，从三个候选里选中第三个、再多打一个字缩到
  // 一个候选时，hi 还停在 2，Enter 什么都选不中
  const optionKey = options.map((o) => o.agentId).join(",");
  useEffect(() => {
    setHi(0);
  }, [optionKey]);

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

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending || !ready) return;
    setSending(true);
    // 复审 Medium：草稿在发送成功之后才清——失败时原样留在输入框里，
    // 不用另外找地方把文字塞回去；workspaceGroupsError 在 footer 上方
    // 露出来说明失败原因
    // 名单一条都没有（还没拉到 / 拉失败）时**不发数组**：服务端把 `[]` 读作
    // "我确认谁都没点"（ADR-0220 决策 2），而这里的空是"我算不出来"——差着
    // 一整个 turn。缺席让服务端拿它自己那份名单解析正文、再回落名单第一只，
    // 于是一句 "@管理员 帮我看下" 照旧有人接，而不是安静地变成一句闲聊
    const ok = candidates.length === 0 ? await cloudSay(text) : await cloudSay(text, mentions);
    if (ok) {
      // mentions 是 draft 的函数，清了正文点名自然跟着清（chip 行也跟着没）
      setDraft("");
      setCaret(0);
      setDismissedAt(null);
    }
    setSending(false);
  };

  /** 选中弹层里第 i 只：写回正文并把光标放回 "@名字 " 之后 */
  const pick = (i: number): void => {
    if (picking === null) return;
    const chosen = options[i];
    if (chosen === undefined) return;
    const next = applyAgentMention(draft, picking.at, caret, chosen.name);
    setDraft(next.text);
    setCaret(next.caret);
    setDismissedAt(null);
    // 光标要等这一帧 commit 完再设：React 在 commit 期间会做一次**选区保全**
    // ——把改动前那个选区偏移恢复到当前有焦点的元素上，于是同一个 tick 里设的
    // 光标会被它盖掉。rAF 排在 commit 之后，设进去才留得住
    const c = next.caret;
    requestAnimationFrame(() => boxRef.current?.setSelectionRange(c, c));
  };

  /** 「插入 @」：在光标处打一个 @，弹层随之出现（钮不再是开关，见 footer 处注） */
  const insertAt = (): void => {
    const box = boxRef.current;
    const pos = box?.selectionStart ?? draft.length;
    // 前一个字符是构词字符时先补一个空格：parseMentions 要求 @ 前是行首或
    // 非构词字符（否则 rick@运营 这种邮箱形状会被当成点名），不补的话这颗钮
    // 插出来的 @ 既不弹层也解析不出人
    const insert = /[\p{L}\p{N}_]/u.test(draft[pos - 1] ?? "") ? " @" : "@";
    const c = pos + insert.length;
    setDraft(draft.slice(0, pos) + insert + draft.slice(pos));
    setCaret(c);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      const b = boxRef.current;
      b?.focus();
      b?.setSelectionRange(c, c);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {onBack ? (
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
        ) : (
          // 没有返回键时工作区名仍然要在：这一行回答的是「我在哪个工作区里」，
          // 而云会话的每一件事（谁能看见、扣谁的额度、用哪把 key）都挂在它上面
          <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">{ws.name}</span>
        )}
        <div className="flex items-center gap-1.5">
          {/* 收尾（issue #822）。云端没有"恢复归档"那一半（daemon 启动只捞
              archived=false 的会话重开房间），所以先问一句——同侧栏「删除
              会话」、踢人那几处的原生 confirm，不新造一套视觉语言 */}
          {ready && (selfUid === cs.ownerUid || selfUid === creatorUid) && (
            <button
              type="button"
              onClick={() => {
                if (!window.confirm("归档这条云会话？群里所有人都会看到它收尾，之后不能再发言，也不能恢复。")) return;
                void cloudArchive();
              }}
              className={cn(
                "press-scale inline-flex w-fit items-center gap-1.5 rounded-[7px] px-1.5 py-1",
                "text-[12.5px] text-muted-foreground transition-colors duration-150",
                "hover:bg-foreground/[0.06] hover:text-foreground"
              )}
            >
              <Archive className="size-[13px]" aria-hidden />
              归档
            </button>
          )}
          <CloudRepoConfigEntry
            isOwner={selfUid === cs.ownerUid}
            ready={ready}
            repo={cs.repo}
            model={cs.model}
            route={cs.modelRoute}
          />
        </div>
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
              // 接力开场白（user_message 带 relay）不画：那是给模型看的
              // "[系统] 「运营」@ 了你"，人看下面那条 agent_relay 接力线就够，
              // 画出来是同一件事说两遍（#950）
              if (hiddenFromCloudTimeline(e)) return null;
              if (e.type === "chat_message") {
                return <ChatMessageRow key={e.seq} event={e} mine={e.fromUid === selfUid} />;
              }
              if (e.type === "user_message") {
                const identity = userRowIdentity(e, ws, selfUid);
                return (
                  <UserMessageRow
                    key={e.seq}
                    ts={e.ts}
                    label={identity.label}
                    text={identity.text}
                    mine={identity.mine}
                    targets={identity.targets}
                  />
                );
              }
              if (e.type === "assistant_message") {
                return <AssistantMessageRow key={e.seq} event={e} ws={ws} index={timelineProjection.index} />;
              }
              if (e.type === "agent_briefed") {
                return <AgentBriefedRow key={e.seq} event={e} />;
              }
              if (e.type === "agent_relay") {
                return <AgentRelayRow key={e.seq} event={e} ws={ws} />;
              }
              if (e.type === "turn_ended") {
                // isLast 恒 false：EventRow 的"重试"钮只看这个 prop（Timeline.tsx:649），
                // 而那颗钮点了走本地 resendMessage——云端没有重发这条路，钮出来就是撒谎
                return <EventRow key={e.seq} event={e} isLast={false} />;
              }
              return <EventRow key={e.seq} event={e} isLast={i === events.length - 1} />;
            })
          )}
          {/* 排队中/正在回复画在时间线**末尾**而不是贴在各自那条 @ 消息下面：
              排队的东西说的是"接下来会发生什么"，那是时间线尾巴的事，不是
              历史里某一行的注脚（跟 turn_ended 的错误行不同——那是已经发生
              的事实，钉在它发生的位置）*/}
          <PendingTurnLines events={events} ws={ws} />
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

      <footer className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
        {/* 「发给谁」预览。**只读**：去掉一枚 = 从正文里把那个 @ 删掉——正文
            才是事实，给 pill 配一颗 × 就等于开了第二个事实来源，两边迟早不一致 */}
        {mentions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>发给</span>
            {mentions.map((id) => (
              <span key={id} className="rounded-full border border-border px-2 py-[1px]">
                {agentNameOf(ws, id)}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* 弹层走 Radix 的 Popover 而不是自己 absolute 定位：这一页整个装在
              CloudSessionMain 的 overflow-y-auto 里，`absolute bottom-full` 画出来的
              列表一旦高过 footer 到滚动容器上沿的距离，超出的部分会被裁掉且滚不到
              （新会话只有一行「还没有消息。」时 footer 离顶不到 90px，三只就削掉一行）。
              Radix 把内容 portal 到 body、位置不够时自己翻到下面——这正是那个裁切的修法。
              键盘**仍然全部**由下面的 textarea onKeyDown 管（方向键/Enter 不能交给 Radix，
              它会拿去做菜单导航）；焦点也一步都不许挪，靠两个 AutoFocus 的 preventDefault */}
          <Popover open={picking !== null && options.length > 0}>
            <PopoverAnchor asChild>
              <textarea
                ref={boxRef}
                rows={1}
                disabled={!ready}
                className="min-h-[34px] flex-1 min-w-0 resize-none rounded-2xl border border-border bg-transparent px-3 py-[7px] text-[13px] leading-relaxed transition-colors duration-150 placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none disabled:opacity-50"
                placeholder={ready ? "输入 @ 点名智能体；不 @ 就只是群里说一句" : "还没连上，暂时发不了消息"}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCaret(e.target.selectionStart);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
                onClick={(e) => setCaret(e.currentTarget.selectionStart)}
                // **故意没有 onBlur**：写进 dismissedAt 的是"这个 @ 不要了"这个
                // 判断，而切窗口不是那个意思——alt-tab 出去再回来，光标一个字没动，
                // 于是 picking 永远是 null，接着打字列表再也不出来。
                // 该关的两条路都有人管了：指针点到外面走 onInteractOutside（Radix 的
                // DismissableLayer 连 focus-outside 一起管），键盘则出不去（Tab /
                // Shift+Tab 在下面被拦去选人了）。切窗口留着它开着没关系——回来时
                // 那份候选依然是这句话此刻要的
                onKeyDown={(e) => {
                  // 输入法组词途中的按键是"选词"不是命令（Enter 尤其——同
                  // FriendChatView 的既有约定），整段跳过
                  if (e.nativeEvent.isComposing) return;
                  if (picking !== null && options.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHi((h) => (h + 1) % options.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHi((h) => (h - 1 + options.length) % options.length);
                      return;
                    }
                    // Enter 在弹层开着时**选人不发送**：正在挑人的那一下按回车，
                    // 意思一定是"就他"，不是"发出去"
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      pick(hi);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setDismissedAt(picking.at);
                      return;
                    }
                  }
                  // Enter 发送、Shift+Enter 换行
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="start"
              role="listbox"
              // 焦点一步都不许挪：这个列表是 textarea 的附属显示，人还在打字。
              // Radix 默认开时把焦点吸进内容、关时还回触发器，两下都会打断输入
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              // 键盘那条路由 textarea 的 onKeyDown 管，这里只兜「焦点不在框里
              // 时按了 Escape」；两边都设成同一个值，重复触发也无所谓
              onEscapeKeyDown={() => setDismissedAt(rawPicking?.at ?? null)}
              onInteractOutside={(e) => {
                // 点回 textarea 不算「点到外面」——它是这个弹层的锚，同一个部件。
                // 算成外面的话，点进 @ 查询词中间会把弹层关掉且**再也不开**
                // （dismissedAt 撞上同一个下标），而人此刻明明还在挑
                if (e.detail.originalEvent.target === boxRef.current) return;
                setDismissedAt(rawPicking?.at ?? null);
              }}
              // 进出场在 app.css 的 [data-slot="popover-content"] 那段（手写 keyframes——
              // 上游那串 animate-in/zoom-in-95 在本仓库是死类名，见 ui/dialog.tsx 顶部）
              className="w-auto min-w-[200px] max-w-[320px] p-1"
            >
              {options.map((o, i) => (
                <div
                  key={o.agentId}
                  role="option"
                  aria-selected={i === hi}
                  // mousedown + preventDefault：用 click 的话 textarea 会先失焦，
                  // 写回之后那次 setSelectionRange 就落在一个没焦点的框上
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                  onMouseEnter={() => setHi(i)}
                  className={cn(
                    "flex cursor-default items-baseline gap-2 rounded-sm px-2 py-[5px] text-[12.5px]",
                    i === hi && "bg-foreground/[0.06]"
                  )}
                >
                  <span className="shrink-0">{o.name}</span>
                  <span className="truncate text-muted-foreground">{o.description}</span>
                </div>
              ))}
            </PopoverContent>
          </Popover>
          {/* 这颗钮不再是"对 Agent 说"的开关（有了名单，得说清对哪一只）——
              它现在只做一件事：在光标处插一个 @，把弹层叫出来 */}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={!ready}
            onClick={insertAt}
            title="@ 智能体"
            aria-label="@ 智能体"
          >
            <AtSign className="size-[13px]" aria-hidden />
          </Button>
          <Button size="sm" disabled={!draft.trim() || sending || !ready} onClick={() => void submit()}>
            发送
          </Button>
        </div>
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
  model,
  route,
}: {
  isOwner: boolean;
  ready: boolean;
  repo: CsRepoState | null;
  model: CsModelState | null;
  route: CsModelRoute | null;
}) {
  const [open, setOpen] = useState(false);
  // 保存成功后短暂显示在钮上的确认(同 ProviderKeyDialog 的"已保存"手法:
  // 弹窗这时已经关了,提示得留在用户看得见的地方)。放在这个外层组件而不是
  // 弹窗内部,是为了让它在弹窗关闭之后还能继续显示 2 秒
  const [saved, setSaved] = useState(false);
  const repoStatus = repoStatusText(repo);
  const modelStatus = modelStatusText(model, route);

  const onSaved = (): void => {
    setOpen(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      {/* 模型排在仓库前面（issue #844）：走不通的路（blocked / 缺 key）
          才是**会挡住干活**的那一格，没配仓库只是"在空目录里干活"。
          两格都给所有成员看，不只是 owner */}
      <span
        className={cn("max-w-[150px] truncate text-[11px]", modelStatus.bad ? "text-err" : "text-muted-foreground")}
        title={modelStatus.full}
      >
        {modelStatus.short}
      </span>
      <span className="max-w-[190px] truncate text-[11px] text-muted-foreground" title={repoStatus.full}>
        {repoStatus.short}
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
            {saved ? "已保存" : model || repo ? "改配置…" : "配置模型 / 仓库…"}
          </Button>
          <CloudRepoConfigDialog
            open={open}
            onOpenChange={setOpen}
            onSaved={onSaved}
            repo={repo}
            model={model}
          />
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
  model,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  repo: CsRepoState | null;
  model: CsModelState | null;
}) {
  const cloudConfig = useChat((s) => s.cloudConfig);

  const [repoUrl, setRepoUrl] = useState("");
  const [pat, setPat] = useState("");
  /** 显式清除已存的 token（issue #834）。没有这一格的话，"留空 = 清掉
      token"是个静默陷阱：地址栏预填了、密码框天生是空的，owner 顺手改个
      地址就把私有仓库的凭据清了，下次 clone 静默失败。语义因此变成三态：
      省略 = 不动，`""` = 清除（只有这个开关能产生），非空 = 换新的 */
  const [clearPat, setClearPat] = useState(false);
  // 模型三件套（issue #844）。apiKey 的三态与 pat 完全同款，理由也同款——
  // 改个型号不该把 key 抹了
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
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
      setModelBaseUrl(model?.baseUrl ?? "");
      setModelId(model?.modelId ?? "");
      setApiKey("");
      setClearKey(false);
      setError(null);
    }
  }, [open, repo, model]);

  const url = repoUrl.trim();
  const mBase = modelBaseUrl.trim();
  const mId = modelId.trim();
  // 两组各自成立才提交那一组（issue #844）：只填了模型就只发模型那一格，
  // 服务端那边没提到的一组原样保留
  const hasRepoPatch = url !== "" || clearPat;
  const hasModelPatch = (mBase !== "" && mId !== "") || clearKey;

  const submit = async (): Promise<void> => {
    if (busy || (!hasRepoPatch && !hasModelPatch)) return;
    if (url !== "" && repoUrlHasEmbeddedCredential(url)) {
      setError(EMBEDDED_CREDENTIAL_MESSAGE);
      return;
    }
    if (clearKey && (mBase === "" || mId === "")) {
      // 清 key 要连着地址/型号一起发（服务端那格是整体三件套），但地址和
      // 型号是预填好的，空了说明人手动清掉了——照实说，别默默存半个
      setError("要清除 key 的话，模型地址和型号得留着（清 key 不等于删掉整格配置）。");
      return;
    }
    setError(null);
    setBusy(true);
    const patch: {
      repoUrl?: string;
      pat?: string;
      model?: { baseUrl: string; modelId: string; apiKey?: string };
    } = {};
    if (hasRepoPatch) {
      if (url !== "") patch.repoUrl = url;
      // 三态，见 clearPat 的注释：清除 > 新值 > 不动
      const typed = pat.trim();
      if (clearPat) patch.pat = "";
      else if (typed !== "") patch.pat = typed;
    }
    if (hasModelPatch) {
      const typedKey = apiKey.trim();
      patch.model = clearKey
        ? { baseUrl: mBase, modelId: mId, apiKey: "" }
        : typedKey !== ""
          ? { baseUrl: mBase, modelId: mId, apiKey: typedKey }
          : { baseUrl: mBase, modelId: mId };
    }
    const ok = await cloudConfig(patch);
    setBusy(false);
    if (ok) {
      setPat(""); // 存完即清——即使紧接着 onSaved() 就要把整个弹窗关掉
      setApiKey("");
      onSaved();
    } else {
      setError(useChat.getState().workspaceGroupsError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>云会话配置</DialogTitle>
          <DialogDescription>
            模型和仓库是两件独立的事，可以只改一样。云端**不提供公共 key**——
            这里填谁的 key，烧的就是谁的额度（issue #844）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-[10px]">
          <p className="text-[11px] font-medium text-foreground">模型</p>
          <Input
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder="https://api.deepseek.com/v1"
            value={modelBaseUrl}
            onChange={(e) => { setModelBaseUrl(e.target.value); setError(null); }}
          />
          <Input
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder="型号 id，例如 deepseek-v4-flash"
            value={modelId}
            onChange={(e) => { setModelId(e.target.value); setError(null); }}
          />
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={clearKey}
            className="font-mono text-[13px]"
            placeholder={model?.hasKey ? "已存了一把 key（留空 = 不改动）" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {model?.hasKey && (
            <button
              type="button"
              className="w-fit text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setClearKey((v) => !v);
                setApiKey("");
              }}
            >
              {clearKey ? "取消清除（保留已存的 key）" : "清除已存的 key"}
            </button>
          )}

          <p className="mt-2 text-[11px] font-medium text-foreground">仓库（可选）</p>
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
            保存不会立刻触发 clone，要等下一次工具调用。
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
          <Button size="sm" disabled={busy || (!hasRepoPatch && !hasModelPatch)} onClick={() => void submit()}>
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

/** 点火了一个 turn 的那句话（复审 Rejected #1 补齐；targets 是 Task 10 补的
    "说给谁"）：user_message 本体，可视觉语言照抄 ChatMessageRow——群聊里
    这就是"有人说了一句话"，只是这一句额外触发了 Agent 干活。label 解析
    不出时（旧日志/前缀被破坏）就不画标签行，只显示时间，正文原样兜底显示
    全文（含没剥掉的前缀，宁可多显示一点也不假装解析成功了）。targets
    非空时标签行末尾追加 "· → 谁"——这是这句话点了谁的唯一可见痕迹，
    不点名的普通发言（targets 为空）不多这一截 */
function UserMessageRow({
  ts,
  label,
  text,
  mine,
  targets,
}: {
  ts: number;
  label: string | null;
  text: string;
  mine: boolean;
  targets: string[];
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
        {targets.length > 0 ? ` · → ${targets.join("、")}` : ""}
      </span>
      <Bubble align={mine ? "end" : "start"} variant={mine ? "tinted" : "muted"}>
        <BubbleContent className="whitespace-pre-wrap break-words">{text}</BubbleContent>
      </Bubble>
    </div>
  );
}

/** Agent 的回复（复审 Rejected #1 补齐；署名换成 assistantLabel 是 Task 10）：
    恒左对齐（Agent 不可能是"我"）。content 在纯工具调用的 turn 里可能是
    空串（events.ts 的字段注释）——这时不画空气泡，改成无条件把 toolCalls
    摊成一行行 ToolActivityLine，这样即使模型这一轮一个字没说，用户也能
    看见"它干了什么"，不是全程无声。有正文又有工具调用时两者都画
    （events.ts 原话："文本和工具调用请求可以同时出现"）。ws 是查
    agentId → 名字的名单，多智能体上线前落的旧消息没有 agentId，
    assistantLabel 据此回退到 "Agent" */
function AssistantMessageRow({
  event,
  ws,
  index,
}: {
  event: AssistantMessageEvent;
  ws: WorkspaceSnapshot;
  index: ToolIndex;
}) {
  const hasText = event.content.trim() !== "";
  const toolCalls = event.toolCalls ?? [];
  return (
    <div className="flex max-w-[85%] flex-col items-start gap-1 self-start">
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {assistantLabel(event, ws)} · {formatProxyTime(event.ts)}
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

/** agent 就位（Task 10）：改提示词生效了在界面上唯一的痕迹——`briefIfNeeded`
    (services/runtime/src/sessionService.ts) 每次改动派发新的 instructions
    才会落这条事件，光看聊天记录本身看不出"我刚改的提示词有没有吃上"，
    这一行就是那个回执。视觉上刻意比 ChatMessageRow/UserMessageRow 更淡更
    小——它是审计性质的旁白，不是群里任何人说的话 */
function AgentBriefedRow({ event }: { event: AgentBriefedEvent }) {
  return (
    <p className="px-1 text-[10.5px] italic text-muted-foreground/70">
      「{event.name}」就位{event.instructions.trim() ? "（提示词已更新）" : ""}
    </p>
  );
}

/** 接力线（#950）：一只 agent 在自己的回复里 @ 了另一只，棒从谁传到谁、
    是第几棒。样式照 AgentBriefedRow——同属审计性质的旁白，不是群里任何
    人说的话。配对的那条 user_message（带 relay）不画（hiddenFromCloudTimeline），
    这一行是它在时间线上唯一的痕迹 */
function AgentRelayRow({ event, ws }: { event: AgentRelayEvent; ws: WorkspaceSnapshot }) {
  return (
    <p className="px-1 text-[10.5px] italic text-muted-foreground/70">
      {relayLineText(event, ws)}
    </p>
  );
}

/** 「谁还没回」（Task 10，src/shared/turnLedger.ts 的 openTurns 是事实来源）：
    画在时间线**末尾**而不是贴在各自那条 @ 消息下面——排队的东西说的是
    "接下来会发生什么"，那是时间线尾巴的事；这是日志的投影不是 UI 本地态，
    daemon 重启回来后重新算一遍照样对得上。running 前面一个跳动的点，
    queued 前面一个不跳动的点——同一屏里"正在做"和"还没轮到"要一眼分开 */
function PendingTurnLines({ events, ws }: { events: readonly SessionEvent[]; ws: WorkspaceSnapshot }) {
  const pending = useMemo(() => openTurns(events), [events]);
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((t) => (
        <div key={`${t.seq}:${t.agentId}`} className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-[6px] rounded-full",
              t.state === "running" ? "bg-brand animate-pulse motion-reduce:animate-none" : "bg-muted-foreground/40"
            )}
            aria-hidden
          />
          {agentNameOf(ws, t.agentId)} {t.state === "running" ? "正在回复…" : "排队中…"}
        </div>
      ))}
    </>
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
