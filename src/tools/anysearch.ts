// anysearch — web_search / web_extract 共用的云端 JSON-RPC 客户端。
// anysearch 只是后端插头:换 SearXNG/Tavily 只改这个文件,工具名/参数/日志不动(spec)。
// key 经主进程注入的闭包进来,不进工具参数——参数会落事件日志,key 进去 = 永久泄漏。

import type { ExecutionWorld } from "../world/executionWorld.js";

export const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";

export type GetKey = () => string | undefined;

interface RpcResponse {
  result?: { content?: { type?: string; text?: string }[] };
  error?: { message?: string };
}

export async function callAnysearch(
  world: ExecutionWorld,
  tool: "search" | "extract",
  args: Record<string, unknown>,
  getKey: GetKey
): Promise<string> {
  const key = getKey();
  const headers: Record<string, string> = { "X-Anysearch-Client": "otter/0.1" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const data = (await world.http.postJson(
    ANYSEARCH_ENDPOINT,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    { headers }
  )) as RpcResponse;

  if (data.error) throw new Error(`anysearch 报错: ${data.error.message ?? "未知错误"}`);
  const texts = (data.result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!);
  if (texts.length === 0) throw new Error("anysearch 响应里没有文本内容");
  return texts.join("\n\n");
}
