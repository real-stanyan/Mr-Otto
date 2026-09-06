// workspaceError —— 工作区那几条 Supabase 错误说给人听（#843 ③）。
//
// 主进程把 PostgREST 的原话（`column workspace_sessions.kind does not exist`、
// `new row violates row-level security policy`）原样递给渲染层贴在侧栏上——
// 对用户是天书，对我们是「客户端比库新，去跑 migration」。照 humanizeMcpError
// （ADR-0189）的规矩：**只翻认得出的，认不出的原样留着**——一句看不懂的英文，
// 比一句自信的错误翻译有用得多。
//
// 判据优先看 PostgREST/PG 的 `code`（supabaseWorkspacesApi.unwrap 把它挂在
// Error 上），文案正则只是 code 缺席时的兜底——文案会随 PostgREST 版本变，
// code 不会。缺 migration 那一档**把原文带上**：那句话是说给维护者听的
// （缺的是哪一列），翻译掉就没人知道该跑哪个 migration 了。

/** 从 Error / 字符串 / 任意值里取 message 与 PostgREST code */
function pick(e: unknown): { message: string; code: string | undefined } {
  if (e instanceof Error) {
    return { message: e.message, code: (e as { code?: unknown }).code as string | undefined };
  }
  if (typeof e === "string") return { message: e, code: undefined };
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown };
    return {
      message: typeof o.message === "string" ? o.message : String(e),
      code: typeof o.code === "string" ? o.code : undefined,
    };
  }
  return { message: String(e), code: undefined };
}

/** 客户端比数据库新：缺列 / 缺表 / PostgREST 的 schema cache 里没有这一列 */
export const SCHEMA_BEHIND =
  "这个版本的 Mr Otto 比服务端数据库新（缺一次 migration），要等服务端更新，别重试";

export function humanizeWorkspaceError(e: unknown): string {
  const { message, code } = pick(e);
  const t = message.trim();
  // 42703 undefined_column / 42P01 undefined_table / PGRST204 schema cache 里没这列
  if (
    code === "42703" ||
    code === "42P01" ||
    code === "PGRST204" ||
    /\b(column|relation) .+ does not exist\b/i.test(t) ||
    /Could not find the .+ column/i.test(t)
  ) {
    return `${SCHEMA_BEHIND}。原文：${t}`;
  }
  if (code === "23505" || /duplicate key value/i.test(t)) return "已经有同名的了";
  if (code === "42501" || /row-level security/i.test(t)) {
    return "没有权限做这件事——你已不是这个工作区的成员，或者这一步只有 owner 能做";
  }
  if (/\bJWT expired\b|invalid JWT|\b401\b/i.test(t)) return "登录已过期，重新登录再试";
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET/i.test(t)) {
    return "连不上服务器——网络不通";
  }
  if (/timed? ?out/i.test(t)) return "等太久没回应，超时了";
  return t;
}
