// MCP prompt 进 `/` 菜单——纯逻辑抽出来，组件只管渲染（同 mcpForm.ts 的做法）。
//
// 四件事：
// ① 菜单条目怎么长（id 的唯一性 / 描述里带上是哪台 server 来的——不然两台
//    server 都叫 "summarize" 时，用户分不清选中的是哪一个）。
// ② 参数表单的初值 + 必填校验（required 的参数没填不能提交）。
// ③ 一份表单状态长什么样（mcpPromptFormKey）——纯粹是"server+name 拼成一个
//    字符串"，给 React 当 remount key 用（同一个 prompt 重开不该重新播一遍
//    进场动效，换一个 prompt 才该）。**不**用来判断异步响应是否过期——
//    见④，同一个 prompt 被取消又重开，key 不变，但那已经是两次不同的提交了。
// ④ 一次提交的回调落地时,这个结果还算不算数(isCurrentMcpPromptSubmission)——
//    展开是一次异步 IPC,submitMcpPromptForm 发出请求之后,用户完全可能已经
//    取消又重开了**同一个** prompt(server+name 不变,③的 key 骗不过这一关)、
//    换了下一个 prompt、或者切换了会话。落地前拿"发出去时留的号+会话 id"
//    跟"此刻的号+会话 id"比,两个都对得上才算数,认不出就该原地放弃,
//    不然会把过期请求的结果糊到一张新卡上,或者糊进了另一个会话的输入框。

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

/** 表单这一刻在填哪个 prompt，纯粹是给 React 当 remount key 用的字符串——
    同一个 prompt 被取消又重开，key 不变（不该重新播一遍进场动效）；
    换了不同 prompt，key 跟着变（该重新播）。**不回答"这份异步响应还新不
    新鲜"**——那个问题的答案在 isCurrentMcpPromptSubmission 里，两者故意
    分开：同一个 prompt 重开前后，这个 key 完全相同，但对提交请求来说
    已经是两次不同的、互不相干的提交了（review finding 1） */
export function mcpPromptFormKey(
  form: { server: string; name: string } | null
): string | null {
  return form ? `${form.server}:${form.name}` : null;
}

/** 一次 MCP prompt 提交的回调落地时，判它还算不算数：出发时留的号
    （token）和会话 id，都得跟此刻的对得上——
    - token 不对：这份表单在请求飞在半空的时候被取消/重开过（哪怕重开的
      是同一个 prompt，见 mcpPromptFormKey 的注释）、或者用户又提交了一次。
    - session 不对：请求飞在半空的时候用户切换了会话——展开的目标输入框
      已经不是发起这次请求时那一个了。
    两个条件是 AND，不是 OR：只要有一个过期，这份响应就不该再生效
    （review finding 1 + finding 2）*/
export function isCurrentMcpPromptSubmission(
  current: { token: number; sessionId: string },
  expected: { token: number; sessionId: string }
): boolean {
  return current.token === expected.token && current.sessionId === expected.sessionId;
}
