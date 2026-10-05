// 小应用的宿主（#1591 第 1 期 b，spec §3.4）：拉这一版的清单与文件表 → 文件落本机 → WebView 以 file:// 载入入口页 →
// 桥（window.otto）：storage 走 app_data、nav 换页、share 走系统分享单、ask 把人带到管理员私聊并发出那句（plan 小修 3）、haptic。
// 没有外网：WebView 只许读本机这一版的目录；应用自己乱发的消息只会被忽略（parseBridgeRequest）。
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Share, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { AppRow, AppVersionRow } from "../../../src/shared/apps.js";
import { APP_BRIDGE_JS, appAskText, bridgeDenied, bridgeReplyJs, parseBridgeRequest, type BridgeRequest } from "../../../src/shared/appBridge.js";
import { appData, appPageOk, fetchAppVersion, fetchApps } from "../../../src/shared/appsApi.js";
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { appById } from "./appsStore.js";
import { appFileUri, ensureAppFiles } from "./appFiles.js";

type Props = NativeStackScreenProps<RootStackParams, "MiniApp">;

type Loaded = { app: AppRow; version: AppVersionRow; dirUri: string; uid: string };

export function MiniAppScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { appId } = route.params;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const web = useRef<WebView | null>(null);
  const nav = useNavigation();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const uid = (await supabase.auth.getSession()).data.session?.user.id ?? null;
        if (uid === null) throw new Error("还没登录");
        let app = appById(appId);
        if (app === null) app = (await fetchApps(supabase))?.find((a) => a.id === appId) ?? null;
        if (app === null) throw new Error("没有这个应用了");
        if (app.currentVersion < 1) throw new Error("这个应用还没有打出第一版");
        const version = await fetchAppVersion(supabase, app.id, app.currentVersion);
        if (version === null) throw new Error("这一版的清单读不出来");
        const dir = await ensureAppFiles(uid, app.id, version.version, version.files);
        if (!alive) return;
        setLoaded({ app, version, dirUri: dir.uri, uid });
        setPage(version.manifest.entry);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [appId]);

  const name = loaded?.app.name ?? appById(appId)?.name ?? "应用";
  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      // 改一下 = 跟管理员说（spec §3.3「改 = 新版本」：同一条任务链，专员出下一版）
      headerRight: () => (
        <HeaderTextButton label="改一下" disabled={false} onPress={() => { toast("跟管理员说要改什么，专员会出下一版"); navigation.navigate("Chat", { kind: "agent", agentId: ADMIN_AGENT_ID }); }} />
      ),
    });
  }, [navigation, name]);

  const reply = useCallback((id: string, ok: boolean, value: unknown) => {
    web.current?.injectJavaScript(bridgeReplyJs(id, ok, value));
  }, []);

  const handle = useCallback(async (req: BridgeRequest, l: Loaded): Promise<unknown> => {
    const denied = bridgeDenied(req.method, l.version.manifest.capabilities);
    if (denied !== null) throw new Error(denied);
    const [a0, a1] = req.args;
    switch (req.method) {
      case "storage.get": return appData.get(supabase, l.app.id, l.uid, a0);
      case "storage.set": await appData.set(supabase, l.app.id, l.uid, a0, a1); return true;
      case "storage.list": return appData.list(supabase, l.app.id, l.uid, a0);
      case "storage.remove": await appData.remove(supabase, l.app.id, l.uid, a0); return true;
      case "nav": {
        if (!appPageOk(l.version.files, a0)) throw new Error("没有这一页");
        setPage((cur) => { if (cur !== null) history.current.push(cur); return a0; });
        return true;
      }
      case "back": {
        const prev = history.current.pop();
        if (prev !== undefined) setPage(prev);
        else nav.goBack();
        return true;
      }
      case "share": {
        const text = typeof (a0 as { text?: unknown })?.text === "string" ? (a0 as { text: string }).text.slice(0, 1000) : `${l.app.name} —— Otto 应用`;
        await Share.share({ message: text });
        return true;
      }
      case "ask": {
        const line = appAskText(l.app.name, a0);
        if (line === null) throw new Error("要问什么得写一句");
        navigation.navigate("Chat", { kind: "agent", agentId: ADMIN_AGENT_ID, dispatch: line });
        return { sent: true };
      }
      case "haptic": {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return true;
      }
    }
  }, [nav, navigation]);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    const req = parseBridgeRequest(e.nativeEvent.data);
    if (req === null || loaded === null) return;
    void handle(req, loaded).then(
      (v) => reply(req.id, true, v),
      (err: unknown) => reply(req.id, false, err instanceof Error ? err.message : String(err)),
    );
  }, [handle, loaded, reply]);

  if (error !== null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: c.background }}>
        <Text style={{ fontSize: 15, color: c.mutedForeground, textAlign: "center" }}>{error}</Text>
      </View>
    );
  }
  if (loaded === null || page === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <WebView
      ref={web}
      style={{ flex: 1, backgroundColor: c.background }}
      source={{ uri: appFileUri(loaded.dirUri, page) }}
      originWhitelist={["file://*"]}
      allowFileAccess
      allowFileAccessFromFileURLs
      allowingReadAccessToURL={loaded.dirUri}
      injectedJavaScriptBeforeContentLoaded={APP_BRIDGE_JS}
      onMessage={onMessage}
      // 没有外网（spec §3.1）：任何不是本机这一版目录下的跳转一律不放行
      onShouldStartLoadWithRequest={(r) => r.url.startsWith(loaded.dirUri)}
      javaScriptEnabled
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
    />
  );
}
