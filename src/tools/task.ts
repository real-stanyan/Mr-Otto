// task — 把一件子任务派给一个 subagent，等它跑完，把汇报交回模型。
//
// 硬规则：工具只依赖 ExecutionWorld 和注入的接口。而"派活"要造一个新 agent，
// createAgent 住在 src/main/ —— 所以这里只认 SubagentRunner 这个洞，
// 真身在 src/main/subagentRunner.ts，由组装根接线。
// 形状与 createAskUserTool(questioner) / createWebSearchTool(keyGetter) 一模一样。

import type { Tool, ToolRunContext } from "./tool.js";
import type { SubagentDef } from "../shared/subagent.js";

export interface SubagentRunner {
  run(opts: {
    agent: string;
    task: string;
    parentToolCallId: string;
    signal?: AbortSignal;
  }): Promise<{ report: string; childSessionId: string }>;
}

interface TaskArgs {
  agent: string;
  task: string;
}

function parseArgs(raw: unknown): TaskArgs {
  if (typeof raw !== "object" || raw === null) throw new Error("task 参数必须是对象");
  const { agent, task } = raw as Record<string, unknown>;
  if (typeof agent !== "string" || !agent) throw new Error("task 缺少 agent（要派给谁）");
  if (typeof task !== "string" || !task) throw new Error("task 缺少 task（派什么活）");
  return { agent, task };
}

/** 把清单写进工具描述——模型是靠每个 subagent 的 description 挑人的，
    光有 enum 里的名字它没法判断谁合适 */
function describe(defs: readonly SubagentDef[]): string {
  const roster = defs.map((d) => `- ${d.name}：${d.description || "（无描述）"}`).join("\n");
  return (
    "把一件可以独立完成的子任务派给一个 subagent。它在自己的会话里干活，" +
    "干完把结论交回来——过程不占你的上下文。\n" +
    "适合：需要翻很多文件才能回答的调查、可以并行推进的独立小活、" +
    "你不想让中间输出淹没主线的脏活。\n" +
    "task 要写成一段自足的指令：subagent 看不到你和用户的对话，" +
    "它只能看到你写在 task 里的东西。\n\n" +
    `可派的 subagent：\n${roster}`
  );
}

export function createTaskTool(runner: SubagentRunner, list: () => SubagentDef[]): Tool {
  return {
    // getter 而不是常量：清单每次现扫磁盘（同 scanSkills 的不缓存规则），
    // 用户在设置页加了一个人，下一轮模型就该看见他，不用重开会话。
    // TS 里 getter 满足 `def: ToolDefinition`，Tool 接口一个字不用改
    get def() {
      const defs = list();
      return {
        name: "task",
        description: describe(defs),
        parameters: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              enum: defs.map((d) => d.name),
              description: "派给哪个 subagent",
            },
            task: {
              type: "string",
              description: "派下去的任务。写成自足的一段话——subagent 看不到你和用户的对话",
            },
          },
          required: ["agent", "task"],
        },
      };
    },
    // 派活本身不碰世界，不需要审批；危险动作在子 agent 里各自过审批门
    requiresApproval: false,
    async run(raw: unknown, _world, ctx?: ToolRunContext): Promise<string> {
      const { agent, task } = parseArgs(raw);
      const known = list().map((d) => d.name);
      if (!known.includes(agent)) {
        // 抛错 = engine 落 tool_result: error，模型看得见、能改口重派。
        // 把名单一起告诉它，省一轮试探
        throw new Error(
          `没有名叫「${agent}」的 subagent。可派的有：${known.join("、") || "（一个都没有）"}`
        );
      }
      const { report } = await runner.run({
        agent,
        task,
        parentToolCallId: ctx?.toolCallId ?? "",
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
      return report;
    },
  };
}
