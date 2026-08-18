// todo_write — 模型把大任务拆成清单，并随进度改写它。
//
// 唯一一个不碰世界的工具：它的"效果"完全是把整张表写进日志（作为 toolCall 的
// args），供 deriveTodos 投影给 UI。所以 run 只做参数校验 + 回一句确认——
// 落盘由 engine 的既有路径负责，工具依旧只依赖 ExecutionWorld 接口（这里连它都不用）。

import type { Tool } from "./tool.js";
import { TODO_TOOL_NAME, countTodos, parseTodoArgs } from "../session/deriveTodos.js";

export const todoWriteTool: Tool = {
  def: {
    name: TODO_TOOL_NAME,
    description:
      "维护当前任务清单。用于把多步骤的活拆成小任务并跟踪进度：动手前先写下计划，" +
      "开始做某项时把它标为 in_progress，做完立刻标 completed。" +
      "每次调用都要传【整张表】（不是增量），它会整体覆盖上一份。" +
      "同一时刻最多只有一项 in_progress。单步就能做完的活不必用。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "完整的任务清单，按执行顺序排列",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "任务描述，祈使句，简短" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "pending 待处理 / in_progress 进行中 / completed 已完成",
              },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
  requiresApproval: false,

  async run(args) {
    const items = parseTodoArgs(args);
    if (!items) {
      throw new Error(
        "todo_write: 参数必须是 { items: [{ text: string, status: \"pending\"|\"in_progress\"|\"completed\" }] }"
      );
    }
    const c = countTodos(items);
    // 不硬性拦多个 in_progress：模型偶尔并行两项是它的判断，拦下来会让它反复重试。
    // 回一句现状即可——它下次调用自己会收敛
    return `清单已更新：共 ${c.total} 项（进行中 ${c.inProgress} / 待处理 ${c.pending} / 已完成 ${c.completed}）`;
  },
};
