// proxyNamespace —— 把好友代理来的 MCP 服务并进 B 自己那份（issue #670，ADR-0151）。
//
// B 的会话里有两种 MCP 服务：自己接的，和好友 A 借来的。两边都可能叫 `shopify`，
// 而下游有两处按不同字段认人：
//
//   - **名字**：`createMcpTools` 拿 `server.name` 分配模型可见名，
//     `assignMcpToolNames` 规则 ① 把「同 server 名 + 同 tool 名」当重复项**静默跳过**
//     —— 不是重命名，是丢掉一个，留哪个看列表顺序；
//   - **派发**：那把刀的 `run` 闭包调 `world.mcp.callTool(server.id, ...)`，
//     合并层只收到一个 `"shopify"`，判断不出这一刀该本地跑还是打帧发给 A。
//
// 所以 id 和 name 都得带上「这是谁的」。
//
// **前缀用好友 uid 的短标签，不用昵称**，两条理由：
//   1. 工具名会过 `safe()`（`[^A-Za-z0-9_-]` → `_`，见 mcpToolName）——中文昵称
//      整串变下划线，两个中文名好友还会塌成同一串，正好撞回上面那条静默丢弃；
//   2. 昵称可改，而审批记忆是按**完整工具名**记的（ADR-0041），改一次名字就换一把，
//      「永久允许」静默失效。uid 不会变。
// 好友的人话名字进**工具描述**（模型和审批弹窗都看得见），不进名字。
//
// 纯逻辑零 IO：不碰传输、不碰存储，假 capability 即可测。

import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";
import { mcpToolName, type McpContent, type McpServerConfig } from "../shared/mcp.js";

/** id 前缀。冒号在 server id 里不会出现（mcp.json 的键是人手起的名字），
    而且它已经被 `safe()` 换成下划线——不会污染模型可见名的可读性 */
const ID_PREFIX = "proxy";
/** uid 短标签的长度。8 个十六进制位 = 32 bit，好友数量级下撞不上 */
const TAG_LEN = 8;

/** 一条活着的代理通道：谁的、叫什么、以及那份 McpCapability */
export interface ProxyChannelView {
  friendUid: string;
  /** 好友的人话名字（进描述，不进名字）。空串 = 还没拿到资料，退回短标签 */
  label: string;
  mcp: McpCapability;
}

/** 好友 uid → ASCII 短标签。uid 是 uuid，取前 8 位去掉横线即可 */
export function friendTag(friendUid: string): string {
  const hex = friendUid.replace(/[^A-Za-z0-9]/g, "");
  return hex.slice(0, TAG_LEN) || "unknown";
}

/** 代理服务在 B 这边的 id：`proxy:<tag>:<A 那边的真 id>` */
export function proxyServerId(friendUid: string, realServerId: string): string {
  return `${ID_PREFIX}:${friendTag(friendUid)}:${realServerId}`;
}

/** 反过来：认不出就 null（B 自己的服务走这条，原样交给本地 hub） */
export function parseProxyServerId(id: string): { tag: string; realServerId: string } | null {
  if (!id.startsWith(`${ID_PREFIX}:`)) return null;
  const rest = id.slice(ID_PREFIX.length + 1);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const realServerId = rest.slice(sep + 1);
  if (!realServerId) return null;
  return { tag: rest.slice(0, sep), realServerId };
}

/** 代理服务的展示名 = `<真名>_<短标签>`，如 `shopify_3f2a1b9c`——模型看到的刀
    就是 `mcp__shopify_3f2a1b9c__get_orders`：读得出是哪台服务，也读得出
    「不是我自己那台」。
    **不用 `@`**（issue #792，原来是 `<真名>@<短标签>`）：'@' 过不了 mcpToolName
    的 safe()，名字不 faithful，于是**每把**借来的工具都挂 4 位指纹
    （`…__get_orders_ab3f`）——名字没法预告（share_grant_note 的对应表写不准）、
    也没法肉眼对回去。下划线形态 safe() 原样保留，faithful、零指纹。
    审批记忆按完整工具名记，这次改名会作废旧记录——该功能线上从没通过（#790），
    此刻改零成本，以后就改不动了 */
export function proxyServerName(friendUid: string, realName: string): string {
  return `${realName}_${friendTag(friendUid)}`;
}

/** 工具描述前缀：**这一刀会动别人的账号**，模型和审批弹窗都该一眼看见 */
function describedFor(label: string, friendUid: string, original: string): string {
  const who = label || friendTag(friendUid);
  return `【好友代理·${who}】这次调用在${who}的机器上执行、用${who}的凭证。${original}`;
}

/**
 * 导入连带借来服务的会话包时，焊进模型视野的那段注记（issue #788）。
 *
 * fork 历史里的工具调用记的是分享者机器上的名字（`mcp__square__…`），借来的
 * 同一台在本机叫 `mcp__square_<tag>__…`——不说清对应关系，模型对不上号时会
 * 自作主张在本地 mcp_configure/mcp_authorize，把「凭证不出对方机器」整个绕开。
 * 名字用 mcpToolName 现算（与工具表同一条流水线），不手拼字符串。
 */
export function shareGrantNoteText(
  friendName: string,
  friendUid: string,
  servers: readonly string[]
): string {
  const who = friendName || friendTag(friendUid);
  const lines = servers.map((id) => {
    // 占位工具名 TOOL 纯 ASCII，safe() 原样保留，末尾替换成 * 就是前缀形状
    const shape = mcpToolName(proxyServerName(friendUid, id), "TOOL").replace(/TOOL$/, "*");
    return `- 历史里的 \`mcp__${id}__*\` 在本机对应 \`${shape}\``;
  });
  return [
    `【会话来源】这个会话是好友 ${who} 分享给你的 fork。历史里那些 MCP 工具调用当时跑在 TA 的机器上；`,
    `TA 已把这些服务借给你（好友代理，凭证留在 TA 那边、调用时 TA 得在线）：${servers.join("、")}。`,
    ...lines,
    `继续用这些服务时直接调上面带后缀的工具名；**不要**为它们在本地跑 mcp_configure / mcp_authorize——那会改用你自己的账号，和这段历史操作的不是同一份数据。`,
  ].join("\n");
}

/** 把一条代理通道报出来的服务改写成「B 这边看到的样子」 */
export function viewProxyServers(ch: ProxyChannelView): McpServerHandle[] {
  return ch.mcp.servers().map((s) => ({
    ...s,
    id: proxyServerId(ch.friendUid, s.id),
    name: proxyServerName(ch.friendUid, s.name),
    tools: s.tools.map((t) => ({ ...t, description: describedFor(ch.label, ch.friendUid, t.description) })),
  }));
}

/**
 * 合并：B 自己的 + 当前活着的每一条代理通道。
 *
 * `channels` 是**取函数**不是数组：代理通道随时来去（好友上线/撤销/断线），
 * 而 `buildTools` 每 turn 现算一次工具表（agent.ts 的注释），
 * 传数组等于把「此刻有哪些好友」冻在装配那一刻。
 */
export function mergeProxyMcp(own: McpCapability, channels: () => readonly ProxyChannelView[]): McpCapability {
  /** 按 id 找到该由谁执行。回 null = 这是 B 自己的服务 */
  function route(serverId: string): { ch: ProxyChannelView; realServerId: string } | null {
    const parsed = parseProxyServerId(serverId);
    if (!parsed) return null;
    const ch = channels().find((c) => friendTag(c.friendUid) === parsed.tag);
    // 前缀对但找不到通道 = 那个好友的通道已经断了/被撤销了。
    // **不回落到本地**：回落等于把「调小明的 shopify」悄悄执行成「调我自己的 shopify」
    if (!ch) throw new Error(`好友代理通道已经不在了（${parsed.tag}），这次调用没发出去`);
    return { ch, realServerId: parsed.realServerId };
  }

  return {
    // 代理那边不需要 ready（工具表是 A 推过来的），只等本地 hub
    ready: () => own.ready(),
    servers: () => [...own.servers(), ...channels().flatMap(viewProxyServers)],
    // 下面五个一律写成 async：`route` 会抛（通道没了），而它们的签名回的是 Promise。
    // 不写 async 的话那个异常是**同步**炸出去的，调用方的 `.catch` 接不住
    // —— mcpHub 出于同一个理由把 callTool 写成 async（见那份文件的注释）
    callTool: async (serverId, tool, args, signal): Promise<McpContent[]> => {
      const r = route(serverId);
      return r ? r.ch.mcp.callTool(r.realServerId, tool, args, signal) : own.callTool(serverId, tool, args, signal);
    },
    readResource: async (serverId, uri, signal): Promise<McpContent[]> => {
      const r = route(serverId);
      return r ? r.ch.mcp.readResource(r.realServerId, uri, signal) : own.readResource(serverId, uri, signal);
    },
    getPrompt: async (serverId, name, args) => {
      const r = route(serverId);
      return r ? r.ch.mcp.getPrompt(r.realServerId, name, args) : own.getPrompt(serverId, name, args);
    },
    // 配置/授权落到代理那边会抛「这是分享者那边的事」——那正是该说的话，
    // 别在这层提前拦：拦了就等于本层要自己维护一份同样的措辞
    configure: async (id, cfg, signal) => {
      const r = route(id);
      return r ? r.ch.mcp.configure(r.realServerId, cfg, signal) : own.configure(id, cfg, signal);
    },
    authorize: async (id, signal) => {
      const r = route(id);
      return r ? r.ch.mcp.authorize(r.realServerId, signal) : own.authorize(id, signal);
    },
    configOf: (id): McpServerConfig | undefined => {
      // 同步方法，通道没了不该抛——按「没有本地配置」答，那也是事实
      const parsed = parseProxyServerId(id);
      if (!parsed) return own.configOf(id);
      const ch = channels().find((c) => friendTag(c.friendUid) === parsed.tag);
      return ch?.mcp.configOf(parsed.realServerId);
    },
  };
}
