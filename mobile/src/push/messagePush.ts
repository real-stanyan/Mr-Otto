// 消息推送在手机这一侧（#1442）：前台时弹不弹、点开去哪。推不推由 runtime 判（开关 / 免打扰 / 人正连着那个
// 房间就不推）；这里只补一条服务端看不见的：App 在前台、人正看着这条聊天时不弹（朋友私聊不经过 runtime 的房间，
// 只能在这儿挡）。
//
// 点开：载荷里的 otto 那一格（shared/notifyPrefs.ts 的 alertTargetFromPayload 逐格验）。冷启动（被点通知叫起来）
// 时导航还没挂上，先记着，RootNavigator 的 onReady 再送（同回电那条 flushPendingNav）。
import { CommonActions } from "@react-navigation/native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { myAppForHost } from "../../../src/shared/appRoom.js";
import { fetchApps } from "../../../src/shared/appsApi.js";
import { ringTarget } from "../../../src/shared/callRing.js";
import { alertKey, alertTargetFromPayload, type AlertTarget } from "../../../src/shared/notifyPrefs.js";
import { openKeyNow } from "../inbox/seenStore.js";
import { navRef } from "../nav/navRef.js";
import { supabase } from "../supabase.js";

const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** 远程推送的整份载荷在 trigger.payload；content.data 只是其中的 body 那一格（expo-notifications 的约定） */
function targetOf(n: Notifications.Notification): AlertTarget | null {
  const trigger = n.request.trigger as { type?: string; payload?: unknown } | null;
  return alertTargetFromPayload(trigger?.payload ?? null) ?? alertTargetFromPayload(n.request.content.data);
}

let pendingNav: (() => void) | null = null;

function open(t: AlertTarget): void {
  // 房间叫人（#1675）：先找我名下对应房主应用的那一份（我是房主 = 同一个 id；否则是它的副本），再进房间模式
  if (t.kind === "room") {
    void (async () => {
      const apps = await fetchApps(supabase);
      const mine = myAppForHost(apps ?? [], t.hostAppId);
      const go = (): void => {
        navRef.dispatch(CommonActions.reset(mine === null
          ? { index: 0, routes: [{ name: "Home" }] }
          : { index: 1, routes: [{ name: "Home" }, { name: "MiniApp" as const, params: { appId: mine.id, roomId: t.roomId } }] }));
      };
      if (navRef.isReady()) go();
      else pendingNav = go;
    })();
    return;
  }
  const route =
    t.kind === "friend"
      ? { name: "FriendChat" as const, params: { uid: t.uid } }
      : { name: "Chat" as const, params: ringTarget(t) };
  const go = (): void => {
    navRef.dispatch(CommonActions.reset({ index: 1, routes: [{ name: "Home" }, route] }));
  };
  if (navRef.isReady()) go();
  else pendingNav = go;
}

export function flushPushNav(): void {
  const go = pendingNav;
  pendingNav = null;
  go?.();
}

let handled: string | null = null;
function onResponse(r: Notifications.NotificationResponse | null): void {
  if (r === null || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  // 冷启动时 getLastNotificationResponseAsync 与监听器可能把同一条报两次
  const id = r.notification.request.identifier;
  if (handled === id) return;
  handled = id;
  const t = targetOf(r.notification);
  if (t !== null) open(t);
}

if (!IN_EXPO_GO) {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const t = targetOf(n);
      const watching = t !== null && openKeyNow() === alertKey(t);
      return { shouldShowBanner: !watching, shouldShowList: !watching, shouldPlaySound: !watching, shouldSetBadge: false };
    },
  });
  Notifications.addNotificationResponseReceivedListener(onResponse);
  void Notifications.getLastNotificationResponseAsync().then(onResponse).catch(() => undefined);
}
