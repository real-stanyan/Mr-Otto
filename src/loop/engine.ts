// LoopEngine — 把环闭上：输入 → 落盘 → 投影 → 模型 → 落盘 → 工具 → 落盘 → 再投影……
// 不变量执行处：每一步先 append 再继续，模型看到的永远是日志的投影。

import type { NewSessionEvent } from "../session/store.js";
import type { EventLog } from "../session/eventLog.js";
import type {
  MemoryLoadedEvent,
  SessionEvent,
  UserAttachmentRef,
  UserMessageEvent,
  UserTextFile,
} from "../session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION, COMPACT_COMPRESSION } from "../session/deriveMessages.js";
import { barrenEventIndexes } from "../session/barrenTurns.js";
import { boundedContextEvents } from "../session/modelContextScan.js";
import { clipHeadTail, redactSensitiveText } from "../shared/redact.js";
import { contextUsed } from "../shared/contextEstimate.js";
import { shouldAutoCompact, type AutoCompactSettings } from "../shared/autoCompact.js";
import {
  detectToolLoop,
  roundFingerprint,
  loopNudgeText,
  HISTORY_LIMIT,
  type ToolLoopDetection,
} from "../shared/toolLoopGuard.js";
import type { DeltaKind, ModelAdapter, ModelReply, ToolDefinition } from "../model/adapter.js";
import { errorClassOf } from "../model/errorClass.js";
import type { ChatMessage } from "../session/deriveMessages.js";
import type { Tool } from "../tools/tool.js";
import { withAbortSignal, withExecOutput, type ExecutionWorld } from "../world/executionWorld.js";
import { runPipeline, hookMatches, guardMatches, hookWithTimeout } from "./middleware.js";
import type { ToolCallContext, ToolGuard, ToolHook, ToolMiddleware, ToolOutcome } from "./middleware.js";
import { createApprovalGate } from "./approvalGate.js";
import type { Approver } from "./approvalGate.js";
import { createReasoningClock } from "./reasoningClock.js";
import { createExecStreamLimiter } from "../shared/execStream.js";

/** AbortError 判定：fetch 中止、signal.reason、throwIfAborted 抛的都是它 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 同 turn 二次自动压缩的增长闸（issue #283 ⑤）：距上次压缩尝试后占用至少
    再涨这么多估算 token 才允许再压。取值凑合在"防原地重压"（摘要仍超阈值时
    占用近乎不动，永远够不着闸）和"超长 turn 别顶着窗口上限跑死"之间 */
export const REAUTO_MIN_GROWTH_TOKENS = 20_000;

/** 长 turn 软告警阈值（issue #283 ⑥）：单 turn 模型步数到这就喊一声。
    不拦不停——无步数上限是 DSH 式的明确决定（失控兜底是停止键，ADR-0006），
    这只是把"还在跑"送到不在屏幕前的用户眼前 */
export const LONG_TURN_ROUNDS = 30;

export interface LoopEngineOptions {
  store: EventLog;
  adapter: ModelAdapter;
  /** 工具表。传函数 = 每个 turn 开始时重算一次（MCP server 中途连上/掉线
      要能被这个会话看见）；传数组 = 也是每 turn 惰性重读**同一个数组引用**
      （#474：不是"一次定终身"——调用方原地 push 会在下个 turn 生效，撞名
      warn 也会从整场一次变成每 turn 一次。生产代码唯一的调用方走函数模式，
      数组模式只有测试在用；别把它当成不可变快照）。

      为什么不是"turn 内彻底冻结"（issue #750）：那条冻结原本是为了保住一个
      不变量——**模型看到过的名字，dispatch 时必须还查得到**。turn 中途整张
      表换掉会破坏它（模型按旧表发的调用在新表里查不到，收到"未知工具"）。
      但"只长不缩"不破坏它：加进来的名字不会让已经发出去的调用失效。
      所以每圈跑一次 refreshToolsKeepingNames()——新连上的 MCP server，
      这一轮就能用；掉线的那台名字仍然留在表里（available() 会把它挡在
      声明表外，真被调到也是一句它自己的错误，而不是"未知工具"）。 */
  tools: Tool[] | (() => Tool[]);
  world: ExecutionWorld;
  sessionId: string;
  /** 每条事件落盘后回调 —— CLI 打印、将来 UI 实时刷新都挂这 */
  onEvent?: (event: SessionEvent) => void;
  /** 流式文本碎片回调（临时 UI 直播，不是事实）。kind 区分思考/正文两条频道。
      半成品永不落盘：日志只收凝固后的完整 assistant_message——
      pi 的"消息完成后不可修改"同款边界 */
  onAssistantDelta?: (text: string, kind: DeltaKind) => void;
  /** 工具输出直播回调（bash 的 stdout/stderr 碎片，临时 UI 直播，不是事实）。
      和 onAssistantDelta 一对儿：碎片不落盘，完整输出以 tool_result 事件落盘 */
  onToolOutput?: (toolCallId: string, chunk: string, stream: "stdout" | "stderr") => void;
  /** requiresApproval 工具的审批人；不给 = 危险操作一律默认拒绝 */
  approver?: Approver;
  /** 额外中间件，插在审批门之后、执行器之前（日志、限流、脱敏都从这进） */
  middlewares?: ToolMiddleware[];
  /** 自动压缩（ADR-0062）：给了就在 loop 每圈模型调用前判定占用。
      不给 = 这个装配没有自动压缩（测试和裸装配照旧，只能手动 /compact） */
  autoCompact?: {
    contextWindow: () => number | undefined; // 当前型号的窗口；换型号后现算
    settings: () => AutoCompactSettings; // 现读（设置页改了当场生效）
  };
  /** 单 turn 模型步数到 LONG_TURN_ROUNDS 时喊一次（每 turn 至多一次）。
      不给 = 不喊（测试和裸装配照旧）。装配层拿它发系统通知 */
  onLongTurn?: (rounds: number) => void;
  /** 认出退化循环时喊一声（issue #891）。每次命中喊一次——历史在喊完后清空，
      所以再喊得再攒够一个完整周期 × 遍数。不给 = 不喊（护栏本身照常注消息） */
  onToolLoop?: (detection: ToolLoopDetection) => void;
  /** Deferred 工具的可见集（issue #348）：活 Set 引用，tool_search 命中时写入，
      这里每轮过滤声明表时读。不给 = deferred 工具永不可见（等同 hidden） */
  deferredExposed?: ReadonlySet<string>;
  /** Pre/PostToolUse 钩子（issue #350）。跑在审批门与执行器之间：拦截/改参/
      拒绝/反馈四种裁决都由 engine 统一落 tool_hook 事件。不给 = 无钩子。
      可给 getter（issue #395 用户钩子）：每次工具调用现取——用户改了
      hooks.json 下一次调用立即生效（与 execPolicy 现读同款热更新语义） */
  hooks?: ToolHook[] | (() => ToolHook[]);
  /** 单调守卫（issue #383）：Pre 钩子之后、执行留痕之前的 deny-only 闸。
      看到的是最终生效参数（过完审批改参与钩子改参）。不给 = 无守卫 */
  guards?: ToolGuard[];
  /** 这台 engine 代表哪只工作区 agent(#928)。给了就随 env() 缝进每条落盘事件。
      不给 = 单 agent 会话,一个字段都不加 —— 本机会话的日志与改动前逐字节相同 */
  agentId?: string;
  /** 退化循环护栏喊到第几次就硬停这一 turn（#957 E-F5）。缺席 = 永不停，
      即 ADR-0212 落地时的行为（注一条话，turn 照跑，无步数天花板 ADR-0006）。
      **`0` 与负数一律按「不封顶」处理，和缺席同义**：`>= 0` 的写法会让第一次
      护栏就抛（`1 >= 0`），而那读起来像「一次都不许喊」——一个配错的 0 会把
      「没有上限」翻译成「最严的上限」，方向正好相反。要「一次都不许」就别装
      护栏，不是把上限调到 0。
      **本机会话不该配**：那条无天花板规则的前提是「人就坐在那儿，停止键随时
      能按」。云会话的群聊 turn 没有那个人 —— 真机上跑过 300 次模型调用、
      99 次护栏、零进展、没有任何终点。命中时抛错，走 runFrom 既有的
      turn_ended{outcome:"error"}，不新造 outcome 也不新造事件类型 */
  loopGuardMaxNudges?: number;
}

export class LoopEngine {
  private toolsByName: Map<string, Tool>;
  /** 去重后的工具表（撞名后到者已被拒）：声明表/过滤都用它，不用 opts.tools。
      每 turn 由 rebuildTools() 重算，turn 内冻结——见 LoopEngineOptions.tools 注释 */
  private tools: Tool[];
  /** 每 turn 重算的来源；传数组时包成常量函数 */
  private readonly toolsProvider: () => Tool[];
  private readonly pipeline: ToolMiddleware[];
  private adapter: ModelAdapter;
  /** 当前 turn 的中断开关；idle 时为 null。每个 turn 一个新的——
      AbortSignal 是一次性的，翻过去就回不来 */
  private turnAbort: AbortController | null = null;
  /** 上次自动压缩尝试后的上下文占用（估算 token）；null = 本 turn 还没压过。
      runTurn 里每 turn 重置。增长闸（issue #283 ⑤）：距上次压缩后占用至少再涨
      REAUTO_MIN_GROWTH_TOKENS 才允许再压——"摘要本身仍超阈值"时原地重压只是
      烧钱（老的一压一次就锁死整 turn），但工具密集的超长 turn 里摘要后又胀
      回去是真实场景，新料够多时第二刀是值得的 */
  private compactFloor: number | null = null;
  /** 正在跑的 turn 的身份 = 开启它的 user_message 的 seq（issue #344 steer）。
      idle / compact 专场时为 null。seq 是日志分配的稳定身份——渲染层从事件流
      里看到的就是它，乐观锁两端说的天然是同一个数 */
  private currentTurnId: number | null = null;
  /** 压缩进行中（auto compact 在 turn 中途触发时为 true）。此时拒绝 steer：
      compact 以它开跑那一刻的日志为准，之后落的 user_message 会被
      context_compacted 的"之前一切被替换"语义静默吞掉——宁可让用户重发 */
  private compacting = false;
  /** 模型调用进行中（issue #871）：这段时间到达的后台结果先攒进
      deferredBackground，assistant_message 落盘后再追加（见 appendBackground） */
  private sampling = false;
  private deferredBackground: Array<{ text: string; taskIds: string[] }> = [];
  /** 上一条已落盘的请求信封的比较键（issue #383）。null = 本进程还没落过，
      首次比较时从日志快照里找最后一条 request_envelope 播种（resume 后不重复落）。
      信封变了才落新的——典型会话整场一两条 */
  private lastEnvelopeKey: string | null = null;
  /** 本 turn 的日志快照（issue #277）：每圈全量 SELECT + JSON.parse + 重投影
      在工具密集的 turn 里是 O(事件数×步数)。快照只在 turn 的第一圈全量读，
      之后每圈用 load({afterSeq}) 补尾段——引擎自己 append 的和带外落的
      （分类/建议/改名等异步外挂）都在尾段里，谁先谁后由 store 的 seq 定序，
      不用在内存里做合并。turn 结束即丢（runTurn 的 finally）：agent 长活，
      一直攥着整段日志是拿常驻内存换查询，不值——turn 内攥着才是纯赚 */
  private turnLog: SessionEvent[] | null = null;
  /** 本 turn 每一圈工具调用的指纹（issue #891）。只在 turn 内活着——
      循环是「这一趟活里出不来」，跨 turn 比对没有意义（用户已经又说了话）。
      喊过一次就清空：护栏不是每圈都念叨的复读机 */
  private loopFingerprints: string[] = [];
  /** 本 turn 护栏喊过几次（#957 E-F5）。作用域同 loopFingerprints —— 一趟活，
      turn 的 finally 清零。跨 turn 累加没有意义：用户（或上一棒）已经又说了话 */
  private loopNudges = 0;

  constructor(private readonly opts: LoopEngineOptions) {
    this.adapter = opts.adapter;
    this.toolsProvider = typeof opts.tools === "function" ? opts.tools : () => opts.tools as Tool[];
    this.toolsByName = new Map();
    this.tools = [];
    this.rebuildTools();
    // 审批门永远是第一层 —— 没人能插队到它前面绕过审批
    this.pipeline = [
      createApprovalGate({
        approver: opts.approver,
        onDecision: (call, outcome) =>
          this.append({
            ...this.env(),
            type: "approval_decision",
            toolCallId: call.id,
            decision: outcome.decision,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
            // 长期许可和改过的参数都是"这一刻发生的新事实",日志推不出来 —— 必须落盘
            ...(outcome.grant ? { grant: outcome.grant } : {}),
            ...(outcome.revisedArgs !== undefined ? { revisedArgs: outcome.revisedArgs } : {}),
            // 云会话群聊（issue #799 系列）："谁批的"同样是日志推不出来的新事实——
            // Approver 实现（云 runtime 的 approvalRouter）负责认定，这里只转告
            ...(outcome.decidedBy ? { decidedBy: outcome.decidedBy } : {}),
          }),
      }),
      ...(opts.middlewares ?? []),
    ];
  }

  /** 换模型 = 换实现。engine 对"有哪些模型"一无所知，只认 ModelAdapter 接口 */
  setAdapter(adapter: ModelAdapter): void {
    this.adapter = adapter;
  }

  /** 重算工具表。撞名保护（issue #349 ⑤）：同名后到者拒绝注册（先到的赢），
      不静默覆盖——内置工具在装配数组里排在 MCP 工具前面，外部工具因此永远
      占不了内置名；Map 构造器的 last-wins 恰好是反的，所以显式跳过。
      每 turn 跑一次，所以撞名警告也每 turn 打一次——这是刻意的：一台 server
      反复挂同名刀，用户该一直看得到，而不是只在会话开头看到一次。 */
  private rebuildTools(): void {
    const byName = new Map<string, Tool>();
    const list: Tool[] = [];
    for (const t of this.toolsProvider()) {
      if (byName.has(t.def.name)) {
        console.warn(`工具「${t.def.name}」已注册，后到的同名工具被拒绝挂载`);
        continue;
      }
      byName.set(t.def.name, t);
      list.push(t);
    }
    this.toolsByName = byName;
    this.tools = list;
  }

  /** turn 内的工具表刷新：**只长不缩**（issue #750）。
      每圈模型调用前跑一次，于是"这一轮刚接上的 MCP server，这一轮就能用"。

      规则一句话：以 provider 现在这份为准，但**旧表里有、新表里没有的名字
      一个都不删**。删掉才会破坏那个不变量（模型看到过的名字必须还查得到）；
      加进来不会。掉线那台的刀就这么留着——`available()` 把它挡在声明表外，
      模型看不到它；万一真被调到，报的是它自己那句错误，而不是"未知工具"。

      不打撞名警告：那句话每 turn 说一次是刻意的（一台 server 反复挂同名刀，
      用户该一直看得到），每圈说一次就成了刷屏。 */
  private refreshToolsKeepingNames(): void {
    const byName = new Map<string, Tool>();
    const list: Tool[] = [];
    for (const t of this.toolsProvider()) {
      if (byName.has(t.def.name)) continue;
      byName.set(t.def.name, t);
      list.push(t);
    }
    // 旧表里独有的名字补回去（顺序排在后面：新表是"现在的样子"，
    // 这些是"这一轮还欠着的收口"）
    for (const t of this.tools) {
      if (byName.has(t.def.name)) continue;
      byName.set(t.def.name, t);
      list.push(t);
    }
    this.toolsByName = byName;
    this.tools = list;
  }

  /** exposure 三态的可见性判定（issue #348）。hidden 不在这里拦调用——
      toolsByName 仍有它，dispatch 照常（"注册了但模型看不到"≠"不存在"） */
  private toolVisible(t: Tool): boolean {
    const exposure = t.exposure ?? "direct";
    if (exposure === "direct") return true;
    if (exposure === "deferred") return this.opts.deferredExposed?.has(t.def.name) ?? false;
    return false; // hidden
  }

  /** 落盘 + 通知，loop 里所有写日志走这一个口 */
  private append(event: NewSessionEvent): SessionEvent {
    const full = this.opts.store.append(event);
    this.opts.onEvent?.(full);
    return full;
  }

  private envBase() {
    return { sessionId: this.opts.sessionId, ts: Date.now() };
  }

  private env() {
    const base = this.envBase();
    // 展开而不是恒定写 agentId: undefined —— 后者过不了 exactOptionalPropertyTypes
    //(tsconfig.json:26):把 undefined 塞进 agentId?: string 的值域是 TS2379,直接编译不过。
    //(JSON.stringify 那边其实无所谓:对象属性值为 undefined 时整个 key 会被丢掉,
    // 不会写成 null —— 实测 {"sessionId":"s1","ts":1}。挡住这种写法的是类型不是序列化)
    return this.opts.agentId ? { ...base, agentId: this.opts.agentId } : base;
  }

  /** 这次投影之后有没有落过新的用户消息（issue #871）。projected = 这圈喂给
      模型的那份快照；之后引擎自己落的 envelope / assistant_message 也在尾段里，
      只认 user_message */
  private unseenUserTail(projected: SessionEvent[]): boolean {
    const lastSeq = projected.at(-1)?.seq ?? -1;
    const fresh = this.opts.store.load(this.opts.sessionId, { afterSeq: lastSeq });
    const me = this.opts.agentId;
    return fresh.some((e) => {
      if (e.type !== "user_message") return false;
      // 群聊里**点了名的话一条都不算"我没答的"**——包括点名我自己的那些
      // （#932 复审）。不变量在 sessionService.say()：每一条带 mentions 的
      // user_message 落盘的同时就已经有一个 turn 归它——要么是它自己排的那个
      // job，要么是去重命中、并到了那只 agent 还排在队里的 job 上（那一轮开跑
      // 时读的是整份日志，这句话在里面）；daemon 中途死掉那种由装配时的重启
      // 补跑（openTurns）接住。所以正在跑的这一轮再为它采样一圈，产出的是**同
      // 一句话的第二个答案**，不是"捡回一条没人管的话"。
      // 早退那一行保持逐字不变：没配 agentId（本机会话）或这条没点名（群里随
      // 口一句、后台任务回注、退化循环护栏那条注入）照旧算没答的——ADR-0205 /
      // ADR-0212 靠的就是它，一个字都不能动
      if (!me || !e.mentions || e.mentions.length === 0) return true;
      return false;
    });
  }

  /** 当前日志快照：第一次全量，之后增量补尾段。首圈持有的是 load() 现造的
      数组（没有第二个持有者），增量圈拼接出新数组——两种情况下已交出去的
      旧快照都不会被原地改动（这里从不 push 已交出的数组） */
  private snapshot(): SessionEvent[] {
    const { store, sessionId } = this.opts;
    if (this.turnLog === null) {
      // 首圈的全量读换成有界重建（issue #351）：checkpoint 之前对模型视野
      // 再无贡献的事件不读。boundedContextEvents 返回 null（无 checkpoint /
      // 逃生舱）时退回全量——保守正确 > 优化；等价性由一致性测试钉住
      this.turnLog = boundedContextEvents(store, sessionId) ?? store.load(sessionId);
    } else {
      const lastSeq = this.turnLog.at(-1)?.seq ?? -1;
      // 增量圈**跳过点了我的名的那些**（#957 A-10 / #934）：turn 跑到一半到的
      // 「@运营」在落盘那一刻就已经有一个 turn 归它（sessionService.say() 的
      // 不变量，ADR-0220），这一轮再把它读进上下文，模型就会在**这**一轮里
      // 顺手答一遍，下一轮那个 job 起跑时再答一遍 —— 同一句话两个答案。
      // 判据是「点了我」不是「有 mentions」：点别人的那条是群里的动静，我看得见。
      // 首圈（上面那支）不过这道滤 —— 开场白本来就点着我，它正是这一轮要答的。
      // 被滤掉的事件**不进 turnLog，于是 lastSeq 不前进到它们**：下一圈会把它
      // 再读出来再滤一次（多一次 JSON.parse，行为正确）；它后面若已有别的事件，
      // lastSeq 就越过去了，那条从此不再出现 —— 两种情形下它都出不了这一轮的
      // 上下文，而这正是唯一要保证的事。`readUpToSeq`（起跑那一刻的日志尾，
      // turnLedger 的收口判据）取自 runFrom 开头的一次 store.load，与这里无关，
      // 语义不受影响
      const me = this.opts.agentId;
      const fresh = store
        .load(sessionId, { afterSeq: lastSeq })
        .filter((e) => !(me && e.type === "user_message" && e.mentions?.includes(me)));
      if (fresh.length > 0) this.turnLog = [...this.turnLog, ...fresh];
    }
    return this.turnLog;
  }

  /** 单次工具调用走完整条管线（审批门→中间件→执行器），返回结果不落盘——
      落盘归调用方（并发组要按原调用序落）。中断后的调用不执行，补"没执行"
      的事实结果——OpenAI 方言要求每个 tool_call 都有答复，缺一个 = 会话投影
      永久 400（ADR-0005 的教训） */
  private async dispatch(
    call: { id: string; name: string; args: unknown },
    world: ExecutionWorld,
    signal: AbortSignal
  ): Promise<ToolOutcome> {
    if (signal.aborted) {
      return {
        status: "error",
        output: "调用未执行：用户中断了 turn。执行器未达，世界未被此调用变更。",
      };
    }
    // 按调用再包一层：输出直播的回调在这绑上 toolCallId——
    // world 到工具手里已经"知道"该把碎片挂到哪次调用，工具自己无感。
    // 限流器（issue #343 第二层，per-call 配额）：单 chunk 上限 + 总条数配额，
    // 保护 IPC 与渲染进程；配额烧完直播静默结束，读取由 world 层继续到 EOF
    const onToolOutput = this.opts.onToolOutput;
    const callWorld = onToolOutput
      ? withExecOutput(
          world,
          createExecStreamLimiter((chunk, stream) => onToolOutput(call.id, chunk, stream))
        )
      : world;
    return runPipeline(this.pipeline, (ctx) => this.execute(ctx), {
      call,
      tool: this.toolsByName.get(call.name),
      world: callWorld,
      sessionId: this.opts.sessionId,
      signal,
    });
  }

  /** 洋葱芯：真正跑 tool.run 的执行器 —— 只有穿过全部中间件才到得了这 */
  private async execute(ctx: ToolCallContext): Promise<ToolOutcome> {
    if (!ctx.tool) {
      return { status: "error", output: `未知工具: ${ctx.call.name}` };
    }
    // PreToolUse 钩子（issue #350）：在留痕/碰世界**之前**——block 的调用
    // 不产生 tool_execution_started（同 denied：执行器未达，世界未变）。
    // 干预本身落 tool_hook 事件（model-visible means logged 的钩子版）
    for (const hook of this.hooksFor(ctx.call.name)) {
      if (!hook.pre) continue;
      // 超时按弃权处理（issue #383，见 HOOK_TIMEOUT_MS）：挂死的钩子不挂死 turn
      const r = await hookWithTimeout(hook.pre(ctx));
      if (!r) continue;
      if (r.block !== undefined) {
        this.append({
          ...this.env(), type: "tool_hook", toolCallId: ctx.call.id,
          hook: hook.name, phase: "pre", action: "block", message: r.block,
        });
        return { status: "error", output: `[PreToolUse 拦截] ${r.block}` };
      }
      if (r.reviseArgs !== undefined) {
        this.append({
          ...this.env(), type: "tool_hook", toolCallId: ctx.call.id,
          hook: hook.name, phase: "pre", action: "revise_args", revisedArgs: r.reviseArgs,
        });
        // 换新对象不原地改（同审批门 revisedArgs 的纪律）；后续钩子看到的是改后的
        ctx.call = { ...ctx.call, args: r.reviseArgs };
      }
    }
    // 单调守卫（issue #383）：钩子表完态之后、留痕碰世界之前的最后一道闸。
    // deny-only——守卫之间没有翻案（后一只无法放行前一只拒掉的）；它看到的
    // ctx.call.args 是最终生效参数（审批改参、钩子改参都已发生），execpolicy
    // 的 forbidden 规则在这复查——堵"批的是原参数、执行的是改后参数"的洞
    for (const guard of (this.opts.guards ?? []).filter((g) => guardMatches(g, ctx.call.name))) {
      const reason = await guard.check(ctx);
      if (reason === undefined) continue;
      this.append({
        ...this.env(), type: "tool_hook", toolCallId: ctx.call.id,
        hook: guard.name, phase: "pre", action: "guard_deny", message: reason,
      });
      return { status: "denied", output: `[守卫拒绝] ${reason}` };
    }
    // 碰世界之前先留痕（ADR-0004）：崩溃后"有 started 无 result" = 悬空执行。
    // 被拒绝的调用到不了这（审批门短路），所以 denied 没有此事件
    this.append({ ...this.env(), type: "tool_execution_started", toolCallId: ctx.call.id });
    let outcome: ToolOutcome;
    try {
      const raw = await ctx.tool.run(ctx.call.args, ctx.world, {
        toolCallId: ctx.call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      // run 可返回字符串（现状）或 { output, concludesTurn, images }（DSH 式提前收口 / 出图）
      outcome =
        typeof raw === "string"
          ? { status: "ok", output: raw }
          : {
              status: "ok",
              output: raw.output,
              ...(raw.concludesTurn ? { concludesTurn: true } : {}),
              // 原始字节到此为止：能不能落盘由 imageIntake 中间件说了算
              ...(raw.images && raw.images.length > 0 ? { images: raw.images } : {}),
            };
    } catch (err) {
      // 中断（AbortError）原样上抛语义不变：外面的收口逻辑靠它。
      // 普通异常照旧折成 error 结果——但 error 也过 Post 钩子？不：钩子管的是
      // "成功结果该不该被接受"，失败已经是失败，注入反馈只会把错误信息搅浑
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
    // PostToolUse 钩子（issue #350）：可拒绝结果 / 注入反馈。只对 ok 结果跑
    for (const hook of this.hooksFor(ctx.call.name)) {
      if (!hook.post) continue;
      // 超时同 Pre：弃权（fail-open）——Post 只影响"结果怎么被接受"，不碰世界
      const r = await hookWithTimeout(hook.post(ctx, outcome));
      if (!r) continue;
      if (r.reject !== undefined) {
        // 原始输出进事件（审计不丢），模型收到的 tool_result 是拒绝后的 error
        this.append({
          ...this.env(), type: "tool_hook", toolCallId: ctx.call.id,
          hook: hook.name, phase: "post", action: "reject",
          message: r.reject, originalOutput: outcome.output,
        });
        return { status: "error", output: `[PostToolUse 拒绝] ${r.reject}` };
      }
      if (r.feedback !== undefined) {
        // 结果原样放行：日志/UI 存原始输出；投影读本事件把反馈包装进模型
        // 看到的 tool 消息（deriveMessages）——两个消费者分离
        this.append({
          ...this.env(), type: "tool_hook", toolCallId: ctx.call.id,
          hook: hook.name, phase: "post", action: "feedback", message: r.feedback,
        });
      }
    }
    return outcome;
  }

  /** 匹配这把工具的钩子（注册序即执行序）。getter 形态现取现算（热更新） */
  private hooksFor(toolName: string): ToolHook[] {
    const hooks = typeof this.opts.hooks === "function" ? this.opts.hooks() : (this.opts.hooks ?? []);
    return hooks.filter((h) => hookMatches(h, toolName));
  }

  /** 请求信封落盘（issue #383）：信封与上一条不同才落。比较键 = 信封内容的
      JSON（不含 seq/ts 这些信封外壳）——同样内容的请求不重复记账 */
  private appendEnvelopeIfChanged(
    log: SessionEvent[],
    messages: ChatMessage[],
    defs: ToolDefinition[]
  ): void {
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    const cfg = this.adapter.requestConfig ?? {};
    const payload = {
      model: this.adapter.model,
      ...(cfg.wireModel !== undefined ? { wireModel: cfg.wireModel } : {}),
      ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
      system,
      tools: defs,
    };
    const key = JSON.stringify(payload);
    if (this.lastEnvelopeKey === null) {
      // 播种：resume/进程重启后先看日志里最后一条信封，相同就不再落。
      // 快照可能是有界重建（#351）截过头部的——找不到就当没有，代价是
      // 多落一条内容相同的信封（审计冗余，无害）
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i]!;
        if (e.type !== "request_envelope") continue;
        const { seq: _s, sessionId: _i, ts: _t, type: _y, ignorable: _g, ...prev } = e;
        this.lastEnvelopeKey = JSON.stringify(prev);
        break;
      }
    }
    if (key === this.lastEnvelopeKey) return;
    this.append({ ...this.env(), type: "request_envelope", ignorable: true, ...payload });
    this.lastEnvelopeKey = key;
  }

  /** /compact：把现有上下文交给模型写摘要，摘要落盘成 context_compacted 事件，
      之后的投影从摘要起步。贵（一次全量输入 + 摘要输出）——manual 是用户主动要，
      auto 是上下文超阈值自动触发（trigger 字段落盘，溯源谁点的火）。
      摘要出自模型（不确定），而模型今后看到的就是它 —— model-visible means logged。 */
  async compact(opts: { trigger: "auto" | "manual"; signal?: AbortSignal } = { trigger: "manual" }): Promise<void> {
    // 压缩是"特殊 turn"，拒绝 steer（issue #344）：compact 以此刻的日志为准，
    // 中途落的 user_message 会被 context_compacted 的替换语义吞掉
    this.compacting = true;
    try {
      await this.compactInner(opts);
    } finally {
      this.compacting = false;
    }
  }

  private async compactInner(opts: { trigger: "auto" | "manual"; signal?: AbortSignal }): Promise<void> {
    const { store, sessionId } = this.opts;
    const log = store.load(sessionId);
    // 摘要专用投影（ADR-0003）：整段历史无保真区，长工具输出/参数都截断——
    // 摘要人要的是"发生了什么"，不是逐字证据；输入 token 是 compact 的主要成本。
    // system 消息脱敏：memory_loaded 无条件拼进 system 尾部（deriveMessages 375 行，
    // ADR-0060），且不经过压缩——这是记忆里的 key 能泄到摘要人手上的另一条路，
    // 和下面新拼的 MEMORY CONTEXT 段是同一个风险、同一次外发，一并处理
    const messages = deriveMessages(log, COMPACT_COMPRESSION).map((m) =>
      m.role === "system" ? { ...m, content: redactSensitiveText(m.content) } : m
    );
    // 压缩前把长期记忆递给摘要人（hermes 的 on_pre_compress 同款）：已经在记忆里的
    // 事实不必再进摘要；脱敏 + 截断——记忆是自由文本，难免混进 key，摘要是另一次外发。
    // 反向查找最新一条（一个 session 通常只有一条，但保险起见找最后一条）
    const mem = [...log].reverse().find((e): e is MemoryLoadedEvent => e.type === "memory_loaded");
    const memText = mem ? [mem.memory, mem.user].filter(Boolean).join("\n§\n") : "";
    const memoryContext = memText
      ? [{
          role: "user" as const,
          content: `MEMORY CONTEXT（已在长期记忆里的事实，摘要里不要重复）:\n${clipHeadTail(redactSensitiveText(memText))}`,
        }]
      : [];
    const reply = await this.adapter.chat(
      [
        ...messages,
        ...memoryContext,
        {
          role: "user",
          content:
            "请把以上对话压缩成一份摘要，供后续对话作为唯一的历史记忆使用。保留：任务目标、" +
            "已完成的动作（含涉及的文件路径与命令）、关键决定及其理由、未完成事项。" +
            (memText ? "MEMORY CONTEXT 里已有的事实不要重复写进摘要。" : "") +
            "直接输出摘要正文，不要开场白。",
          // 不再要求摘要人「逐字保留最后一条 user 消息」（issue #283 ④）：#193 之后
          // 投影层已确定性重注原文（deriveMessages 的当前请求兜底），提示词那半是
          // 双份——摘要人逐不逐字本就不可控，正因为不可控才有 #193，可控的那份赢
        },
      ],
      undefined, // 不带工具：这一步只要文字
      undefined,
      opts.signal // auto 触发时带上 turn 的中断信号——Stop 也要能砍掉正在跑的摘要
    );
    if (!reply.content.trim()) throw new Error("模型没有产出摘要，compact 已放弃（未写入任何事件）");

    this.append({
      ...this.env(),
      type: "context_compacted",
      summary: reply.content,
      model: this.adapter.model,
      trigger: opts.trigger,
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
  }

  /** 中断当前 turn（ADR-0006）。幂等：没 turn 在跑 / 重复按都是无操作。
      效果 = 信号翻转，三个可能卡住的位置各自醒来：
      fetch/SSE 抛 AbortError、审批 resolve 成 denied、bash 子进程收 SIGTERM */
  abortTurn(): void {
    this.turnAbort?.abort();
  }

  /** 正在跑的 turn 的身份（给 UI 做乐观锁的另一端）。idle = null */
  get runningTurnId(): number | null {
    return this.currentTurnId;
  }

  /** 插话（issue #344，codex turn/steer 同款）：不中断，把用户输入注入正在跑的
      turn。先落盘（user_message 事件）——loop 每圈都从日志重新投影，模型下一次
      采样自然看到它并转向，已完成的工具调用全部保留。
      expectedTurnId 乐观锁：提交瞬间 turn 可能刚好结束/换代，id 对不上就拒绝并
      让用户重发——绝不把话注进错的 turn。压缩进行中同样拒绝（见 compacting）。
      投影层保证乱序安全：工具组进行中落的 user_message 会被推迟到组的结果之后
      再进上下文（deriveMessages 的顺序修复），OpenAI 方言的配对约束不被打破 */
  steer(text: string, expectedTurnId: number): void {
    if (this.compacting) {
      throw new Error("正在压缩上下文，暂时不能插话——请稍后重发这句话");
    }
    if (this.currentTurnId === null) {
      throw new Error("turn 已结束，插话没有目标——这句话请作为新消息发送");
    }
    if (this.currentTurnId !== expectedTurnId) {
      throw new Error("turn 对不上号（它可能刚结束、新 turn 又开了）——请确认现场后重发");
    }
    if (!text.trim()) throw new Error("插话内容为空");
    this.append({ ...this.envBase(), type: "user_message", content: text });
  }

  /** 后台任务结果尾部追加（issue #871，Claude Code task-notification 对照）：
      turn 在跑时把完成结果作为 user_message(origin:"background") 追加进日志——
      loop 每圈从日志重新投影，模型下一次采样就看到，同一 turn 里接着干，
      不必等收口再另开一轮。与 steer 同一条路：纯尾部追加，前缀字节不变，
      prefix cache 不受影响（ADR-0088 那条「mid-splice 毁缓存」说的是中段重写，
      不是这个形状）。
      回 false = 此刻不能追加（idle：没有 turn 可接；compacting：压缩以它开跑
      那一刻的日志为准，之后落的会被 context_compacted 静默吞掉），调用方
      自己决定攒着还是另开一轮。不抛错：后台任务的完成不是用户动作，
      没人在等一条错误横幅 */
  appendBackground(text: string, taskIds: string[]): boolean {
    if (this.currentTurnId === null || this.compacting) return false;
    // 模型正在采样：先攒着，等这条 assistant_message 落盘再追加。此刻直接
    // append 的话日志序是 user(后台结果) → assistant(模型正说的话)，投影出来
    // 像模型已经答过这个结果了——它根本没看见。攒到它说完再落，日志序才是
    // 模型真实的视野；loop 随后发现尾上多了一条没答的用户消息会再采样一圈
    if (this.sampling) {
      this.deferredBackground.push({ text, taskIds });
      return true;
    }
    this.appendBackgroundNow(text, taskIds);
    return true;
  }

  private appendBackgroundNow(text: string, taskIds: string[]): void {
    this.append({
      // env() 不是 envBase()（#957 A-5）：后台结果是**注给这一只 agent 看的**
      // 私话，不是人在群里说的。缺了 agentId，agentView 的早退路径会把它原样
      // 放行给同一个会话里的每一只 agent —— 它们读到一条自己从没派过的任务的
      // 完成通知，且长得和人说的话一模一样。本机会话没配 agentId，一个字段都不多
      ...this.env(),
      type: "user_message",
      content: text,
      origin: "background",
      backgroundTaskIds: taskIds,
    });
  }

  /** 采样期间攒下的后台结果落盘。采样正常结束、中断、暴死三条路都要过这里——
      完成事实已经发生，攒着的不能随 turn 一起蒸发 */
  private flushDeferredBackground(): void {
    const pending = this.deferredBackground;
    this.deferredBackground = [];
    for (const d of pending) this.appendBackgroundNow(d.text, d.taskIds);
  }

  /** 跑一个完整 turn：直到模型不再要工具为止。
      收口和暴死都落 turn_ended（ADR-0004）——错误照旧向上抛，落盘是补记事实不是吞错。
      中断（ADR-0006）落 outcome:"aborted" 且不抛：停止是用户意志，不是故障。

      返回这一轮的收口方式（error 走抛的那条路，返回不了）：调用方要按"用户按没按
      停止"决定跑不跑那几条 turn 后外挂，而它早就在这儿知道了——让它回头去日志里
      倒着找最后一条 turn_ended，是把已知的事实再推导一遍（issue #112） */
  async runTurn(
    userInput: string,
    attachments?: UserAttachmentRef[],
    textFiles?: UserTextFile[],
    /** 非人类来源(issue #428):后台任务回注传它,UI 据此换皮。缺席 = 人亲手发的,
        事件形状与从前逐字节一致。
        taskIds = 这条回注驮的后台任务(issue #452 / ADR-0109):后台任务面板据此
        知道结果**真的进了对话**——那比"任务完成了"晚一整个 turn */
    background?: { taskIds: string[] }
  ): Promise<"completed" | "aborted"> {
    const opening = this.append({
      ...this.envBase(),
      type: "user_message",
      content: userInput,
      // 空数组不落字段:无附件的事件形状与从前逐字节一致(投影回归测试的前提)
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(textFiles && textFiles.length > 0 ? { textFiles } : {}),
      ...(background ? { origin: "background" as const, backgroundTaskIds: background.taskIds } : {}),
    });
    return this.runFrom(opening);
  }

  /** 对一条**已经在日志里**的 user_message 起 turn（#932 坑 ②）。云会话的
      发言在 say() 那一刻就落盘（带 fromUid/mentions），turn 可能排队等一会儿
      才轮到——轮到时开场白早就在日志里了，再 append 一条就是同一句话落两遍
      （模型读两遍、时间线画两遍）。runTurn 与它共用 runFrom：turn 的身份、
      收口、finally 清场一个字不差，只有“开场那条谁来落”不同。
      opening 必须带 seq（store.append 的返回值），不是 NewSessionEvent */
  async runLoggedTurn(opening: UserMessageEvent): Promise<"completed" | "aborted"> {
    return this.runFrom(opening);
  }

  private async runFrom(opening: SessionEvent): Promise<"completed" | "aborted"> {
    // turn 的身份 = 开启它的 user_message 的 seq（issue #344 steer 的乐观锁）
    this.currentTurnId = opening.seq;
    this.turnAbort = new AbortController();
    this.compactFloor = null;
    // 这一轮开跑时日志已经到哪儿（#932 终审）。runTurn 走这条时 opening 是刚
    // append 的那条，尾巴是空的 → 就是 opening.seq 自己；runLoggedTurn 走这条时
    // job 在队里等过一会儿，等待期间落的每条都在这个数以内——它们都进得了这一轮
    // 的第一次快照。turnLedger 靠它判「这条点名是不是这轮看见过的」：**没看见过
    // 的不许被这条 turn_ended 收口**（否则 mid-turn 到的那条会永远没人答）。
    // 只在配了 agentId（云会话多智能体）的 engine 上写：本机会话的日志形状
    // 一个字节都不变（engineAgentId.test.ts 的「没配就一个字段都不加」钉着）
    // 先声明再在 try 里读：这一次 store.load 也可能抛（SQLite 锁 / fork 链深度），
    // 抛在 try 外面就是「currentTurnId 置位了、turn_ended 永远不落」——正是下面
    // 那段注释禁止的形状；而 runJob 那侧的 engineStarted 此时已经是 true，
    // 它的补偿也不会来（#932 终审复审）。读不到就退回 opening.seq：只会少收口
    // 不会误收口（重启补跑多跑一轮，不丢消息）
    let readUpToSeq: number | null = null;
    const endEnv = () => (readUpToSeq === null ? this.env() : { ...this.env(), readUpToSeq });
    try {
      if (this.opts.agentId) {
        readUpToSeq = opening.seq;
        readUpToSeq = this.opts.store.load(this.opts.sessionId, { afterSeq: opening.seq }).at(-1)?.seq ?? opening.seq;
      }
      // 工具表这一 turn 的快照。turn 内不再变——见 LoopEngineOptions.tools 注释。
      // 必须在 try 里：provider 是调用方给的任意函数（agent.ts 的 buildTools 里有
      // createMcpTools/applyExposurePolicy），抛错要走下面的 catch 落 turn_ended:
      // outcome:"error"，不能让已经落盘的 user_message 和已置位的 currentTurnId/
      // turnAbort 永远没有对应的收口（append-only 日志的配对不变量、steer 的乐观锁
      // 目标都靠 turn_ended/finally 收场）
      this.rebuildTools();
      await this.loop(this.turnAbort.signal);
      this.append({ ...endEnv(), type: "turn_ended", outcome: "completed" });
      return "completed";
    } catch (err) {
      if (isAbort(err)) {
        this.append({ ...endEnv(), type: "turn_ended", outcome: "aborted" });
        return "aborted";
      }
      // errorClass = 抛错处（adapter）贴的分类（issue #389）；error 存原文不动
      const errorClass = errorClassOf(err);
      this.append({
        ...endEnv(),
        type: "turn_ended",
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
        ...(errorClass ? { errorClass } : {}),
      });
      throw err;
    } finally {
      this.turnAbort = null;
      this.currentTurnId = null; // steer 的目标随 turn 一起消失
      this.turnLog = null; // 快照只活一个 turn：长会话不常驻在内存里
      this.loopFingerprints = []; // 同上：循环判据的作用域是这一趟活
      this.loopNudges = 0; // 同上：喊过几次也只在这一趟活里算数
    }
  }

  /** turn 主循环 —— DSH 式收敛：不数步数，靠数据信号收口。
      两个结束信号：(1) 模型这步没要任何工具（说完了）；(2) 某次工具结果声明
      concludesTurn（提前收口）。失控空转的兜底是用户停止键（abort 信号，
      ADR-0006），不是预设步数天花板。 */
  private async loop(signal: AbortSignal): Promise<void> {
    const { sessionId } = this.opts;
    // 工具拿到的 world 天生带中断信号（装饰器），工具代码对中断无感——
    // 硬规则"工具只依赖 ExecutionWorld"原样成立
    const world = withAbortSignal(this.opts.world, signal);
    // 本 turn 的模型步数（长 turn 软告警用；恰好踩线喊一次，之后不再重复）
    let rounds = 0;

    while (true) {
      signal.throwIfAborted(); // 上一圈工具被杀后从这收口，不再浪费一次投影

      // 每圈只取一次快照（issue #193），且快照是增量维护的（issue #277）：
      // 首圈全量、之后补尾段，占用检查和投影读同一份
      let log = this.snapshot();
      // barren 也只算一次（issue #277）：占用估计和投影是同一把尺子，
      // 传同一个集合进去，不在同一数组上重算两遍
      let barren = barrenEventIndexes(log);

      // 自动压缩（ADR-0062）：每次模型调用前看一眼占用。放在 loop 里而不是 turn 开头——
      // 工具密集的 turn 中途也会胀。同 turn 再压过增长闸（见 compactFloor 注释）
      if (this.opts.autoCompact) {
        const { contextWindow, settings } = this.opts.autoCompact;
        const used = contextUsed(log, barren);
        const grown =
          this.compactFloor === null || used >= this.compactFloor + REAUTO_MIN_GROWTH_TOKENS;
        if (grown && shouldAutoCompact(used, contextWindow(), settings())) {
          try {
            await this.compact({ trigger: "auto", signal });
          } catch (err) {
            // 中断不是"失败"——是用户意志（ADR-0006）。让它原样冒到 runTurn 的
            // catch，落 turn_ended:"aborted"；只有真失败（模型没吐摘要等）才吞
            if (isAbort(err)) throw err;
            console.warn("自动压缩失败，占用再涨一档前不再尝试", err);
          }
          log = this.snapshot(); // compact 落了 context_compacted，尾段补进快照
          barren = barrenEventIndexes(log);
          // 成败都记地板：成 = 压后的新占用（从这起算增长），败 = 当前占用
          // （同一水位不再撞墙，涨够一档再试——失败原因多半还在）
          this.compactFloor = contextUsed(log, barren);
        }
      }

      // 工具表只长不缩地刷一遍（issue #750）：上一圈 mcp_configure 刚接上的
      // server，这一圈模型就能看见它的刀——不用等用户再说一句"好了"
      this.refreshToolsKeepingNames();

      // 永远从日志现算上下文——loop 自己不持有任何对话状态。
      // 带压缩：老 turn 的长工具输出折叠（确定性，重放可还原模型视野）
      const messages = deriveMessages(log, DEFAULT_COMPRESSION, barren);
      rounds++;
      if (rounds === LONG_TURN_ROUNDS) this.opts.onLongTurn?.(rounds);

      // available() 为 false 的工具不进模型看到的声明表——挂着(toolsByName 里还在,
      // 万一模型误调也能给出清楚的错误)不等于此刻用得出东西，报一把只会失败的工具
      // 只会让模型白试一次。
      // exposure（issue #348）同一道滤网：hidden 永不进表；deferred 只有被
      // tool_search 搜到（进了 deferredExposed）才进表；direct/缺席照旧
      const defs = this.tools
        .filter((t) => this.toolVisible(t))
        .filter((t) => t.available?.() ?? true)
        .map((t) => t.def);

      // 给 adapter 一次现算路由的机会（issue #696 fix round 1）：云 runtime 的
      // model 是读 chat() 才会算出来的值，不先 prepare() 一次，这里读到的
      // this.adapter.model 就是上一 turn 的旧值——信封与 assistant_message 对不上。
      // 只在 adapter 真实现了 prepare() 时才 await：`await undefined` 本身也会
      // 让出一个微任务，没实现 prepare() 的 adapter（桌面端、大多数测试假货）
      // 不该白吃这一次让权——engine.test.ts 的中断竞态测试靠的正是：调用
      // runTurn() 后同步调用 abortTurn() 时，chat() 的 Promise executor 已经跑过、
      // 监听器已经挂上；多一次无谓的微任务边界会把 abort 冲到 chat() 调用之前
      if (this.adapter.prepare) {
        await this.adapter.prepare();
      }

      // 请求信封（issue #383）：先落盘再喂模型——信封里是这次请求中日志推不出的
      // 那半（渲染后的 system、工具声明表、model/wireModel/thinking）。与上一条
      // 相同就不落；本进程首次比较时从快照里播种（resume 后不重复落一条一样的）
      this.appendEnvelopeIfChanged(log, messages, defs);

      // 思考耗时只有在碎片流里才测得到:包一层记下频道切换的时刻,原回调原样透传
      const clock = createReasoningClock();
      const onDelta = this.opts.onAssistantDelta;
      this.sampling = true;
      let reply: ModelReply;
      try {
        reply = await this.adapter.chat(
          messages,
          defs,
          onDelta
            ? (text, kind) => {
                clock.observe(kind);
                onDelta(text, kind);
              }
            : undefined, // 非流式路径:测不到就不测,字段缺席
          signal // 中断从这穿进 fetch / SSE 读流
        );
      } catch (err) {
        // 采样没成（中断/暴死）：攒着的后台结果照样落盘——它们是已经发生的事实，
        // 下一个 turn 的模型该看见。落在 turn_ended 之前
        this.sampling = false;
        this.flushDeferredBackground();
        throw err;
      }
      this.sampling = false;
      const reasoningMs = clock.finish();

      this.append({
        ...this.env(),
        type: "assistant_message",
        content: reply.content,
        model: this.adapter.model,
        ...(reply.toolCalls ? { toolCalls: reply.toolCalls } : {}),
        ...(reply.usage ? { usage: reply.usage } : {}), // token 账单随事件落盘，UI 从日志求和
        // 思考过程随消息落盘（模型产出的新信息，丢了回放就永远缺这段）；
        // 投影层会丢弃它——API 禁止思考回流上下文
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        // 耗时只在真有思考内容时才有意义(空思考的耗时是噪音)
        ...(reply.reasoning && reasoningMs !== null ? { reasoningMs } : {}),
        ...(reply.route ? { route: reply.route } : {}), // 钱从谁账上出（ADR-0176 决定五）
        // #857：本次花了多少 credit。是事实不是投影（不记它就只剩从 token 反推，
        // 而托管侧的单价/cache 折扣客户端不知道）；只在 hosted + 非流式有
        ...(reply.creditCostMicro !== undefined ? { creditCostMicro: reply.creditCostMicro } : {}),
      });
      // 采样期间到的后台结果现在落盘：排在模型这句话之后，日志序 = 它的真实视野
      this.flushDeferredBackground();

      if (!reply.toolCalls || reply.toolCalls.length === 0) {
        // 模型说完了——除非它说话的当口有人往日志尾巴上追加了用户消息
        // （后台任务结果 appendBackground / 插话 steer）而这次采样没看到
        // （issue #871）：那条消息在投影之后才落盘，就这么收口的话它会永远
        // 挂在日志尾上没人答，后台结果等于丢了。再采样一圈让模型接上——
        // 代价只在真撞上这个窗口时付，而且每圈都消费掉新消息，不会空转
        if (this.unseenUserTail(log)) continue;
        return;
      }

      // 工具执行（issue #283 ③）：**连续的并发安全调用**（parallelSafe 且免审批）
      // 并发跑；有副作用/要审批的工具是屏障，前后仍严格串行——模型按顺序想事，
      // "先写后跑"的依赖不能被并发打乱。结果按原调用序落盘：投影按 toolCallId
      // 配对不吃顺序，但重放/测试读日志时顺序确定性是白捡的，别丢
      const calls = reply.toolCalls;

      // 退化循环护栏（issue #891）。判据在采样之后、执行之前算，但话要等到
      // 这一圈的 tool_result 全部落盘之后才注 —— assistant(tool_calls) 与它的
      // tool_result 之间插一条 user_message，投影出来就是「有 tool_call 没答复」，
      // OpenAI 方言当场不合法（ADR-0005 的教训）
      this.loopFingerprints.push(roundFingerprint(calls));
      if (this.loopFingerprints.length > HISTORY_LIMIT) {
        this.loopFingerprints.splice(0, this.loopFingerprints.length - HISTORY_LIMIT);
      }
      const loop = detectToolLoop(this.loopFingerprints);

      const isSafe = (c: { name: string }) => {
        const t = this.toolsByName.get(c.name);
        return t?.parallelSafe === true && !t.requiresApproval;
      };
      let idx = 0;
      while (idx < calls.length) {
        let end = idx + 1;
        if (isSafe(calls[idx]!)) {
          while (end < calls.length && isSafe(calls[end]!)) end++;
        }
        const group = calls.slice(idx, end);
        idx = end;
        const outcomes = await Promise.all(group.map((call) => this.dispatch(call, world, signal)));
        let concluded = false;
        for (let g = 0; g < group.length; g++) {
          const outcome = outcomes[g]!;
          this.append({
            ...this.env(),
            type: "tool_result",
            toolCallId: group[g]!.id,
            status: outcome.status,
            output: outcome.output,
            // 有才写:旧日志里没有这个字段,新日志里也只有 write_file 有
            ...(outcome.diffStat ? { diffStat: outcome.diffStat } : {}),
            // 落的是 ref 不是字节(events.ts 的 images 注释)。中间件没装 = 没有
            // imageRefs = 这个键整个不出现,旧日志形状不变
            ...(outcome.imageRefs && outcome.imageRefs.length > 0
              ? { images: [...outcome.imageRefs] }
              : {}),
          });
          // concludesTurn = 数据驱动的提前收口（DSH 同款）：本步到此为止，
          // 不给模型补答的机会，turn 直接 completed。组内已执行的结果都要落
          //（每个 tool_call 必须有答复），组后未执行的靠投影自愈层补文案
          if (outcome.concludesTurn) concluded = true;
        }
        if (concluded) return;
      }
      // 结果已落盘 → 下一圈 deriveMessages 自然带上它们

      // 打转的那句话现在才注（理由见上面 detectToolLoop 那处的注释）。
      // **不停 turn** —— 无步数天花板仍然成立（ADR-0006），这只是把模型自己
      // 看不见的事实摆到它眼前，怎么办由它决定。载体沿用 appendBackground
      // 那条路：一条 user_message，模型投影时和用户说的话逐字节一样
      // （deriveMessages 读都不读 origin），UI 靠 origin 换皮认出不是人打的
      if (loop) {
        this.append({
          // env() 不是 envBase()（#957 A-5）：护栏那句话是说给**打转的这一只**
          // 听的。缺了 agentId，agentView 早退放行，群里每一只 agent 都会读到
          // 「你在原地打转」——没打转的那只收到的是一句没头没脑的指责，而且
          // 它和人说的话在投影里一模一样，分不出来。本机会话（没配 agentId）
          // 的事件形状逐字节不变
          ...this.env(),
          type: "user_message",
          content: loopNudgeText(loop),
          origin: "loop_guard",
        });
        // 清空历史：喊完从头攒，不做每圈复读的护栏。真没听进去的话，
        // 再凑够一个完整周期 × 遍数会再喊一次——语气不变，次数是升级
        this.loopFingerprints = [];
        this.opts.onToolLoop?.(loop);
        // 硬停（#957 E-F5）：喊到第 N 次还在转就抛，走 runFrom 既有的
        // catch → turn_ended{outcome:"error"} 收口。注意顺序 —— **话先落盘再抛**：
        // 停止是结论，那句话是事实，事实不该因为结论而消失（日志里读得到
        // 「喊过 N 次」才解释得了这条 error）。
        // 缺席 = 现状：ADR-0006 的无步数天花板对本机会话原样成立（人就坐在
        // 那儿，停止键随时能按）。云会话没有那个人 —— 真机上一条群聊 turn 跑了
        // 300 次模型调用、喊了 99 次护栏，从头到尾没有任何东西会让它结束
        // cap > 0 而不是 cap !== undefined：0/负数按「不封顶」算（见选项注释）
        const cap = this.opts.loopGuardMaxNudges ?? 0;
        this.loopNudges++;
        if (cap > 0 && this.loopNudges >= cap) {
          throw new Error(
            `退化循环：护栏连续提醒 ${this.loopNudges} 次仍在原地打转，本轮停止`
          );
        }
      }
    }
  }
}
