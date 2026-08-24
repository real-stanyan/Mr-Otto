// 工具暴露策略（issue #348，codex mcp_tool_exposure 对照）——纯函数。
//
// 工具数量随 MCP server 增长会撑爆模型工具表。三道闸，全在装配期跑一次：
// ① 单工具 spec 体积预算：超上限降 Hidden（不报错——一把巨物不该拖垮整桌）
// ② 总量预算：按序累加，烧完之后的全部降 Hidden
// ③ 数量阈值：过了就整批转 Deferred（初始工具表不含，tool_search 搜到才可见）
//
// 预算量的是 def 的 JSON 字节数——它就是喂给模型的那份声明，尺子和成本同源。

import type { Tool, ToolExposure } from "./tool.js";

/** codex 同款默认：单工具 8KB / 总量 64KB */
export const DEFAULT_MAX_TOOL_BYTES = 8 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024;
/** 数量阈值：MCP 工具超过这个数就整批 Deferred。取值凑合在"常见单 server
    十来把刀直接可见"和"everything 级 server 别把工具表撑成目录"之间 */
export const DEFAULT_DEFER_THRESHOLD = 12;

export interface ExposurePolicy {
  maxToolBytes?: number;
  maxTotalBytes?: number;
  deferThreshold?: number;
}

function specBytes(tool: Tool): number {
  return Buffer.byteLength(JSON.stringify(tool.def), "utf8");
}

/** 对一批工具套暴露策略，返回带 exposure 的新数组（不改入参）。
    已显式标了 exposure 的工具不动——策略只填空，不覆盖手写决定 */
export function applyExposurePolicy(tools: Tool[], policy: ExposurePolicy = {}): Tool[] {
  const maxTool = policy.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES;
  const maxTotal = policy.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const threshold = policy.deferThreshold ?? DEFAULT_DEFER_THRESHOLD;

  const bulk: ToolExposure = tools.length > threshold ? "deferred" : "direct";
  let budget = maxTotal;
  return tools.map((t) => {
    if (t.exposure !== undefined) return t;
    const bytes = specBytes(t);
    if (bytes > maxTool) return { ...t, exposure: "hidden" as const };
    if (bytes > budget) return { ...t, exposure: "hidden" as const };
    budget -= bytes;
    return { ...t, exposure: bulk };
  });
}
