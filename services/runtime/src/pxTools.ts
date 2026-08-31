// pxTools —— 好友代理云端执行面接进云 runtime 的工具桥（ADR-0199，issue #799 系列）。
// 把 edge 的 grantedView 变成 engine 认识的 Tool 列表：每条借来的刀过一次
// safe 化改名（同 proxyNamespace 口径：uid 短前缀不昵称，不取昵称——昵称过不了
// safe() 又会变），requiresApproval:false——白名单内没有逐次审批（ADR-0151 口径），
// 云端三道闸（身份/关系/白名单，px.ts 的 pxGate）才是真正的关卡。
//
// grants 按 host 逐个查（T3 定稿，覆盖 brief 写作时"一次性整份"的假定）：
// GET {edgeBase}/px/v1/grants?host=<hostUid>&fromUid=<uid>。单 host 失败（网络/
// HTTP 错/形状不对）只跳过该 host、记 warn，不炸掉整批查询——一个好友掉线
// 不该让其余好友的授权也拿不到。不做客户端 workspaceId 过滤：edge 的三道闸
// 才是权威，这里只管把它给的那份转成工具。

import type { Tool } from "../../../src/tools/tool.js";

export interface PxCallDeps {
  /** edge 服务根，不带尾斜杠（如 https://edge.mrotto.agency） */
  edgeBase: string;
  /** 平台身份（VPS 云 runtime）的共享密钥，对应 worker.ts 的 RUNTIME_SECRET */
  runtimeSecret: string;
  fetchImpl?: typeof fetch;
}

export interface GrantedPxTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** fetchGrantedTools 的一条产物：某个 host 授权借出的一台服务 */
export interface GrantedPxServer {
  hostUid: string;
  serverId: string;
  toolDefs: GrantedPxTool[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** edge 错误信封的人话：`{error:"..."}` 与 `{error:{message:"..."}}` 都认
    （worker 侧两种写法都见过，pxCloudClient.ts 同款兼容） */
function errMessage(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  const e = payload.error;
  if (typeof e === "string") return e;
  if (isObj(e) && typeof e.message === "string") return e.message;
  return null;
}

/** 按 host 逐个查 GET /px/v1/grants，合并成扁平列表。
    单 host 查询失败（网络/HTTP 错/响应形状不对）跳过该 host，不抛错——
    调用方（sessionService）拿到的是"能查到的那些"，不是"全有或全无" */
export async function fetchGrantedTools(
  deps: PxCallDeps,
  fromUid: string,
  hostUids: readonly string[]
): Promise<GrantedPxServer[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: GrantedPxServer[] = [];
  for (const hostUid of hostUids) {
    try {
      const url = `${deps.edgeBase}/px/v1/grants?host=${encodeURIComponent(hostUid)}&fromUid=${encodeURIComponent(fromUid)}`;
      const res = await fetchImpl(url, { headers: { "x-runtime-secret": deps.runtimeSecret } });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn(`px grants 查询失败（host=${hostUid}，HTTP ${res.status}）：${errMessage(payload) ?? "?"}，跳过该 host`);
        continue;
      }
      if (!isObj(payload) || !Array.isArray(payload.servers)) continue;
      for (const s of payload.servers) {
        if (!isObj(s) || typeof s.serverId !== "string" || !Array.isArray(s.toolDefs)) continue;
        out.push({ hostUid, serverId: s.serverId, toolDefs: s.toolDefs as GrantedPxTool[] });
      }
    } catch (err) {
      console.warn(`px grants 查询失败（host=${hostUid}）：${err instanceof Error ? err.message : String(err)}，跳过该 host`);
    }
  }
  return out;
}

/** 模型工具名只认 [a-zA-Z0-9_-]；其余字符（空格、点……）一律换成下划线 */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 调用结果的 content 数组压成一段文本喂模型：text 项拼正文，其余项整体
    JSON.stringify——px 调用的结果只喂模型，不进时间线卡片，不需要完整
    McpContent 形状（那是桌面 pxCloudClient.ts 走 toMcpContent 的理由） */
function squashContent(content: unknown): string {
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return "";
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return content
    .map((item) =>
      isObj(item) && item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)
    )
    .join("\n");
}

/** fetchGrantedTools 的产物 → engine 能挂的 Tool[]。
    requiresApproval:false（ADR-0151 口径：白名单内没有逐次审批）；
    run 打 POST /px/v1/call，4xx/5xx 抛错（不吞——错误要进 tool_result，
    让模型知道这次调用没成）。

    撞名自诊断（复审 Minor）：safe 化改名后两个不同 host/server 的工具仍可能
    撞到同一个名字（比如两个好友都托管了叫 "list" 的工具、且 host 短前缀恰好
    相同）。engine 的 rebuildTools() 本来就会做"先到者赢 + warn"兜底，但那条
    warn 只报工具名，不报是哪两个 host/server 撞的——线上排查很费劲。这里自己
    先查一遍，撞名时把两边的 hostUid/serverId/原始 tool 名都打进 warn，**语义
    不变**：仍然保留先到者，只是把 engine 会做的兜底提前做一遍、顺便留下
    诊断信息（重复项不重复推入数组，避免 engine 那条无信息量的 warn 再叠一次） */
export function buildPxTools(
  deps: PxCallDeps,
  fromUid: string,
  granted: readonly GrantedPxServer[]
): Tool[] {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tools: Tool[] = [];
  const seen = new Map<string, { hostUid: string; serverId: string; toolName: string }>();
  for (const g of granted) {
    for (const t of g.toolDefs) {
      const name = safeName(`px_${g.hostUid.slice(0, 8)}_${g.serverId}_${t.name}`);
      const prior = seen.get(name);
      if (prior) {
        console.warn(
          `px 工具名撞车「${name}」：` +
            `先到者 host=${prior.hostUid} server=${prior.serverId} tool=${prior.toolName}，` +
            `被拒者 host=${g.hostUid} server=${g.serverId} tool=${t.name}——保留先到者`
        );
        continue;
      }
      seen.set(name, { hostUid: g.hostUid, serverId: g.serverId, toolName: t.name });
      tools.push({
        def: { name, description: t.description, parameters: (t.inputSchema ?? {}) as object },
        requiresApproval: false,
        async run(args) {
          const res = await fetchImpl(`${deps.edgeBase}/px/v1/call`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-runtime-secret": deps.runtimeSecret },
            body: JSON.stringify({ fromUid, hostUid: g.hostUid, serverId: g.serverId, tool: t.name, args }),
          });
          const payload: unknown = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(errMessage(payload) ?? `px 调用被拒（HTTP ${res.status}）`);
          }
          const result = isObj(payload) ? payload.result : null;
          return squashContent(isObj(result) ? result.content : null);
        },
      });
    }
  }
  return tools;
}
