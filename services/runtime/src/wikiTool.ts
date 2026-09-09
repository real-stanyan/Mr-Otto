// wikiTool —— 团队 wiki 的两把刀（#1140，spec §2.1）。与 spec 的一处偏离：`Tool.parallelSafe` 是整把刀的
// 属性，按 action 分不开，所以只读的 read / search 拆成 `wiki_read`（parallelSafe），write / remove / check
// 留在 `wiki`。两把都 requiresApproval:false——它们是记忆写入，不是沙箱里的任意写（同 memory 工具）。
// 只依赖注入的 WikiService（硬规则「工具只依赖接口」在这两把刀上体现为「只依赖 WikiService」）。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { WIKI_OWN_BUDGET, WIKI_PINNED_BUDGET } from "../../../src/shared/wiki.js";
import type { WikiAuthor, WikiService } from "./wikiService.js";

export const WIKI_READ_TOOL_NAME = "wiki_read";
export const WIKI_TOOL_NAME = "wiki";
const MAX_CONSECUTIVE_FAILURES = 3;

function strList(v: unknown): string[] | null {
  if (typeof v === "string") return v.trim() === "" ? [] : [v.trim()];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((x) => (x as string).trim()).filter((x) => x !== "");
  return null;
}

export function createWikiTools(deps: { service: WikiService; agentId: string; agentName: () => string }): [Tool, Tool] {
  const author = (): WikiAuthor => ({ kind: "agent", id: deps.agentId, label: deps.agentName() });

  const readTool: Tool = {
    def: {
      name: WIKI_READ_TOOL_NAME,
      description:
        "读团队 wiki（/work/wiki）。给 paths 读整页（可一次多页，路径如 customers/acme.md、team.md、index.md）；" +
        "给 query 在全部页面里搜关键词（大小写不敏感，回路径:行号: 片段）。涉及客户、口径、分工、历史决定时先看索引再读页。",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "要读的页路径（相对 wiki/）" },
          query: { type: "string", description: "关键词搜索" },
        },
      },
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      const paths = strList(a["paths"]);
      const query = typeof a["query"] === "string" ? a["query"].trim() : "";
      if (query !== "") {
        const hits = await deps.service.search(query);
        if (hits.length === 0) return "没有匹配。换个词，或读 index.md 看有哪些页。";
        return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
      }
      if (paths && paths.length > 0) {
        const pages = await deps.service.read(paths);
        return pages.map((p) => `### ${p.path}\n${p.text === null ? "（没有这页）" : p.text.replace(/\n$/, "")}`).join("\n\n");
      }
      throw new Error("要给 paths 或 query 之一（paths 读页，query 搜索）");
    },
  };

  let consecutiveFailures = 0;
  const writeTool: Tool = {
    def: {
      name: WIKI_TOOL_NAME,
      description:
        "维护团队 wiki。action=write 整页写入（新建或覆盖）：path（一层目录、小写 kebab、.md）、title、summary（一句话，进索引）、" +
        `content（整页正文 markdown，用 [[路径]] 链到相关页）、pinned（每轮都注入，常驻合计 ≤ ${WIKI_PINNED_BUDGET} 字，team.md 恒常驻）、sources（会话 id#seq 或 /work 路径）。` +
        `agents/<你的 id>.md 是你自己的页（≤ ${WIKI_OWN_BUDGET} 字，只有你能写）。action=remove 删一页；action=check 机械体检（断链 / 孤儿 / 过期 / 预算），` +
        "人说「整理 wiki」时先跑它再按 SCHEMA.md 的步骤处理。先用 wiki_read 搜有没有页，有就改那页别另开。index.md / log.md 由工具维护，别写。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["write", "remove", "check"] },
          path: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          content: { type: "string", description: "整页正文（别名 body）" },
          pinned: { type: "boolean" },
          sources: { type: "array", items: { type: "string" } },
        },
        required: ["action"],
      },
    },
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const n = consecutiveFailures;
        consecutiveFailures = 0;
        return `wiki 连续失败 ${n} 次，本轮放弃，不再重试。继续回答；下一轮再整理 wiki。`;
      }
      try {
        const out = await execute(args);
        consecutiveFailures = 0;
        return out;
      } catch (err) {
        consecutiveFailures++;
        throw err;
      }
    },
  };

  async function execute(args: unknown): Promise<string> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (a["action"]) {
      case "write": {
        const path = typeof a["path"] === "string" ? a["path"].trim() : "";
        if (path === "") throw new Error("write 需要 path");
        if (typeof a["title"] !== "string") throw new Error("write 需要 title");
        const body = typeof a["content"] === "string" ? a["content"] : typeof a["body"] === "string" ? a["body"] : undefined;
        if (body === undefined) throw new Error("write 需要 content（整页正文）");
        const sources = strList(a["sources"]);
        const r = await deps.service.write(
          {
            path,
            title: a["title"],
            summary: typeof a["summary"] === "string" ? a["summary"] : "",
            body,
            pinned: a["pinned"] === true,
            // exactOptionalPropertyTypes:true——`sources ?? undefined` 仍会把键写成显式 undefined
            // 传进一个 `sources?: string[]` 的可选属性，tsc 拒绝。条件展开：sources 为 null 时干脆不带这个键。
            ...(sources ? { sources } : {}),
          },
          author(),
        );
        return `已写 ${r.path}（${r.chars} 字）。`;
      }
      case "remove": {
        const path = typeof a["path"] === "string" ? a["path"].trim() : "";
        if (path === "") throw new Error("remove 需要 path");
        await deps.service.remove(path, author());
        return `已删 ${path}。`;
      }
      case "check":
        return deps.service.check(author());
      default:
        throw new Error(`action 只能是 write / remove / check，收到 ${String(a["action"])}`);
    }
  }

  return [readTool, writeTool];
}
