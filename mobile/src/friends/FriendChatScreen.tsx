// 和朋友私聊（#1386，spec §5.7）：messages 表（0001），不是云会话——所以是另一张页，气泡、时刻、输入栏与智能体那几种
// 同一套样子。一次拉最近 50 条，往上翻再拉；realtime 推新消息，通道哑了降级成轮询（friendsStore）。
// 桌面发来的「分享会话」是一段 JSON 信封：画成一张卡（shareCardView：邀请码不上屏），手机上打不开会话包，只说去哪儿做。
// 删了好友的那个人：库里 RLS 不许再发（messages_insert_accepted_friend），输入栏换成一句实话。
import { useFocusEffect } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import type { DirectMessage } from "../../../src/shared/friends.js";
import { decodeEnvelope } from "../../../src/shared/sessionPackageCodec.js";
import { shareCardView } from "../../../src/shared/shareCard.js";
import { friendName, needsTimeRow, timelineTimeLabel } from "../../../src/shared/wechatInbox.js";
import { WxComposer, type HoldState } from "../chat/WxComposer.js";
import { NewGroupDialog } from "../group/NewGroupDialog.js";
import { useHome } from "../home/homeStore.js";
import { markSeen, setOpenKey } from "../inbox/seenStore.js";
import { useInbox } from "../inbox/useInbox.js";
import type { RootStackParams } from "../nav/types.js";
import { useMyName } from "../tabs/MeScreen.js";
import { usePalette, withAlpha } from "../theme.js";
import { Spinner } from "../ui.js";
import { dictationUsable, startDictation, stopDictation, useVoice } from "../voice/voiceStore.js";
import { PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { HeaderIconButton } from "../wx/TabHeader.js";
import { toast } from "../wx/toast.js";
import { loadOlderThread, openThread, sendToFriend, useFriends } from "./friendsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "FriendChat">;
type Item = { kind: "time"; key: string; label: string } | { kind: "msg"; key: string; m: DirectMessage };

function Bubble({ m, mine, name, avatar, meName, meAvatar }: { m: DirectMessage; mine: boolean; name: string; avatar: string; meName: string; meAvatar: string }) {
  const { c } = usePalette();
  const env = decodeEnvelope(m.body);
  const body = env !== null ? (
    (() => {
      const v = shareCardView(env, { mine, fromName: name });
      return (
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, gap: 4, maxWidth: 260 }}>
          <Text style={{ fontSize: 13, color: c.mutedForeground }}>{v.heading}</Text>
          {v.title !== null ? <Text style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{`《${v.title}》`}</Text> : null}
          {v.message !== null ? <Text style={{ fontSize: 14, color: c.foreground }}>{v.message}</Text> : null}
          <Text style={{ fontSize: 12, color: c.faint }}>{v.meta}</Text>
          {v.grant !== null ? <Text style={{ fontSize: 13, color: c.mutedForeground }}>{v.grant}</Text> : null}
          <Text style={{ fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>{v.hint}</Text>
        </View>
      );
    })()
  ) : (
    <View style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }), backgroundColor: mine ? c.bubbleMe : c.bubbleThem }}>
      <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{m.body}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {mine ? <PersonTile name={meName} url={meAvatar} size={40} me /> : <PersonTile name={name} url={avatar} size={40} />}
      <View style={{ flexShrink: 1, maxWidth: "76%" }}>{body}</View>
    </View>
  );
}

export function FriendChatScreen({ route, navigation }: Props) {
  const { uid } = route.params;
  const { c } = usePalette();
  const friends = useFriends();
  const inbox = useInbox();
  const me = useMyName();
  const voice = useVoice();
  const headerHeight = useHeaderHeight();
  const [note, setNote] = useState<string | null>(null);
  const [hold, setHold] = useState<HoldState>({ phase: "idle" });
  const [holdText, setHoldText] = useState("");
  const home = useHome();
  const [grouping, setGrouping] = useState<{ key: number; visible: boolean } | null>(null);
  const createdGroup = useRef<string | null>(null);
  const row = friends.rows?.find((r) => r.profile.id === uid) ?? null;
  const name = row !== null ? friendName(row.profile) : "";
  const friend = row?.status === "accepted";
  const thread = friends.threads.get(uid);
  const key = `f:${uid}`;
  const others = inbox.unreadChats;

  useEffect(() => {
    void openThread(uid);
  }, [uid]);
  useFocusEffect(
    useCallback(() => {
      setOpenKey(key);
      return () => {
        setOpenKey(null);
        markSeen(key, Date.now());
      };
    }, [key]),
  );
  const last = thread?.messages[thread.messages.length - 1];
  useEffect(() => {
    if (last !== undefined) markSeen(key, Date.parse(last.createdAt) || Date.now());
  }, [key, last]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: () => (
        <HeaderIconButton label="聊天信息" onPress={() => navigation.navigate("ChatInfo", { kind: "friend", uid })}>
          <Icon name="ellipsis" size={24} stroke={2} color={c.foreground} />
        </HeaderIconButton>
      ),
      ...(others > 0 ? { headerBackTitle: String(others), headerBackButtonDisplayMode: "default" as const } : { headerBackButtonDisplayMode: "minimal" as const }),
    });
  }, [navigation, name, uid, others, c.foreground]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let prev: number | null = null;
    const now = Date.now();
    for (const m of thread?.messages ?? []) {
      const ts = Date.parse(m.createdAt) || 0;
      if (needsTimeRow(prev, ts)) out.push({ kind: "time", key: `t${m.id}`, label: timelineTimeLabel(ts, now) });
      prev = ts;
      out.push({ kind: "msg", key: `m${m.id}`, m });
    }
    return out.reverse();
  }, [thread?.messages]);

  const send = async (text: string): Promise<boolean> => {
    setNote(null);
    try {
      await sendToFriend(uid, text);
      return true;
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
        <View style={{ flex: 1 }}>
          {thread === undefined || thread.loading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner /></View>
          ) : items.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
              {row !== null ? <PersonTile name={name} url={row.profile.avatarUrl} size={64} /> : null}
              <Text style={{ fontSize: 14, color: c.mutedForeground }}>{friend ? "说第一句话吧。" : ""}</Text>
            </View>
          ) : (
            <FlatList
              inverted
              // 不满一屏时贴顶（#1424）：inverted 翻转了上下，内容坐标的「尾」是屏幕上的「顶」，
              // 同 chat/ChatScreen.tsx 那一处
              contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", paddingBottom: 8 }}
              data={items}
              keyExtractor={(it) => it.key}
              renderItem={({ item }) =>
                item.kind === "time" ? (
                  <Text style={{ alignSelf: "center", fontSize: 11.5, color: c.faint, fontVariant: ["tabular-nums"] }}>{item.label}</Text>
                ) : (
                  <Bubble m={item.m} mine={item.m.sender !== uid} name={name} avatar={row?.profile.avatarUrl ?? ""} meName={me.name} meAvatar={me.avatar} />
                )
              }
              ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
              ListHeaderComponent={<View style={{ height: 14 }} />}
              ListFooterComponent={
                thread.hasOlder ? (
                  <View style={{ paddingVertical: 12, alignItems: "center" }}>
                    {thread.older === "failed" ? (
                      <Pressable accessibilityRole="button" onPress={() => void loadOlderThread(uid)} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                        <Text style={{ fontSize: 13, color: c.mutedForeground }}>没读到更早的消息 · <Text style={{ color: c.brand }}>重试</Text></Text>
                      </Pressable>
                    ) : thread.older === "loading" ? <Spinner /> : null}
                  </View>
                ) : null
              }
              onEndReached={() => {
                if (thread.hasOlder && thread.older === "idle") void loadOlderThread(uid);
              }}
              onEndReachedThreshold={0.5}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          )}
          {hold.phase === "down" ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: "30%", alignItems: "center" }}>
              <View style={{ width: 188, minHeight: 150, borderRadius: 20, padding: 16, backgroundColor: "rgba(20, 20, 22, 0.88)", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <Icon name="mic" size={40} stroke={1.6} color={hold.cancel ? "rgba(255,255,255,0.4)" : "#5ac8fa"} />
                <Text numberOfLines={4} style={{ fontSize: 14, color: "#ffffff", textAlign: "center" }}>{holdText === "" ? "在听…" : holdText}</Text>
                <Text style={{ fontSize: 13, color: "#ffffff", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: hold.cancel ? c.destructive : "transparent" }}>
                  {hold.cancel ? "松开手指，取消发送" : "松开 发送 · 上划 取消"}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
        {note !== null || thread?.error ? (
          <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 16, paddingBottom: 6 }}>{note ?? `没拉到最新的消息（${thread?.error ?? ""}）`}</Text>
        ) : null}
        {friend ? (
          <WxComposer
            draftKey={key}
            placeholder=""
            canSend
            sessionId={null}
            onSend={send}
            plus={
              // 拉人建群（#1393）：带上 TA，再拉几位——群建在我的主场里
              home.home !== null
                ? [{ key: "group", icon: "users-round", label: "拉人建群", onPress: () => setGrouping({ key: Date.now(), visible: true }) }]
                : []
            }
            {...(dictationUsable(voice)
              ? {
                hold: {
                  onDown: () => {
                    setHoldText("");
                    startDictation(setHoldText, (m) => setNote(m));
                  },
                  onChange: setHold,
                  onUp: (ok: boolean) => {
                    void (async () => {
                      const text = await stopDictation(ok);
                      setHoldText("");
                      if (!ok) return;
                      if (text.trim() === "") {
                        toast("没听清，按住再说一遍");
                        return;
                      }
                      await send(text.trim());
                    })();
                  },
                },
              }
              : {})}
          />
        ) : (
          <View style={{ padding: 16, paddingBottom: 32, backgroundColor: c.side, borderTopWidth: 0.5, borderTopColor: withAlpha(c.foreground, 0.12) }}>
            <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center" }}>
              {row === null ? "你们已经不是朋友了，发不了消息。" : "对方还没同意加你为朋友，发不了消息。"}
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
      {grouping !== null && home.home !== null ? (
        <NewGroupDialog
          key={grouping.key}
          visible={grouping.visible}
          ws={home.home}
          selfUid={home.selfUid ?? ""}
          title="拉人建群"
          lead={`带上${name}，再拉几位（你的智能体或朋友），凑够 2 位就能建。朋友让智能体动手要等你批。`}
          presetPeople={[uid]}
          onClose={() => setGrouping((g) => (g === null ? g : { ...g, visible: false }))}
          onCreated={(sid) => {
            createdGroup.current = sid;
            setGrouping((g) => (g === null ? g : { ...g, visible: false }));
          }}
          onExited={() => {
            setGrouping(null);
            const sid = createdGroup.current;
            createdGroup.current = null;
            // 换成那个新群（返回回到列表，不回到这条私聊），同智能体私聊里的「拉人建群」
            if (sid !== null && navigation.isFocused()) navigation.replace("Chat", { kind: "group", sessionId: sid });
          }}
        />
      ) : null}
    </View>
  );
}
