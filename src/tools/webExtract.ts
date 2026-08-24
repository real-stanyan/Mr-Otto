// web_extract — 抓整页正文转 markdown。纯读不落地,不需要审批。

import type { Tool } from "./tool.js";
import { callAnysearch, type GetKey } from "./anysearch.js";

export function createWebExtractTool(getKey: GetKey): Tool {
  return {
    def: {
      name: "web_extract",
      description: "抓取网页完整正文,转成 markdown 返回。搜索结果的摘要不够时用它读全文",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 网址" },
        },
        required: ["url"],
      },
    },
    requiresApproval: false,
    parallelSafe: true, // 只读外呼,无共享状态(issue #283 ③)

    async run(args, world) {
      const { url } = args as { url?: unknown };
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        throw new Error("web_extract: 参数 url 必须是 http(s) 网址");
      }
      return callAnysearch(world, "extract", { url }, getKey);
    },
  };
}
