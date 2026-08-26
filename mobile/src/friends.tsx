// 好友那一屏:列表 / 加好友 / 聊天。三屏一个 screen 字段推着走,和 App.tsx 的
// phase 同一个路数 —— 屏少到不值得上路由。
//
// 从 App.tsx 里搬出来自己一个文件,是因为它从"一屏只读列表"长成了三屏带写操作:
// 会话那条链路(握手、密封流、审批)和好友这条链路(Supabase、RLS、Realtime)
// 之间没有任何共享状态,挤在一个文件里只会让两边都更难读。
//
// 数据全部直连 Supabase,不经中继 —— 理由写在 friendsApi.ts 开头(ADR-0108)。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { DirectMessage, FriendProfile } from "../../src/shared/friends.js";
import { mergeMessages, needsTimeLabel, timeLabel } from "../../src/shared/friendsQuery.js";
import {
  acceptFriend, AlreadyLinked, currentUserId, latestInboxId, listInboxSince, listFriends,
  listMessages, removeFriend, requestFriend, searchProfiles, sendMessage, subscribeFriends,
  type FriendRow,
} from "./friendsApi.js";
import { usePalette, type as t, radius, space } from "./theme.js";
import {
  Avatar, Button, Card, DetailBar, Dot, Group, Headline, Hint, Meta, Note, Page, Row, Spinner,
  Title, useKeyboardInset,
} from "./ui.js";

/** Realtime 哑了以后多久拉一次。8 秒:比人等得住的上限短,比一条心跳长 */
const POLL_MS = 8_000;

type Screen =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "chat"; friend: FriendRow };

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Friends({ onDetailChange, onBadge }: {
  /** 翻进「加好友」或某条聊天 = 推进一层,底栏要收起来 */
  onDetailChange: (inDetail: boolean) => void;
  /** 页签上那个红点该显示多少:待我处理的请求 + 没看过的消息 */
  onBadge: (n: number) => void;
}) {
  const [uid, setUid] = useState<string | null>(null);
  const [rows, setRows] = useState<FriendRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Realtime 两条通道都通没有。断了不报错,只是慢几秒(轮询兜底) */
  const [live, setLive] = useState(true);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [thread, setThread] = useState<DirectMessage[] | null>(null);

  /** 已经收到过的最大消息 id。Realtime 和轮询会送来同一条,
      单调游标让"未读 +1"这件事只发生一次(内容那边 mergeMessages 自己去重) */
  const cursor = useRef(0);
  /** 回调要在订阅里读**当下**的屏幕,而订阅只装一次 —— 存 ref,别让它进依赖 */
  const openWith = useRef<string | null>(null);
  openWith.current = screen.kind === "chat" ? screen.friend.profile.id : null;

  const load = useCallback(() => {
    listFriends().then((r) => { setRows(r); setErr(null); }).catch((e: unknown) => setErr(why(e)));
  }, []);

  const deliver = useCallback((m: DirectMessage) => {
    if (m.id <= cursor.current) return;
    cursor.current = m.id;
    if (openWith.current === m.sender) {
      setThread((prev) => mergeMessages(prev ?? [], [m]));
      return;
    }
    setUnread((u) => ({ ...u, [m.sender]: (u[m.sender] ?? 0) + 1 }));
  }, []);

  // 起手:拿到 uid,把收件箱游标对到"此刻",然后才订阅。
  // 游标不先对齐的话,第一次轮询会把最近一页历史消息当成新消息全推一遍
  useEffect(() => {
    void (async () => {
      const id = await currentUserId();
      if (!id) return;
      cursor.current = await latestInboxId(id);
      setUid(id);
    })().catch((e: unknown) => setErr(why(e)));
  }, []);

  useEffect(() => {
    if (!uid) return;
    load();
    return subscribeFriends(uid, {
      onFriendships: load,
      onMessage: deliver,
      onHealth: (h) => setLive(h === "live"),
    });
  }, [uid, load, deliver]);

  // Realtime 哑了才轮询。通着的时候一次都不拉 —— 轮询是兜底,不是双保险
  useEffect(() => {
    if (!uid || live) return;
    const tick = (): void => {
      load();
      listInboxSince(uid, cursor.current).then((ms) => ms.forEach(deliver)).catch(() => {});
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [uid, live, load, deliver]);

  // 从后台回到前台:立刻对一次表。挂起期间 WebSocket 多半已经被系统收走了
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" || !uid) return;
      load();
      listInboxSince(uid, cursor.current).then((ms) => ms.forEach(deliver)).catch(() => {});
    });
    return () => sub.remove();
  }, [uid, load, deliver]);

  const incoming = (rows ?? []).filter((f) => f.status === "pending" && f.direction === "incoming");
  const unreadTotal = Object.values(unread).reduce((a, b) => a + b, 0);
  useEffect(() => {
    onBadge(incoming.length + unreadTotal);
  }, [incoming.length, unreadTotal, onBadge]);

  useEffect(() => {
    onDetailChange(screen.kind !== "list");
  }, [screen.kind, onDetailChange]);

  const openChat = (f: FriendRow): void => {
    // 进门先把未读清了 —— 人已经在看了,红点再挂着就是骗人
    setUnread((u) => ({ ...u, [f.profile.id]: 0 }));
    setThread(null);
    setScreen({ kind: "chat", friend: f });
    if (!uid) return;
    listMessages(uid, f.profile.id)
      .then((ms) => setThread((prev) => mergeMessages(prev ?? [], ms)))
      .catch((e: unknown) => { setThread([]); setErr(why(e)); });
  };

  if (screen.kind === "add") {
    return <AddFriend known={rows ?? []} onBack={() => setScreen({ kind: "list" })} onAdded={load} />;
  }

  if (screen.kind === "chat") {
    if (!uid) return <Page><Note tone="error">没登录</Note></Page>;
    return (
      <Chat
        uid={uid} friend={screen.friend} messages={thread} live={live}
        onBack={() => { setScreen({ kind: "list" }); setThread(null); }}
        onSent={(m) => setThread((prev) => mergeMessages(prev ?? [], [m]))}
      />
    );
  }

  return (
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>好友</Title>
        {live ? null : <Hint>实时推送没通，正在每隔几秒对一次表。</Hint>}
      </View>
      {err ? <Note tone="error">{err}</Note> : null}

      {rows === null ? (
        <View style={{ paddingVertical: space.xl, alignItems: "center" }}><Spinner /></View>
      ) : (
        <FriendLists
          rows={rows} unread={unread}
          onOpen={openChat}
          onAccept={(f) => void acceptFriend(f.friendshipId).then(load).catch((e: unknown) => setErr(why(e)))}
          onRemove={(f) => void removeFriend(f.friendshipId).then(load).catch((e: unknown) => setErr(why(e)))}
        />
      )}

      <Group footer="按名字或邮箱找人。对方通过之后才能私信。">
        <Row label="加好友" chevron onPress={() => setScreen({ kind: "add" })} />
      </Group>
    </Page>
  );
}

/* ── 列表 ───────────────────────────────────────────────
   三组,顺序就是"要不要我动手":待我处理的请求 → 好友 → 我发出去还没被通过的。
   三组用 iOS 的 inset grouped list,不是三摞卡片 —— 同一类的事挤一块板,
   靠小标题分开,眼睛一次就能扫完"有没有事等我"。 */
function FriendLists({ rows, unread, onOpen, onAccept, onRemove }: {
  rows: FriendRow[];
  unread: Record<string, number>;
  onOpen: (f: FriendRow) => void;
  onAccept: (f: FriendRow) => void;
  onRemove: (f: FriendRow) => void;
}) {
  const incoming = rows.filter((f) => f.status === "pending" && f.direction === "incoming");
  const friends = rows.filter((f) => f.status === "accepted");
  const outgoing = rows.filter((f) => f.status === "pending" && f.direction === "outgoing");

  if (rows.length === 0) {
    return (
      <Card>
        <Headline>还没有好友</Headline>
        <Hint>下面「加好友」按名字或邮箱找人，对方通过就出现在这里。</Hint>
      </Card>
    );
  }

  return (
    <View style={{ gap: space.lg }}>
      {incoming.length ? (
        <Group header="好友请求">
          {incoming.map((f) => (
            <RequestRow key={f.friendshipId} row={f}
              onAccept={() => onAccept(f)} onReject={() => onRemove(f)} />
          ))}
        </Group>
      ) : null}

      {friends.length ? (
        <Group header="好友" footer="点一个人开始聊。长按可以删好友。">
          {friends.map((f) => (
            <PersonRow
              key={f.friendshipId} profile={f.profile} unread={unread[f.profile.id] ?? 0}
              chevron onPress={() => onOpen(f)} onLongPress={() => onRemove(f)}
            />
          ))}
        </Group>
      ) : null}

      {outgoing.length ? (
        <Group header="我发出的" footer="等对方通过。点一下可以撤回。">
          {outgoing.map((f) => (
            <PersonRow key={f.friendshipId} profile={f.profile} trailing="等对方通过"
              onPress={() => onRemove(f)} />
          ))}
        </Group>
      ) : null}
    </View>
  );
}

/** 一个人一行。Row 的 label 只吃字符串,而这里要头像 + 两行字 + 右边的东西,
    所以自己画一行,但内边距/最小高度/分隔线的缩进都跟 Row 对齐 —— 混在同一块板里
    看不出是两种行 */
function PersonRow({ profile: p, unread = 0, trailing, chevron, onPress, onLongPress }: {
  profile: FriendProfile;
  unread?: number;
  trailing?: string;
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const { c } = usePalette();
  const body = (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.sm,
      paddingHorizontal: space.md, paddingVertical: 10, minHeight: 56,
    }}>
      <Avatar url={p.avatarUrl || undefined} name={p.name || p.email} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ ...t.body, color: c.foreground }} numberOfLines={1}>
          {p.name || p.email}
        </Text>
        {p.name ? <Meta>{p.email}</Meta> : null}
      </View>
      {unread > 0 ? (
        <View style={{
          minWidth: 20, height: 20, borderRadius: radius.pill, paddingHorizontal: 6,
          backgroundColor: c.destructive, alignItems: "center", justifyContent: "center",
        }}>
          <Text style={{ ...t.footnote, fontWeight: "600", color: c.destructiveForeground }}>
            {unread > 99 ? "99+" : unread}
          </Text>
        </View>
      ) : null}
      {trailing ? (
        <Text style={{ ...t.footnote, color: c.mutedForeground }} numberOfLines={1}>{trailing}</Text>
      ) : null}
      {chevron ? (
        <View style={{
          width: 8, height: 8, borderRightWidth: 1.6, borderTopWidth: 1.6,
          borderColor: c.mutedForeground, transform: [{ rotate: "45deg" }],
        }} />
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button" onPress={onPress} onLongPress={onLongPress}
      // 整行变色,不缩放:缩放是"这是个按钮"的语汇,整行高亮才是"我选中了这一行"
      style={({ pressed }) => (pressed ? { backgroundColor: c.muted } : undefined)}
    >
      {body}
    </Pressable>
  );
}

/** 一条待我处理的请求。**两个动作都摆出来** —— 收到请求时人要做的只有通过或拒绝,
    藏进长按里等于让人猜 */
function RequestRow({ row: f, onAccept, onReject }: {
  row: FriendRow;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { c } = usePalette();
  const [busy, setBusy] = useState(false);
  const go = (fn: () => void) => () => { setBusy(true); fn(); };
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Avatar url={f.profile.avatarUrl || undefined} name={f.profile.name || f.profile.email} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text style={{ ...t.body, color: c.foreground }} numberOfLines={1}>
            {f.profile.name || f.profile.email}
          </Text>
          {f.profile.name ? <Meta>{f.profile.email}</Meta> : null}
        </View>
        <Dot tone="warn" />
      </View>
      {/* 小胶囊靠右一行:桌面 permission-grant 的动作行是同一个形状,安静、不抢卡片主体 */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        <Button label="拒绝" variant="plain" size="auto" disabled={busy} onPress={go(onReject)} />
        <Button label="通过" size="auto" disabled={busy} onPress={go(onAccept)} />
      </View>
    </View>
  );
}

/* ── 加好友 ─────────────────────────────────────────────
   一个搜索框 + 结果。**已经有关系的人不给"添加"按钮**,给一句现状 ——
   点了才被库里那条唯一索引拒绝,是最糟的一种"没反应"。 */
function AddFriend({ known, onBack, onAdded }: {
  known: FriendRow[];
  onBack: () => void;
  onAdded: () => void;
}) {
  const { c } = usePalette();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FriendProfile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 这一趟已经发出去的请求。列表要等 Realtime 回来才刷新,中间这段不能没反应 */
  const [sent, setSent] = useState<Record<string, true>>({});
  const { root, keyboard } = useKeyboardInset(() => {});

  // 输一个字搜一次是在替用户按回车。300ms:比连续打字的间隔长,比人停手后的耐心短
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return; }
    const id = setTimeout(() => {
      setBusy(true);
      searchProfiles(term)
        .then((r) => { setHits(r); setErr(null); })
        .catch((e: unknown) => setErr(why(e)))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const relation = (id: string): string | null => {
    const f = known.find((x) => x.profile.id === id);
    if (!f) return sent[id] ? "已发送" : null;
    if (f.status === "accepted") return "已是好友";
    return f.direction === "incoming" ? "等你通过" : "等对方通过";
  };

  const add = (p: FriendProfile): void => {
    setErr(null);
    setBusy(true);
    requestFriend(p.id)
      .then(() => { setSent((s) => ({ ...s, [p.id]: true })); onAdded(); })
      .catch((e: unknown) => setErr(e instanceof AlreadyLinked ? e.message : why(e)))
      .finally(() => setBusy(false));
  };

  return (
    <View ref={root.ref} onLayout={root.onLayout} style={{ flex: 1, paddingBottom: keyboard }}>
      <DetailBar back="好友" title="加好友" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          style={{
            backgroundColor: c.card, color: c.foreground,
            borderRadius: radius.control,
            borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
            paddingHorizontal: space.md, paddingVertical: 12, ...t.body,
          }}
          placeholder="名字或邮箱"
          placeholderTextColor={c.mutedForeground}
          autoCapitalize="none" autoCorrect={false} autoFocus
          value={q} onChangeText={setQ}
          returnKeyType="search"
        />
        {err ? <Note tone="error">{err}</Note> : null}

        {hits === null ? (
          <Hint>输入对方的名字或注册邮箱。找到人之后发一条请求，等对方通过。</Hint>
        ) : hits.length === 0 ? (
          <Card>
            <Headline>没找到这个人</Headline>
            <Hint>换个写法试试，或者跟对方确认一下注册用的邮箱。</Hint>
          </Card>
        ) : (
          <Group>
            {hits.map((p) => {
              const state = relation(p.id);
              return (
                <View key={p.id} style={{
                  flexDirection: "row", alignItems: "center", gap: space.sm,
                  paddingHorizontal: space.md, paddingVertical: 10, minHeight: 56,
                }}>
                  <Avatar url={p.avatarUrl || undefined} name={p.name || p.email} />
                  <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                    <Text style={{ ...t.body, color: c.foreground }} numberOfLines={1}>
                      {p.name || p.email}
                    </Text>
                    {p.name ? <Meta>{p.email}</Meta> : null}
                  </View>
                  {state ? (
                    <Text style={{ ...t.footnote, color: c.mutedForeground }}>{state}</Text>
                  ) : (
                    <Button label="添加" size="auto" disabled={busy} onPress={() => add(p)} />
                  )}
                </View>
              );
            })}
          </Group>
        )}
        {busy && hits === null ? <Spinner /> : null}
      </ScrollView>
    </View>
  );
}

/* ── 聊天 ───────────────────────────────────────────────
   气泡 + 输入框。键盘让位自己量(useKeyboardInset,理由在那儿写着)。
   发送是**乐观**的:按下就上屏,失败了把字还给输入框 —— 在手机网络上,
   等一个来回再上屏,每一条都像卡住了。 */
function Chat({ uid, friend, messages, live, onBack, onSent }: {
  uid: string;
  friend: FriendRow;
  /** null = 还在拉。空数组 = 真的还没聊过 */
  messages: DirectMessage[] | null;
  live: boolean;
  onBack: () => void;
  onSent: (m: DirectMessage) => void;
}) {
  const { c } = usePalette();
  const list = useRef<ScrollView | null>(null);
  const atBottom = useRef(true);
  const [text, setText] = useState("");
  /** 已经上屏、还没落库的那几条。id 用负数,和真行的正 id 天然不撞 */
  const [pending, setPending] = useState<{ key: number; body: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const nextKey = useRef(-1);

  const toEnd = (): void => { if (atBottom.current) list.current?.scrollToEnd({ animated: true }); };
  useEffect(toEnd, [messages, pending]);
  const { root, keyboard } = useKeyboardInset(toEnd);

  const submit = (): void => {
    const body = text.trim();
    if (!body) return;
    setErr(null);
    setText("");
    const key = nextKey.current--;
    setPending((p) => [...p, { key, body }]);
    sendMessage(uid, friend.profile.id, body)
      .then((m) => { onSent(m); setPending((p) => p.filter((x) => x.key !== key)); })
      .catch((e: unknown) => {
        setPending((p) => p.filter((x) => x.key !== key));
        setErr(why(e));
        // 打的字还回去:发不出去还把内容吞掉,是这一屏最不能犯的错
        setText((cur) => (cur ? cur : body));
      });
  };

  const ready = text.trim().length > 0;

  return (
    <View ref={root.ref} onLayout={root.onLayout} style={{ flex: 1, paddingBottom: keyboard }}>
      <DetailBar back="好友" title={friend.profile.name || friend.profile.email} onBack={onBack} />
      {live ? null : (
        <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}>
          <Hint>实时推送没通，新消息可能晚几秒到。</Hint>
        </View>
      )}

      <ScrollView
        ref={list}
        contentContainerStyle={{ padding: space.md, gap: space.xs }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
        }}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        onContentSizeChange={toEnd}
      >
        {messages === null ? (
          <View style={{ paddingVertical: space.xl, alignItems: "center" }}><Spinner /></View>
        ) : messages.length === 0 && pending.length === 0 ? (
          <View style={{ paddingVertical: space.xl, alignItems: "center", gap: space.xs }}>
            <Headline>还没聊过</Headline>
            <Hint>说点什么。</Hint>
          </View>
        ) : null}

        {(messages ?? []).map((m, i) => (
          <Bubble
            key={m.id} body={m.body} mine={m.sender === uid}
            stamp={needsTimeLabel(m.createdAt, i === 0 ? null : messages![i - 1]!.createdAt)
              ? timeLabel(m.createdAt, Date.now())
              : null}
          />
        ))}
        {pending.map((p) => <Bubble key={p.key} body={p.body} mine stamp={null} sending />)}
      </ScrollView>

      <View style={{
        paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: space.xs,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
        backgroundColor: c.background,
      }}>
        {err ? <Note tone="error">{err}</Note> : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
          <TextInput
            style={{
              flex: 1, backgroundColor: c.card, color: c.foreground,
              borderRadius: radius.control,
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
              paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11,
              // 长文本自己长高,到五六行封顶——再高就把聊天记录挤没了
              maxHeight: 132, ...t.body,
            }}
            placeholder="说点什么…"
            placeholderTextColor={c.mutedForeground}
            multiline value={text} onChangeText={setText}
          />
          <Pressable
            accessibilityRole="button" accessibilityLabel="发送"
            onPress={submit} disabled={!ready} hitSlop={8}
            style={({ pressed }) => [
              {
                width: 44, height: 44, borderRadius: radius.pill,
                alignItems: "center", justifyContent: "center",
                backgroundColor: c.primary,
              },
              !ready && { opacity: 0.35 },
              pressed && ready && { opacity: 0.8 },
            ]}
          >
            <Text style={{ ...t.headline, color: c.primaryForeground }}>↑</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** 一条气泡。自己的靠右、蓝底;对方的靠左、卡片底。
    尾巴那一角收小(6 而不是 18)—— 四角一样圆的气泡分不出是谁说的 */
function Bubble({ body, mine, stamp, sending }: {
  body: string;
  mine: boolean;
  /** 上面那条居中的时间;null = 和上一条挨得够近,不插 */
  stamp: string | null;
  sending?: boolean;
}) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.xs }}>
      {stamp ? (
        <Text style={{
          ...t.footnote, color: c.mutedForeground, textAlign: "center", paddingVertical: space.xs,
        }}>
          {stamp}
        </Text>
      ) : null}
      <View style={{
        maxWidth: "80%",
        alignSelf: mine ? "flex-end" : "flex-start",
        backgroundColor: mine ? c.primary : c.card,
        borderWidth: mine ? 0 : StyleSheet.hairlineWidth,
        borderColor: c.border,
        borderRadius: 18,
        borderBottomRightRadius: mine ? 6 : 18,
        borderBottomLeftRadius: mine ? 18 : 6,
        paddingHorizontal: 13, paddingVertical: 9,
        // 还没落库的那条压暗一档:它和已经发出去的不是同一回事
        opacity: sending ? 0.55 : 1,
      }}>
        <Text
          selectable
          style={{ ...t.body, color: mine ? c.primaryForeground : c.foreground }}
        >
          {body}
        </Text>
      </View>
    </View>
  );
}
