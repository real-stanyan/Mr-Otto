// 聊天主界面 — 功能优先（视觉设计等 harness 完工后再做）。
// 消息区就是事件日志的直接渲染：又一个投影，UI 不持有自己的对话状态。

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingOrb } from "thinking-orbs";
import { useChat } from "./store.js";
import { dispatchSlash } from "./commands.js";
import { Replay } from "./replay/Replay.js";
import { MODEL_CATALOG, findModel } from "../../shared/modelCatalog.js";
import type { SessionEvent } from "../../session/events.js";

/** 会话累计 token（prompt + completion）——又一个日志投影：重开 app 账不丢 */
function totalTokens(events: SessionEvent[]): number {
  let sum = 0;
  for (const e of events) {
    if ((e.type === "assistant_message" || e.type === "context_compacted") && e.usage) {
      sum += e.usage.promptTokens + e.usage.completionTokens;
    }
  }
  return sum;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** 当前上下文占用估计 = 最近一次 API 调用的 prompt + completion。
    近似而非精确（下个请求的 prompt 才是真占用），但它来自日志、随事件流实时更新 */
function contextUsed(events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e?.type === "assistant_message" || e?.type === "context_compacted") && e.usage) {
      // compact 之后历史只剩摘要：占用近似为摘要本身的体积
      if (e.type === "context_compacted") return e.usage.completionTokens;
      return e.usage.promptTokens + e.usage.completionTokens;
    }
  }
  return 0;
}

/** orb 旁的状态文案：耗时 · token · 在干嘛（Claude Code 状态行同款，一行合体）。
    挂载即计时——本组件只在 turn 进行中存在，出生时刻就是 turn 起点 */
function TurnMeta({ label, events }: { label: string; events: SessionEvent[] }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const tokens = useMemo(() => totalTokens(events), [events]);
  return (
    <span>
      {fmtElapsed(now - start)} · {fmtTokens(tokens)} tokens · {label}
    </span>
  );
}

/** 输入框下的状态条（Claude Code 同款布局）：
    左 = 审批模式；右 = 模型 · thinking · 上下文用量。
    模式/thinking 是运行时偏好（主进程 agent 持有）；模型是日志投影；用量是日志投影 */
function ComposerBar() {
  const model = useChat((s) => s.model);
  const events = useChat((s) => s.events);
  const approvalMode = useChat((s) => s.approvalMode);
  const thinking = useChat((s) => s.thinking);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const switchModel = useChat((s) => s.switchModel);
  const setApprovalMode = useChat((s) => s.setApprovalMode);
  const setThinking = useChat((s) => s.setThinking);

  const choice = findModel(model);
  const ctxWindow = choice?.contextWindow ?? 128_000;
  const used = contextUsed(events);
  const pct = Math.min(100, Math.round((used / ctxWindow) * 100));

  return (
    <div className="composer-bar">
      <select
        className={"mode-select" + (approvalMode === "auto" ? " bypass" : "")}
        value={approvalMode}
        title="审批模式：危险操作是逐条问你，还是免问直批（决定都会落日志）"
        onChange={(e) => void setApprovalMode(e.target.value as "ask" | "auto")}
      >
        <option value="ask">逐条审批</option>
        <option value="auto">自动批准</option>
      </select>

      <span className="spacer" />

      <select
        className="model-select"
        value={model}
        disabled={status === "running"}
        onChange={(e) => void switchModel(e.target.value)}
      >
        {MODEL_CATALOG.map((m) => (
          <option key={m.model} value={m.model}>
            {m.label}
          </option>
        ))}
        {/* OTTER_MODEL 填了目录外的型号：补一项，不然 select 显示空白 */}
        {!findModel(model) && <option value={model}>{model}</option>}
      </select>

      <select
        className="thinking-select"
        value={thinking ? "on" : "off"}
        disabled={status === "running" || !choice?.supportsThinking}
        title={choice?.supportsThinking ? "thinking：模型先推理再作答（更好也更贵）" : "当前型号不支持 thinking 开关"}
        onChange={(e) => void setThinking(e.target.value === "on")}
      >
        <option value="on">Thinking 开</option>
        <option value="off">Thinking 关</option>
      </select>

      <span className="ctx-usage" title={`上下文占用估计（最近一次调用的 token 账单）/ 型号上下文窗`}>
        {fmtTokens(used)}/{fmtTokens(ctxWindow)} · {pct}%
      </span>
    </div>
  );
}

/** agent 状态 → orb 动画。审批等待优先于 running：这时是 agent 在等人 */
function orbStateOf(status: "idle" | "running", hasApproval: boolean) {
  if (hasApproval) return "listening" as const;
  return status === "running" ? ("working" as const) : ("breathing" as const);
}

function EventRow({ event }: { event: SessionEvent }) {
  switch (event.type) {
    case "user_message":
      return <div className="row user">{event.content}</div>;

    case "assistant_message":
      // 模型输出按 Markdown 渲染（react-markdown 默认转义 HTML，无注入面）；
      // 用户消息保持原文——用户打的不是 markdown，别替他排版
      return (
        <>
          {event.content && (
            <div className="row assistant md">
              <Markdown remarkPlugins={[remarkGfm]}>{event.content}</Markdown>
            </div>
          )}
          {event.toolCalls?.map((c) => (
            <div key={c.id} className="row chip tool-call">
              请求工具 <code>{c.name}</code> <code>{JSON.stringify(c.args)}</code>
            </div>
          ))}
        </>
      );

    case "tool_result":
      return (
        <div className={`row chip result-${event.status}`}>
          [{event.status}] <code>{event.output.slice(0, 400)}</code>
        </div>
      );

    case "approval_decision":
      return (
        <div className="row audit">
          审批：{event.decision === "approved" ? "已批准" : "已拒绝"}
          {event.reason ? `（${event.reason}）` : ""}
        </div>
      );

    case "session_created":
      return <div className="row audit">会话已创建</div>;

    case "session_archived":
      return <div className="row audit">会话已归档</div>;

    case "context_compacted":
      return (
        <div className="row audit">
          ✻ 上下文已压缩——此前对话折叠为摘要（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );

    case "model_changed":
      return (
        <div className="row audit">
          模型切换 → {event.provider}/{event.model}
        </div>
      );
  }
}

function ApprovalCard() {
  // 只渲染挂靠在当前会话上的卡——别的会话的审批留在它自己的视图里
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const decide = useChat((s) => s.decide);
  const [reason, setReason] = useState("");

  if (!approval) return null;
  return (
    <div className="approval">
      <div className="approval-head">危险操作待审批</div>
      <div className="approval-body">
        <code>{approval.call.name}</code> — {approval.toolDescription}
        <pre>{JSON.stringify(approval.call.args, null, 2)}</pre>
      </div>
      <div className="approval-actions">
        <input
          placeholder="拒绝原因（可空，模型会看到）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button className="deny" onClick={() => void decide("denied", reason.trim() || undefined)}>
          拒绝
        </button>
        <button className="approve" onClick={() => void decide("approved")}>
          批准
        </button>
      </div>
    </div>
  );
}

/** key 配置行：输入框存完即清——渲染层不留 key 的任何副本 */
function KeyRow({ envName, label }: { envName: string; label: string }) {
  const configured = useChat((s) => s.keyStatus[envName] ?? false);
  const saveApiKey = useChat((s) => s.saveApiKey);
  const [draft, setDraft] = useState("");

  const save = async () => {
    if (!draft.trim()) return;
    await saveApiKey(envName, draft.trim());
    setDraft("");
  };

  return (
    <div className="key-row">
      <div className="key-info">
        <span className="key-label">{label}</span>
        <span className={configured ? "key-state ok" : "key-state"}>
          {configured ? "● 已配置" : "○ 未配置"}
        </span>
        <code className="key-env">{envName}</code>
      </div>
      <div className="key-actions">
        <input
          type="password"
          placeholder={configured ? "输入新 key 覆盖" : "粘贴 API key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button disabled={!draft.trim()} onClick={() => void save()}>
          保存
        </button>
        {configured && (
          <button className="deny" onClick={() => void saveApiKey(envName, "")}>
            清除
          </button>
        )}
      </div>
    </div>
  );
}

function Settings() {
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);
  // 目录里每个不同的 apiKeyEnv 一行（provider 可能共用同一个 key）
  const providers = [...new Map(MODEL_CATALOG.map((m) => [m.apiKeyEnv, m.provider])).entries()];

  return (
    <main className="settings">
      <header>
        <span className="name">API Key 设置</span>
        <button className="ghost" onClick={closeSettings}>
          返回
        </button>
      </header>
      <section className="settings-body">
        <p className="hint">
          key 存在本机 <code>keys.json</code>（仅当前用户可读），不进会话日志，不回传界面。
          此处配置的 key 优先于 .env。
        </p>
        {providers.map(([envName, provider]) => (
          <KeyRow key={envName} envName={envName} label={provider} />
        ))}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

/** 左侧常驻侧栏：会话列表 + 底部设置/登录槽 */
function Sidebar() {
  const sessions = useChat((s) => s.sessions);
  const sessionId = useChat((s) => s.sessionId);
  const phase = useChat((s) => s.phase);
  const showSettings = useChat((s) => s.showSettings);
  const resume = useChat((s) => s.resume);
  const startSession = useChat((s) => s.startSession);
  const openSettings = useChat((s) => s.openSettings);
  const deleteSession = useChat((s) => s.deleteSession);
  const statusBySession = useChat((s) => s.statusBySession);
  const approvals = useChat((s) => s.approvals);

  // 没记 workspace 的旧会话无法重建围栏，列表里不出现
  const resumable = sessions.filter((s) => s.workspace !== null);

  return (
    <aside className="sidebar">
      <div className="brand">otter</div>
      <button className="new-session" onClick={() => void startSession()}>
        ＋ 新会话
      </button>
      <nav className="session-list">
        {/* 行是 div 而非 button：里面要嵌删除按钮，button 套 button 是非法 HTML */}
        {resumable.map((s) => (
          <div
            key={s.sessionId}
            className={
              "session-item" +
              (phase === "chat" && !showSettings && s.sessionId === sessionId ? " active" : "")
            }
            onClick={() => void resume(s.sessionId)}
          >
            <span className="dir">{s.workspace?.split("/").pop()}</span>
            <span className="when">
              {new Date(s.lastTs).toLocaleDateString()} · {s.events} 条
              {/* 后台会话的动静：等审批 > 跑 turn，让你在别的会话也看得见 */}
              {approvals[s.sessionId] ? (
                <em className="flag approval"> 等审批</em>
              ) : statusBySession[s.sessionId] === "running" ? (
                <em className="flag running"> 运行中</em>
              ) : null}
            </span>
            <button
              className="session-delete"
              title="删除会话（整段日志从库里抹除，不可恢复）"
              onClick={(e) => {
                e.stopPropagation(); // 别触发外层的"切换到该会话"
                if (confirm(`彻底删除会话 ${s.workspace?.split("/").pop()} · ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                  void deleteSession(s.sessionId);
                }
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="ghost" onClick={() => void openSettings()}>
          设置
        </button>
        {/* 登录占位：账号体系是 v2（自托管 VPS / Docker per bot）的事，先留槽 */}
        <div className="login-slot">未登录</div>
      </div>
    </aside>
  );
}

function Welcome() {
  const startSession = useChat((s) => s.startSession);
  const error = useChat((s) => s.error);

  return (
    <main className="welcome">
      <h1>otter</h1>
      <p>
        选择一个工程文件夹开始会话，或在左侧继续之前的会话。
        <br />
        agent 的文件读写会被限制在该文件夹内，危险操作先经你审批。
      </p>
      <button className="primary" onClick={() => void startSession()}>
        选择工程文件夹…
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

export function App() {
  const { phase, sessionId, workspace, events, error, boot, send } = useChat();
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const replayCursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const showSettings = useChat((s) => s.showSettings);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const replaying = replayCursor !== null;

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView(); // 高频动作：瞬时滚动，不加动画
  }, [events.length, status, approval]);

  const submit = () => {
    const text = input.trim();
    if (!text || status === "running") return;
    setInput("");
    if (dispatchSlash(text)) return; // "/" 开头 = 对 harness 说话，不进模型
    void send(text);
  };

  if (phase === "connecting") return <main className="boot">连接主进程…</main>;

  // 布局：侧栏常驻，主区三态（设置 / 欢迎 / 聊天）
  const main = showSettings ? (
    <Settings />
  ) : phase === "welcome" ? (
    <Welcome />
  ) : (
    <main className="chat">
      <header>
        <span className="name">otter</span>
        <span className="meta" title={workspace}>
          {workspace.split("/").pop()} · {sessionId}
        </span>
        <button className="ghost" onClick={() => setReplayCursor(replaying ? null : 0)}>
          {replaying ? "回到直播" : "回放"}
        </button>
      </header>

      {replaying ? (
        <>
          {/* 富回放：画布 + 函数轨迹，重演每条事件在系统里的路径 */}
          <Replay />
          {/* 审批卡永不因回放隐藏：它是挂起中的活控制件，藏了 agent 就卡死 */}
          <ApprovalCard />
        </>
      ) : (
        <>
          <section className="timeline">
            {events.map((e) => (
              <EventRow key={e.seq} event={e} />
            ))}
            {error && <div className="row chip result-error">[turn 失败] {error}</div>}
            {(status === "running" || approval !== null) && (
              <div className="row agent-status">
                <ThinkingOrb
                  state={orbStateOf(status, approval !== null)}
                  size={20}
                  theme="dark"
                />
                <TurnMeta label={approval ? "等待审批…" : "思考中…"} events={events} />
              </div>
            )}
            <div ref={bottomRef} />
          </section>

          <ApprovalCard />

          <footer>
            <div className="composer">
              <input
                autoFocus
                placeholder={status === "running" ? "turn 进行中…" : "输入消息，回车发送"}
                disabled={status === "running"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
                }}
              />
              <button onClick={submit} disabled={status === "running" || !input.trim()}>
                发送
              </button>
            </div>
            <ComposerBar />
          </footer>
        </>
      )}
    </main>
  );

  return (
    <div className="layout">
      <Sidebar />
      {main}
    </div>
  );
}
