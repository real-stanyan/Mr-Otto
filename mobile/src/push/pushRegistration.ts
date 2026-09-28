// 推送登记（#1411，spec §1.2）：智能体办完事打电话回给你，手机先得把自己的推送令牌交给服务端。
//
// · 冷启动（已登录）、每次回到前台、每次登录，各登记一次：令牌可能变，RPC 是幂等的（0045 的
//   register_push_device）。第一次会弹系统的通知权限框——拒了就没有令牌，这个人收不到回电
//   （runtime 那边说「他的手机没开通知」）。
// · 退出登录前注销这台（unregisterPush）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网照样退出。
// · Expo Go 里不登记：那里拿到的是 Expo Go 自己的令牌，拿我们的 bundle 当 topic 去发必然被 APNs 拒。
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { supabase } from "../supabase.js";

const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.stanyan.mrotto.mobile";
const PUSHABLE = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

/** 这次启动登记成功的那个令牌（注销用） */
let token: string | null = null;
let inflight: Promise<void> | null = null;

const warn = (what: string, e: unknown): void => {
  console.warn(`推送${what}失败：${e instanceof Error ? e.message : String(e)}`);
};

/** 登记这台手机（登录了才做；没权限就先问一次，问过被拒就算了） */
export function registerPush(): Promise<void> {
  if (!PUSHABLE) return Promise.resolve();
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session === null) return;
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    }
    if (!perm.granted) return;
    const t = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof t !== "string" || t === "") return;
    const { error } = await supabase.rpc("register_push_device", { p_token: t, p_bundle: BUNDLE_ID });
    if (error) {
      warn("登记", error.message);
      return;
    }
    token = t;
  })()
    .catch((e: unknown) => warn("登记", e))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 退出登录前注销这台。最多等 3 秒：断网时调不通，退出不能被它卡住 */
export async function unregisterPush(): Promise<void> {
  if (!PUSHABLE || token === null) return;
  const t = token;
  const call = (async () => {
    const { error } = await supabase.rpc("unregister_push_device", { p_token: t });
    if (error) warn("注销", error.message);
    else token = null;
  })().catch((e: unknown) => warn("注销", e));
  await Promise.race([call, new Promise<void>((r) => setTimeout(r, 3_000))]);
}

void registerPush();
AppState.addEventListener("change", (s) => {
  if (s === "active") void registerPush();
});
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") void registerPush();
});
