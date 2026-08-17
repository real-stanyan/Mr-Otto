// account — OAuth 登录的客户端编排层（Task 5）。
// 三块职责：deep-link/loopback 回调 URL 解析（parseAuthCallback）、
// supabase user → AccountInfo 的字段映射（toAccountInfo）、
// 以及把 signIn/handleCallback/signOut 串起来的 AccountManager。
//
// 真 client（createClient + pkce + authStorage）的组装被隔离进 createSupabaseAuthClient
// 这一个工厂函数——它是本文件唯一会碰 @supabase/supabase-js 真实构造器和文件路径的地方，
// 单测永远只注入 SupabaseLike 假实现，不实例化真 client、不发网络请求。

import { createClient } from "@supabase/supabase-js";
import { createAuthStorage } from "./authStorage.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./authConfig.js";

export type AccountInfo = {
  signedIn: boolean;
  email: string;
  name: string;
  avatarUrl: string;
};

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
    signOut(): Promise<{ error: unknown }>;
  };
};

const REDIRECT_TO = "mrotto://auth-callback";

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
 */
export function createSupabaseAuthClient(filePath: string): SupabaseLike {
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
  return client as unknown as SupabaseLike;
}

export class AccountManager {
  private readonly openExternal: (url: string) => void;
  private readonly onChange: (info: AccountInfo) => void;
  private readonly client: SupabaseLike;
  private account: AccountInfo = EMPTY_ACCOUNT;

  constructor(deps: { openExternal(url: string): void; onChange(info: AccountInfo): void; client?: SupabaseLike }) {
    if (!deps.client) {
      // 真 client 需要落盘路径（userData 下的具体位置由接线层决定），
      // 这里不替调用方猜路径——缺 client 时直接报错，指向 createSupabaseAuthClient(filePath)。
      throw new Error(
        "AccountManager 需要注入 client：用 createSupabaseAuthClient(filePath) 构造真 client，或测试里传假实现"
      );
    }
    this.openExternal = deps.openExternal;
    this.onChange = deps.onChange;
    this.client = deps.client;
  }

  async signIn(provider: "google" | "github"): Promise<void> {
    const { data } = await this.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
    });
    if (data.url) {
      this.openExternal(data.url);
    }
  }

  async handleCallback(url: string): Promise<void> {
    const code = parseAuthCallback(url);
    if (!code) return;
    const { data } = await this.client.auth.exchangeCodeForSession(code);
    this.account = toAccountInfo(data.user);
    this.onChange(this.account);
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
    this.account = EMPTY_ACCOUNT;
    this.onChange(this.account);
  }

  getAccount(): AccountInfo {
    return this.account;
  }
}
