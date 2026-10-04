// 推送登记。两种令牌，同一个 RPC（0047 的 register_push_device）：
// · VoIP（#1411 → #1428）：智能体回电走 VoIP 推送 + CallKit。令牌由 PushKit 给（otto-call），不要通知权限。
// · 普通通知（alert，#1442）：智能体回答 / 有人 @ 我 / 朋友消息。要通知权限：登录之后第一次回到前台时问一次
//   （iOS 只会弹一次系统框；拒了就不再问，令牌照样登记不上——设置页那段开关说清去系统设置里打开）。
//
// · 冷启动（已登录）、每次回到前台、每次登录、PushKit 给了新令牌，各登记一次：令牌可能变，RPC 是幂等的。
// · 退出登录前注销这台（unregisterPush）：退出之后这台手机不该再响这个账号的来电和消息。最多等 3 秒，断网照样退出。
// · Expo Go 里没有 otto-call（同 otto-speech），也收不到远程推送：两种都不登记。
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { OttoCall } from "../../modules/otto-call/index.js";
import { supabase } from "../supabase.js";

const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.stanyan.mrotto.mobile";
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** 这次启动登记成功的那几个令牌（注销用） */
const registered = new Set<string>();
let inflight: Promise<void> | null = null;

const warn = (what: string, e: unknown): void => {
  console.warn(`推送${what}失败：${e instanceof Error ? e.message : String(e)}`);
};

async function register(token: string, kind: "voip" | "alert"): Promise<void> {
  if (token === "") return;
  const { error } = await supabase.rpc("register_push_device", { p_token: token, p_bundle: BUNDLE_ID, p_kind: kind });
  if (error) {
    warn("登记", error.message);
    return;
  }
  registered.add(token);
}

/** 普通通知的令牌：没问过权限就问一次；拒了（或这台不支持）回 null */
async function alertToken(): Promise<string | null> {
  if (IN_EXPO_GO) return null;
  let { status } = await Notifications.getPermissionsAsync();
  if (status === "undetermined") ({ status } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } }));
  if (status !== "granted") return null;
  const t = await Notifications.getDevicePushTokenAsync();
  return typeof t.data === "string" && t.data !== "" ? t.data : null;
}

/** 登记这台手机（登录了才做） */
export function registerPush(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session === null) return;
    const voip = OttoCall?.getVoipToken() ?? null;
    if (voip !== null) await register(voip, "voip");
    const alert = await alertToken().catch((e: unknown) => {
      warn("申请通知权限", e);
      return null;
    });
    if (alert !== null) await register(alert, "alert");
  })()
    .catch((e: unknown) => warn("登记", e))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 退出登录前注销这台。最多等 3 秒：断网时调不通，退出不能被它卡住 */
export async function unregisterPush(): Promise<void> {
  if (registered.size === 0) return;
  const tokens = [...registered];
  const run = Promise.all(
    tokens.map(async (t) => {
      const { error } = await supabase.rpc("unregister_push_device", { p_token: t });
      if (error) warn("注销", error.message);
      else registered.delete(t);
    }),
  ).catch((e: unknown) => warn("注销", e));
  await Promise.race([run, new Promise<void>((r) => setTimeout(r, 3_000))]);
}

void registerPush();
AppState.addEventListener("change", (s) => {
  if (s === "active") void registerPush();
});
supabase.auth.onAuthStateChange((event) => {
  // 换了账号：上一个账号登记过的令牌，RPC 会把它们挪到新账号名下（0045），这里只要重新登记一遍
  if (event === "SIGNED_IN") {
    registered.clear();
    void registerPush();
  }
});
OttoCall?.addListener("onCall", (raw) => {
  if (raw.type === "token") void registerPush();
});
if (!IN_EXPO_GO) {
  Notifications.addPushTokenListener(() => {
    registered.clear();
    void registerPush();
  });
}
