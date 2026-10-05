// request_app_connect —— 智能体要用一个还没连上的连接器目录应用时，请主人连（#1666）。只管参数与目录解析；
// 发不发卡（已经能用 / 已有开着的卡 / 每小时上限）与落盘在 sessionService 的 offer。只在自己会话里画一张卡、
// 真正的授权在主人手里：不过审批门（同 ADR-0358 的论证）
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { APP_CONNECT_WHY_MAX, REQUEST_APP_CONNECT_TOOL_NAME, resolveConnectApp } from "../../../src/shared/appConnect.js";

export interface RequestAppConnectDeps {
  /** 发卡；回给模型的那句话。参数已校验、目录已解析 */
  offer: (o: { catalogId: string; appName: string; why: string }) => string;
}

export function createRequestAppConnectTool(deps: RequestAppConnectDeps): Tool {
  return {
    def: {
      name: REQUEST_APP_CONNECT_TOOL_NAME,
      description:
        "请主人连上一个应用（连接器目录里的，比如 Supabase、GitHub、Notion、飞书）：会话里会出一张卡，主人点一下就去连 / 重新登录。" +
        "用在你要办的事必须用某个应用、而你手上没有它的工具的时候。调了之后用一句话告诉主人要连什么、为什么，然后这一轮就停下；" +
        "他连上或者不连，都会有一条消息回到这里。",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "应用名或目录 id，如 supabase / GitHub" },
          why: { type: "string", description: `为什么要连（${APP_CONNECT_WHY_MAX} 字以内，写给主人看）：要用它办什么` },
        },
        required: ["app", "why"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld): Promise<string> {
      const a = (args ?? {}) as Record<string, unknown>;
      const app = typeof a.app === "string" ? a.app : "";
      const rawWhy = typeof a.why === "string" ? a.why.replace(/\s+/gu, " ").trim() : "";
      if (rawWhy === "") throw new Error("request_app_connect: why 不能是空的");
      const why = [...rawWhy].length > APP_CONNECT_WHY_MAX ? `${[...rawWhy].slice(0, APP_CONNECT_WHY_MAX).join("")}…` : rawWhy;
      const r = resolveConnectApp(app);
      if (r.kind === "unknown") throw new Error(`request_app_connect: 目录里没有「${app.trim()}」，手机上连不了。让主人去电脑上的 Mr Otto 里接`);
      if (r.kind === "blocked") throw new Error(`request_app_connect: ${r.entry.name} ${r.reason}`);
      return deps.offer({ catalogId: r.entry.id, appName: r.entry.name, why });
    },
  };
}
