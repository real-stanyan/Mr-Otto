// 「这台设备上有没有一份登录记录」——判据只有这一份，桌面与手机共用（同 wire.ts 的纪律）。
//
// 进门那道闸要的是一个**同步、离线也答得出**的答案（ADR-0182/0183）。桌面早就这么判了：
// `auth.json` 里存着一份 session 就算登录过。手机端原来判的是 `getSession()` 的返回值，
// 而那个函数会发网络——于是断网 + access token 已过期时它回 `session: null`，
// 人被弹回登录卡，尽管**盘上那份 session 一个字节都没少**。
//
// supabase-js 2.112 的链路（读过实现，不是推测）：`__loadSession` 发现 token 过期 → 去刷新 →
// 断网抛的是 `AuthRetryableFetchError` → `_callRefreshToken` 里删 session 那段被
// `if (!isAuthRetryableFetchError(error))` 挡住，**盘上那份留着**；但读路径接着判
// `accessTokenStillValid`，token 真过期了所以为假，于是返回 `session: null`。
// 也就是说：东西还在，只是那一问答了「没有」。闸门不该照那一问判。
//
// 判据按**形状**认，不按 key 名硬拼（ADR-0183 的理由原样成立）：supabase 哪天改了 key 方案，
// 硬拼的失败模式是「登录了也进不去」的死循环，按形状认则退化成「多认一份退役项目的旧 token」——
// 那个人进得来，但进去之后处处是未登录态，正是闸门本来就决定要放行的那一类。

/**
 * 一条存储记录是不是一份 session。回解析出来的对象（调用方还要读 `user.id`），不是 = null。
 *
 * 两条排除：key 里带 `code-verifier` 的是「点过一次 OAuth 然后放弃」留下的（#729 被它骗过一次）；
 * 解析不出对象、或没有非空 `access_token` 的不算。
 */
export function parseStoredSession(key: string, value: unknown): Record<string, unknown> | null {
  if (key.includes("code-verifier")) return null;
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null; // 解析不了就不是 session（code verifier 是裸串，走不到这儿也无妨）
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const token = (parsed as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token === "") return null;
  return parsed as Record<string, unknown>;
}

/** 这堆 key/value 里有没有一份 session。手机端把 kv-store 整个扫一遍交进来 */
export function hasStoredSession(entries: Iterable<readonly [string, unknown]>): boolean {
  for (const [k, v] of entries) if (parseStoredSession(k, v) !== null) return true;
  return false;
}
