// 聊天页（#1356 A1，spec §5.3 / §6）。私聊为主；群聊先是基础版（群设置、@ 谁、名单变更那一行在 A3）。
//
// · 头：回退 | 药丸（脸 + 名字）| 私聊右边那颗直接进设置（中间没有菜单）。浮在内容上，页面内容
//   从底下滚过去（spec §4）。药丸里那张脸 = dmFaceState（与桌面私聊头部同一份判据）。名单与
//   名字从日志推导（chatViewOf，ADR-0302 / #1302），还没开房时用清单那一行。
// · 时间线：倒置的 FlatList（最新一条贴底）；往上翻到顶取更早一页（尾巴模式），失败给一颗
//   要人点的钮——哨兵自己重试的话，一条连不上的线会在人往上滚时反复打网络。
// · 草稿：私聊还没建时是同一张页、还没有会话，第一句发出去那一刻才建（spec §5.2）。当场就建
//   会让「点进去看一眼」也把它顶到名册最上面。
// · 状态（spec §6）：gone 一行「正在重连…」、发送钮灰；denied 是终态，说清是哪一种 +「回名册」。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { BlurView } from "expo-blur";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { resolveSendMentions } from "../../../src/shared/agentMentionInput.js";
import { chatViewOf } from "../../../src/shared/agentRoster.js";
import { cloudDeniedText } from "../../../src/shared/cloudSessionState.js";
import { chatCentre, chatRows, liveRows, nowRowOf, resolveChatTarget, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { dmFaceState } from "../../../src/shared/ottoFace/index.js";
import { parseMentions } from "../../../src/shared/remote/agentMention.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { BackGlyph, MoreGlyph } from "../chrome/Glyphs.js";
import { ROUND_BUTTON_SIZE, RoundButton } from "../chrome/RoundButton.js";
import {
  closeChat, dropUnsent, loadOlder, openChat, resendUnsent, sendText, startDm, stopTurn, useChatStore,
} from "../cloud/chatStore.js";
import { Face } from "../face/Face.js";
import { GroupFaces } from "../face/GroupFaces.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Spinner } from "../ui.js";
import { ChatRowView, NowRowView } from "./ChatRows.js";
import { Composer } from "./Composer.js";

const EMPTY_EVENTS: SessionEvent[] = [];
type Item = { kind: "row"; row: ChatRow } | { kind: "now"; now: NowRow };
type Props = NativeStackScreenProps<RootStackParams, "Chat">;

function Gap() {
  return <View style={{ height: 12 }} />;
}

function Line({ tone, children }: { tone: "muted" | "warn" | "error"; children: ReactNode }) {
  const { c } = usePalette();
  const color = tone === "error" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
  return <Text style={{ ...t.footnote, color, flexShrink: 1 }}>{children}</Text>;
}

function Centered({ top, children }: { top: number; children: ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: top, paddingHorizontal: space.lg }}>{children}</View>;
}

/** 顶上那一格（倒置列表里 ListFooterComponent 画在最上面）：给浮在上面的头留出位置，外加翻页的三态 */
function OlderRow({ top, hasOlder, older }: { top: number; hasOlder: boolean; older: "idle" | "loading" | "failed" }) {
  const { c } = usePalette();
  return (
    <View style={{ paddingTop: top, paddingBottom: 8, alignItems: "center" }}>
      {!hasOlder ? null : older === "failed" ? (
        // 上一页的内容留在原地不清屏；重试是一颗要人点的钮
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => void loadOlder()}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          <Text style={{ ...t.footnote, color: c.mutedForeground }}>
            没读到更早的消息 · <Text style={{ color: c.brand }}>重试</Text>
          </Text>
        </Pressable>
      ) : older === "loading" ? (
        <Spinner />
      ) : null}
    </View>
  );
}

/** 刚进来、一句都还没说（或只有看不见的内务事件）时的那一屏 */
function Hello({ ws, kind, agentIds, title }: { ws: WorkspaceSnapshot; kind: "dm" | "group"; agentIds: string[]; title: string }) {
  const { c } = usePalette();
  const first = agentIds[0];
  if (kind === "dm" && first !== undefined) {
    const a = ws.agents.find((x) => x.agentId === first);
    return (
      <View style={{ alignItems: "center", gap: 8 }}>
        <Face slot={agentFaceSlot(ws, first)} tier="m" state="alive" phase={facePhase(first)} />
        <Text style={{ ...t.headline, color: c.foreground }}>{title}</Text>
        {a !== undefined && a.description !== "" ? (
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{a.description}</Text>
        ) : null}
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>说第一句话就开始了。</Text>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} />
      <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>
        {`${agentIds.map((id) => agentNameOf(ws, id)).join("、")}都在。说第一句话就开始了。`}
      </Text>
    </View>
  );
}

function ChatHeader({ top, title, faces, onBack, onSettings }: {
  top: number;
  title: string;
  faces: ReactNode;
  onBack: () => void;
  onSettings?: () => void;
}) {
  const { c, isDark } = usePalette();
  const { width } = useWindowDimensions();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: top, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <RoundButton label="返回" onPress={onBack}>
        <BackGlyph color={c.foreground} />
      </RoundButton>
      <View pointerEvents="box-none" style={{ flex: 1, alignItems: "center" }}>
        {/* 药丸：46 高、左 9 右 16、最大宽 62%、毛玻璃（spec §4） */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={title}
          style={{
            height: 46, maxWidth: width * 0.62, borderRadius: 23, overflow: "hidden",
            flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 9, paddingRight: 16,
          }}
        >
          <BlurView intensity={40} tint={isDark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.foreground, 0.1) }]} />
          {faces}
          <Text numberOfLines={1} style={{ ...t.headline, color: c.foreground, flexShrink: 1 }}>{title}</Text>
        </View>
      </View>
      {onSettings !== undefined ? (
        <RoundButton label="设置" onPress={onSettings}>
          <MoreGlyph color={c.foreground} />
        </RoundButton>
      ) : (
        // 群设置在 A3：这一片不画一颗点了没去处的钮（#722），用同宽的空位让药丸居中
        <View style={{ width: ROUND_BUTTON_SIZE }} />
      )}
    </View>
  );
}

export function ChatScreen({ route, navigation }: Props) {
  const target = route.params;
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const home = useHome();
  const chat = useChatStore();
  const ws = home.home;
  const resolved = useMemo(() => (ws !== null ? resolveChatTarget(ws, home.chats, target) : null), [ws, home.chats, target]);
  const sessionId = resolved?.sessionId ?? null;
  /** 这一页自己的一句（点名打错了、建私聊失败、停不下来） */
  const [pageNote, setPageNote] = useState<{ text: string; tone: "muted" | "error" } | null>(null);
  const [stopping, setStopping] = useState(false);

  // 这条线已经存在就进房；草稿什么都不做，第一句发出去才建
  useEffect(() => {
    if (ws === null || resolved === null || sessionId === null) return;
    void openChat(ws.id, sessionId, resolved.seed, resolved.title);
    // 只跟「是哪一条」走：resolved 每次刷新名册都是新对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id, sessionId]);
  useEffect(() => () => closeChat(), []);

  const session = chat.session;
  const events = session?.events ?? EMPTY_EVENTS;
  const selfUid = session?.selfUid || home.selfUid || "";
  const draft = resolved !== null && resolved.sessionId === null && session === null;
  const view = ws !== null && session !== null && session.chat ? chatViewOf(ws, session.chat, events, resolved?.title ?? "") : null;
  const kind = view?.kind ?? resolved?.kind ?? "dm";
  const agentIds = view?.agentIds ?? resolved?.agentIds ?? [];
  const title = view?.title ?? resolved?.title ?? "";
  const dmAgent = kind === "dm" ? (agentIds[0] ?? null) : null;

  const rows = useMemo(() => (ws !== null ? chatRows({ events, ws, selfUid, now: Date.now() }) : []), [ws, events, selfUid]);
  const live = useMemo(() => (ws !== null ? liveRows({ streaming: chat.streaming, ws, now: Date.now() }) : []), [ws, chat.streaming]);
  const nowRow = useMemo(() => (ws !== null ? nowRowOf({ events, streaming: chat.streaming, ws }) : null), [ws, events, chat.streaming]);
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [...rows, ...live].map((row) => ({ kind: "row" as const, row }));
    if (nowRow !== null) list.push({ kind: "now", now: nowRow });
    return list.reverse(); // 倒置列表：data[0] 画在最底下
  }, [rows, live, nowRow]);

  const ready = session?.state === "ready";
  const canSend = draft || ready;

  const onSend = async (text: string): Promise<boolean> => {
    if (ws === null || resolved === null) return false;
    // 点名解析与桌面同一份（resolveSendMentions）：私聊里名单只有那一只
    const candidates = agentIds.map((id) => ({ agentId: id, name: agentNameOf(ws, id) }));
    const plan = resolveSendMentions({ text, parsed: parseMentions(text, candidates), refreshFailed: false, freshCandidates: candidates });
    if (plan.kind === "block") {
      setPageNote({ text: plan.error, tone: "error" });
      return false;
    }
    setPageNote(null);
    if (draft && dmAgent !== null) {
      const r = await startDm(ws.id, dmAgent, text, plan.mentions);
      if (!r.ok) {
        setPageNote({ text: r.message, tone: "error" });
        return false;
      }
      // 名册那一行要认出这条新私聊（下次点进来直接进房，不再是草稿）
      void refreshHome();
      return true;
    }
    const r = await sendText(text, plan.mentions);
    return r.ok || r.unknown === true;
  };

  const stop = async (seq: number): Promise<void> => {
    setStopping(true);
    const r = await stopTurn(seq);
    setStopping(false);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定停下来没有", tone: "muted" } : { text: r.message, tone: "error" });
  };

  const headerTop = insets.top + 8;
  const headerSpace = headerTop + ROUND_BUTTON_SIZE + 12;
  const centre = chatCentre({
    session: session === null ? null : { state: session.state, eventCount: events.length },
    draft,
    openFailed: chat.error !== null,
    rowCount: items.length,
  });

  const headFaces: ReactNode =
    ws === null ? null
      : dmAgent !== null ? (
        <Face slot={agentFaceSlot(ws, dmAgent)} tier="s" state={dmFaceState(openTurns(events), chat.streaming, dmAgent)} phase={facePhase(dmAgent)} ringColor={c.card} />
      ) : (
        <GroupFaces agentIds={agentIds} slots={agentIds.map((id) => agentFaceSlot(ws, id))} state="plain" />
      );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1 }}>
          {ws !== null && resolved === null ? (
            <Centered top={headerSpace}>
              {home.loaded ? <Text style={{ ...t.callout, color: c.mutedForeground }}>这条聊天已经不在了。</Text> : <Spinner />}
            </Centered>
          ) : ws === null || centre === "loading" ? (
            <Centered top={headerSpace}>
              <Spinner />
            </Centered>
          ) : centre === "hello" ? (
            <Centered top={headerSpace}>
              <Hello ws={ws} kind={kind} agentIds={agentIds} title={title} />
            </Centered>
          ) : centre === "blank" ? (
            <View style={{ flex: 1 }} />
          ) : (
            <FlatList
              inverted
              data={items}
              keyExtractor={(it) => (it.kind === "row" ? it.row.key : it.now.key)}
              renderItem={({ item }) =>
                item.kind === "row" ? (
                  <ChatRowView row={item.row} ws={ws} />
                ) : (
                  <NowRowView now={item.now} ws={ws} ready={ready} stopping={stopping} onStop={() => void stop(item.now.seq)} />
                )
              }
              ItemSeparatorComponent={Gap}
              onEndReached={() => {
                if (session?.hasOlder && session.older === "idle") void loadOlder();
              }}
              onEndReachedThreshold={0.5}
              ListHeaderComponent={<View style={{ height: 10 }} />}
              ListFooterComponent={<OlderRow top={headerSpace} hasOlder={session?.hasOlder ?? false} older={session?.older ?? "idle"} />}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          )}
        </View>

        <View style={{ gap: 6, paddingHorizontal: 16 }}>
          {session?.state === "gone" ? <Line tone="muted">正在重连…</Line> : null}
          {session?.state === "denied" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Line tone="error">{cloudDeniedText(session.deniedCode, session.deniedServerVersion)}</Line>
              <Button size="auto" variant="plain" label="回名册" onPress={() => navigation.popToTop()} />
            </View>
          ) : null}
          {session?.gapNote ? <Line tone="warn">{session.gapNote}</Line> : null}
          {chat.notice ? <Line tone="muted">{chat.notice}</Line> : null}
          {chat.error ? <Line tone="error">{chat.error}</Line> : null}
          {chat.sendError ? <Line tone="error">{chat.sendError}</Line> : null}
          {pageNote ? <Line tone={pageNote.tone}>{pageNote.text}</Line> : null}
          {chat.unsent !== null && chat.unsent.sessionId === session?.sessionId ? (
            // 中性灰不是红色：它不是一次失败，是这一层消除不了的不确定。两颗钮把决定交回给人
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Line tone="muted">{chat.unsent.note}</Line>
              <Button size="auto" variant="plain" label="重新发送" disabled={!ready} onPress={() => void resendUnsent()} />
              <Button size="auto" variant="plain" label="放弃" onPress={dropUnsent} />
            </View>
          ) : null}
        </View>

        <Composer
          placeholder={kind === "dm" ? `跟「${title}」说…` : "说点什么…"}
          canSend={canSend}
          sessionId={session?.sessionId ?? null}
          onSend={onSend}
        />
      </KeyboardAvoidingView>

      <ChatHeader
        top={headerTop}
        title={title}
        faces={headFaces}
        onBack={() => navigation.goBack()}
        {...(dmAgent !== null ? { onSettings: () => navigation.navigate("AgentSettings", { agentId: dmAgent }) } : {})}
      />
    </View>
  );
}
