// SubagentRunner — task 工具那个洞的真身（ADR-0047）。
// 组装根特权：这里可以 import createAgent，工具那边不行。
//
// 递归由构造挡死：建子 agent 时不传 subagentRunner，子 agent 因此没有 task 工具。
// 这比运行时过滤可靠——但"没有哪条代码路径能绕过它"不是免费的：会话可以被
// **重建**（resumeSession），重建那条路必须同样不传 subagentRunner，否则它就是
// 一扇后门。见 index.ts 的 createSessionAgent（子会话分支）。
// AGENTS.md 的 MVP 边界"明确不做多 agent 编排"靠这两处一起成立。

import { createAgent, type AgentPush } from "./agent.js";
import { SESSION_SEARCH_TOOL_NAME } from "../tools/sessionSearch.js";
import { denyingApprover } from "./uiApprover.js";
import { composeSubagentPrompt, readContextDocs } from "./subagentPrompt.js";
import type { EventStore } from "../session/store.js";
import type { AttachmentStore } from "../session/attachments.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { SubagentDef } from "../shared/subagent.js";
import type { SubagentRunner } from "../tools/task.js";
import type { AutoCompactSettings } from "../shared/autoCompact.js";

type Agent = ReturnType<typeof createAgent>;

export interface SubagentRunnerDeps {
  store: EventStore;
  attachments: AttachmentStore;
  push: AgentPush;
  /** 现扫磁盘的清单（同 scanSkills 的不缓存规则） */
  list: () => SubagentDef[];
  /** 派活那一刻的父会话上下文。函数而不是值：派活可能发生在会话开始后很久，
      那时父的模型/world 可能已经变过 */
  parent: () => {
    sessionId: string;
    workspace: string;
    world: ExecutionWorld;
    model: string;
    /** 父会话此刻的审批档。approval: "inherit" 的定义直接用它——
        "用户有没有打开免审批"是个运行时状态，读一次快照会在长会话里过期 */
    approvalMode: "ask" | "auto";
  };
  getAccessToken?: () => Promise<string | null>;
  alwaysAllow?: () => ReadonlySet<string>;
  /** 自动压缩设置的现读器（同 alwaysAllow 的活引用规矩）。子 agent 也该守同一份
      设置——不给 = 走 createAgent 的全局默认 */
  autoCompactSettings?: () => AutoCompactSettings;
  /** 把刚建好的子 agent 登记进组装根的 agent 注册表（index.ts 的 `agents`）。
      不是可选的锦上添花：不登记的话，resumeSession 的 `agents.has(sessionId)`
      短路失效，用户点一下时间线上那张还在跑的卡就会在同一个活 sessionId 上
      **再建一个 agent**，第二个 agent 的崩溃修复给还在飞的工具调用补一条
      "app 在执行中退出"的假 tool_result，紧接着真结果也落盘——同一个
      toolCallId 两条 tool_result，这个子会话从此每次投影都 400，永久中毒
      （deriveMessages 里记着这条老教训）。测试和裸装配不传它照旧 */
  register?: (agent: Agent) => void;
  /** 测试接缝：真跑 turn 要发 HTTP。生产代码不传它 */
  runTurn?: (agent: Agent, push: AgentPush, task: string) => Promise<void>;
  /** 拼好的 system prompt。以函数注入而不是传一份拼好的字符串：读盘要发生在
      **派活那一刻**（工作区文档改了，下次派活就是新的），而不是接线那一刻。
      测试喂假实现 */
  composePrompt?: (def: SubagentDef, workspace: string) => string;
}

/** 中断落到父侧的那句话。spec §3「中断传播」：父侧 tool_result 写「子任务被
    用户中断」且 status 是 error——抛出去而不是返回半截汇报，engine 捕获后落的
    就是 error。返回字符串会被记成 ok，模型下一轮读到的是"子任务完成了，这是
    它的汇报"，而事实是这条线断了 */
const ABORTED = "子任务被用户中断";

export function createSubagentRunner(deps: SubagentRunnerDeps): SubagentRunner {
  const runTurn =
    deps.runTurn ?? ((agent: Agent, _push: AgentPush, task: string) => agent.engine.runTurn(task));
  const composePrompt =
    deps.composePrompt ??
    ((def: SubagentDef, workspace: string) =>
      composeSubagentPrompt({ def, docs: readContextDocs(workspace, def.context) }));

  return {
    async run({ agent: name, task, parentToolCallId, signal }) {
      const def = deps.list().find((d) => d.name === name);
      if (!def) throw new Error(`没有名叫「${name}」的 subagent`);

      // 进门就已经被中断：下面 addEventListener("abort") 再也不会响，不挡的话
      // 用户按了停止之后子 agent 还会完完整整跑一轮（engine 那道 signal.aborted
      // 检查和这里之间有一条窄缝，abort 正落在缝里就是这个下场）
      if (signal?.aborted) throw new Error(`${ABORTED}：还没派出去就停了，什么都没发生。`);

      const parent = deps.parent();

      // 审批和问卷冒泡到父会话：卡挂到子 sessionId 的话，用户正看着父会话，
      // 看不见卡、子 agent 干等——死锁。审批是"问人"，人就在父会话界面上。
      // 直播碎片不冒泡：那是子会话的直播，父时间线上那张卡自己去订阅
      const childPush: AgentPush = {
        ...deps.push,
        approvalRequest: (_child, call, tool, preview) =>
          deps.push.approvalRequest(parent.sessionId, call, tool, preview, def.name),
        askUserRequest: (_child, toolCallId, questions) =>
          deps.push.askUserRequest(parent.sessionId, toolCallId, questions),
      };

      const child = createAgent({
        store: deps.store,
        workspace: parent.workspace,
        world: parent.world, // 同一个 world 实例，不新造（v2 = 同一个容器）
        push: childPush,
        attachments: deps.attachments,
        allowTools: def.tools,
        spawnedBy: { sessionId: parent.sessionId, toolCallId: parentToolCallId, agent: def.name },
        ...(deps.getAccessToken ? { getAccessToken: deps.getAccessToken } : {}),
        ...(deps.autoCompactSettings ? { autoCompactSettings: deps.autoCompactSettings } : {}),
        // deny 换掉整条审批链（mode/授权都不参与）；ask/auto/inherit 走常规链，
        // 用户永久授过权的工具在子 agent 里照样免问——授权授的是工具，不是会话
        ...(def.approval === "deny"
          ? { approver: denyingApprover }
          : deps.alwaysAllow
            ? { alwaysAllow: deps.alwaysAllow }
            : {}),
        // 刻意不传 subagentRunner —— 子 agent 因此没有 task 工具，递归到此为止
      });

      // 先登记再干别的：从这一刻起 sessionId 就是"活的"，resumeSession 必须
      // 能查到它、走"只切视线"那条路，而不是另建一个 agent（见 register 的注释）
      deps.register?.(child);

      // inherit = 用父此刻那一档（内置那两份走这条）。deny 上面已经换掉整条审批链，
      // 到不了这里
      if (def.approval === "inherit") child.setApprovalMode(parent.approvalMode);
      else if (def.approval === "ask" || def.approval === "auto") child.setApprovalMode(def.approval);
      // 型号跟着定义走；没写就跟父。switchModel 与当前相同时内部 no-op，零多余事件
      if (def.model) child.switchModel(def.model);
      if (def.thinking) child.setThinking(def.thinking);

      // 先落子侧的"我是谁"（模型可见的新信息，先落盘再喂模型），
      // 再落父侧的"派出去了"，最后才开跑。
      // session_search 指引（issue #190）：主会话的用法指引跟着 memory_loaded 走，
      // 子会话没有那条事件——工具真挂上了才补这一句，没挂的装配不该被告知能查历史
      const toolNames = child.toolDefs.map((d) => d.name);
      const searchHint = toolNames.includes(SESSION_SEARCH_TOOL_NAME)
        ? "\n\n过去做过什么、进度到哪、当时怎么决定的——用 session_search 查历史会话。"
        : "";
      deps.push.event(
        deps.store.append({
          sessionId: child.sessionId,
          ts: Date.now(),
          type: "subagent_briefed",
          agent: def.name,
          instructions: composePrompt(def, parent.workspace) + searchHint,
          tools: toolNames, // 实际挂上的，不是文件里写的
          model: child.model,
        })
      );
      deps.push.event(
        deps.store.append({
          sessionId: parent.sessionId,
          ts: Date.now(),
          type: "subagent_spawned",
          toolCallId: parentToolCallId,
          childSessionId: child.sessionId,
          agent: def.name,
          task,
        })
      );

      // 父 turn 的停止键往下传：子会话自己没有停止键（ADR-0047 的代价之一）
      const onAbort = () => child.engine.abortTurn();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await runTurn(child, childPush, task);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }

      // 中断了就别再去捞"汇报"：子会话最后那条 assistant_message 是半截话，
      // 当成 ok 返回等于告诉父模型这件事办完了（spec §3 中断传播）。
      // 中断这个事实在子日志里是 turn_ended: aborted，但父分区推不出来——
      // 而模型看的正是父分区，所以必须在这儿落成父侧的 error
      if (signal?.aborted) {
        throw new Error(`${ABORTED}。子会话 ${child.sessionId} 里留着已经发生的那部分过程。`);
      }

      // 汇报 = 最后一条 assistant_message 的正文（pi 式：最终文本即返回值）
      const last = deps.store
        .load(child.sessionId)
        .filter((e) => e.type === "assistant_message")
        .at(-1);
      const report =
        last?.type === "assistant_message" && last.content.trim()
          ? last.content
          : `subagent「${def.name}」结束了，但没有产出汇报正文。` +
            `子会话 ${child.sessionId} 里有完整过程，可以换个说法重派。`;

      return { report, childSessionId: child.sessionId };
    },
  };
}
