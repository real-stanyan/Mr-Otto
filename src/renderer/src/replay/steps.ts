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
  };

  switch (e.type) {
    case "session_created": {
      S.badge = "诞生";
      S.desc =
        "会话诞生：选完工程文件夹，main 铸造 sessionId，日志第 0 条落 session_created。" +
        "workspace 记在这条里——围栏、恢复会话、重放全从它重建。";
      S.nodes = ["n-user", "n-bridge", "n-store"];
      S.edges = ["e-user-bridge"];
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
      S.fns = [
        fn("runTurn(userInput)", "loop/engine.ts", "turn 入口", `userInput = "${clip(e.content)}"`),
        ...APPEND(e, `content: "${clip(e.content, 60)}"`),
        fn("onEvent(e)", "回调（UI 经桥刷新）", "收到完整事件（带 seq）"),
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
          "转成 status:'error' 的 tool_result 落盘——模型下一轮看到错误自己调整，turn 不崩。";
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
        S.desc = "放行：穿过审批门到执行器，tool.run 走 ExecutionWorld 真干活。结果落盘。";
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
        "删除 = 追加归档标记。日志 append-only（DB trigger 拒绝 DELETE），所以不能真删：" +
        "列表投影时滤掉带此标记的会话。历史不说谎，误删可救。";
      S.nodes = ["n-bridge", "n-store"];
      S.edges = [];
      S.fns = [
        fn("deleteSession(sessionId)", "main/index.ts", "拒绝删运行中的会话，然后追加标记"),
        ...APPEND(e, "（无 payload——标记本身就是全部信息）"),
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
