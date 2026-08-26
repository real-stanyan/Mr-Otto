// account — OAuth 登录的客户端编排层（Task 5）。
// 三块职责：deep-link/loopback 回调 URL 解析（parseAuthCallback）、
// supabase user → AccountInfo 的字段映射（toAccountInfo）、
// 以及把 signIn/handleCallback/signOut 串起来的 AccountManager。
//
// 真 client（createClient + pkce + authStorage）的组装被隔离进 createSupabaseAuthClient
// 这一个工厂函数——它是本文件唯一会碰 @supabase/supabase-js 真实构造器和文件路径的地方，
// 单测永远只注入 SupabaseLike 假实现，不实例化真 client、不发网络请求。
//
// Task 6 接线形态（控制者裁决，client 必填）：
//   new AccountManager({ openExternal, onChange, client: createSupabaseAuthClient(path) })

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAuthStorage } from "./authStorage.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../shared/authConfig.js";
import { authLandingUrl } from "../shared/edgeConfig.js";
import type { AccountInfo } from "../shared/shellBridge.js";

export type { AccountInfo };

const EMPTY_ACCOUNT: AccountInfo = { signedIn: false, email: "", name: "", avatarUrl: "" };

type SupabaseUserLike = { email?: string; user_metadata?: Record<string, unknown> } | null;

/** supabase-js 客户端的最小接口——真 client 结构上兼容，测试注入假实现 */
export type SupabaseLike = {
  auth: {
    signInWithOAuth(args: {
      provider: "google" | "github";
      options: { redirectTo: string; skipBrowserRedirect: boolean };
    }): Promise<{ data: { url: string | null }; error: unknown }>;
    exchangeCodeForSession(code: string): Promise<{ data: { user: SupabaseUserLike }; error: unknown }>;
    signInWithPassword(args: {
      email: string;
      password: string;
    }): Promise<{ data: { user: SupabaseUserLike; session: unknown }; error: unknown }>;
    signUp(args: {
      email: string;
      password: string;
    }): Promise<{ data: { user: SupabaseUserLike; session: unknown }; error: unknown }>;
    signOut(): Promise<{ error: unknown }>;
    // 冷启动恢复用：向 supabase 发一次真实校验（不是读本地 getSession），
    // 用 authStorage 里恢复出来的 session 换一个当下有效的 user；离线/过期时 user 为 null。
    getUser(): Promise<{ data: { user: SupabaseUserLike }; error: unknown }>;
    // 拿当前 access token 喂 otto-gateway。读 getSession 而不是缓存令牌:
    // supabase-js 开着 autoRefreshToken,过期的会在这一步换新,自己缓存等于跟它抢活
    getSession(): Promise<{ data: { session: { access_token: string } | null }; error: unknown }>;
  };
};

// 授权完成后浏览器去落地页（不是直接 mrotto:// 深链）：深链浏览器渲染不了，
// 标签页停在 Google 旧页面上像卡死。落地页显示结果、页内 JS 再转发深链唤起
// app——app 侧收到的仍是 mrotto://auth-callback?code=…，parseAuthCallback 不变
const REDIRECT_TO = authLandingUrl();

/** supabase error（形态不定，AuthError 或任意 unknown）→ 可读消息 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** mrotto 深链或 loopback 回调 URL 里提取 code；非回调 URL（含无 code）一律 null */
export function parseAuthCallback(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const isMrottoCallback = parsed.protocol === "mrotto:" && parsed.hostname === "auth-callback";
  const isLoopbackCallback =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.pathname === "/callback";

  if (!isMrottoCallback && !isLoopbackCallback) return null;
  return parsed.searchParams.get("code");
}

/** supabase user → AccountInfo；null 用户回全空 signedIn=false */
export function toAccountInfo(user: SupabaseUserLike): AccountInfo {
  if (!user) return EMPTY_ACCOUNT;

  const email = user.email ?? "";
  const metadata = user.user_metadata ?? {};
  const metaName = typeof metadata["name"] === "string" ? (metadata["name"] as string) : undefined;
  const metaUserName = typeof metadata["user_name"] === "string" ? (metadata["user_name"] as string) : undefined;
  const emailPrefix = email.includes("@") ? (email.split("@")[0] ?? "") : "";
  const name = metaName ?? metaUserName ?? emailPrefix;

  const metaAvatarUrl = typeof metadata["avatar_url"] === "string" ? (metadata["avatar_url"] as string) : undefined;
  const metaPicture = typeof metadata["picture"] === "string" ? (metadata["picture"] as string) : undefined;
  const avatarUrl = metaAvatarUrl ?? metaPicture ?? "";

  return { signedIn: true, email, name, avatarUrl };
}

/**
 * 真 client 工厂——createClient + pkce + authStorage（Task 4 产物）组装。
 * 只有这个函数会碰真实 supabase-js 构造器和落盘路径；单测不调用它。
 *
 * 真 client 工厂——auth 视角(SupabaseLike)给 AccountManager,raw 完整 client
 * 给好友网关(from/channel)。同一个实例双出口:同一登录态,别建两个 client
 */
export function createSupabaseAuthClient(filePath: string): { auth: SupabaseLike; raw: SupabaseClient } {
  const storage = createAuthStorage(filePath);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
    },
  });
  return { auth: client as unknown as SupabaseLike, raw: client };
}

export class AccountManager {
  private readonly openExternal: (url: string) => void;
  private readonly onChange: (info: AccountInfo) => void;
  private readonly client: SupabaseLike;
  private account: AccountInfo = EMPTY_ACCOUNT;

  constructor(deps: { openExternal(url: string): void; onChange(info: AccountInfo): void; client: SupabaseLike }) {
    this.openExternal = deps.openExternal;
    this.onChange = deps.onChange;
    this.client = deps.client;
  }

  async signIn(provider: "google" | "github"): Promise<void> {
    const { data, error } = await this.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
    });
    if (error) {
      throw new Error(errorMessage(error));
    }
    if (!data.url) {
      throw new Error("signInWithOAuth 未返回授权 URL");
    }
    this.openExternal(data.url);
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(errorMessage(error));
    }
    this.account = toAccountInfo(data.user);
    this.onChange(this.account);
  }

  /**
   * 邮箱密码注册。两种正常结局，调用方据此提示用户：
   * - "signed-in"：服务端免邮箱验证（autoconfirm），注册即登录，已触发 onChange。
   * - "confirm-email"：服务端要求邮箱验证（user 有、session 无），去邮箱点完
   *   确认链接后回来用密码登录；此时**不是**登录态，不触发 onChange。
   */
  async signUpWithPassword(email: string, password: string): Promise<"signed-in" | "confirm-email"> {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) {
      throw new Error(errorMessage(error));
    }
    if (!data.session) return "confirm-email";
    this.account = toAccountInfo(data.user);
    this.onChange(this.account);
    return "signed-in";
  }

  async handleCallback(url: string): Promise<void> {
    const code = parseAuthCallback(url);
    if (!code) return;
    const { data, error } = await this.client.auth.exchangeCodeForSession(code);
    if (error) {
      // 失败不调 onChange——不能让"换 session 失败"看起来像"正常登出"，
      // 两者对调用方而言必须可区分。
      throw new Error(errorMessage(error));
    }
    this.account = toAccountInfo(data.user);
    this.onChange(this.account);
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) {
      // 服务端登出失败不阻塞本地登出：本地状态永远清空，服务端 session 交给自然过期。
      console.error("AccountManager.signOut：服务端 signOut 失败，仅清本地状态", error);
    }
    this.account = EMPTY_ACCOUNT;
    this.onChange(this.account);
  }

  /**
   * 冷启动登录态恢复：account 初始值恒为 EMPTY，signIn/handleCallback/signOut 是仅有的
   * 赋值路径——重启后即使 authStorage 从 auth.json 恢复了 session，getAccount() 在
   * restore 之前仍会一直回 signedIn:false。调 getUser()（而非读本地 getSession）用恢复
   * 出来的 session 发一次真实校验，比信本地缓存可靠。
   *
   * error 或 user 为 null（离线 / session 过期 / 从未登录过）一律静默：保持 EMPTY、
   * 不触发 onChange、不 throw——冷启动时这是正常状态，不是需要向上抛的异常。
   */
  async restore(): Promise<void> {
    const { data, error } = await this.client.auth.getUser();
    if (error) {
      console.error("AccountManager.restore：getUser 失败，保持未登录态", error);
      return;
    }
    if (!data.user) return;
    this.account = toAccountInfo(data.user);
    this.onChange(this.account);
  }

  getAccount(): AccountInfo {
    return this.account;
  }

  /**
   * otto-gateway 的进门凭据。每次请求前现取——access token 一小时就过期,
   * 缓存下来等于让 turn 跑到一半突然 401。
   *
   * 未登录 / 离线 / session 过期一律回 null(不是异常):调用方据此走"没登录"那条路,
   * 而不是把一次正常的未登录状态炸成错误。
   */
  async getAccessToken(): Promise<string | null> {
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error || !data.session) return null;
      return data.session.access_token || null;
    } catch (err) {
      console.error("AccountManager.getAccessToken：取 session 失败", err);
      return null;
    }
  }
}
