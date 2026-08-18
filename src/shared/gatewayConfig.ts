// otto-gateway 的地址。共享常量:主进程接线用,渲染层显示"官方额度"来源时也用。
// 这里只有 URL(不是秘密);官方 key 只活在网关服务器的 .env 里,客户端永远拿不到。

/** 生产网关。nginx 的 /gw/ 反代到 VPS 上的 :8787(deploy/otto-gateway/) */
export const DEFAULT_GATEWAY_BASE_URL = "https://otto-auth.stan.damianslife.com/gw/v1";

/** 本地调试网关时用 OTTO_GATEWAY_URL 覆盖(例:http://127.0.0.1:8787/v1) */
export const GATEWAY_BASE_URL_ENV = "OTTO_GATEWAY_URL";

export function gatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[GATEWAY_BASE_URL_ENV] ?? DEFAULT_GATEWAY_BASE_URL;
}

/** 网关自己的错误形状(gateway.ts 的 apiError)。402 = 额度用尽 */
export interface GatewayErrorBody {
  error: { message: string; type: "otto_gateway"; code: string };
}

export function parseGatewayError(body: string): GatewayErrorBody["error"] | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const err = (parsed as { error?: unknown }).error;
    if (typeof err !== "object" || err === null) return null;
    const e = err as Record<string, unknown>;
    if (e.type !== "otto_gateway") return null;
    return {
      message: typeof e.message === "string" ? e.message : "",
      type: "otto_gateway",
      code: typeof e.code === "string" ? e.code : "",
    };
  } catch {
    return null;
  }
}
