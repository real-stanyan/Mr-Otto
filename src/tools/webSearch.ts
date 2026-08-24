// web_search — 联网搜索。纯读不落地,不需要审批(与 read_file 同级)。

import type { Tool } from "./tool.js";
import { callAnysearch, type GetKey } from "./anysearch.js";

export function createWebSearchTool(getKey: GetKey): Tool {
  return {
    def: {
      name: "web_search",
      description: "联网搜索。返回适合直接阅读的文本结果(含标题/摘要/链接)",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: { type: "number", description: "结果条数,1-10,默认 5" },
        },
        required: ["query"],
      },
    },
    requiresApproval: false,
    parallelSafe: true, // 只读外呼,无共享状态(issue #283 ③)

    async run(args, world) {
      const { query, max_results } = args as { query?: unknown; max_results?: unknown };
      if (typeof query !== "string" || query.length === 0) {
        throw new Error("web_search: 参数 query 必须是非空字符串");
      }
      const n = max_results === undefined ? 5 : max_results;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error("web_search: max_results 必须是 1-10 的整数");
      }
      return callAnysearch(world, "search", { query, max_results: n }, getKey);
    },
  };
}
