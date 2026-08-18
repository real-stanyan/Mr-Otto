// 富回放的核心映射：SessionEvent → ReplayStep（画布该亮哪些节点/边 + 函数轨迹）。
// 纯函数、零 DOM——这是 docs/replay-demo.html 里 toStep 的"真日志版"：
// demo 硬编码剧本数据，这里全部从事件本体推导，任何真实会话都能回放。
// 又一次事件日志的投影：聊天区投影"说了什么"，回放投影"系统里发生了什么"。

import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import { resolveModel } from "../../../shared/modelCatalog.js";

/** 函数轨迹一格：n=函数名 f=文件 io=职责 out=传给下一格的数据 skip=本步没执行 */
export interface FnLink {
  n: string;
  f: string;
  io: string;
  out: string | null;
  skip: boolean;
}

export interface ReplayStep {
  ev: SessionEvent;
  title: string;
  badge: string;
  desc: string;
  /** 红色系（拒绝/报错）；false = 绿色系 */
  deny: boolean;
  nodes: string[];
  edges: string[];
  fns: FnLink[];
  /** 链条入口数据：第一个函数吃进去的是什么（触发源）。
      末端输出 = 最后一个 fn 的 out——每条链都必须给最后一格填 out。 */
  input: string;
}

const fn = (n: string, f: string, io: string, out: string | null = null, skip = false): FnLink => ({
  n, f, io, out, skip,
});

/** 长文本截断：数据卡是示意，不是全文阅读器 */
const clip = (s: string, n = 90): string => (s.length > n ? s.slice(0, n) + "…" : s);
const j = (v: unknown, n = 120): string => clip(JSON.stringify(v) ?? "undefined", n);

/** 结尾恒定的落盘二连：所有事件都以 append → EventStore.append 收尾 */
const APPEND = (e: SessionEvent, payloadPreview: string): FnLink[] => [
  fn(
    "append(event)",
    "loop/engine.ts",
    "唯一写口",
    `event = { type: "${e.type}",\n  ${payloadPreview} }\n（注意：还没有 seq）`
  ),
  fn(
    "EventStore.append()",
    "session/store.ts",
    "事务：SELECT MAX(seq)+1 → INSERT",
    `落盘完成，seq = ${e.seq} 已分配\n触发器保证 UPDATE/DELETE 直接 RAISE(ABORT)`
  ),
];

/** toolCallId → 当初模型发的那个 ToolCallRequest（从日志里找，不另存状态） */
function findCall(all: SessionEvent[], toolCallId: string): ToolCallRequest | undefined {
  for (const e of all) {
    if (e.type === "assistant_message" && e.toolCalls) {
      const c = e.toolCalls.find((c) => c.id === toolCallId);
      if (c) return c;
    }
  }
  return undefined;
}

/** 这个 toolCallId 走过审批吗（日志里有没有对应 approval_decision） */
function wasApproved(all: SessionEvent[], toolCallId: string): boolean {
  return all.some((e) => e.type === "approval_decision" && e.toolCallId === toolCallId);
}

const TOOL_INFO: Record<string, { file: string; worldCall: string }> = {
  read_file: { file: "tools/readFile.ts", worldCall: "world.fs.read(path)" },
  write_file: { file: "tools/writeFile.ts", worldCall: "world.fs.write(path, content)" },
  bash: { file: "tools/bash.ts", worldCall: "world.exec(command)" },
};
const toolInfo = (name: string | undefined) =>
  (name ? TOOL_INFO[name] : undefined) ?? { file: "tools/*.ts", worldCall: "world.*" };

export function toStep(e: SessionEvent, _i: number, all: SessionEvent[]): ReplayStep {
  const S: ReplayStep = {
    ev: e,
    title: e.type,
    badge: "",
    desc: "",
    deny: false,
    nodes: [],
    edges: [],
    fns: [],
    input: "",
  };

  switch (e.type) {
    case "session_created": {
      S.badge = "诞生";
      S.desc =
        "会话诞生：选完工程文件夹，main 铸造 sessionId，日志第 0 条落 session_created。" +
        "workspace 记在这条里——围栏、恢复会话、重放全从它重建。";
      S.nodes = ["n-user", "n-bridge", "n-store"];
      S.edges = ["e-user-bridge"];
      S.input = `用户点「＋新会话」\n选中文件夹 "${e.workspace ?? "（旧日志无此字段）"}"`;
      S.fns = [
        fn("startSession()", "main/index.ts", "文件夹选择框 → 建 agent", `workspace = "${e.workspace ?? "（旧日志无此字段）"}"`),
        fn("createAgent(opts)", "main/agent.ts", "组装 store / world / engine，铸造 sessionId", `sessionId = "${e.sessionId}"`),
        ...APPEND(e, `workspace: ${j(e.workspace)}`),
      ];
      break;
    }

    case "user_message": {
      S.badge = "输入";
      S.desc =
        "用户在 React UI 输入，经 ShellBridge（IPC）进 main 的 engine。" +
        "第一件事不是调模型——是 append 落盘（先落盘再喂模型）。";
      S.nodes = ["n-user", "n-bridge", "n-loop", "n-store"];
      S.edges = ["e-user-bridge", "e-bridge-loop", "e-loop-store"];
      S.input = `输入框原文 = "${clip(e.content)}"\n回车 → sendMessage(sessionId, text) 过桥`;
      S.fns = [
        fn("runTurn(userInput)", "loop/engine.ts", "turn 入口", `userInput = "${clip(e.content)}"`),
        ...APPEND(e, `content: "${clip(e.content, 60)}"`),
        fn(
          "onEvent(e)",
          "回调（UI 经桥刷新）",
          "收到完整事件（带 seq）",
          `渲染层 events[] 追加 seq ${e.seq}\n聊天区 / 回放画布同帧更新`
        ),
      ];
      break;
    }

    case "assistant_message": {
      const wantsTools = !!e.toolCalls?.length;
      S.badge = wantsTools ? "要调工具" : "收口";
      S.desc = wantsTools
        ? "日志投影成 messages 喂给模型，模型回复带 toolCalls：要执行工具。回复先落盘，工具后执行。"
        : "上一步结果已在日志里 → 重新投影（load → deriveMessages → chat()），模型看到发生了什么，给出回复，落盘。无 toolCalls = 本 turn 收敛。";
      S.nodes = ["n-store", "n-derive", "n-adapter", "n-loop"];
      S.edges = ["e-store-derive", "e-derive-adapter", "e-adapter-loop", "e-loop-store"];
      S.input = `turn 循环：日志里有 ${e.seq} 条事件（seq 0…${e.seq - 1}）\n上一步的结果已落盘 → 该问模型了`;
      const choice = resolveModel(e.model);
      S.fns = [
        fn("store.load(sessionId)", "session/store.ts", "ORDER BY seq 全量读", `events = ${e.seq} 条（seq 0…${e.seq - 1}）`),
        fn(
          "deriveMessages(events)",
          "session/deriveMessages.ts",
          "纯函数投影",
          "user / assistant / tool_result 投影成 messages\napproval_decision · model_changed · session_* 不投影\nworkspace 化作 system 消息"
        ),
        fn(
          "adapter.chat(messages, tools)",
          "model/openaiCompatible.ts",
          "方言翻译：对象 → JSON 字符串",
          `POST ${choice.baseUrl}/chat/completions\nbody = { model: "${e.model}", messages, tools }`
        ),
        fn(
          "fetch → 解析响应",
          "model/openaiCompatible.ts",
          "方言翻译：JSON 字符串 → 对象",
          wantsTools
            ? `tool_calls = ${j(e.toolCalls, 140)}\nJSON.parse(arguments) → args 恢复成对象`
            : `content = "${clip(e.content)}"\n无 tool_calls → runTurn return`
        ),
        ...APPEND(
          e,
          wantsTools
            ? `model: "${e.model}",\n  toolCalls: ${j(e.toolCalls, 100)}`
            : `content: "${clip(e.content, 60)}",\n  model: "${e.model}"`
        ),
      ];
      break;
    }

    case "approval_decision": {
      S.deny = e.decision === "denied";
      S.badge = S.deny ? "拒绝" : "批准";
      const call = findCall(all, e.toolCallId);
      S.desc =
        `toolCall 进管线，审批门拦下 ${call?.name ?? "工具"}，问 Approver` +
        "（UIApprover 挂起 Promise，审批卡经 ShellBridge 弹到 UI）—— " +
        (S.deny ? "拒绝。" : "批准。") +
        "决定落盘（审计线，模型不消费这条）。";
      S.nodes = ["n-loop", "n-gate", "n-approver", "n-bridge", "n-store"];
      S.edges = ["e-loop-gate", "e-gate-approver", "e-loop-store"];
      S.input = `模型上一步发出的 toolCall：\n${j(call, 140)}`;
      S.fns = [
        fn("runPipeline(pipeline, execute, ctx)", "loop/middleware.ts", "管线入口", `ctx = { call: ${j(call)},\n  tool, world, sessionId }`),
        fn("dispatch(0) → 审批门", "loop/middleware.ts", "洋葱第一层", "ctx.tool.requiresApproval === true\n→ 拦下，不放行"),
        fn(
          "approver.decide(call, tool)",
          "main/uiApprover.ts（实现 «interface» Approver）",
          "挂起 Promise，等 UI 经 IPC 回 resolve",
          `outcome = { decision: "${e.decision}"${e.reason ? `,\n  reason: "${clip(e.reason, 60)}"` : ""} }`
        ),
        fn("onDecision(call, outcome)", "loop/engine.ts", "决定即落盘钩子"),
        ...APPEND(e, `toolCallId: "${e.toolCallId}",\n  decision: "${e.decision}"`),
      ];
      break;
    }

    case "tool_result": {
      const call = findCall(all, e.toolCallId);
      const info = toolInfo(call?.name);
      // 真执行耗时 = 推导值：配对 tool_execution_started 的 ts 相减（审批等待不计）。
      // 旧日志没有该事件 → 不标注。不知道就不说，不编——理解题③的根治在这一行
      const started = all.find(
        (x) => x.type === "tool_execution_started" && x.toolCallId === e.toolCallId
      );
      const dur = started ? `执行耗时 ${e.ts - started.ts} ms（审批等待不计）。` : "";
      S.input = `进入工具管线的 ctx：\ncall = ${j(call, 120)}\n+ tool 定义 + world + sessionId`;
      const gateFn = wasApproved(all, e.toolCallId)
        ? fn("审批门 → next()", "loop/approvalGate.ts", "approved → 放行", "ctx 原样进洋葱下一层")
        : fn("审批门 → next()", "loop/approvalGate.ts", "requiresApproval = false，免审直通", "ctx 原样进洋葱下一层");

      if (e.status === "denied") {
        S.deny = true;
        S.badge = "denied";
        S.desc =
          "短路：审批门直接返回 denied，tool.run 根本没执行（工具层、ExecutionWorld 都没亮）。" +
          "拒绝作为 tool_result 落盘——模型下一轮从这条知道被拒。";
        S.nodes = ["n-gate", "n-store"];
        S.edges = ["e-loop-store"];
        S.fns = [
          fn(
            "审批门 return { status: 'denied' }",
            "loop/approvalGate.ts",
            "短路：不调 next()",
            `outcome = { status: "denied",\n  output: "${clip(e.output)}" }\n下面的函数全跳过 ↓`
          ),
          fn("next() / dispatch(1)", "loop/middleware.ts", "没执行", null, true),
          fn("execute(ctx)", "loop/engine.ts", "没执行", null, true),
          fn(`tool.run(args, world)`, info.file, "没执行", null, true),
          fn(info.worldCall, "world/localWorld.ts", "没执行 —— 世界没被碰", null, true),
          ...APPEND(e, `toolCallId: "${e.toolCallId}",\n  status: "denied"`),
        ];
      } else if (e.status === "error") {
        S.deny = true;
        S.badge = "error";
        S.desc =
          "工具执行报错（参数不合法 / 围栏拦截 / 运行时炸了）。错误被 execute 的 try/catch 接住，" +
          "转成 status:'error' 的 tool_result 落盘——模型下一轮看到错误自己调整，turn 不崩。" +
          dur;
        S.nodes = ["n-gate", "n-tool", "n-store"];
        S.edges = ["e-gate-tool", "e-loop-store"];
        S.fns = [
          gateFn,
          fn("dispatch(1) → 洋葱芯", "loop/middleware.ts", "中间件走完，到执行器", "execute(ctx)，try/catch 兜错"),
          fn("tool.run(args, world)", info.file, "参数校验 + 干活", `args = ${j(call?.args)}\n执行中抛错 ↓`),
          fn(
            "execute 的 catch",
            "loop/engine.ts",
            "异常 → 结果，不外泄",
            `outcome = { status: "error",\n  output: "${clip(e.output)}" }`
          ),
          ...APPEND(e, `toolCallId: "${e.toolCallId}",\n  status: "error"`),
        ];
      } else {
        S.badge = "ok";
        S.desc = "放行：穿过审批门到执行器，tool.run 走 ExecutionWorld 真干活。结果落盘。" + dur;
        S.nodes = ["n-gate", "n-tool", "n-world", "n-store"];
        S.edges = ["e-gate-tool", "e-tool-world", "e-loop-store"];
        S.fns = [
          gateFn,
          fn("dispatch(1) → 洋葱芯", "loop/middleware.ts", "中间件走完，到执行器", "execute(ctx)，try/catch 兜错"),
          fn("tool.run(args, world)", info.file, "参数校验 + 干活", `args = ${j(call?.args)}\n校验通过 → 调 ${info.worldCall}`),
          fn(
            info.worldCall,
            "world/localWorld.ts",
            "唯一碰 node:fs / child_process 的地方",
            `世界已变更\nrun 返回 outcome = { status: "ok",\n  output: "${clip(e.output)}" }`
          ),
          ...APPEND(e, `toolCallId: "${e.toolCallId}",\n  status: "ok"`),
        ];
      }
      break;
    }

    case "model_changed": {
      S.badge = "换模型";
      S.desc =
        "用户在 header 下拉框切模型，经 ShellBridge 进 main。先落 model_changed 再换 adapter——" +
        "落盘失败就不换，日志与现实永不分叉。恢复会话时'当前模型'就从最后一条 model_changed 投影回来。";
      S.nodes = ["n-user", "n-bridge", "n-loop", "n-adapter", "n-store"];
      S.edges = ["e-user-bridge", "e-bridge-loop", "e-loop-store"];
      S.input = `header 下拉框选中 "${e.model}"\nswitchModel(model) 过桥进 main`;
      S.fns = [
        fn("switchModel(modelId)", "main/agent.ts", "同型号 = 无操作；否则先落盘", `目标 = ${e.provider}/${e.model}`),
        ...APPEND(e, `provider: "${e.provider}",\n  model: "${e.model}"`),
        fn("makeAdapter(choice) → engine.setAdapter", "main/agent.ts · loop/engine.ts", "查目录拿 baseUrl / key env，热替换", `adapter 现在指向 ${resolveModel(e.model).baseUrl}`),
      ];
      break;
    }

    case "session_archived": {
      S.badge = "归档";
      S.desc =
        "遗留事件：早期版本'删除' = 追加归档标记 + 列表滤掉。现版本删除改为整会话物理抹除" +
        "（EventStore.purge，ADR-0002），不再产生此事件；旧日志里的它必须永远可重放。";
      S.nodes = ["n-bridge", "n-store"];
      S.edges = [];
      S.input = `侧栏 ✕ + 确认框\ndeleteSession("${e.sessionId}") 过桥`;
      S.fns = [
        fn("deleteSession(sessionId)", "main/index.ts", "旧版：拒绝删运行中的会话，然后追加标记"),
        ...APPEND(e, "（无 payload——标记本身就是全部信息）"),
      ];
      break;
    }

    case "session_renamed": {
      S.badge = "改名";
      S.desc =
        "/rename 的落盘。自动标题（第一条 user_message 首行）推得出所以只是投影；" +
        "手动改名是新信息，推不出，必须成为事件。改两次 = 两条事件，投影取最后一条——" +
        "append-only 日志里'修改'永远长这样：不改旧事实，追加新事实盖过它。模型不消费。";
      S.nodes = ["n-user", "n-bridge", "n-store"];
      S.edges = ["e-user-bridge", "e-bridge-loop", "e-loop-store"];
      S.input = `输入框 "/rename ${clip(e.title, 40)}"\nrenameSession(sessionId, title) 过桥`;
      S.fns = [
        fn("dispatchSlash(text)", "renderer/commands.ts", "首个空白切开：指令名 + 参数", `args = "${clip(e.title, 40)}"`),
        fn("renameSession(sessionId, title)", "main/index.ts", "空白标题拒绝；会话必须存在", "合法，落盘"),
        ...APPEND(e, `title: "${clip(e.title, 60)}"`),
        fn("sessions() 投影", "session/store.ts", "列表标题：最后一条 session_renamed 胜出", `侧栏显示 "${clip(e.title, 40)}"`),
      ];
      break;
    }

    case "tool_execution_started": {
      const call = findCall(all, e.toolCallId);
      const info = toolInfo(call?.name);
      S.badge = "执行开始";
      S.desc =
        "碰世界之前先留痕（ADR-0004）：审批门已过（或免审），洋葱芯即将调 tool.run。" +
        "取证价值：崩溃后日志里\"有 started 无对应 tool_result\" = 悬空执行，" +
        "世界可能已被部分变更，该去检查现场。";
      S.nodes = ["n-loop", "n-tool", "n-store"];
      S.edges = ["e-loop-store"];
      S.input = `即将执行的调用：\n${j(call, 140)}`;
      S.fns = [
        fn("dispatch(1) → 洋葱芯", "loop/middleware.ts", "中间件走完，到执行器", "execute(ctx)"),
        fn("execute(ctx)", "loop/engine.ts", `tool.run 之前先 append——${info.file} 还没跑`, "先留痕，再干活"),
        ...APPEND(e, `toolCallId: "${e.toolCallId}"`),
      ];
      break;
    }

    case "turn_ended": {
      S.deny = e.outcome === "error";
      const aborted = e.outcome === "aborted";
      S.badge = S.deny ? "turn 暴死" : aborted ? "turn 中断" : "turn 落幕";
      S.desc = S.deny
        ? "turn 中途炸了（API 报错 / 工具抛错…）。此前错误只走 IPC reject——" +
          "只存在于一帧屏幕上的\"平行真相\"。现在错误是日志事实，重开 app 还在；" +
          "错误照旧向上抛，落盘是补记事实不是吞错（ADR-0004）。"
        : aborted
          ? "用户按了停止（ADR-0006）：AbortSignal 穿透 fetch/SSE、审批门、bash 子进程三处。" +
            "中断不是错误——不向上抛，UI 不当故障渲染；流到一半的文本作废不落盘" +
            "（日志只收完整消息，pi 边界）。"
          : "turn 生命周期边界落盘。模型调用次数 = 数两条边界间的 assistant_message——" +
            "推得出的不落盘，所以没有 steps 字段（同一原则砍掉了 turn_started）。";
      S.nodes = ["n-loop", "n-store"];
      S.edges = ["e-loop-store"];
      S.input = S.deny
        ? `runTurn 的 catch 接住异常：\n"${clip(e.error ?? "", 100)}"`
        : aborted
          ? "abortTurn() 翻转信号 → 卡住处抛 AbortError → runTurn 的 catch 认出它"
          : "loop() 正常返回（模型不再要工具，或工具声明 concludesTurn）";
      S.fns = [
        fn(
          S.deny || aborted ? "runTurn 的 catch" : "runTurn 的 try 收尾",
          "loop/engine.ts",
          S.deny ? "补记事实 → 重新 throw" : aborted ? "补记事实，不 throw（停止非故障）" : "turn 收敛",
          `outcome = "${e.outcome}"`
        ),
        ...APPEND(e, `outcome: "${e.outcome}"${e.error ? `,\n  error: "${clip(e.error, 60)}"` : ""}`),
      ];
      break;
    }

    case "skill_invoked": {
      S.badge = "注入 skill";
      S.desc =
        "$ 指令：用户为本条消息启用一个 skill，主进程在发送时刻现读 SKILL.md 全文快照进事件——" +
        "模型可见的新信息必须落盘；快照 = 日志自包含，skill 文件之后被改/被删，重放不失真。" +
        "投影成 user 消息（中途插 system 各家方言兼容参差，与 compact 摘要同理）。";
      S.nodes = ["n-user", "n-bridge", "n-store"];
      S.edges = ["e-user-bridge"];
      S.input = `用户输入 "$${e.name} 任务…"\n名字给 harness（注入 skill），正文才是给模型的话`;
      S.fns = [
        fn(
          "sendMessage(sessionId, text, skill)",
          "main/index.ts",
          "现扫磁盘读 SKILL.md 做快照，找不到整条拒发",
          `name = "${e.name}"`
        ),
        fn(
          "EventStore.append()",
          "session/store.ts",
          "事务：SELECT MAX(seq)+1 → INSERT",
          `落盘完成，seq = ${e.seq}\ncontent: "${clip(e.content, 50)}"`
        ),
      ];
      break;
    }

    case "context_compacted": {
      S.badge = "压缩";
      S.desc =
        "/compact：模型把此前全部对话写成一份摘要，摘要落盘成事件，之后的投影从摘要起步。" +
        "摘要出自模型（不确定输出），而模型今后看到的就是它——model-visible means logged，" +
        "所以必须是事件，不能是投影层的临时计算。";
      S.nodes = ["n-user", "n-bridge", "n-loop", "n-store", "n-derive", "n-adapter"];
      S.edges = ["e-user-bridge", "e-bridge-loop", "e-store-derive", "e-derive-adapter", "e-adapter-loop", "e-loop-store"];
      S.input = `用户输入 "/compact"\n渲染层查表分发 → compact(sessionId) 过桥（指令不落 user_message）`;
      S.fns = [
        fn("compact()", "loop/engine.ts", "摘要专用投影（长工具输出/参数截断）交给模型", `deriveMessages(前 ${e.seq} 条事件, COMPACT_COMPRESSION) → messages`),
        fn(
          "adapter.chat(messages)",
          "model/openaiCompatible.ts",
          "真实 API 调用，不带工具——只要文字",
          `摘要 = "${clip(e.summary, 60)}"${e.usage ? `\n耗 ${e.usage.promptTokens + e.usage.completionTokens} tokens` : ""}`
        ),
        ...APPEND(e, `summary: "${clip(e.summary, 50)}",\n  model: "${e.model}"`),
      ];
      break;
    }
  }
  return S;
}

// ─── 数据卡迷你高亮器（demo 的 hl() 改造成返回 token 数组，渲染交给组件） ───

export interface Tok {
  /** hk=key hs=字符串 hd=数字 hv=标识符 hw=关键字 hp=标点 hn=中文注释 ""=素色 */
  cls: string;
  text: string;
}

const TOK =
  /("(?:[^"\\]|\\.)*")|(（[^）]*）?)|(-?\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|([{}[\]():,;=…]|→|←|✕|↓|\/)/g;
const KW = /^(true|false|null|return|await|try|catch|POST|SELECT|INSERT|UPDATE|DELETE|RAISE|ABORT|MAX)$/;

export function hl(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(src))) {
    if (m.index > last) out.push({ cls: "", text: src.slice(last, m.index) });
    const [, str, note, num, ident, punct] = m;
    const keyNext = /^\s*:/.test(src.slice(TOK.lastIndex)); // 后面跟冒号 = key
    if (str !== undefined) out.push({ cls: keyNext ? "hk" : "hs", text: str });
    else if (note !== undefined) out.push({ cls: "hn", text: note });
    else if (num !== undefined) out.push({ cls: "hd", text: num });
    else if (ident !== undefined)
      out.push({ cls: keyNext ? "hk" : KW.test(ident) ? "hw" : "hv", text: ident });
    else out.push({ cls: "hp", text: punct! });
    last = TOK.lastIndex;
  }
  if (last < src.length) out.push({ cls: "", text: src.slice(last) });
  return out;
}
