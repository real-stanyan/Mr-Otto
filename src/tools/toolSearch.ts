// tool_search（issue #348）—— Deferred 工具的检索口。
//
// codex 同款机制：开了 tool_search 就把（超阈值的）MCP 工具置为 Deferred，
// 模型初始工具表不含它们；模型按需搜，命中的工具进入可见集（exposed），
// 下一轮声明表里就有了。可见集是共享的活 Set——装配层建一个，engine 过滤
// 声明表时读它，这里写它（与 turnDiff 的 getTurnId 闭包同款接线手法）。
//
// 可见性变化可从日志推导：本工具的 tool_result 落盘（列出了哪些工具名），
// 与 available()（server 掉线，运行时状态）同一档先例。

import type { Tool } from "./tool.js";

/** 一把 deferred 工具的检索视图：名字 + 描述（模型选刀要看的全部） */
export interface DeferredToolInfo {
  name: string;
  description: string;
}

const MAX_RESULTS = 10;

export function createToolSearchTool(
  listDeferred: () => DeferredToolInfo[],
  exposed: Set<string>
): Tool {
  return {
    def: {
      name: "tool_search",
      description:
        "检索按需加载的工具（deferred）。部分工具不在初始工具列表里，用关键词搜到后即可直接调用。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "关键词（匹配工具名与描述，空格分隔多个词取并集计分）",
          },
        },
        required: ["query"],
      },
    },
    requiresApproval: false,
    parallelSafe: true,
    // 没有 deferred 工具就别出这把刀：报一把只会返回空的工具是白让模型试
    available: () => listDeferred().length > 0,
    async run(args) {
      const query = (args as { query?: unknown } | null)?.query;
      if (typeof query !== "string" || query.trim() === "") {
        throw new Error("tool_search: 参数 query 必须是非空字符串");
      }
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = listDeferred()
        .map((t) => {
          const hay = `${t.name} ${t.description}`.toLowerCase();
          const score = words.filter((w) => hay.includes(w)).length;
          return { t, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);
      if (scored.length === 0) {
        return `没有匹配「${query}」的工具。`;
      }
      // 命中即曝光：从下一轮起这些工具出现在工具列表里，可直接调用
      for (const { t } of scored) exposed.add(t.name);
      const lines = scored.map(({ t }) => `- ${t.name}：${t.description || "（无描述）"}`);
      return `找到 ${scored.length} 把工具（已加入你的工具列表，可直接调用）：\n${lines.join("\n")}`;
    },
  };
}
