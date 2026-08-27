// MCP 工具 —— 把一台 server 自报的每个 tool 包成本仓的 Tool 形状。
// 只依赖 ExecutionWorld / McpCapability（AGENTS.md 硬规则）：
// 这里不知道背后是 stdio 子进程还是远程 HTTP，也不知道 SDK 长什么样。

import type { Tool, ToolImage } from "./tool.js";
import type { McpContent } from "../shared/mcp.js";
import type { McpCapability } from "../world/executionWorld.js";
import { assignMcpToolNames, renderMcpContent } from "../shared/mcp.js";

/** 装配时把每台**已连上**的 server 的工具全挂上。
    没连上的不出刀 —— 它的工具清单是空的，没有 def 就无从挂起（spec §四第 3 点）。
    挂上之后能不能用由 available() 管：engine 按 available() 过滤声明表喂模型，
    掉线时工具从模型看到的清单消失。工具仍在 toolsByName 里，掉线前发出的调用
    能收到一句人话而不是"未知工具"。

    双 ID 分离（issue #349）：模型可见名由 assignMcpToolNames 整桌统一分配
    （消毒 + 冲突哈希后缀 + 相同原始身份去重）；raw 名（server.id + t.name）
    走闭包进 run 的回调路由——两套 ID 的映射就是这个闭包本身。 */
/** content 里的图片 → 原始字节（#594）。base64 解码放在这层而不是 shared/mcp.ts:
    那一层手机端会 import 同一份源码，而 Buffer 在 RN 上不存在
    （tests/architecture.test.ts 的第 5 条守的就是这条线）。

    解不开的 base64 跳过：坏数据来自外部 server，不该让整次调用失败 —— 模型
    看到的正文里仍然说了"返回了一张图"，少的只是时间线上那张卡 */
function imagesOf(content: readonly McpContent[]): ToolImage[] {
  const out: ToolImage[] = [];
  for (const c of content) {
    if (c.kind !== "image" || c.data === "") continue;
    const data = Buffer.from(c.data, "base64");
    // Buffer.from 对坏 base64 是静默截断而不是抛错，空结果是唯一能查的信号
    if (data.byteLength === 0) continue;
    out.push({ data: new Uint8Array(data), mimeType: c.mimeType });
  }
  return out;
}

export function createMcpTools(mcp: McpCapability): Tool[] {
  const entries = mcp.servers().flatMap((server) => server.tools.map((t) => ({ server, t })));
  const names = assignMcpToolNames(entries.map((e) => ({ server: e.server.name, tool: e.t.name })));
  return entries.flatMap<Tool>(({ server, t }, i) => {
    const name = names[i];
    if (name == null) return []; // 相同原始身份的重复条目：去重跳过
    return [{
      def: {
        name,
        description: t.description,
        parameters: t.inputSchema as object,
      },
      // 全部要审批：server 是外部代码，MCP 协议里的 readOnlyHint 是它自报的，
      // 不采信（同"不采信页面自报 URL"的判断）。授权记忆按完整工具名记，
      // 所以"永久允许读 issue"不会顺带允许"建 PR"（ADR-0041）
      requiresApproval: true,
      available: () => mcp.servers().some((s) => s.id === server.id && s.live),
      async run(args, world, ctx) {
        if (!world.mcp) throw new Error("这个装配没有 MCP 能力，工具用不了");
        if (!world.mcp.servers().some((s) => s.id === server.id && s.live)) {
          throw new Error(`MCP server「${server.name}」当前没连上，这次调用没发出去`);
        }
        // 回调用 raw 名（server.id + 协议原名），不是模型可见名——收口有损，反推不回去
        const content = await world.mcp.callTool(server.id, t.name, args, ctx?.signal);
        const images = imagesOf(content);
        // 有图才走对象形态:没图时返回字符串,与从前逐字节一致
        return images.length === 0
          ? renderMcpContent(content)
          : { output: renderMcpContent(content), images };
      },
    }];
  });
}
