// SubagentRunner — task 工具那个洞的真身（ADR-0047）。
// 组装根特权：这里可以 import createAgent，工具那边不行。
//
// 递归由构造挡死：建子 agent 时不传 subagentRunner，子 agent 因此没有 task 工具。
// 这比运行时过滤可靠——但"没有哪条代码路径能绕过它"不是免费的：会话可以被
// **重建**（resumeSession），重建那条路必须同样不传 subagentRunner，否则它就是
// 一扇后门。见 index.ts 的 createSessionAgent（子会话分支）。
// AGENTS.md 的 MVP 边界"明确不做多 agent 编排"靠这两处一起成立。

import { createAgent, type AgentPush, type SkillLibrary } from "./agent.js";
import type { ExecRule } from "../shared/execPolicy.js";
import { SESSION_SEARCH_TOOL_NAME } from "../tools/sessionSearch.js";
import { activeSkills } from "../session/activeSkills.js";
import { barrenEventIndexes } from "../session/barrenTurns.js";
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
  /** execpolicy 规则现读器（issue #347，同 alwaysAllow 的活引用规矩）：
      forbidden 对子 agent 同样生效，用户写的"永不放行"不被派活绕过 */
  execPolicy?: () => { rules: ExecRule[] };
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
  /** skill 库接线（同 agent.ts 的 skills 字段，装配根注入）。子 agent 默认也挂
      这把刀——除非 def.skills === "none"："不被行为 skill 污染"的本意里，
      自己去取也该一起关掉，不只是不继承父台账。不给 = 这条装配没有 skill 库
      （测试/裸装配照旧） */
  skills?: SkillLibrary;
}

/** 中断落到父侧的那句话。spec §3「中断传播」：父侧 tool_result 写「子任务被
    用户中断」且 status 是 error——抛出去而不是返回半截汇报，engine 捕获后落的
    就是 error。返回字符串会被记成 ok，模型下一轮读到的是"子任务完成了，这是
    它的汇报"，而事实是这条线断了 */
const ABORTED = "子任务被用户中断";

/** 单会话派活总量硬上限（issue #395，Claude Code spawn cap 对照）。
    递归已由构造挡死（子 agent 没有 task 工具），但"每 turn 派一个"的失控
    循环没有任何闸——长 turn 软告警（LONG_TURN_ROUNDS）喊的是步数，每步
    烧的是一次模型调用，而每次派活烧的是**一整个子会话**，量级不同，值得
    一道自己的硬闸。计数从父日志的 subagent_spawned 推导（投影硬规则：
    不另立计数器），fork 链上祖先派的也算——上限管的是"这条血脉烧了多少"。
    100 = 远高于任何正常用法的兜底值，撞线唯一合理解释是失控 */
export const SUBAGENT_SESSION_CAP = 100;

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

      // 总量硬闸（issue #395）：先数账再花钱。抛错 = engine 落 tool_result:
      // error，模型看得见、能收手改由自己完成——比静默排队诚实
      const spawned = deps.store
        .load(parent.sessionId)
        .filter((e) => e.type === "subagent_spawned").length;
      if (spawned >= SUBAGENT_SESSION_CAP) {
        throw new Error(
          `本会话已派活 ${spawned} 次，达到上限（${SUBAGENT_SESSION_CAP}）——不再派新的子任务。` +
            `剩下的活请自己完成，或让用户新开会话。`
        );
      }

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
          : {
              ...(deps.alwaysAllow ? { alwaysAllow: deps.alwaysAllow } : {}),
              // forbidden 规则跟着常规链走（deny 档整条链已被替换，无处可挂也不需要）
              ...(deps.execPolicy ? { execPolicy: deps.execPolicy } : {}),
            }),
        // skill 工具挂不挂：def.skills === "none" 时连刀一起关掉——不只是不继承
        // 父台账，模型自己现取一份同样算"被行为 skill 污染"，两条路都得堵
        ...(def.skills !== "none" && deps.skills ? { skills: deps.skills } : {}),
        // 刻意不传 subagentRunner —— 子 agent 因此没有 task 工具，递归到此为止
      });

      // 先登记再干别的：从这一刻起 sessionId 就是"活的"，resumeSession 必须
      // 能查到它、走"只切视线"那条路，而不是另建一个 agent（见 register 的注释）
      deps.register?.(child);

      // inherit = 用父此刻那一档（内置那两份走这条）。deny 上面已经换掉整条审批链，
      // 到不了这里
      if (def.approval === "inherit") child.setApprovalMode(parent.approvalMode);
      else if (def.approval === "ask" || def.approval === "auto") child.setApprovalMode(def.approval);
      // 型号跟着定义走；没写 = 跟父此刻那一档（设置页那句「跟随主会话」的兑现，
      // ADR-0108）。曾经这里只有前半句，后半句靠 createAgent 的兜底默认
      // （DEFAULT_MODEL）冒充"跟随"——用户在 Pro 会话里派活，子会话静默用 flash 干，
      // 而三处文档（这行注释、SubagentDef.model 的注释、设置页文案）都写着继承。
      // switchModel 与当前相同时内部 no-op，零多余事件——所以父就是默认档时这行不落事件
      child.switchModel(def.model ?? parent.model);
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
      // 父会话已启用的 skill 随派活下发（ADR-0068）：用户 $ 启用的行为约束覆盖
      // 整个任务，包括派出去的部分——否则「$ponytail 然后 spawn」的子 agent 不受
      // 约束。台账语义与 compact 重注入同一份（activeSkills.ts）。**复制快照**进
      // 子日志而不是引用父日志：子会话必须自包含，重放不跨日志取证（ADR-0007 的
      // 快照理由原样成立）。位置在 briefed 之后、task 之前：先"我是谁"，再说明书，
      // 最后任务。def.skills === "none" = 本 subagent 明确不收
      if (def.skills !== "none") {
        const parentLog = deps.store.load(parent.sessionId);
        for (const [skillName, s] of activeSkills(parentLog, barrenEventIndexes(parentLog))) {
          deps.push.event(
            deps.store.append({
              sessionId: child.sessionId,
              ts: Date.now(),
              type: "skill_invoked",
              name: skillName,
              content: s.content,
              ...(s.args !== undefined ? { args: s.args } : {}),
              // 来源跟着快照走：父会话里模型自取的，子会话里模型也能 release；
              // 用户 $ 启用的，子会话同样动不了（release 的来源校验读这个字段）
              ...(s.source !== undefined ? { source: s.source } : {}),
            })
          );
        }
      }
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
