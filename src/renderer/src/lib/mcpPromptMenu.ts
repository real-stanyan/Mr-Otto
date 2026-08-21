// MCP prompt 进 `/` 菜单——纯逻辑抽出来，组件只管渲染（同 mcpForm.ts 的做法）。
//
// 三件事：
// ① 菜单条目怎么长（id 的唯一性 / 描述里带上是哪台 server 来的——不然两台
//    server 都叫 "summarize" 时，用户分不清选中的是哪一个）。
// ② 参数表单的初值 + 必填校验（required 的参数没填不能提交）。
// ③ 一份表单状态"认不认自己"（mcpPromptFormKey）——展开是一次异步 IPC，
//    submitMcpPromptForm 发出请求之后，用户完全可能已经关掉这张卡、或者
//    选中了下一个 prompt 打开了新的一张。回调落地时得先认一下"我还是不是
//    当下这张卡"，认不出就该原地放弃，不然会把过期请求的结果糊到一张新卡上。

import type { McpPromptInfo } from "../../../shared/mcp.js";

export type McpPromptArg = McpPromptInfo["arguments"][number];

/** `/` 菜单里这条 MCP prompt 的唯一 id。同一个名字可能被两台不同 server
    各挂一份（比如都叫 "summarize"），id 必须把 server 也编进去，
    不能只用 prompt 名字 —— 那样第二台 server 的同名 prompt 会把第一台的
    菜单条目直接顶掉 */
export function mcpPromptCommandId(server: string, name: string): string {
  return `mcp:${server}:${name}`;
}

/** 菜单条目的第二行文案：优先展示 prompt 自己的说明，说明后面永远缀上
    "来自哪台 server"——不加的话，两条同名 prompt 在补全列表里长得一模一样，
    用户没法凭这行字分清选中的到底是哪一个 */
export function mcpPromptCommandDescription(description: string | undefined, server: string): string {
  return description ? `${description} · ${server}` : `来自 ${server} 的 MCP prompt`;
}

/** 参数表单的初值——每个参数一格空字符串。用 prompt 的 arguments 顺序生成，
    表单渲染时按同一份顺序把输入框摆出来 */
export function initialMcpPromptValues(args: readonly McpPromptArg[]): Record<string, string> {
  return Object.fromEntries(args.map((a) => [a.name, ""]));
}

/** 哪些必填参数还没填（去掉首尾空白后为空也算没填——只打了几个空格
    不该被当成"填过了"）。返回参数名列表，空数组 = 可以提交了 */
export function missingRequiredArgs(
  args: readonly McpPromptArg[],
  values: Record<string, string>
): string[] {
  return args.filter((a) => a.required && (values[a.name] ?? "").trim() === "").map((a) => a.name);
}

/** 表单状态的身份指纹：server+name 唯一确定"这是在填哪一个 prompt"。
    null 表单没有身份。submitMcpPromptForm 的异步回调落地时拿它跟出发时
    留的一份快照比对，对不上就说明这张卡已经不是当初发请求的那张了 */
export function mcpPromptFormKey(
  form: { server: string; name: string } | null
): string | null {
  return form ? `${form.server}:${form.name}` : null;
}
