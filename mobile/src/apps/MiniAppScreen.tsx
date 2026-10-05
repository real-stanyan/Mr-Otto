// 小应用的宿主（#1591 第 1 期 b，spec §3.4）：拉这一版的清单与文件表 → 文件落本机 → WebView 以 file:// 载入入口页 →
// 桥（window.otto）：storage 走 app_data、nav 换页、share 走系统分享单、ask 把人带到管理员私聊并发出那句（plan 小修 3）、haptic。
// 没有外网：WebView 只许读本机这一版的目录；应用自己乱发的消息只会被忽略（parseBridgeRequest）。
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, Share, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { AppRow, AppVersionRow } from "../../../src/shared/apps.js";
import { encodeRoomInvite, familyOf, type RoomMember, type RoomRow } from "../../../src/shared/appRoom.js";
import { createRoom, fetchMembers, fetchRoom, inviteToRoom, joinRoom, leaveRoom, listRooms, pingRoom, roomData, subscribeRoom } from "../../../src/shared/appRoomApi.js";
import { APP_BRIDGE_JS, appAskText, appFixText, bridgeDenied, bridgeEventJs, bridgeReplyJs, parseBridgeError, parseBridgeRequest, type BridgeRequest } from "../../../src/shared/appBridge.js";
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

type Loaded = { app: AppRow; version: AppVersionRow; dirUri: string; uid: string; room: RoomRow | null; members: RoomMember[] };

/** 数据类的 room.* 要在房间里才能调 */
function needRoom(l: Loaded): RoomRow {
  if (l.room === null) throw new Error("还没进房间——先 otto.room.create() 或从邀请进来");
  return l.room;
}

/** room.rooms() 交给应用的形状（spec）：时间给 ISO 串 */
function roomSummary(r: RoomRow): { id: string; title: string; hostUid: string; closed: boolean; updatedAt: string } {
  return { id: r.id, title: r.title, hostUid: r.hostUid, closed: r.closed, updatedAt: new Date(r.updatedTs).toISOString() };
}

export function MiniAppScreen({ route, navigation }: Props) {
  const { c } = usePalette();
  const { appId, roomId } = route.params;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  /** 应用自己报上来的第一条错（#1591 真机）：露一条，能一键让管理员修 */
  const [appError, setAppError] = useState<string | null>(null);
  // 分享给好友（#1648）：挑好友 → 私信里一张应用卡，对方点「添加」复制一份到 TA 名下
  const [sharing, setSharing] = useState<{ key: number; visible: boolean; mode: "share" | "invite" } | null>(null);
  /** room.invite() 的回执在选人框关掉时给（选了谁 / 取消 = 空） */
  const inviteDone = useRef<((uids: string[]) => void) | null>(null);
  const roomLink = useRef<ReturnType<typeof subscribeRoom> | null>(null);
  /** 重订房间频道的计数（spec §5.2）：回前台 / 频道断了各加一，订阅 effect 跟着重跑并 resync */
  const [relink, setRelink] = useState(0);
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
        const room = roomId === undefined ? null : await fetchRoom(supabase, roomId);
        if (roomId !== undefined && room === null) throw new Error("进不了这一局（你不在里面，或它已经没了）");
        const version = room === null
          ? await fetchAppVersion(supabase, app.id, app.currentVersion)
          : await fetchAppVersion(supabase, room.hostAppId, room.hostVersion);
        if (version === null) throw new Error(room === null ? "这一版的清单读不出来" : "进不了这一局的那一版（先在私聊里点加入）");
        const dir = room === null
          ? await ensureAppFiles(uid, app.id, version.version, version.files)
          : await ensureAppFiles(room.hostUid, room.hostAppId, room.hostVersion, version.files);
        const members = room === null ? [] : ((await fetchMembers(supabase, room.id)) ?? []);
        if (!alive) return;
        const l: Loaded = { app, version, dirUri: dir.uri, uid, room, members };
        setLoaded(l);
        loadedRef.current = l;
        if (route.params.share === true) setSharing({ key: Date.now(), visible: true, mode: "share" });
        markAppOpened(app.id);
        setPage(version.manifest.entry);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [appId, roomId]);

  const name = loaded?.app.name ?? appById(appId)?.name ?? "应用";
  useLayoutEffect(() => {
    navigation.setOptions({
      title: loaded?.room?.title ?? name,
      // 改一下 = 跟管理员说（spec §3.3「改 = 新版本」：同一条任务链，专员出下一版）
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {loaded !== null && loaded.room !== null && loaded.room.hostUid === loaded.uid && !loaded.room.closed ? (
            <HeaderTextButton label="邀请" disabled={false} onPress={() => setSharing({ key: Date.now(), visible: true, mode: "invite" })} />
          ) : null}
          <HeaderTextButton label="分享" disabled={loadedRef.current === null} onPress={() => setSharing({ key: Date.now(), visible: true, mode: "share" })} />
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
      case "room.current": {
        const r = l.room;
        if (r === null) return null;
        const names = new Map((friends.rows ?? []).map((f) => [f.profile.id, friendName(f.profile)] as const));
        names.set(l.uid, me.name);
        return {
          id: r.id, title: r.title, hostUid: r.hostUid, version: r.hostVersion, closed: r.closed,
          me: { uid: l.uid, name: me.name },
          members: l.members.map((m) => ({ uid: m.uid, name: names.get(m.uid) ?? m.uid.slice(0, 8), status: m.status })),
        };
      }
      case "room.create": {
        const title = typeof (a0 as { title?: unknown })?.title === "string" ? (a0 as { title: string }).title : `${l.app.name} · 一局`;
        const id = await createRoom(supabase, l.app.id, title);
        navigation.replace("MiniApp", { appId: l.app.id, roomId: id });
        return { id };
      }
      case "room.open": {
        if (typeof a0 !== "string") throw new Error("要给房间 id");
        const rooms = (await listRooms(supabase, familyOf(l.app))) ?? [];
        if (!rooms.some((r) => r.id === a0)) throw new Error("没有这一间（或你不在里面）");
        // 只是被邀请、还没加入的：读房主那一版要先是成员（RLS 认 joined），先替 TA 加入
        const mine = ((await fetchMembers(supabase, a0)) ?? []).find((m) => m.uid === l.uid);
        if (mine?.status === "invited") await joinRoom(supabase, a0);
        navigation.replace("MiniApp", { appId: l.app.id, roomId: a0 });
        return true;
      }
      case "room.rooms": return ((await listRooms(supabase, familyOf(l.app))) ?? []).map(roomSummary);
      case "room.invite": {
        const r = needRoom(l);
        if (r.hostUid !== l.uid) throw new Error("只有房主能邀请");
        return await new Promise<string[]>((resolve) => {
          inviteDone.current?.([]);
          inviteDone.current = resolve;
          setSharing({ key: Date.now(), visible: true, mode: "invite" });
        });
      }
      case "room.leave": {
        await leaveRoom(supabase, needRoom(l).id);
        navigation.replace("MiniApp", { appId: l.app.id });
        return true;
      }
      case "room.get": return roomData.get(supabase, needRoom(l).id, a0);
      case "room.list": return roomData.list(supabase, needRoom(l).id, a0);
      case "room.set": return roomData.set(supabase, needRoom(l).id, a0, a1, req.args[2]);
      case "room.remove": await roomData.remove(supabase, needRoom(l).id, a0); return true;
      case "room.send": {
        needRoom(l);
        const link = roomLink.current;
        if (link === null) throw new Error("还没连上房间");
        await link.send(a0);
        return true;
      }
      case "room.ping": return pingRoom(supabase, needRoom(l).id, a0);
    }
  }, [nav, navigation, friends, me]);

  useEffect(() => {
    if (loaded === null || loaded.room === null) return;
    const roomId = loaded.room.id;
    /** 自己关的（离开页面 / 重订前）——之后频道报的 CLOSED 不算断 */
    let closing = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let synced = false;
    const push = (js: string): void => { if (!closing) web.current?.injectJavaScript(js); };
    const refreshMembers = (): void => {
      void fetchMembers(supabase, roomId).then((m) => {
        const cur = loadedRef.current;
        if (closing || m === null || cur === null) return;
        const next = { ...cur, members: m };
        loadedRef.current = next;
        setLoaded(next);
        push(bridgeEventJs("room.members", { members: m }));
      });
    };
    /** 频道断了：退避一下再重订（服务端一直拒时不至于打转） */
    const again = (): void => {
      if (closing || retry !== null) return;
      retry = setTimeout(() => { retry = null; if (!closing) setRelink((n) => n + 1); }, 2000);
    };
    const link = subscribeRoom(supabase, loaded.room.id, loaded.uid, {
      change: (e) => push(bridgeEventJs("room.change", e)),
      members: refreshMembers,
      closed: () => {
        const cur = loadedRef.current;
        if (cur !== null && cur.room !== null) {
          const next = { ...cur, room: { ...cur.room, closed: true } };
          loadedRef.current = next;
          setLoaded(next);
        }
        push(bridgeEventJs("room.closed", {}));
      },
      message: (from, msg) => push(bridgeEventJs("room.message", { from, msg })),
      status: (s) => {
        if (closing) return;
        if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") again();
        // 重订上了（不是第一次订）：断着的那段可能漏了推送，全量补一遍
        else if (s === "SUBSCRIBED" && relink > 0 && !synced) {
          synced = true;
          void roomData.list(supabase, roomId, "").then((rows) => {
            for (const e of rows) push(bridgeEventJs("room.change", e));
          }, () => undefined);
          refreshMembers();
        }
      },
    });
    roomLink.current = link;
    return () => { closing = true; if (retry !== null) clearTimeout(retry); link.close(); };
  }, [loaded?.room?.id, relink]);

  // 回前台就重订（spec §5.2：后台里 socket 多半被系统掐了）
  useEffect(() => {
    if (loaded === null || loaded.room === null) return;
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") setRelink((n) => n + 1); });
    return () => sub.remove();
  }, [loaded?.room?.id]);

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
        title={sharing.mode === "invite" ? `邀请朋友进「${loaded.room?.title ?? ""}」` : `分享「${loaded.app.name}」`}
        lead={sharing.mode === "invite" ? "挑要一起玩的朋友。TA 点开邀请就能进来，没有这个应用会自动装上。" : "挑要分享给的朋友。TA 点「添加」会复制一份到自己名下，数据各存各的。"}
        options={[]}
        people={(friends.rows ?? []).filter((r) => r.status === "accepted").map((r) => ({ uid: r.profile.id, name: friendName(r.profile), url: r.profile.avatarUrl }))}
        peopleLabel="朋友"
        min={1}
        okLabel={sharing.mode === "invite" ? "邀请" : "分享"}
        busy={shareBusy}
        error={shareError}
        onOk={(_agents, _n, people) => {
          if (sharing.mode === "invite") {
            void (async () => {
              setShareBusy(true);
              setShareError(null);
              try {
                const room = needRoom(loaded);
                const card = {
                  appId: room.hostAppId, version: room.hostVersion, name: loaded.app.name, icon: loaded.app.icon, slug: loaded.app.slug,
                  description: loaded.app.description, from: { uid: loaded.uid, name: me.name },
                };
                for (const uid of people) {
                  await inviteToRoom(supabase, room.id, uid);
                  await sendToFriend(uid, encodeRoomInvite(card, { id: room.id, title: room.title }));
                }
                inviteDone.current?.(people);
                inviteDone.current = null;
                setSharing((d) => (d === null ? d : { ...d, visible: false }));
                toast(people.length === 1 ? "邀请发出去了" : `邀请了 ${people.length} 位朋友`);
              } catch (e) {
                setShareError(e instanceof Error ? e.message : String(e));
              } finally {
                setShareBusy(false);
              }
            })();
            return;
          }
          void (async () => {
            setShareBusy(true);
            setShareError(null);
            try {
              const body = encodeAppCard({
                appId: loaded.app.id, version: loaded.app.currentVersion, name: loaded.app.name, icon: loaded.app.icon, slug: loaded.app.slug,
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
        onClose={() => {
          inviteDone.current?.([]);
          inviteDone.current = null;
          setSharing((d) => (d === null ? d : { ...d, visible: false }));
        }}
        onExited={() => { setSharing(null); setShareError(null); }}
      />
    ) : null}
    {appError !== null ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.background, borderTopWidth: 0.5, borderTopColor: c.border }}>
        <Text numberOfLines={2} style={{ flex: 1, fontSize: 13, color: c.destructive }}>{`这个应用出错了：${appError}`}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Chat", { kind: "agent", agentId: ADMIN_AGENT_ID, dispatch: appFixText(loaded.room === null ? loaded.app.name : `${loaded.app.name}（房主那一版）`, loaded.version.version, appError) })}
          style={({ pressed }) => [{ paddingHorizontal: 12, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: c.brand }, pressed && { opacity: 0.7 }]}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>让管理员修</Text>
        </Pressable>
      </View>
    ) : null}
    </View>
  );
}
