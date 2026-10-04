// pushDevices —— 推送令牌表（0045 的 push_devices）的 runtime 那一侧（#1411，spec §1.1 / §1.3）。
// service key 绕过 RLS：按人取令牌（只取这个 bundle 的——别的 App 的令牌拿我们的 topic 去发必然被拒）、
// 回写发成功的那个环境、删掉作废的令牌。
// 按种类取（#1428 / #1442）：回电只发 VoIP 令牌，消息通知只发普通（alert）令牌。
// 读失败往上抛：「查不到」不许说成「他没有设备」（callRinger 会分开说）；写失败只记日志：环境没回写只是
// 下次多试一次，作废令牌没删只是下次多发一次。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApnsEnv, PushDevice, PushDeviceStore, PushKind } from "./apns.js";

export function createSupabasePushDevices(client: SupabaseClient, bundleId: string, log: (m: string) => void): PushDeviceStore {
  const tryWrite = async (what: string, run: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> => {
    // try/catch 而不是只看 {error}：supabase-js 的查询构造器断网时直接 reject（同 cloudSessionMeta.ts 的那条教训）
    try {
      const { error } = await run();
      if (error) log(`[otto-runtime] push_devices ${what}失败：${error.message}`);
    } catch (err) {
      log(`[otto-runtime] push_devices ${what}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    async list(uid: string, kind: PushKind) {
      const { data, error } = await client.from("push_devices").select("token, apns_env").eq("user_id", uid).eq("bundle_id", bundleId).eq("kind", kind);
      if (error) throw new Error(`push_devices 查询失败：${error.message}`);
      return ((data ?? []) as { token: string; apns_env: string | null }[]).map((r): PushDevice => ({
        token: r.token,
        env: r.apns_env === "production" || r.apns_env === "sandbox" ? r.apns_env : null,
      }));
    },
    setEnv(token: string, env: ApnsEnv) {
      return tryWrite("回写环境", () => client.from("push_devices").update({ apns_env: env, updated_at: new Date().toISOString() }).eq("token", token));
    },
    remove(token: string) {
      return tryWrite("删作废令牌", () => client.from("push_devices").delete().eq("token", token));
    },
  };
}
