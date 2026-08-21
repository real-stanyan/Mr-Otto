// SubagentRunner — task 工具那个洞的真身（ADR-0046）。
// 组装根特权：这里可以 import createAgent，工具那边不行。
//
// 递归由构造挡死：建子 agent 时不传 subagentRunner，子 agent 因此没有 task 工具。
// 这比运行时过滤可靠——没有哪条代码路径能绕过它（AGENTS.md 的 MVP 边界
// "明确不做多 agent 编排"由此原样成立）。

import { createAgent, type AgentPush } from "./agent.js";
import { denyingApprover } from "./uiApprover.js";
import type { EventStore } from "../session/store.js";
import type { AttachmentStore } from "../session/attachments.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { SubagentDef } from "../shared/subagent.js";
import type { SubagentRunner } from "../tools/task.js";

/** 拼在用户 instructions 前面的固定前言。
    不指望用户在每个 subagent 文件里都写一遍这段边界——它对所有 subagent 都成立。
    前言也进 subagent_briefed 快照：快照记的是模型看到的全部，不是用户敲进去的部分 */
const PREAMBLE =
  "你是被派来做一件具体任务的子 agent。你的最终一段文本就是返回值——" +
  "它会直接交回给派你来的那个 agent，不是给人看的消息。" +
  "做完就把结论写出来，不要寒暄，不要问「还需要什么帮助吗」。" +
  "你看不到派你来的那个 agent 和用户的对话，任务里没写的背景你就是不知道；" +
  "缺信息时在汇报里说清缺什么，别猜。\n\n";

type Agent = ReturnType<typeof createAgent>;

export interface SubagentRunnerDeps {
  store: EventStore;
  attachments: AttachmentStore;
  push: AgentPush;
  /** 现扫磁盘的清单（同 scanSkills 的不缓存规则） */
  list: () => SubagentDef[];
  /** 派活那一刻的父会话上下文。函数而不是值：派活可能发生在会话开始后很久，
      那时父的模型/world 可能已经变过 */
  parent: () => { sessionId: string; workspace: string; world: ExecutionWorld; model: string };
  getAccessToken?: () => Promise<string | null>;
  alwaysAllow?: () => ReadonlySet<string>;
  /** 测试接缝：真跑 turn 要发 HTTP。生产代码不传它 */
  runTurn?: (agent: Agent, push: AgentPush, task: string) => Promise<void>;
}

export function createSubagentRunner(deps: SubagentRunnerDeps): SubagentRunner {
  const runTurn =
    deps.runTurn ?? ((agent: Agent, _push: AgentPush, task: string) => agent.engine.runTurn(task));

  return {
    async run({ agent: name, task, parentToolCallId, signal }) {
      const def = deps.list().find((d) => d.name === name);
      if (!def) throw new Error(`没有名叫「${name}」的 subagent`);

      const parent = deps.parent();

      // 审批和问卷冒泡到父会话：卡挂到子 sessionId 的话，用户正看着父会话，
      // 看不见卡、子 agent 干等——死锁。审批是"问人"，人就在父会话界面上。
      // 直播碎片不冒泡：那是子会话的直播，父时间线上那张卡自己去订阅
      const childPush: AgentPush = {
        ...deps.push,
        approvalRequest: (_child, call, tool, preview) =>
          deps.push.approvalRequest(parent.sessionId, call, tool, preview),
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
        // deny 换掉整条审批链（mode/授权都不参与）；ask/auto 走常规链，
        // 用户永久授过权的工具在子 agent 里照样免问——授权授的是工具，不是会话
        ...(def.approval === "deny"
          ? { approver: denyingApprover }
          : deps.alwaysAllow
            ? { alwaysAllow: deps.alwaysAllow }
            : {}),
        // 刻意不传 subagentRunner —— 子 agent 因此没有 task 工具，递归到此为止
      });

      if (def.approval === "ask" || def.approval === "auto") child.setApprovalMode(def.approval);
      // 型号跟着定义走；没写就跟父。switchModel 与当前相同时内部 no-op，零多余事件
      if (def.model) child.switchModel(def.model);
      if (def.thinking) child.setThinking(def.thinking);

      // 先落子侧的"我是谁"（模型可见的新信息，先落盘再喂模型），
      // 再落父侧的"派出去了"，最后才开跑
      deps.push.event(
        deps.store.append({
          sessionId: child.sessionId,
          ts: Date.now(),
          type: "subagent_briefed",
          agent: def.name,
          instructions: PREAMBLE + def.instructions,
          tools: child.toolDefs.map((d) => d.name), // 实际挂上的，不是文件里写的
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

      // 父 turn 的停止键往下传：子会话自己没有停止键（ADR-0046 的代价之一）
      const onAbort = () => child.engine.abortTurn();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await runTurn(child, childPush, task);
      } finally {
        signal?.removeEventListener("abort", onAbort);
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
