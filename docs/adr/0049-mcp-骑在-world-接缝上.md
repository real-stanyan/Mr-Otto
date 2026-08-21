# ADR-0049：MCP 骑在 ExecutionWorld seam 上

- 日期：2026-08-21
- 状态：已接受
- 相关：ADR-0008（http seam）、ADR-0031（terminal 骑 world seam）、ADR-0035（browser 骑 world seam）、ADR-0048（MCP 进入范围）
- 设计文档：`docs/superpowers/specs/2026-08-21-mcp-design.md`

## 背景

这是同一句话的第四次复述。ADR-0008 让 http 出站走 `world.http`，ADR-0031 让
终端走 `world.openTerminal`，ADR-0035 让内置浏览器走 `world.browser`——每次
理由都一样：硬规则「工具实现只依赖 `ExecutionWorld` 接口，禁止直接 import
fs / child_process」不是装饰性条款，是 v2 Docker 化（每 bot 一个容器）能不能
成立的前提。MCP 的 stdio 传输要 `spawn` 子进程,这条硬规则挡在正前方，
不能绕。

## 决定

MCP 是 `ExecutionWorld` 上的一个可选能力字段：

```ts
// src/world/executionWorld.ts
export interface McpCapability {
  ready(): Promise<void>;
  servers(): readonly McpServerHandle[];
  callTool(serverId, tool, args, signal?): Promise<McpContent[]>;
  readResource(serverId, uri, signal?): Promise<McpContent[]>;
  getPrompt(serverId, name, args): Promise<string>;
}

export interface ExecutionWorld {
  // ...既有字段
  mcp?: McpCapability;
}

export function withMcp(world: ExecutionWorld, mcp: McpCapability): ExecutionWorld {
  return { ...world, mcp };
}
```

`mcp` 是可选字段，理由与 `openTerminal?` / `browser?` 同源：旧实现和测试里的
假 world 零改动，没有这个字段就是"这个世界没有 MCP 能力"，工具据此直接抛错
（`src/tools/mcpTool.ts:28`）。

**注入方向同 browser，不同 terminal**：`LocalWorld` 是纯 Node 模块，造不出
`McpHub`——hub 要管子进程生命周期、要在 `list_changed` 通知到来时向渲染层推
状态，这些是"有一个长期活着的主进程协调者"才干得了的活。于是由
`src/main/index.ts` 用 `withMcp(world, mcp)` 从 `mcpHub` 反向焊进 world，
工具（`src/tools/mcpTool.ts`）自始至终只认 `world.mcp`，不知道 `mcpHub` 的
存在，也不 `import` SDK——这条边界和 `browser?` 那条一样成立,只是这次能力的
建造方是 hub 而不是 world 自己。

## 被否掉的两条路

**闭包注入 client 进工具层。** 把已经连好的 `McpClientConn` 通过闭包直接捕获
进 `Tool.run`，省掉 world 这一层间接。否决理由有两条，都不是风格偏好：

1. stdio 传输要 `spawn` 一个子进程——闭包里握着这个子进程的引用，等于工具层
   直接持有了一个 child_process 句柄，字面违反硬规则，不是"绕了一下"那种
   擦边，是正面撞上。
2. v2 容器化时，MCP server（至少 stdio 那一类）大概率要 spawn 进 bot 自己的
   容器而不是宿主机——到那时"谁能造出这个连接"这件事本身要换一套实现。走
   world seam,这行不用动；走闭包,当初怎么塞进去的,v2 就要在同一处重新塞
   一遍，且没有类型系统帮你找出所有塞点。

**单个通用 `mcp_call` 工具**（形如 `mcp_call(server, tool, args)`，一个工具
应付所有 server 的所有能力）。表面上更省——不用为每个 server 的每个 tool 单独
挂一把刀。否决理由是模型侧的：模型选工具靠的是工具声明表里的 `name` +
`description` + `parameters`（JSON Schema）,这是它唯一能"看见"的信息。塞进
一个通用工具，`parameters` 要么放弃类型约束退化成"随便一个 JSON blob"，
要么把所有 server 的所有 schema 拼成一个巨大 union——两条路都等于让模型盲选：
它看不到某个具体 tool 到底要什么字段、字段是不是必填、取值范围是什么。MCP
生态这半年积累出来的价值,大半正是"server 自己声明了精确的 schema"这件事;
拿掉它,MCP 剩下的就只是一个换了协议外壳的 shell 命令执行器。实际做法是
`createMcpTools`（`src/tools/mcpTool.ts:14`）把每台 server 的每个 tool
单独包成一把 `Tool`，名字加前缀 `mcp__<server>__<tool>` 避免与内置工具撞名，
`description` / `inputSchema` 原样透给模型。

## 装饰器必须逐字段补透传，已有回归测试钉住

`withAbortSignal` / `withExecOutput`（`src/world/executionWorld.ts:134` /
`:164`）是**逐字段枚举重建** world 的，不是 `{ ...world, signal }` 那种
spread——ADR-0031 / 0035 已经踩过这个坑：新增任何一个 world 能力字段，这两个
装饰器都要手工补一行透传，漏了就是静默丢能力（工具调用时 `world.mcp` 变成
`undefined`，报错信息和"这个世界压根没有 MCP"长得一模一样，调试者分不清是
"这个世界没有"还是"这层包丢了"）。

MCP 这次同样漏不得——`callTool` / `readResource` 还要把 `signal` 接进去
（`withAbortSignal` 里 `mcp.callTool` 的实现是 `(id, tool, args) =>
world.mcp!.callTool(id, tool, args, signal)`，中断语义与 exec 对齐，
ADR-0006）。这次没有只靠"记得改"：`tests/world/executionWorld.test.ts` 的
"装饰器透传 mcp" 一节直接断言两个装饰器都保留 `world.mcp`、且
`withAbortSignal` 把 signal 接进了 `callTool` / `readResource`，是一条
回归测试,不是留言提醒——下一次再加新能力字段,这条先例本身也提醒了要照做
（但不能替下一个字段自动补测试,那件事仍然要靠人）。

## 一处实现细节：hub 不 import SDK

`@modelcontextprotocol/sdk` 被锁在 `src/main/mcpClient.ts` 一个文件里
（ADR-0048 的"多一棵依赖树"代价，收在这一处），`src/main/mcpHub.ts` 只认
`connectMcpClient` 返回的 `McpClientConn` 接口形状，完全不 import SDK。
这不是洁癖：`McpHub` 的状态机（四态迁移、`ready()` 的并发去重与超时、
`list_changed` 触发重拉）因此可以用一个假 `connect` 函数在普通 vitest
里测干净（`tests/main/mcpHub.test.ts`），不需要起真进程或接真 SDK 的
内存 transport；真要验证 SDK 集成本身，测试量收在
`tests/main/mcpClient.test.ts` 一处。

## 什么会推翻这个决定

如果 v2 决定 MCP server（包括 stdio 类）一律跑在宿主机、不进 per-bot 容器
——比如判定"MCP server 通常是通用工具（GitHub、文件系统…），不该按 bot
隔离"——那么 `mcp` 骑在 world seam 上带来的"v2 只需实现 `SandboxWorld.mcp`
不用改工具层"这层收益就不存在了：world seam 本来是为了让容器化时这条线不用
重写，如果容器化根本不打算把 MCP 连接放进容器，这道接缝就是纯装饰,不再
为它的复杂度买单。真到那一步，MCP 更合理的位置可能是主进程一个更直接的
全局服务，工具层直接调用而不必经过 `ExecutionWorld`——但那需要一份新的
ADR 明确记录这个转向，不是这份文档能预先授权的。
