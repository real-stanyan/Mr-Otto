// 推送登记（#1411 → #1428）：智能体回电走 VoIP 推送 + CallKit，手机先得把 PushKit 给的 VoIP 令牌交给服务端。
//
// · 冷启动（已登录）、每次回到前台、每次登录、PushKit 给了新令牌，各登记一次：令牌可能变，RPC 是幂等的
//   （0047 的 register_push_device，p_kind = 'voip'）。VoIP 推送与 CallKit 不需要通知权限，不再向 iOS 要。
// · 退出登录前注销这台（unregisterPush）：退出之后这台手机不该再响这个账号的来电。最多等 3 秒，断网照样退出。
// · Expo Go 里没有 otto-call（同 otto-speech），什么都不登记。
import Constants from "expo-constants";
import { AppState } from "react-native";
import { OttoCall } from "../../modules/otto-call/index.js";
import { supabase } from "../supabase.js";

const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.stanyan.mrotto.mobile";

/** 这次启动登记成功的那个令牌（注销用） */
let token: string | null = null;
let inflight: Promise<void> | null = null;

const warn = (what: string, e: unknown): void => {
  console.warn(`推送${what}失败：${e instanceof Error ? e.message : String(e)}`);
};

/** 登记这台手机（登录了、而且 PushKit 已经给了令牌才做） */
export function registerPush(): Promise<void> {
  if (OttoCall === null) return Promise.resolve();
  if (inflight !== null) return inflight;
  const call = OttoCall;
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session === null) return;
    const t = call.getVoipToken();
    if (t === null || t === "") return;
    const { error } = await supabase.rpc("register_push_device", { p_token: t, p_bundle: BUNDLE_ID, p_kind: "voip" });
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
  if (token === null) return;
  const t = token;
  const run = (async () => {
    const { error } = await supabase.rpc("unregister_push_device", { p_token: t });
    if (error) warn("注销", error.message);
    else token = null;
  })().catch((e: unknown) => warn("注销", e));
  await Promise.race([run, new Promise<void>((r) => setTimeout(r, 3_000))]);
}

void registerPush();
AppState.addEventListener("change", (s) => {
  if (s === "active") void registerPush();
});
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") void registerPush();
});
OttoCall?.addListener("onCall", (raw) => {
  if (raw.type === "token") void registerPush();
});
