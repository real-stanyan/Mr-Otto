// 渲染层状态（Zustand）— 桥上事件流的 UI 投影。
// 只在 boot() 里订阅一次；所有跨进程调用都收敛在这，组件不直接摸 window.otter。

import { create } from "zustand";
import type { SessionEvent } from "../../session/events.js";
import type {
  ApprovalMode,
  ApprovalRequest,
  BootInfo,
  SessionSummary,
  SkillInfo,
  StartSessionOptions,
  TurnStatus,
} from "../../shared/shellBridge.js";

/** 从 Record 里删一个 key 的不可变写法 */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

/** UI 三相：连接中 → 没会话（欢迎页）→ 聊天中 */
type Phase = "connecting" | "welcome" | "chat";

interface ChatState {
  phase: Phase;
  sessionId: string;
  model: string;
  workspace: string;
  events: SessionEvent[];
  /** 侧栏会话列表（常驻） */
  sessions: SessionSummary[];
  /** turn 状态按会话记：A 跑着时你可能正看 B。缺省 = idle */
  statusBySession: Record<string, TurnStatus>;
  /** 待审批按会话挂靠：卡只在自己的会话视图里渲染，侧栏挂标记 */
  approvals: Record<string, ApprovalRequest>;
  /** 流式直播缓冲（按会话攒碎片，思考/正文分频道）。临时投影：完整
      assistant_message 事件一到就清——事件是事实，缓冲只是它到来前的预览 */
  streamingBySession: Record<string, { content: string; reasoning: string }>;
  /** 工具输出直播缓冲（按 toolCallId 攒 bash 的 stdout/stderr 尾巴）。
      只留尾部（终端视角：看最新进展）；tool_result 一到就清——完整输出以它为准 */
  toolOutputByCall: Record<string, string>;
  error: string | null;
  /** 运行时偏好（主进程 agent 持有，这里是镜像；不落日志） */
  approvalMode: ApprovalMode;
  thinking: boolean;
  maxSteps: number;
  /** 回放游标：null = 直播；N = 富回放视图里选中第 N 条事件（0 起）。
      纯渲染层概念——主进程和 agent 对回放毫不知情。 */
  replayCursor: number | null;
  /** 设置页开关（覆盖在任意 phase 之上） */
  showSettings: boolean;
  /** skill 库页开关（与设置页同级，互斥打开） */
  showSkills: boolean;
  /** 本机已安装 skill（磁盘扫描镜像：boot 时取一次，开库页时刷新） */
  skills: SkillInfo[];
  /** env 变量名 → 配了没。渲染层能知道的关于 key 的全部信息 */
  keyStatus: Record<string, boolean>;

  boot(): Promise<void>;
  setReplayCursor(cursor: number | null): void;
  switchModel(model: string): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  setThinking(on: boolean): Promise<void>;
  /** /steps 指令的落点：调单 turn 步数上限（合法性由主进程把关） */
  setMaxSteps(n: number): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): void;
  openSkills(): Promise<void>;
  closeSkills(): void;
  saveApiKey(envName: string, key: string): Promise<void>;
  /** 只弹文件夹选择框（新会话 composer 的文件夹按钮）。null = 用户取消 */
  pickWorkspace(): Promise<string | null>;
  /** 回到新会话 composer 视图（侧栏 ＋ 按钮）——纯导航，不建任何东西 */
  newSession(): void;
  startSession(opts: StartSessionOptions): Promise<void>;
  resume(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** skill = 随消息注入的 skill 名（$ 指令）；主进程落 skill_invoked 后才跑 turn */
  send(text: string, skill?: string): Promise<void>;
  /** 中断当前会话正在跑的 turn（停止键 / Esc）。结果以 turn_ended(aborted) 事件流回 */
  stop(): Promise<void>;
  /** /compact 指令的落点：调主进程压缩上下文（真实模型调用，耗 token） */
  compact(): Promise<void>;
  /** /rename 指令的落点：手动改当前会话标题（落 session_renamed 事件） */
  rename(title: string): Promise<void>;
  decide(decision: "approved" | "denied", reason?: string): Promise<void>;
}

let bootStarted = false; // StrictMode 会双跑 effect，用模块级闩防重复订阅

/** 三条进聊天的路（boot 命中 / 新建 / 恢复）共用的状态落位 */
const enterChat = (info: BootInfo) => ({
  phase: "chat" as const,
  sessionId: info.sessionId,
  model: info.model,
  workspace: info.workspace,
  events: info.events,
  approvalMode: info.approvalMode,
  thinking: info.thinking,
  maxSteps: info.maxSteps,
  replayCursor: null, // 换会话 = 换时间线，旧游标作废
  showSettings: false, // 侧栏点会话 = 想看聊天，覆盖页让位
  showSkills: false,
  error: null,
});

export const useChat = create<ChatState>((set, get) => ({
  phase: "connecting",
  sessionId: "",
  model: "",
  workspace: "",
  events: [],
  sessions: [],
  statusBySession: {},
  approvals: {},
  streamingBySession: {},
  toolOutputByCall: {},
  error: null,
  approvalMode: "ask",
  thinking: true,
  maxSteps: 8,
  replayCursor: null,
  showSettings: false,
  showSkills: false,
  skills: [],
  keyStatus: {},

  setReplayCursor: (replayCursor) => set({ replayCursor }),

  async switchModel(model) {
    try {
      await window.otter.switchModel(model);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async setApprovalMode(mode) {
    try {
      await window.otter.setApprovalMode(get().sessionId, mode);
      set({ approvalMode: mode }); // 主进程认了才落镜像
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async setThinking(on) {
    try {
      await window.otter.setThinking(get().sessionId, on);
      set({ thinking: on });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async setMaxSteps(n) {
    try {
      await window.otter.setMaxSteps(get().sessionId, n);
      set({ maxSteps: n, error: null }); // 主进程认了才落镜像
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openSettings() {
    set({ showSettings: true, showSkills: false, keyStatus: await window.otter.keyStatus() });
  },

  closeSettings: () => set({ showSettings: false }),

  async openSkills() {
    // 开页顺手刷新：skill 是用户随时在磁盘上增删的外部文件，镜像别太陈旧
    set({ showSkills: true, showSettings: false, skills: await window.otter.listSkills() });
  },

  closeSkills: () => set({ showSkills: false }),

  async saveApiKey(envName, key) {
    try {
      await window.otter.setApiKey(envName, key);
      set({ keyStatus: await window.otter.keyStatus() }); // 状态从主进程重新问，不本地猜
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async boot() {
    if (bootStarted) return;
    bootStarted = true;

    window.otter.onEvent((e) =>
      set((s) => {
        // 完整 assistant_message 落地 = 直播缓冲作废（事实覆盖预览）。
        // 这步在分流之前：后台会话的缓冲也要清，不然工具循环里越攒越错
        const streaming =
          e.type === "assistant_message"
            ? without(s.streamingBySession, e.sessionId)
            : s.streamingBySession;
        // 工具输出直播同款作废：事实（tool_result）落地，该调用的碎片扔掉。
        // 不分会话——callId 全局唯一，后台会话的缓冲也要清，不然只涨不消
        const toolOutput =
          e.type === "tool_result" ? without(s.toolOutputByCall, e.toolCallId) : s.toolOutputByCall;
        // 分流：不是正在看的会话的事件，直接丢——它已经在 DB 里了，
        // 切回那个会话时 resumeSession 会全量带回。DB 就是缓冲区。
        if (e.sessionId !== s.sessionId)
          return { streamingBySession: streaming, toolOutputByCall: toolOutput };
        return {
          streamingBySession: streaming,
          toolOutputByCall: toolOutput,
          events: [...s.events, e],
          // header 的当前模型也是日志投影：model_changed 流回来才变，UI 不抢跑
          ...(e.type === "model_changed" ? { model: e.model } : {}),
        };
      })
    );
    window.otter.onAssistantDelta(({ sessionId, text, kind }) =>
      set((s) => {
        const buf = s.streamingBySession[sessionId] ?? { content: "", reasoning: "" };
        return {
          streamingBySession: {
            ...s.streamingBySession,
            [sessionId]:
              kind === "reasoning"
                ? { ...buf, reasoning: buf.reasoning + text }
                : { ...buf, content: buf.content + text },
          },
        };
      })
    );
    window.otter.onToolOutput(({ toolCallId, chunk }) =>
      set((s) => {
        // stdout/stderr 不分家（终端视角：按到达顺序混流）。只留尾部 4000 字——
        // 直播是"最新进展"，头部截断无所谓，完整输出反正在 tool_result 里
        const merged = (s.toolOutputByCall[toolCallId] ?? "") + chunk;
        return {
          toolOutputByCall: {
            ...s.toolOutputByCall,
            [toolCallId]: merged.length > 4000 ? merged.slice(-4000) : merged,
          },
        };
      })
    );
    window.otter.onApprovalRequest((req) =>
      set((s) => ({ approvals: { ...s.approvals, [req.sessionId]: req } }))
    );
    window.otter.onTurnStatus(({ sessionId, status }) =>
      set((s) => ({
        statusBySession: { ...s.statusBySession, [sessionId]: status },
        // turn 收尾兜底：清直播缓冲（防幽灵字）+ 收审批卡。
        // 中断会把挂起的审批在主进程侧 resolve 成 denied——没人点按钮，
        // 卡得跟着 turn 一起谢幕，不然留一张点了也没人听的死卡
        ...(status === "idle"
          ? {
              streamingBySession: without(s.streamingBySession, sessionId),
              approvals: without(s.approvals, sessionId),
            }
          : {}),
      }))
    );

    // 会话列表是侧栏常驻数据，不分 phase 都要；skill 列表给 $ 菜单和库页
    const [info, sessions, skills] = await Promise.all([
      window.otter.boot(),
      window.otter.listSessions(),
      window.otter.listSkills(),
    ]);
    set(info ? { ...enterChat(info), sessions, skills } : { phase: "welcome", sessions, skills });
  },

  async pickWorkspace() {
    try {
      return await window.otter.pickWorkspace();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  newSession: () =>
    set({
      phase: "welcome",
      sessionId: "", // 清掉投影：welcome 视图不属于任何会话（后台事件照常进 DB）
      events: [],
      replayCursor: null,
      showSettings: false,
      showSkills: false,
      error: null,
    }),

  async startSession(opts) {
    try {
      const info = await window.otter.startSession(opts);
      set(enterChat(info));
      set({ sessions: await window.otter.listSessions() }); // 新会话进侧栏
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async resume(sessionId) {
    try {
      const info = await window.otter.resumeSession(sessionId);
      set(enterChat(info));
      set({ sessions: await window.otter.listSessions() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async deleteSession(sessionId) {
    try {
      await window.otter.deleteSession(sessionId);
      const sessions = await window.otter.listSessions();
      // 删的是正看着的会话 → 回欢迎页，清掉它的投影
      if (get().sessionId === sessionId) {
        set({ phase: "welcome", sessions, sessionId: "", events: [], replayCursor: null });
      } else {
        set({ sessions });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async send(text, skill) {
    const sessionId = get().sessionId; // 发消息瞬间锁定目标会话——之后切走也不串
    set({ error: null });
    try {
      await window.otter.sendMessage(sessionId, text, skill);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // turn 暴死已作为 turn_ended 事件渲染在时间线里（ADR-0004）——
      // 同一条错误别再叠一行临时的；transient error 只兜 IPC 层失败（会话不存在等）。
      // 包含判断：Electron 会把 reject 包成 "Error invoking remote method…: <原文>"
      const last = get().events.at(-1);
      if (!(last?.type === "turn_ended" && last.error && msg.includes(last.error))) {
        set({ error: msg });
      }
    }
  },

  async stop() {
    try {
      await window.otter.stopTurn(get().sessionId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async compact() {
    const sessionId = get().sessionId;
    set({ error: null });
    try {
      await window.otter.compact(sessionId); // 结果以 context_compacted 事件流回
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async rename(title) {
    const sessionId = get().sessionId;
    set({ error: null });
    try {
      await window.otter.renameSession(sessionId, title);
      set({ sessions: await window.otter.listSessions() }); // 侧栏标题立即换
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async decide(decision, reason) {
    const sessionId = get().sessionId;
    const approval = get().approvals[sessionId]; // 只能批当前视图里的卡
    if (!approval) return;
    set((s) => ({ approvals: without(s.approvals, sessionId) })); // 先收卡；结果以事件流回
    await window.otter.decideApproval(sessionId, approval.call.id, decision, reason);
  },
}));
