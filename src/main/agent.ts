// 组装根（agent 侧）— 把 store/adapter/tools/world/approver 拼成 engine。
// 刻意不 import electron：接缝都是回调，Electron 接线在 index.ts。

import { randomBytes } from "node:crypto";
import { EventStore } from "../session/store.js";
import { AttachmentStore } from "../session/attachments.js";
import { LoopEngine } from "../loop/engine.js";
import { createOpenAICompatibleAdapter, localTiming } from "../model/openaiCompatible.js";
import {
  DEFAULT_MODEL,
  describeModelWith,
  resolveModel,
  type ModelChoice,
} from "../shared/modelCatalog.js";
import { clampThinking, type ThinkingMode } from "../shared/thinking.js";
import { DEFAULT_AUTO_COMPACT, type AutoCompactSettings } from "../shared/autoCompact.js";
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
import { createMemoryTool } from "../tools/memory.js";
import { writeFileTool } from "../tools/writeFile.js";
import { bashTool } from "../tools/bash.js";
import { createWebSearchTool } from "../tools/webSearch.js";
import { createWebExtractTool } from "../tools/webExtract.js";
import { browserReadTool } from "../tools/browserRead.js";
import {
  withBrowser,
  withMcp,
  withHistory,
  type BrowserCapability,
  type HistoryCapability,
  type McpCapability,
} from "../world/executionWorld.js";
import { createMcpTools } from "../tools/mcpTool.js";
import { createMcpReadResourceTool } from "../tools/mcpReadResource.js";
import { createSessionSearchTool } from "../tools/sessionSearch.js";
import { createTaskTool, type SubagentRunner } from "../tools/task.js";
import type { SubagentDef } from "../shared/subagent.js";
import {
  UIApprover,
  createGrantAwareApprover,
  createModeAwareApprover,
  createPolicyAwareApprover,
  type ApprovalMode,
} from "./uiApprover.js";
import { sessionGrants, type GrantScope } from "../shared/permissionGrants.js";
import { grantKeysFor, grantedScope, canonicalizeCommand } from "../shared/grantKey.js";
import type { ExecRule } from "../shared/execPolicy.js";

/** 没配永久授权文件时的空集（每次现建一个 Set 是白扔的分配） */
const EMPTY_GRANTS: ReadonlySet<string> = new Set();
/** 没配 execpolicy 时的空规则（同上，别每次现建） */
const EMPTY_POLICY: { rules: ExecRule[] } = { rules: [] };
import { buildApprovalPreview } from "./approvalPreview.js";
import { TurnDiffTracker, createTurnDiffMiddleware } from "./turnDiff.js";
import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import type { DeltaKind } from "../model/adapter.js";
import type { ApprovalPreview, TurnDiffUpdate } from "../shared/shellBridge.js";
import type { Tool } from "../tools/tool.js";
import { UIQuestioner } from "./uiQuestioner.js";
import { createAskUserTool } from "../tools/askUser.js";
import type { AskUserOutcome, AskUserQuestion } from "../shared/askUser.js";
import { gatewayBaseUrl } from "../shared/gatewayConfig.js";
import { routeModel } from "./modelRoute.js";
import type { ModelLane } from "../shared/modelLane.js";
import { randomUUID } from "node:crypto";
import type { Approver } from "../loop/approvalGate.js";
import type { ExecutionWorld } from "../world/executionWorld.js";

/** 内置 anysearch key(免费注册所得,仅搜索限额,无支付面)。仓库私有;若开源须先轮换。
    ANYSEARCH_API_KEY 环境变量优先于它。 */
const BUILTIN_ANYSEARCH_KEY = "as_sk_510528174cb15e70f912bc49bdd80eb5";

export interface AgentPush {
  event(e: SessionEvent): void;
  /** 带 sessionId：审批卡要挂靠到具体会话的视图上。preview 有 = write_file 的 diff 预览。
      fromAgent 有 = 这张卡是从某个 subagent 冒泡上来的（ADR-0047），
      缺席 = 主 agent 自己的卡，现有渲染一字不改 */
  approvalRequest(
    sessionId: string,
    call: ToolCallRequest,
    tool: Tool,
    preview?: ApprovalPreview,
    fromAgent?: string
  ): void;
  /** 带 sessionId：问卷卡同理，挂靠到发起提问的那个会话的视图上 */
  askUserRequest(sessionId: string, toolCallId: string, questions: AskUserQuestion[]): void;
  /** 流式文本碎片（临时直播，不落日志）——渲染层按会话、按频道攒着显示 */
  assistantDelta(sessionId: string, text: string, kind: DeltaKind): void;
  /** 工具输出直播碎片（bash 的 stdout/stderr）——同上，不落日志，
      完整输出以 tool_result 事件为准 */
  toolOutput(sessionId: string, toolCallId: string, chunk: string, stream: "stdout" | "stderr"): void;
  /** turn 级聚合 diff（issue #345）：每次写文件工具完成后整份替换。
      对话视图与灵动岛消费同一份——统计只能有一个出处。
      可选：探名字的 probe 装配、subagent（父会话从 tool_result 读汇报，
      不看子会话的实时改动面板）不接这条线 */
  turnDiff?(update: TurnDiffUpdate): void;
}

/** 会话 id：秒级时间戳 + 随机段。
    时间戳留着是为了人能读、列表大致按时间排；随机段是承重的那一半——
    id 是 append-only 日志的分区键，撞一次就是两个会话的事件写进同一条日志，
    而日志不可编辑，事后拆不开（#111）。
    旧日志里的 `s-<14 位>` 不受影响：全仓没有任何地方解析这个形状，
    resume 只按字符串原样取（AGENTS.md 硬规则：旧日志必须永远可重放）。 */
function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `s-${stamp}-${randomBytes(4).toString("hex")}`;
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
  /** 永久授权名单（ADR-0041，index.ts 从 userData/permissions.json 注入）。
      活引用：查的是"此刻"的名单，不是装配时的快照。
      不给 = 这个装配没有永久授权（测试和裸装配照旧，每次都问人） */
  alwaysAllow?: () => ReadonlySet<string>;
  /** execpolicy 规则（issue #347）：每次 decide 现读（热更新与 alwaysAllow 同款）。
      不给 = 无静态判定，链条与从前逐字节一致 */
  execPolicy?: () => { rules: ExecRule[] };
  /** 审批 UI「永久」产出 allow 前缀规则（issue #347 ③）。返回 false = 候选规则
      没过禁止前缀校验，调用方退回精确 key。不给 = 永久授权只走精确 key（旧路） */
  persistAllowRule?: (pattern: string[], cwd: string | undefined) => boolean;
  /** 授一条永久许可（落进那个文件）。不给 = 「永久」这一档在本装配里不生效 */
  persistAlwaysAllow?: (tool: string) => void;
  /** MCP 能力（index.ts 从 mcpHub 注入）。hub 要管子进程生命周期、要向渲染层推状态，
      LocalWorld 造不出来 —— 同 makeBrowser 的注入方向（ADR-0035）。
      不给 = 这个装配没有 MCP（测试和裸装配照旧） */
  mcp?: McpCapability;
  /** 历史会话查询能力（index.ts 用 createHistoryCapability(store, ...) 焊进来）。
      挂了才装 session_search 工具——子 agent 复用父 world 时自带（withHistory 焊在
      父身上），resumeChild 走的是父的旧世界，同理不用重复传（ADR-0060 的另一半） */
  history?: HistoryCapability;
  /** 复用现成的 world 而不是新造（ADR-0047）。子 agent 必须跑在父的 world 实例里：
      LocalWorld 下两者等价，但 v2 换 SandboxWorld 时"同一个容器"就是硬要求
      （方向同 ADR-0031）。给了它就不再 createLocalWorld / makeBrowser */
  world?: ExecutionWorld;
  /** 这个会话是被派活派出来的：写进 session_created 第 0 条 */
  spawnedBy?: { sessionId: string; toolCallId: string; agent: string };
  /** 只挂名字在这份名单里的工具。不给 = 全套（现有装配一字不受影响）。
      task 不在这里挡——它压根不会被挂上（见 subagentRunner：建子 agent 时
      不传 subagentRunner，递归由构造挡死） */
  allowTools?: readonly string[];
  /** 换掉整条审批链（mode 感知 + 授权感知 + UI）。给了 = 那三层都不参与。
      目前唯一用途：approval: "deny" 的 subagent 传 denyingApprover */
  approver?: Approver;
  /** 给了 = 这个装配能派活（挂 task 工具）。子 agent 刻意不传它——
      递归由此挡死（ADR-0047） */
  subagentRunner?: SubagentRunner;
  /** 现扫磁盘的 subagent 清单，task 工具的 def 每轮现算 */
  listSubagents?: () => SubagentDef[];
  /** 新 session 的长期记忆快照（ADR-0060）。由 index.ts 在造 agent 之前读好——
      createAgent 是同步的。resume 时忽略：日志里那条 memory_loaded 才是模型看过的 */
  memory?: { memory: string; user: string };
  /** 用户级配置目录（如 ~/.mr-otto），只在自己新造 LocalWorld 时用得上
      （opts.world 给了就走那条路，这个字段被忽略——同 makeBrowser 的取舍）。
      不给 = 造出来的 world 没有 config 能力，memory 工具不挂、记忆快照也落不了盘 */
  configRoot?: string;
  /** 自动压缩设置的现读器（index.ts 从设置页状态注入，ADR-0062）。
      不给 = 用全局默认（DEFAULT_AUTO_COMPACT，开启，按窗口两档阈值） */
  autoCompactSettings?: () => AutoCompactSettings;
  /** 长 turn 软告警（issue #283 ⑥）：单 turn 模型步数踩线时喊一次。
      不给 = 不喊（子会话/测试/裸装配照旧）。index.ts 拿它发系统通知 */
  onLongTurn?: (rounds: number) => void;
}) {
  const { store } = opts;

  const sessionId = opts.resumeSessionId ?? newSessionId();
  // world 先于 approver：审批预览要借它的 fs 读旧文件（围栏天然生效）。
  // 外面给了现成的就用它（子 agent 走这条：必须和父在同一个 world 实例里）
  const base: ExecutionWorld =
    opts.world ??
    (() => {
      // 浏览器能力从外面注入:WebContentsView 只有主进程造得出来,LocalWorld 造不出来
      // (与 openTerminal 的方向相反,见 ADR-0035)。工具照旧只认 world.browser
      const local = createLocalWorld({
        root: opts.workspace,
        ...(opts.configRoot ? { configRoot: opts.configRoot } : {}),
      });
      return opts.makeBrowser ? withBrowser(local, opts.makeBrowser(sessionId)) : local;
    })();
  // MCP 叠在最外层。子 agent 走 opts.world 那条路时不会被重复包一层：
  // subagentRunner 复用父的 world 实例，父身上已经带着 withMcp 那层
  const withMcpLayer = opts.mcp ? withMcp(base, opts.mcp) : base;
  // history 叠在 mcp 之外——同一件事：子 agent 复用父的 world 实例时这层已经在了，
  // 不会被重复包一层（world.history 是不是在只问 world，不问 opts.history 给没给）
  const world = opts.history ? withHistory(withMcpLayer, opts.history) : withMcpLayer;
  // "这次装配有没有 MCP 能力"问的是 world，不是参数（ADR-0054）：子 agent 跑在
  // 父的 world 实例里，父身上那份 mcp 就是它的。工具照旧要过 allowTools 白名单——
  // 挂载不等于给用（子 agent 的白名单里没点名 mcp__… 就是一把都没有）
  const mcp = opts.mcp ?? world.mcp;
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
  // 本会话授过权的工具（ADR-0041）。resume 时从日志重建 —— 会话中途授的权
  // 必须跟着会话回来，而日志是它唯一的凭据（approval_decision.grant）。
  // 新会话那份日志是空的，扫出来就是空集合
  // resume 的日志读一次、三处共用（授权重建 / 崩溃修复 / 型号投影，issue #279）：
  // 构造期间没有并发写者，这份快照对三处都是新鲜的。新会话 = null（日志还是空的）
  const resumeLog = opts.resumeSessionId ? store.load(opts.resumeSessionId) : null;
  const sessionAllow = new Set<string>(resumeLog ? sessionGrants(resumeLog) : []);
  if (!opts.resumeSessionId) {
    // workspace 写进日志第 0 条：它是会话事实，不是运行时配置。
    // system 消息（deriveMessages）和文件围栏（LocalWorld root）都从这个事实派生。
    // resume 时它已在日志里——engine 每 turn 从日志现算，所以这里啥都不用"恢复"。
    store.append({
      sessionId,
      ts: Date.now(),
      type: "session_created",
      workspace: opts.workspace,
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    });
    // 长期记忆快照落盘（ADR-0060）：紧跟 session_created 之后，先落盘再喂模型。
    // 只在有记忆能力的装配里落——world.config 不在 = 这个装配压根没有长期记忆
    if (opts.memory && world.config) {
      store.append({
        sessionId,
        ts: Date.now(),
        type: "memory_loaded",
        memory: opts.memory.memory,
        user: opts.memory.user,
      });
    }
  } else {
    // 崩溃修复（ADR-0005，留痕层）：上次 app 在工具执行中途退出的话，日志里
    // 会有悬空 toolCall（无配对 tool_result）。补合成结果事件——修复 = 追加，
    // 永不改写。文案按 tool_execution_started 区分"跑了一半"和"没开跑"。
    // 幂等：补过即配对，再 resume 不重复。事故从此是时间线事实，UI/回放可见。
    const log = resumeLog!;
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
  // 新会话此刻的日志里不可能有 model_changed（上面刚落的只有 session_created /
  // memory_loaded），resume 用同一份快照——崩溃修复补的 tool_result 不影响这条投影
  const lastSwitch = (resumeLog ?? [])
    .filter((e) => e.type === "model_changed")
    .at(-1);
  let current: ModelChoice = resolveWithCapabilities(
    lastSwitch?.type === "model_changed"
      ? lastSwitch.model
      : (process.env["OTTER_MODEL"] ?? DEFAULT_MODEL)
  );
  // lane 和型号同一个取法(都从最后一条 model_changed 投影)。旧日志没这个字段 = auto,
  // 也就是老规矩:自带 key 优先(ADR-0020/0045)
  let lane: ModelLane = (lastSwitch?.type === "model_changed" ? lastSwitch.lane : undefined) ?? "auto";

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
      lane, // 每次请求现读:会话中途换 lane,下一次调用就该改道(同 key/登录态)
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
      // 本机推理（Ollama）：首 token 前的冷加载 + prefill 是在干活不是挂死，
      // 看门狗放宽到 10 分钟（见 localTiming 的注释）；云端型号 {} = 默认
      timing: localTiming(choice),
    });

  // anysearch key:内置默认(免费注册 key,只管搜索限额,无支付面——用户决定开箱即高限额,
  // 见 ADR-0008 追记);ANYSEARCH_API_KEY 环境变量可覆盖 = 换 key 不用改代码。
  // 拎成变量而不是内联进 engine:渲染层要拿这份表的 def 算上下文占用(BootInfo.toolDefs),
  // 两处必须是同一个数组——engine 挂的和 UI 报的不能各说各话
  // 工具表是一次性拼好的（挂载一次定终身，见 tool.ts 的注释），
  // 拼之前必须已经知道每台 server 提供了什么。createAgent 是同步的，
  // 所以 ready() 在 index.ts 里、造 agent 之前就 await 过了；
  // 这里再叫一次是幂等的兜底（并发调只连一次，见 mcpHub）
  void mcp?.ready();

  const tools: Tool[] = [
    createAskUserTool(questioner),
    todoWriteTool,
    // 只有带长期记忆能力的装配（world.config 在）才挂这把工具——没有配置目录
    // 的装配（裸装配/测试）不该对模型宣称有记忆
    ...(world.config ? [createMemoryTool()] : []),
    // 同理：world 有没有历史会话查询能力（world.history 在不在）决定挂不挂
    // session_search——没有 history 能力的装配（裸装配/测试）不该对模型宣称能查历史
    ...(world.history ? [createSessionSearchTool()] : []),
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
    // 同理：world 里没有 mcp 的装配（裸装配/测试）一把 mcp 工具都不挂
    ...(mcp ? createMcpTools(mcp) : []),
    ...(mcp ? [createMcpReadResourceTool(mcp)] : []),
    // 挂载只问"这次装配有没有派活的能力"(subagentRunner 给没给)，不再问"清单此刻
    // 是不是空的"——LoopEngine 把 toolsByName 冻在构造那一刻(src/loop/engine.ts)，
    // 挂没挂必须一次定终身，否则组装时清单恰好是空的那个 agent 一辈子看不到 task，
    // 哪怕用户后来在设置页建了第一个 subagent 也救不回来(这是每个新用户都会撞的
    // 首次使用路径)。清单是不是空的这件事现在归 task 自己的 available()答，
    // 报给模型的工具表(下面 toolDefs)和 LoopEngine 每轮取 def 时都会过滤掉它
    ...(opts.subagentRunner
      ? [createTaskTool(opts.subagentRunner, opts.listSubagents ?? (() => []))]
      : []),
  ];

  // 白名单：给了就只留名单里的。放在数组构造之后而不是之前——上面那些条件
  // （world.browser 才挂 browser_read）是"这个装配有没有这把刀"，白名单是
  // "这次准不准用"，两件事，别搅在一起
  const mounted = opts.allowTools
    ? tools.filter((t) => opts.allowTools!.includes(t.def.name))
    : tools;

  // turn 级聚合 diff（issue #345）：per-agent 一只 tracker，中间件挂在审批门
  // 之后（engine 把审批门永远排第一）——被拒的写盘进不了聚合。
  // getTurnId 闭包现读 engine.runningTurnId：engine 在下面才构造，调用时已就位
  const turnDiffTracker = new TurnDiffTracker();

  const engine = new LoopEngine({
    store,
    adapter: makeAdapter(current),
    tools: mounted,
    world,
    sessionId,
    middlewares: [
      createTurnDiffMiddleware(turnDiffTracker, sessionId, () => engine.runningTurnId, (u) =>
        opts.push.turnDiff?.(u)
      ),
    ],
    // auto 模式短路 UI 审批；决定照常过审批门落 approval_decision
    // 两层短路，顺序有意：先看模式（"完全访问"是对整台机器说的话），
    // 再看授权（对某个工具说的话）。都不命中才弹卡。
    // opts.approver 给了 = 整条链换成它，mode/grant 都不参与
    // （subagent 唯一用途：denyingApprover——没人盯屏幕，弹卡等人等于永久挂起）
    approver:
      opts.approver ??
      // execpolicy 最外层（issue #347）：forbidden 硬拒连 bypass 模式都压不过
      // ——规则是用户亲手写的"永不放行"；allow 免弹卡；其余往里走
      createPolicyAwareApprover(
        () => opts.execPolicy?.() ?? EMPTY_POLICY,
        opts.workspace,
        createModeAwareApprover(
          () => approvalMode,
          createGrantAwareApprover(
            // 判定粒度是规范化 key（issue #342，shared/grantKey.ts）：bash 按命令、
            // write_file 按路径、其余按工具，全部掺 cwd；旧的裸工具名条目按宽语义兼容
            (call) =>
              grantedScope(call, opts.workspace, sessionAllow, opts.alwaysAllow?.() ?? EMPTY_GRANTS),
            approver
          )
        )
      ),
    onEvent: opts.push.event,
    onAssistantDelta: (text, kind) => opts.push.assistantDelta(sessionId, text, kind),
    onToolOutput: (toolCallId, chunk, stream) =>
      opts.push.toolOutput(sessionId, toolCallId, chunk, stream),
    // 闭包读的是 current 这个变量,不是此刻的值——换模型时 current 被重新赋值
    // （switchModel），闭包必须现读到新窗口，不能锁死装配那一刻的型号
    autoCompact: {
      // 窗口是兜底猜的数（未探测的本机 Ollama / 目录外的自定义型号id）就别拿它算阈值——
      // 一个假数据驱动自动压缩，压出来的时机毫无意义（可能太早也可能永远压不到）
      contextWindow: () => (current.contextWindowKnown ? current.contextWindow : undefined),
      settings: opts.autoCompactSettings ?? (() => DEFAULT_AUTO_COMPACT),
    },
    ...(opts.onLongTurn ? { onLongTurn: opts.onLongTurn } : {}),
  });

  /** 切换 = 先落事实（model_changed），再换投影（adapter 实例）。顺序是硬规则。
      lane 一起落:同一个型号换条路走(自己的 key ↔ 官方赠额)也是一次切换,
      而且它决定这个 turn 的钱从谁账上出 —— 那是"发生过什么"的一部分 */
  function switchModel(modelId: string, nextLane: ModelLane = "auto"): void {
    if (modelId === current.model && nextLane === lane) return;
    const next = resolveWithCapabilities(modelId);
    const full = store.append({
      sessionId,
      ts: Date.now(),
      type: "model_changed",
      provider: next.provider,
      model: next.model,
      // auto 不写进日志:它是缺省,写了等于给每条旧事件补一个没有信息量的字段
      ...(nextLane === "grant" ? { lane: nextLane } : {}),
    });
    lane = nextLane;
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
    /** IPC：审批卡上按下的不只是"批准"，还捎带一条长期许可（ADR-0041）。
        授权的粒度是规范化 key（issue #342），而 IPC 回来的只有 toolCallId ——
        从挂起表里查回完整调用（含 args）现算 key。查不到（卡已过期/重复点击）
        就什么也不授：宁可再问一次，不能给错调用开门。
        revisedArgs：用户在卡上改过参数时，实际执行、也是用户实际同意的是那一份
        （ADR-0041 分块审批）——key 必须从它算，与日志重建（sessionGrants）同规则 */
    grant(toolCallId: string, scope: GrantScope, revisedArgs?: unknown): void {
      const call = approver.callFor(toolCallId);
      if (!call) return;
      const effective = revisedArgs !== undefined ? { ...call, args: revisedArgs } : call;
      // 「永久」的 bash 命令优先产出 execpolicy allow 规则（issue #347 ③）：
      // 整条精确 token + cwd，前缀语义让"同命令多带一个参数"不再重问。
      // 候选没过禁止前缀校验（裸 git 这类）→ 退回 #342 的精确 key，宁窄勿宽
      if (scope === "always" && effective.name === "bash" && opts.persistAllowRule) {
        const cmd = (effective.args as { cmd?: unknown } | null)?.cmd;
        if (typeof cmd === "string") {
          const c = canonicalizeCommand(cmd);
          if (c.kind === "cmd" && opts.persistAllowRule(JSON.parse(c.canon) as string[], opts.workspace)) {
            return; // 规则已落盘并热生效，精确 key 不再重复记
          }
        }
      }
      for (const key of grantKeysFor(effective, opts.workspace)) {
        if (scope === "session") sessionAllow.add(key);
        else opts.persistAlwaysAllow?.(key);
      }
    },
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
    /** 喂给模型的工具声明（渲染层算上下文占用用；只有 name/description/parameters）。
        getter 而不是快照数组：task 工具的 def 随磁盘上的 subagent 清单现算
        （用户在设置页加了人，当场生效，不用重开会话），报的账必须跟着变 */
    get toolDefs() {
      // available() 为 false 的工具（挂着但此刻用不出东西，比如清单还空着的
      // task）不进这份表——模型不该被告知一把只会失败的工具，UI 的上下文占用
      // 账也不该替它算钱
      return mounted.filter((t) => t.available?.() ?? true).map((t) => t.def);
    },
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
