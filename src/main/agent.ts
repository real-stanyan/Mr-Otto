// 组装根（agent 侧）— 把 store/adapter/tools/world/approver 拼成 engine。
// 刻意不 import electron：接缝都是回调，Electron 接线在 index.ts。

import { EventStore } from "../session/store.js";
import { AttachmentStore } from "../session/attachments.js";
import { LoopEngine } from "../loop/engine.js";
import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import {
  DEFAULT_MODEL,
  describeModelWith,
  resolveModel,
  type ModelChoice,
} from "../shared/modelCatalog.js";
import { clampThinking, type ThinkingMode } from "../shared/thinking.js";
import { lookupOllamaModel } from "./ollamaModels.js";

/** 目录查表 + Ollama 能力补齐（装了什么、能不能看图、思不思考、窗多大只有探测知道）。
    会话里所有拿到 ModelChoice 的地方都走它。
    补齐口径与渲染层共用 describeModelWith——同一个型号不该在两边显示成两种能力。
    探不到就用兜底形态，注册表是缓存不是事实来源；目录外的 id 仍按 DeepSeek 方言兜底 */
function resolveWithCapabilities(model: string): ModelChoice {
  return describeModelWith(model, (tag) => lookupOllamaModel(tag)) ?? resolveModel(model);
}
import { createLocalWorld } from "../world/localWorld.js";
import { readFileTool } from "../tools/readFile.js";
import { todoWriteTool } from "../tools/todoWrite.js";
import { writeFileTool } from "../tools/writeFile.js";
import { bashTool } from "../tools/bash.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createWebExtractTool } from "../tools/webExtract.js";
import { browserReadTool } from "../tools/browserRead.js";
import { withBrowser, type BrowserCapability } from "../world/executionWorld.js";
import { UIApprover, createModeAwareApprover, type ApprovalMode } from "./uiApprover.js";
import { buildApprovalPreview } from "./approvalPreview.js";
import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import type { DeltaKind } from "../model/adapter.js";
import type { WriteFilePreview } from "../shared/shellBridge.js";
import type { Tool } from "../tools/tool.js";
import { UIQuestioner } from "./uiQuestioner.js";
import { createAskUserTool } from "../tools/askUser.js";
import type { AskUserOutcome, AskUserQuestion } from "../shared/askUser.js";
import { gatewayBaseUrl } from "../shared/gatewayConfig.js";
import { routeModel } from "./modelRoute.js";
import { randomUUID } from "node:crypto";

/** 内置 anysearch key(免费注册所得,仅搜索限额,无支付面)。仓库私有;若开源须先轮换。
    ANYSEARCH_API_KEY 环境变量优先于它。 */
const BUILTIN_ANYSEARCH_KEY = "as_sk_510528174cb15e70f912bc49bdd80eb5";

export interface AgentPush {
  event(e: SessionEvent): void;
  /** 带 sessionId：审批卡要挂靠到具体会话的视图上。preview 有 = write_file 的 diff 预览 */
  approvalRequest(
    sessionId: string,
    call: ToolCallRequest,
    tool: Tool,
    preview?: WriteFilePreview
  ): void;
  /** 带 sessionId：问卷卡同理，挂靠到发起提问的那个会话的视图上 */
  askUserRequest(sessionId: string, toolCallId: string, questions: AskUserQuestion[]): void;
  /** 流式文本碎片（临时直播，不落日志）——渲染层按会话、按频道攒着显示 */
  assistantDelta(sessionId: string, text: string, kind: DeltaKind): void;
  /** 工具输出直播碎片（bash 的 stdout/stderr）——同上，不落日志，
      完整输出以 tool_result 事件为准 */
  toolOutput(sessionId: string, toolCallId: string, chunk: string, stream: "stdout" | "stderr"): void;
}

export function createAgent(opts: {
  /** app 级资源，由外面注入——欢迎页列会话时 agent 还不存在，库必须先活着 */
  store: EventStore;
  workspace: string;
  push: AgentPush;
  /** 给了 = 恢复旧会话：复用它的 id，不再追加 session_created */
  resumeSessionId?: string;
  /** 图片附件库(app 级资源,index.ts 注入)——adapter 请求时解 image_ref 用 */
  attachments: AttachmentStore;
  /** Supabase access token 取用器(index.ts 注入 AccountManager.getAccessToken)。
      不给 = 这个装配里没有登录态,只能走自带 key 那条路(测试和裸装配照旧) */
  getAccessToken?: () => Promise<string | null>;
  /** 浏览器能力工厂(index.ts 注入,按 sessionId 绑到 browserHub)。
      不给 = 这个装配没有浏览器,browser_read 会明确报错(测试和裸装配照旧) */
  makeBrowser?: (sessionId: string) => BrowserCapability;
}) {
  const { store } = opts;

  const sessionId =
    opts.resumeSessionId ?? `s-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  // world 先于 approver：审批预览要借它的 fs 读旧文件（围栏天然生效）
  const base = createLocalWorld({ root: opts.workspace });
  // 浏览器能力从外面注入:WebContentsView 只有主进程造得出来,LocalWorld 造不出来
  // (与 openTerminal 的方向相反,见 ADR-0033)。工具照旧只认 world.browser
  const world = opts.makeBrowser ? withBrowser(base, opts.makeBrowser(sessionId)) : base;
  const approver = new UIApprover((call, tool) => {
    // 预览是尽力而为：算好了随卡出场，算炸了（理论上不会）卡照常弹、走 JSON 兜底。
    // async 在闭包里消化——UIApprover 不知道预览的存在，审批悬停语义原样
    void buildApprovalPreview(call, world).then(
      (preview) => opts.push.approvalRequest(sessionId, call, tool, preview),
      () => opts.push.approvalRequest(sessionId, call, tool)
    );
  });
  // 问人和审批同构：都是"管线悬停等一次 UI 往返"，只是问的内容不同
  const questioner = new UIQuestioner((toolCallId, questions) =>
    opts.push.askUserRequest(sessionId, toolCallId, questions)
  );
  // 运行时偏好（刻意不落日志）：影响的是"怎么问人/怎么调 API"，不是模型看到的上下文。
  // 代价：resume 后回默认值——审批模式回 ask 是安全默认，thinking 回开是保守默认。
  let approvalMode: ApprovalMode = "ask";
  if (!opts.resumeSessionId) {
    // workspace 写进日志第 0 条：它是会话事实，不是运行时配置。
    // system 消息（deriveMessages）和文件围栏（LocalWorld root）都从这个事实派生。
    // resume 时它已在日志里——engine 每 turn 从日志现算，所以这里啥都不用"恢复"。
    store.append({ sessionId, ts: Date.now(), type: "session_created", workspace: opts.workspace });
  } else {
    // 崩溃修复（ADR-0005，留痕层）：上次 app 在工具执行中途退出的话，日志里
    // 会有悬空 toolCall（无配对 tool_result）。补合成结果事件——修复 = 追加，
    // 永不改写。文案按 tool_execution_started 区分"跑了一半"和"没开跑"。
    // 幂等：补过即配对，再 resume 不重复。事故从此是时间线事实，UI/回放可见。
    const log = store.load(sessionId);
    const answered = new Set(
      log.filter((e) => e.type === "tool_result").map((e) => e.toolCallId)
    );
    const started = new Set(
      log.filter((e) => e.type === "tool_execution_started").map((e) => e.toolCallId)
    );
    for (const e of log) {
      if (e.type !== "assistant_message") continue;
      for (const tc of e.toolCalls ?? []) {
        if (answered.has(tc.id)) continue;
        const full = store.append({
          sessionId,
          ts: Date.now(),
          type: "tool_result",
          toolCallId: tc.id,
          status: "error",
          output: started.has(tc.id)
            ? "执行中断：执行已开始但结果未落盘（app 在执行中退出）。" +
              "世界可能已被部分变更，结果未知，建议检查现场。"
            : "执行中断：调用未开始执行就被中断（审批未决或 app 退出）。" +
              "执行器未达，世界未被此调用变更。",
        });
        opts.push.event(full);
      }
    }
  }

  // 当前模型 = 日志投影：最后一条 model_changed 说了算，没有就用默认。
  // resume 时上次的选择自动回来——和 workspace 同一招，零额外持久化。
  const lastSwitch = store
    .load(sessionId)
    .filter((e) => e.type === "model_changed")
    .at(-1);
  let current: ModelChoice = resolveWithCapabilities(
    lastSwitch?.type === "model_changed"
      ? lastSwitch.model
      : (process.env["OTTER_MODEL"] ?? DEFAULT_MODEL)
  );

  // thinking 也是运行时偏好，但它的**取值范围**由型号决定：GLM 是开/关，
  // GPT-5 是低/中/高（关不掉），Grok 4 干脆没有开关。所以初值不能写死 true，
  // 得问当前型号的默认档；换型号时同理要钳回新型号有的那一档（switchModel）
  let thinking: ThinkingMode = current.thinking.default;

  // key 本体只在这里碰 process.env；缺 key 不拦启动，chat 时报错给 UI。
  //
  // 端点每次请求现算(resolveEndpoint),不在构造时定死。两个理由:
  // ① 网关凭据是 access token,一小时就过期,静态捕获等于 turn 跑到一半 401;
  // ② 用户可能在会话中途填了自己的 key 或登出,路线该当场改,而不是等重开会话。
  const resolveEndpoint = async (choice: ModelChoice) => {
    const route = routeModel({
      choice,
      ownKey: process.env[choice.apiKeyEnv] ?? "",
      ownBaseUrl: process.env[choice.baseUrlEnv],
      accessToken: opts.getAccessToken ? await opts.getAccessToken() : null,
      gatewayBaseUrl: gatewayBaseUrl(),
    });
    if (route.kind === "blocked") throw new Error(route.reason);
    return {
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      // 幂等键只对网关有意义:同一次调用若因网络重投递到达两次,网关据此不重复扣费
      ...(route.kind === "gateway" ? { headers: { "x-otto-request-id": randomUUID() } } : {}),
    };
  };

  const makeAdapter = (choice: ModelChoice) =>
    createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey: process.env[choice.apiKeyEnv] ?? "",
      resolveEndpoint: () => resolveEndpoint(choice),
      model: choice.model, // 日志 id（Ollama 带前缀）
      wireModel: choice.wireModel, // 发上线的 id
      // 有挡位的型号才带 thinking 字段——别给不认识它的 API 发陌生参数。
      // 档要按 choice 钳一次：切模型和这里之间没有别的把关，钳漏了就会
      // 把 GLM 的"开"原样发给 GPT-5（reasoning_effort:"on" 不是合法值）
      ...(choice.thinking.modes.length > 0
        ? { thinking: { mode: clampThinking(thinking, choice.thinking), wire: choice.thinking.wire } }
        : {}),
      // 有眼睛的型号 image_ref 才解 bytes;没眼睛的换占位文本(vision-bridge 供文字)
      vision: choice.supportsVision,
      readAttachment: (id) => opts.attachments.read(id),
    });

  // anysearch key:内置默认(免费注册 key,只管搜索限额,无支付面——用户决定开箱即高限额,
  // 见 ADR-0008 追记);ANYSEARCH_API_KEY 环境变量可覆盖 = 换 key 不用改代码。
  // 拎成变量而不是内联进 engine:渲染层要拿这份表的 def 算上下文占用(BootInfo.toolDefs),
  // 两处必须是同一个数组——engine 挂的和 UI 报的不能各说各话
  const tools: Tool[] = [
    createAskUserTool(questioner),
    todoWriteTool,
    readFileTool,
    writeFileTool,
    bashTool,
    createWebSearchTool(() => process.env["ANYSEARCH_API_KEY"] ?? BUILTIN_ANYSEARCH_KEY),
    createWebExtractTool(() => process.env["ANYSEARCH_API_KEY"] ?? BUILTIN_ANYSEARCH_KEY),
    // 有浏览器能力才上这把工具。无条件挂着的话,没浏览器的装配(裸装配/测试)
    // 会对模型宣称有这把工具,模型试一次、吃一个"这个世界没有内置浏览器",
    // 白烧一轮。工具表同时也是 UI 报的上下文占用(BootInfo.toolDefs),
    // 报一把用不了的工具连账也是错的
    ...(world.browser ? [browserReadTool] : []),
  ];

  const engine = new LoopEngine({
    store,
    adapter: makeAdapter(current),
    tools,
    world,
    sessionId,
    // auto 模式短路 UI 审批；决定照常过审批门落 approval_decision
    approver: createModeAwareApprover(() => approvalMode, approver),
    onEvent: opts.push.event,
    onAssistantDelta: (text, kind) => opts.push.assistantDelta(sessionId, text, kind),
    onToolOutput: (toolCallId, chunk, stream) =>
      opts.push.toolOutput(sessionId, toolCallId, chunk, stream),
  });

  /** 切换 = 先落事实（model_changed），再换投影（adapter 实例）。顺序是硬规则 */
  function switchModel(modelId: string): void {
    if (modelId === current.model) return;
    const next = resolveWithCapabilities(modelId);
    const full = store.append({
      sessionId,
      ts: Date.now(),
      type: "model_changed",
      provider: next.provider,
      model: next.model,
    });
    opts.push.event(full); // engine 外落的盘，推送自己负责
    // 换型号 = 换挡位表。手上这一档多半不在新型号的表里（"开"→ GPT-5 只有低/中/高），
    // 按强度就近落地；顺序在 setAdapter 之前——adapter 要拿到钳好的那一档
    thinking = clampThinking(thinking, next.thinking);
    engine.setAdapter(makeAdapter(next));
    current = next;
  }

  return {
    engine,
    approver,
    /** IPC 唤醒挂起的问卷（与 approver.resolve 同构） */
    answerQuestions(toolCallId: string, outcome: AskUserOutcome): void {
      questioner.resolve(toolCallId, outcome);
    },
    sessionId,
    workspace: opts.workspace,
    /** 这个 agent 的 ExecutionWorld——终端接线要靠它才能走 seam 而不是绕过去
        (ADR-0031)：v2 SandboxWorld 把 openTerminal 实现成 docker exec，
        终端得开在 agent 这个 world 里，不能在 index.ts 里另起一个 LocalWorld */
    world,
    /** 喂给模型的工具声明（渲染层算上下文占用用；只有 name/description/parameters） */
    toolDefs: tools.map((t) => t.def),
    switchModel,
    /** 设置页存了新 key 后调：现 adapter 捏的还是旧 key，重建一个 */
    reloadAdapter(): void {
      engine.setAdapter(makeAdapter(current));
    },
    get model() {
      return current.model;
    },
    get approvalMode() {
      return approvalMode;
    },
    /** turn 中途也可切：下一个工具调用立即遵守新模式（getMode 是活引用） */
    setApprovalMode(mode: ApprovalMode): void {
      approvalMode = mode;
    },
    get thinking(): ThinkingMode {
      return thinking;
    },
    /** 当前型号的挡位表（渲染层画下拉框用：有哪几档、什么方言） */
    get thinkingSpec() {
      return current.thinking;
    },
    /** thinking 是 adapter 构造参数，改了要重建 adapter（调用方负责挡 turn 进行中）。
        钳一次再存：渲染层可能拿着上一款型号的选项集发过来 */
    setThinking(mode: ThinkingMode): void {
      thinking = clampThinking(mode, current.thinking);
      engine.setAdapter(makeAdapter(current));
    },
  };
}

/** 极简 .env 装载：只补空缺，不覆盖已有环境变量。组装根特权，别处禁用 fs */
export function loadDotEnv(readFile: (p: string) => string, path: string): void {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return; // 没有 .env 就算了
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2] ?? "";
    }
  }
}
