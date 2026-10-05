// 小应用的宿主（#1591 第 1 期 b，spec §3.4）：拉这一版的清单与文件表 → 文件落本机 → WebView 以 file:// 载入入口页 →
// 桥（window.otto）：storage 走 app_data、nav 换页、share 走系统分享单、ask 把人带到管理员私聊并发出那句（plan 小修 3）、haptic。
// 没有外网：WebView 只许读本机这一版的目录；应用自己乱发的消息只会被忽略（parseBridgeRequest）。
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Share, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { AppRow, AppVersionRow } from "../../../src/shared/apps.js";
import { APP_BRIDGE_JS, appAskText, appFixText, bridgeDenied, bridgeReplyJs, parseBridgeError, parseBridgeRequest, type BridgeRequest } from "../../../src/shared/appBridge.js";
import { appData, appPageOk, fetchAppVersion, fetchApps } from "../../../src/shared/appsApi.js";
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { appById } from "./appsStore.js";
import { encodeAppCard } from "../../../src/shared/appCard.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { sendToFriend, useFriends } from "../friends/friendsStore.js";
import { useMyName } from "../tabs/MeScreen.js";
import { markAppOpened } from "./recentApps.js";
import { appFileUri, ensureAppFiles } from "./appFiles.js";

type Props = NativeStackScreenProps<RootStackParams, "MiniApp">;

type Loaded = { app: AppRow; version: AppVersionRow; dirUri: string; uid: string };

export function MiniAppScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { appId } = route.params;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  /** 应用自己报上来的第一条错（#1591 真机）：露一条，能一键让管理员修 */
  const [appError, setAppError] = useState<string | null>(null);
  // 分享给好友（#1648）：挑好友 → 私信里一张应用卡，对方点「添加」复制一份到 TA 名下
  const [sharing, setSharing] = useState<{ key: number; visible: boolean } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const friends = useFriends();
  const me = useMyName();
  const loadedRef = useRef<Loaded | null>(null);
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
        loadedRef.current = { app, version, dirUri: dir.uri, uid };
        markAppOpened(app.id);
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
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <HeaderTextButton label="分享" disabled={loadedRef.current === null} onPress={() => setSharing({ key: Date.now(), visible: true })} />
          <HeaderTextButton label="改一下" disabled={false} onPress={() => { toast("跟管理员说要改什么，专员会出下一版"); navigation.navigate("Chat", { kind: "agent", agentId: ADMIN_AGENT_ID }); }} />
        </View>
      ),
    });
  }, [navigation, name, loaded]);

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
    const err = parseBridgeError(e.nativeEvent.data);
    if (err !== null) {
      setAppError((cur) => cur ?? err);
      return;
    }
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
    <View style={{ flex: 1, backgroundColor: c.background }}>
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
    {sharing !== null ? (
      <PickAgentsDialog
        key={sharing.key}
        visible={sharing.visible}
        ws={{ id: "", name: "", ownerUid: "", members: [], connectors: [], sessions: [], agents: [], sandboxApproval: null, kind: "home" }}
        title={`分享「${loaded.app.name}」`}
        lead="挑要分享给的朋友。TA 点「添加」会复制一份到自己名下，数据各存各的。"
        options={[]}
        people={(friends.rows ?? []).filter((r) => r.status === "accepted").map((r) => ({ uid: r.profile.id, name: friendName(r.profile), url: r.profile.avatarUrl }))}
        peopleLabel="朋友"
        min={1}
        okLabel="分享"
        busy={shareBusy}
        error={shareError}
        onOk={(_agents, _n, people) => {
          void (async () => {
            setShareBusy(true);
            setShareError(null);
            try {
              const body = encodeAppCard({
                appId: loaded.app.id, version: loaded.version.version, name: loaded.app.name, icon: loaded.app.icon, slug: loaded.app.slug,
                description: loaded.app.description, from: { uid: loaded.uid, name: me.name },
              });
              for (const p of people) await sendToFriend(p, body);
              setSharing((d) => (d === null ? d : { ...d, visible: false }));
              toast(people.length === 1 ? "分享出去了" : `分享给了 ${people.length} 位朋友`);
            } catch (e) {
              setShareError(e instanceof Error ? e.message : String(e));
            } finally {
              setShareBusy(false);
            }
          })();
        }}
        onClose={() => setSharing((d) => (d === null ? d : { ...d, visible: false }))}
        onExited={() => { setSharing(null); setShareError(null); }}
      />
    ) : null}
    {appError !== null ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.background, borderTopWidth: 0.5, borderTopColor: c.border }}>
        <Text numberOfLines={2} style={{ flex: 1, fontSize: 13, color: c.destructive }}>{`这个应用出错了：${appError}`}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Chat", { kind: "agent", agentId: ADMIN_AGENT_ID, dispatch: appFixText(loaded.app.name, loaded.version.version, appError) })}
          style={({ pressed }) => [{ paddingHorizontal: 12, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: c.brand }, pressed && { opacity: 0.7 }]}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>让管理员修</Text>
        </Pressable>
      </View>
    ) : null}
    </View>
  );
}
