// 手机端的全部界面。三屏,一个状态机推着走:
//   登录 → 配对(核对 6 位安全码) → 舰队(看 + 审批)
//
// 范围就到这里(ADR-0094):不建会话、不改设置、不切模型、不管 MCP。
// 屏幕少到不值得上路由 —— 一个 phase 字段比 expo-router 少一整层依赖。
//
// 视觉语言全部来自 src/theme.ts,那张表逐个值抄自桌面的 app.css:同一套
// Apple 四色底盘、同一套语义色、同样跟随系统深浅色。组件在 src/ui.tsx。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Keyboard, LayoutAnimation, Platform, Pressable,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
  type ViewStyle,
} from "react-native";
import type { IslandAgent, IslandFleet } from "../src/shared/shellBridge.js";
import type { MobileMessage } from "../src/shared/remote/frames.js";
import { groupByWorkspace, groupTone, type WorkspaceGroup } from "../src/shared/remote/groups.js";
import { parseMarkdown, type Span as MdSpan } from "../src/shared/remote/markdown.js";
import { groupTimeline, splitTool } from "../src/shared/remote/timeline.js";
import type { PinnedPeerStore, RemotePeer } from "../src/shared/remote/devices.js";
import type { MobileBridge } from "../src/shared/remote/mobileBridge.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { listFriends, type FriendRow } from "./src/friendsApi.js";
import { connect, devices, openStore, RELAY_BASE } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, MONO, radius, space } from "./src/theme.js";
import {
  Button, Card, CodeTiles, Dot, Headline, Hint, Meta, Note, StatusLine, Strong,
  TabIcon, Tile, Title, Warn,
} from "./src/ui.js";

type Phase = "loading" | "signIn" | "pair" | "fleet";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [store, setStore] = useState<PinnedPeerStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await openStore();
      setStore(s);
      const { data } = await supabase.auth.getSession();
      if (!data.session) return setPhase("signIn");
      setPhase(s.peerIdentity() ? "fleet" : "pair");
    })().catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <Screen center><Note tone="error">{error}</Note></Screen>;
  if (phase === "loading" || !store) return <Screen center><Spinner /></Screen>;

  return (
    <Screen>
      {phase === "signIn" ? (
        <SignIn onDone={() => setPhase(store.peerIdentity() ? "fleet" : "pair")} />
      ) : phase === "pair" ? (
        <Pair store={store} onPaired={() => setPhase("fleet")} />
      ) : (
        <Shell
          store={store}
          onRepair={() => setPhase("pair")}
          onSignedOut={() => setPhase("signIn")}
        />
      )}
    </Screen>
  );
}

/** 地面。状态栏跟着主题走 —— 深色底配浅色状态栏,反过来读不出来 */
function Screen({ children, center }: { children: React.ReactNode; center?: boolean }) {
  const { c, isDark } = usePalette();
  return (
    <SafeAreaView style={[
      { flex: 1, backgroundColor: c.background },
      center && { alignItems: "center", justifyContent: "center", padding: space.lg },
    ]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      {children}
    </SafeAreaView>
  );
}

function Spinner() {
  const { c } = usePalette();
  return <ActivityIndicator color={c.mutedForeground} />;
}

/** 每一屏的滚动容器。标题和正文之间留一口气,列表项之间留小的。
    grow = 内容不足一屏时把容器撑满,好让里面自己去配平上下 */
function Page({ children, grow }: { children: React.ReactNode; grow?: boolean }) {
  return (
    <ScrollView
      contentContainerStyle={[
        { padding: space.lg, paddingBottom: space.xl, gap: space.md },
        grow && { flexGrow: 1 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

/* ── 登录 ───────────────────────────────────────────────
   OAuth 在上、邮箱密码在下,是因为**这个账号体系里注册走的是 OAuth**:
   用 Google 注册的账号根本没有密码,只留密码那条路的话它永远登不进来
   (虚拟机上实测就是这条:一个 Google 账号在这屏反复报 Invalid login credentials)。
   密码那半留着但收进折叠里 —— 桌面支持 signUpWithPassword,确实存在有密码的账号。

   两个 provider 按钮都是 secondary,不是两个蓝按钮:用户有哪个账号就点哪个,
   两者平权。蓝色(primary)一屏只留给一个真正的主动作。 */
function SignIn({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const oauth = (provider: OAuthProvider): void => {
    void (async () => {
      setBusy(provider);
      setErr(null);
      try {
        await signInWithProvider(provider);
        onDone();
      } catch (e: unknown) {
        // 取消不是故障,不报红
        if (!(e instanceof AuthCancelled)) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    // 这一屏只有三个按钮,顶到天花板会在下面留一大片空。撑满高度、内容居中,
    // 按钮正好落在拇指够得着的地方
    <Page grow>
      <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
        <View style={{ gap: space.sm, alignItems: "flex-start" }}>
          {/* 和桌面同一张脸(resources/icon.png 的副本):这是两端唯一的共同标记。
              不再叠 borderRadius —— 图本身已经是圆角的,再圆一次会切掉边 */}
          <Image source={require("./assets/otto-mark.png")} style={{ width: 68, height: 68 }} />
          <Title>Mr Otto</Title>
          <Hint>用<Strong>和电脑上同一个</Strong>账号登录。</Hint>
        </View>
        {err ? <Note tone="error">{err}</Note> : null}
      <View style={{ gap: space.sm }}>
        <Button
          variant="outline"
          label={busy === "google" ? "登录中…" : "用 Google 登录"}
          disabled={busy !== null}
          onPress={() => oauth("google")}
        />
        <Button
          variant="outline"
          label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
          disabled={busy !== null}
          onPress={() => oauth("github")}
        />
      </View>
        {showPassword ? (
          <PasswordForm disabled={busy !== null} onError={setErr} onDone={onDone} />
        ) : (
          <Button label="用邮箱密码登录" variant="plain" onPress={() => setShowPassword(true)} />
        )}
      </View>
    </Page>
  );
}

/** 邮箱密码那一半。只有桌面上用 signUpWithPassword 注册过的账号能走这条 */
function PasswordForm(props: {
  disabled: boolean;
  onError: (m: string | null) => void;
  onDone: () => void;
}) {
  const { c } = usePalette();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    props.onError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return props.onError(error.message);
    props.onDone();
  };

  const input = {
    backgroundColor: c.card, color: c.foreground, borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    paddingHorizontal: space.md, paddingVertical: 13, ...t.body,
  };

  return (
    // 上边一条线,把它和上面那两个 OAuth 按钮分开
    <View style={{
      gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border, paddingTop: space.md,
    }}>
      <TextInput
        style={input} placeholder="邮箱" placeholderTextColor={c.mutedForeground}
        autoCapitalize="none" autoComplete="email" keyboardType="email-address"
        value={email} onChangeText={setEmail}
      />
      <TextInput
        style={input} placeholder="密码" placeholderTextColor={c.mutedForeground}
        autoComplete="current-password" secureTextEntry value={password} onChangeText={setPassword}
      />
      <Button
        label={busy ? "登录中…" : "登录"}
        disabled={busy || props.disabled}
        onPress={() => void submit()}
      />
    </View>
  );
}

/* ── 配对 ───────────────────────────────────────────────
   这一屏真正要人做的只有一件事:把这里的 6 位数和电脑上那个比一遍。
   账号目录不是信任来源(ADR-0095):公钥从 Supabase 下发,掌握库的人能发一把假的。
   对上了才 pin —— 所以文案必须把"对不上就别配"说在按钮前面。
   数字拆成一格一格,因为它的唯一用途是**逐位比对**。 */
function Pair({ store, onPaired }: { store: PinnedPeerStore; onPaired: () => void }) {
  const [peers, setPeers] = useState<RemotePeer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const api = devices(store);

  const refresh = useCallback(() => {
    void (async () => {
      setErr(null);
      await api.registerSelf("iPhone");
      setPeers(await api.listPeers());
    })().catch((e: unknown) => setErr(String(e)));
    // api 每次 render 新建一个,不进依赖 —— 它没有状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(refresh, [refresh]);

  const pin = async (deviceId: string): Promise<void> => {
    setBusy(deviceId);
    const ok = await api.pin(deviceId);
    setBusy(null);
    if (ok) onPaired();
    else setErr("这台电脑的公钥不合法,没有配对");
  };

  return (
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>配对电脑</Title>
        <Hint>
          下面的 6 位数会同时显示在电脑的「设置 → 手机」里。
          <Warn>对不上就不要配</Warn>——那说明中间有人换掉了公钥。
        </Hint>
      </View>
      {err ? <Note tone="error">{err}</Note> : null}
      {peers === null ? (
        <Spinner />
      ) : peers.length === 0 ? (
        <Card>
          <Headline>还没有电脑登记</Headline>
          <Hint>在电脑上打开「设置 → 手机」,这里下拉刷新就能看到它。</Hint>
        </Card>
      ) : (
        peers.map((p) => (
          <Card key={p.deviceId} style={{ gap: space.md }}>
            <Headline>{p.label || p.deviceId}</Headline>
            <CodeTiles code={p.code} />
            <Button
              label={busy === p.deviceId ? "配对中…" : p.pinned ? "重新配对" : "安全码一致，配对"}
              disabled={busy === p.deviceId}
              onPress={() => void pin(p.deviceId)}
            />
          </Card>
        ))
      )}
      <Button label="刷新" variant="plain" onPress={refresh} />
    </Page>
  );
}

/* ── 底栏与三个页签 ─────────────────────────────────────
   会话 / 好友 / 设置。**三个都常驻挂载,靠 display 切**,不是卸载重建:
   会话那页里握着到电脑的连接(握手 + 密封流),切个页签就断线重连是不可接受的。

   翻进详情屏时底栏收起来 —— 那是"推进去"的一层,不是第四个页签。 */
type Tab = "sessions" | "friends" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "sessions", label: "会话" },
  { id: "friends", label: "好友" },
  { id: "settings", label: "设置" },
];

function Shell({ store, onRepair, onSignedOut }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  onSignedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [inDetail, setInDetail] = useState(false);

  const pane = (id: Tab): ViewStyle => ({
    flex: 1,
    // display:"none" 而不是条件渲染:见上面为什么不能卸载
    display: tab === id ? "flex" : "none",
  });

  return (
    <View style={{ flex: 1 }}>
      {/* 品牌栏。翻进详情屏时让位给那一屏自己的返回栏——两条顶栏叠着没有意义 */}
      {inDetail ? null : <BrandBar />}
      <View style={pane("sessions")}>
        <Fleet store={store} onRepair={onRepair} onDetailChange={setInDetail} />
      </View>
      <View style={pane("friends")}><Friends /></View>
      <View style={pane("settings")}>
        <Settings store={store} onRepair={onRepair} onSignedOut={onSignedOut} />
      </View>
      {inDetail ? null : <TabBar tab={tab} onTab={setTab} />}
    </View>
  );
}

/** 顶部品牌栏:和桌面同一张脸 + 字标。只出现一次,不跟着页签变 */
function BrandBar() {
  const { c } = usePalette();
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.xs,
      paddingHorizontal: space.md, paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
    }}>
      <Image source={require("./assets/otto-mark.png")} style={{ width: 26, height: 26 }} />
      <Text style={{ ...t.headline, color: c.foreground }}>Mr Otto</Text>
    </View>
  );
}

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { c } = usePalette();
  return (
    <View style={{
      flexDirection: "row",
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
      backgroundColor: c.background,
    }}>
      {TABS.map((x) => (
        <Pressable
          key={x.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === x.id }}
          onPress={() => onTab(x.id)}
          // 49pt = iOS 底栏的标准高度。整格可点,不是只有字可点
          style={({ pressed }) => [
            { flex: 1, minHeight: 49, alignItems: "center", justifyContent: "center", gap: 3,
              paddingVertical: 6 },
            pressed && { opacity: 0.5 },
          ]}
        >
          <TabIcon name={x.id} color={tab === x.id ? c.foreground : c.mutedForeground} />
          <Text style={{
            // 11pt:iOS 底栏标签的量。用 footnote(13)的话图标+文字挤不进 49pt
            fontSize: 11, lineHeight: 13, letterSpacing: 0.05,
            // 选中只靠颜色和字重,不加下划线/底色:底栏本来就窄,多一层装饰就挤
            color: tab === x.id ? c.foreground : c.mutedForeground,
            fontWeight: tab === x.id ? "600" : "400",
          }}>
            {x.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/* ── 好友 ───────────────────────────────────────────────
   **只读**。加好友、收发私信、接受请求这些写操作留在电脑上 —— 手机端是第三个
   投影窗口(ADR-0094),不是第二个完整客户端。 */
function Friends() {
  const [rows, setRows] = useState<FriendRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    listFriends().then(setRows).catch((e: unknown) =>
      setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>好友</Title>
        <Hint>加好友、私信、接受请求都在电脑上做,这里只看。</Hint>
      </View>
      {err ? <Note tone="error">{err}</Note> : null}
      {rows === null ? (
        <View style={{ paddingVertical: space.xl, alignItems: "center" }}><Spinner /></View>
      ) : rows.length === 0 ? (
        <Card>
          <Headline>还没有好友</Headline>
          <Hint>在电脑上的「好友」里加一个,这里会出现。</Hint>
        </Card>
      ) : (
        rows.map((f) => <FriendRowView key={f.profile.id} row={f} />)
      )}
      <Button label="刷新" variant="plain" onPress={load} />
    </Page>
  );
}

function FriendRowView({ row: f }: { row: FriendRow }) {
  const { c } = usePalette();
  const waiting = f.status === "pending";
  const what = !waiting ? "好友"
    : f.direction === "incoming" ? "等你在电脑上通过" : "等对方通过";
  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {f.profile.avatarUrl
          ? <Image source={{ uri: f.profile.avatarUrl }} style={{ width: 36, height: 36, borderRadius: radius.pill }} />
          : <Tile><Text style={{ ...t.footnote, color: c.mutedForeground }}>
              {(f.profile.name || f.profile.email || "?").slice(0, 1).toUpperCase()}
            </Text></Tile>}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Headline lines={1}>{f.profile.name || f.profile.email}</Headline>
          <Meta>{f.profile.name ? `${f.profile.email} · ${what}` : what}</Meta>
        </View>
        {waiting && f.direction === "incoming" ? <Dot tone="warn" /> : null}
      </View>
    </Card>
  );
}

/* ── 设置 ───────────────────────────────────────────────
   只放**这台手机自己**的事:账号、配对、连的哪个中继。电脑上的设置
   (模型、MCP、审批策略)不在这儿改 —— ADR-0094 的边界没动。 */
function Settings({ store, onRepair, onSignedOut }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  onSignedOut: () => void;
}) {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  const signOut = (): void => {
    void (async () => {
      setBusy(true);
      await supabase.auth.signOut();
      setBusy(false);
      onSignedOut();
    })();
  };

  return (
    <Page>
      <View style={{ paddingTop: space.sm }}><Title>设置</Title></View>

      <Card style={{ gap: space.sm }}>
        <Headline>账号</Headline>
        <Meta>{email ?? "读取中…"}</Meta>
        <Button
          variant="outline" label={busy ? "退出中…" : "退出登录"}
          disabled={busy} onPress={signOut}
        />
      </Card>

      <Card style={{ gap: space.sm }}>
        <Headline>配对的电脑</Headline>
        <Hint>
          {store.peerIdentity()
            ? "已配对。换电脑、或安全码对不上时重新配一次。"
            : "还没配对。"}
        </Hint>
        <Button variant="outline" label="重新配对" onPress={onRepair} />
      </Card>

      <Card style={{ gap: space.sm }}>
        <Headline>连接</Headline>
        {/* 中继看不见内容(端到端加密),但连的是哪一台是排查时的第一个问题 */}
        <Meta>{`中继 ${RELAY_BASE}`}</Meta>
        <Meta>{`本机 ${store.deviceId}`}</Meta>
      </Card>
    </Page>
  );
}

/* ── 舰队 ───────────────────────────────────────────────
   看 + 审批。桌面不在线时不假装有内容:一句"你的 Mac 不在线"
   (中继零落盘,没有队列可回放 —— 这是设计,不是缺陷)。 */
function Fleet({ store, onRepair, onDetailChange }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  /** 翻进详情屏时底栏要收起来 */
  onDetailChange: (inDetail: boolean) => void;
}) {
  const [fleet, setFleet] = useState<IslandFleet | null>(null);
  const [ready, setReady] = useState(false);
  /** 打开的会话。null = 停在列表上 */
  const [open, setOpen] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<MobileMessage[] | null>(null);
  const bridge = useRef<MobileBridge | null>(null);
  /** 订阅状态归手机(桌面那侧的 watch 是连接级的,断了就忘)。
      重连后要靠这个 ref 把 watch 补发一次 —— 否则详情屏会永远停在旧内容 */
  const watching = useRef<string | null>(null);
  /** 收起的工作区(全路径为键)。**内存态,不持久化** —— 和灵动岛那侧同一个决定:
      收起是"这会儿别占地方",不是一条要记住的偏好 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 手机上没有终端。这两样是详情屏在"等不到内容"时唯一能给人看的东西 */
  const [diag, setDiag] = useState<{ frames: number; timelines: number; log: string[] }>(
    { frames: 0, timelines: 0, log: [] },
  );

  useEffect(() => {
    const b = connect(store, {
      onLog: (m) => setDiag((d) => ({ ...d, log: [...d.log, m].slice(-6) })),
      onFrame: (f) => {
        setDiag((d) => ({
          ...d,
          frames: d.frames + 1,
          timelines: d.timelines + (f.type === "timeline" ? 1 : 0),
        }));
        if (f.type === "fleet") setFleet(f.fleet);
        // 只认自己订的那一个:换会话时旧订阅的迟到帧不该覆盖新屏
        else if (f.type === "timeline" && f.sessionId === watching.current) setTimeline(f.messages);
      },
      onReady: (r) => {
        setReady(r);
        // **断线不清屏**。第一版这里把 fleet 和 timeline 都清成 null,于是
        // 每一次抖动(切后台回来、Wi-Fi 切蜂窝、网关掐 idle)都会把人正在读的
        // 那一屏换成整页"你的 Mac 不在线",两秒后又换回来。断线是常态,
        // 而"清屏"是个不可逆的动作——它把内容和连接状态混成了一件事。
        // 现在只有连接状态会变,内容留着,由横幅说清楚它是断线前的。
        if (r && watching.current) b.send({ type: "watch", sessionId: watching.current });
      },
    });
    bridge.current = b;
    return () => b.dispose();
  }, [store]);

  const openSession = (sessionId: string): void => {
    onDetailChange(true);
    watching.current = sessionId;
    setTimeline(null); // 上一个会话的内容一帧都不要留在屏上
    setOpen(sessionId);
    bridge.current?.send({ type: "watch", sessionId });
  };

  // 打开的那个会话可能从舰队里消失(电脑上关掉了):退回列表,别停在一屏死内容。
  // 放 effect 里而不是渲染里 —— 渲染期 setState 是 React 的未定义行为
  useEffect(() => {
    if (open !== null && fleet && !fleet.agents.some((a) => a.sessionId === open)) closeSession();
    // closeSession 每次 render 新建,不进依赖:它只读 ref + setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fleet]);

  const closeSession = (): void => {
    onDetailChange(false);
    const sid = watching.current;
    watching.current = null;
    setOpen(null);
    setTimeline(null);
    if (sid) bridge.current?.send({ type: "unwatch", sessionId: sid });
  };

  // 有会话在跑才让钟走 —— 空闲时不必每秒唤醒 JS 线程
  const now = useTicker((fleet?.agents ?? []).some((a) => a.phase === "active"));

  /** 回 false = 会话没建立。**不乐观回显**:把一条没发出去的消息画在时间线上,
      比直接说"没连上"糟糕得多 —— 用户会以为电脑那边已经在跑了 */
  const sendText = (sessionId: string, text: string): boolean =>
    bridge.current?.send({ type: "send", sessionId, text }) ?? false;

  // 断了先当抖动看:这么久还没回来才认定是真离线(而且只在**一无所有**时才翻脸,
  // 手里有快照就一直留着,见 onReady)。冷启动同样走这条——刚打开 app 的
  // 头一两秒握手还没完,直接甩一句"你的 Mac 不在线"是在说谎
  const GRACE_MS = 6_000;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (ready) return setSettled(false);
    const id = setTimeout(() => setSettled(true), GRACE_MS);
    return () => clearTimeout(id);
  }, [ready]);

  const decide = (a: IslandAgent, ok: boolean): void => {
    const callId = a.pendingApproval?.callId;
    if (!callId) return;
    // send 回 false = 会话没建立。不乐观更新:审批这种动作显示成"批了"
    // 而其实没发出去,比显示"没连上"糟糕得多
    bridge.current?.send({
      type: ok ? "approve" : "deny", sessionId: a.sessionId, callId,
    });
  };

  // 一无所有的两种:还在等第一份(转圈),和等够了还没有(说实话)
  if (!fleet) {
    if (!settled) {
      return (
        <Page grow>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Spinner />
          </View>
        </Page>
      );
    }
    return (
      <Page>
        <View style={{ gap: space.sm, paddingTop: space.xl }}>
          <Title>你的 Mac 不在线</Title>
          <Hint>它上线之后这里会自动出现。中继不落盘,期间发生的事不会补播。</Hint>
        </View>
        <Button label="重新配对" variant="plain" onPress={onRepair} />
      </Page>
    );
  }

  const opened = open === null ? null : fleet.agents.find((a) => a.sessionId === open) ?? null;
  if (opened) {
    return (
      <SessionView
        agent={opened} now={now} messages={timeline} diag={diag} online={ready}
        onBack={closeSession} onDecide={decide}
        onSend={(text) => sendText(opened.sessionId, text)}
        onRetry={() => bridge.current?.send({ type: "watch", sessionId: opened.sessionId })}
      />
    );
  }

  return (
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>会话</Title>
        {ready
          ? <StatusLine tone="ok">已连上你的 Mac</StatusLine>
          : <StatusLine tone="warn">{settled ? "断开了,下面是断线前的" : "重连中…"}</StatusLine>}
      </View>
      {fleet.agents.length === 0 ? (
        <Card>
          <Headline>没有打开的会话</Headline>
          <Hint>在电脑上开一个,这里会自己出现。</Hint>
        </Card>
      ) : (
        // 分组和灵动岛同一套(shared/remote/groups.ts):同一份 IslandFleet
        // 在桌面、岛、手机上不该长得不一样
        groupByWorkspace(fleet.agents).map((g, i) => {
          const shut = collapsed.has(g.key);
          return (
            <View key={`${g.key}#${i}`} style={{ gap: space.sm }}>
              <WorkspaceHeader
                group={g} collapsed={shut}
                onToggle={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(g.key)) next.add(g.key);
                  return next;
                })}
              />
              {shut ? null : g.agents.map((a) => (
                <AgentCard
                  key={a.sessionId} agent={a} now={now} onDecide={decide} online={ready}
                  onOpen={() => openSession(a.sessionId)}
                />
              ))}
            </View>
          );
        })
      )}
    </Page>
  );
}

/**
 * 键盘占了屏幕底下多少,给一个直接能当 paddingBottom 用的数。
 *
 * **为什么不是 KeyboardAvoidingView**:它的 behavior="padding" 拿
 * `_frame.y + _frame.height` 和键盘的 screenY 求差,而 `_frame` 来自 onLayout ——
 * 那是**相对父级**的坐标,不是屏幕坐标。这一屏挂在 SafeAreaView 里(顶上还有
 * 一条安全区),KAV 于是以为自己的底边比实际高了整整一个顶部安全区,让位就少
 * 那么多,输入框照样被盖掉一截。包错层是一点不让,包对层是让少了——两次都不对,
 * 原因不同,而第二次比第一次更难看出来。
 *
 * 自己量没这个歧义:measureInWindow 给的是屏幕坐标,和 endCoordinates.screenY
 * 同一套系。只在 layout 时量一次存下来,键盘事件里就不必等异步回调——让位得和
 * 键盘同一帧开始动,晚一帧就看得出来。
 *
 * Android 不接:系统的 adjustResize 已经把窗口缩过了,再让一次是双份。
 */
function useKeyboardInset(onShow: () => void): {
  root: { ref: React.RefObject<View | null>; onLayout: () => void };
  keyboard: number;
} {
  const ref = useRef<View | null>(null);
  /** 这一屏底边在屏幕坐标里的位置 */
  const bottom = useRef<number | null>(null);
  const [inset, setInset] = useState(0);
  const onLayout = (): void => {
    ref.current?.measureInWindow((_x, y, _w, h) => { bottom.current = y + h; });
  };

  // 回调每次 render 都是新的,但监听只装一次:存进 ref,别让它进依赖
  const shown = useRef(onShow);
  shown.current = onShow;

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // willChangeFrame 一个事件管收放两头:收起时 screenY 就是屏幕高度,差值自然归零
    const sub = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      const b = bottom.current;
      if (b === null) return;
      const next = Math.max(0, b - e.endCoordinates.screenY);
      LayoutAnimation.configureNext({
        duration: e.duration || 250,
        update: { type: LayoutAnimation.Types.keyboard },
      });
      setInset(next);
      if (next > 0) shown.current();
    });
    return () => sub.remove();
  }, []);

  return { root: { ref, onLayout }, keyboard: inset };
}

/** 一秒一跳的钟。只在有会话真的在跑时才装 —— 空闲时不必让 JS 线程每秒醒一次 */
function useTicker(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

function elapsed(since: number, now: number): string {
  const sec = Math.max(0, Math.round((now - since) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/** 工作区组头。整行可点收放,和灵动岛的 workspaceHeader 一个形状。
    **收起时组内状态不能凭空消失**:组里有等审批的给 warn 点(要人动手的那种,
    绝不能被收起藏没),否则有 active 给 busy 点 —— 这是收起功能能不能用的前提。 */
function WorkspaceHeader({ group: g, collapsed, onToggle }: {
  group: WorkspaceGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { c } = usePalette();
  const tone = collapsed ? groupTone(g) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      onPress={onToggle}
      hitSlop={8}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: space.xs, paddingTop: space.xs },
        pressed && { opacity: 0.5 },
      ]}
    >
      <Text style={{ ...t.footnote, color: c.mutedForeground, width: 12 }}>
        {collapsed ? "▸" : "▾"}
      </Text>
      <Text style={{ ...t.footnote, color: c.mutedForeground }} numberOfLines={1}>
        {g.label}
      </Text>
      {tone ? <Dot tone={tone} /> : null}
    </Pressable>
  );
}

function AgentCard({ agent: a, now, onDecide, onOpen, online }: {
  agent: IslandAgent;
  now: number;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  onOpen: () => void;
  online: boolean;
}) {
  const { c } = usePalette();
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";
  const d = a.turnDiff;

  return (
    <Card style={{ gap: space.sm }}>
      {/* 行首方块 + 标题,和桌面 permission-grant 的头一行同构 */}
      {/* 整行可点:点进去看时间线。审批那两个键是各自的 Pressable,不会被这一层截走 */}
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: space.sm },
          pressed && { opacity: 0.6 },
        ]}
      >
        <Tile><Dot tone={tone} /></Tile>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {/* 标题是用户起的,长度没有上限:限一行,超了省略号收尾 */}
          <Headline lines={1}>{a.title ?? a.sessionId}</Headline>
          {/* 元信息一律等宽 + 暗:桌面那侧 `1 步 · 120 tokens` 就是这个样式 */}
          <Meta>
            {what}
            {a.phase === "active" && a.turnStartedAt ? ` · ${elapsed(a.turnStartedAt, now)}` : ""}
            {a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
          </Meta>
        </View>
        {/* 可点的记号。没有它,一张卡片看不出能不能按 */}
        <Text style={{ ...t.title, color: c.mutedForeground, marginTop: -2 }}>›</Text>
      </Pressable>

      {/* 本轮改了多少 —— 桌面和对话视图消费同一份统计,两处只能显示同一个数 */}
      {d ? (
        <View style={{ flexDirection: "row", gap: space.sm, paddingLeft: 28 + space.sm }}>
          <Meta>{d.files} 文件</Meta>
          <Text style={{ ...t.footnote, color: c.ok, fontFamily: MONO }}>+{d.additions}</Text>
          <Text style={{ ...t.footnote, color: c.destructive, fontFamily: MONO }}>−{d.deletions}</Text>
        </View>
      ) : null}

      {a.pendingApproval ? <Approval agent={a} onDecide={onDecide} online={online} /> : null}
    </Card>
  );
}

/* ── 会话详情 ───────────────────────────────────────────
   点进来看时间线 + 就地审批。三件事值得说清楚:

   1. **待批那一块钉在底部**,不跟着时间线滚。审批是这一屏唯一的动作,
      而它在日志里的位置可能在几十条之上 —— 让人为了按一下先滚半天是坏的。
   2. **时间线只有三种角色**,而且已经在桌面那侧截过了(shared/remote/timeline.ts)。
      这里不再截,只把 truncated 标记翻译成一句"在电脑上看全文"。
   3. **新消息到了自动滚到底**,但只在人本来就贴着底的时候 —— 正在往回翻的人
      被拽回底部比不自动滚更烦。 */
function SessionView({ agent: a, now, messages, diag, online, onBack, onDecide, onSend, onRetry }: {
  agent: IslandAgent;
  now: number;
  messages: MobileMessage[] | null;
  /** 连接活着没有。断了这一屏**不清空**——留着断线前的内容,顶上挂一条横幅
      说清楚它是旧的,同时把审批和发送都锁上 */
  online: boolean;
  diag: { frames: number; timelines: number; log: string[] };
  onBack: () => void;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  onSend: (text: string) => boolean;
  onRetry: () => void;
}) {
  const { c } = usePalette();
  const list = useRef<ScrollView | null>(null);
  const atBottom = useRef(true);
  /** 4 秒还没等到内容就别再转圈了。**一个永远转下去的菊花是最差的状态**:
      它和"这个会话是空的"、"帧被丢了"、"根本没连上"长得一模一样,
      而这三种情况用户该做的事完全不同 */
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const id = setTimeout(() => setWaited(true), 4_000);
    return () => clearTimeout(id);
  }, [a.sessionId, messages]);
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";

  useEffect(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const { root, keyboard } = useKeyboardInset(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  });

  return (
    // paddingBottom 让位给键盘。**这里不能用 KeyboardAvoidingView**——见 useKeyboardInset。
    // 之所以把内边距加在 flex:1 的外层而不是加在输入框上:外层的高度由父级定,
    // 内边距不改变它自己的 frame,所以量出来的位置在键盘开合期间是稳的(不会自激)
    <View
      ref={root.ref}
      onLayout={root.onLayout}
      style={{ flex: 1, paddingBottom: keyboard }}
    >
      {/* 顶栏。返回在左上,和 iOS 的方向一致 */}
      <View style={{
        paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
        flexDirection: "row", alignItems: "center", gap: space.xs,
      }}>
        <Pressable
          accessibilityRole="button" onPress={onBack} hitSlop={12}
          style={({ pressed }) => [{ paddingVertical: 6, paddingRight: space.xs }, pressed && { opacity: 0.5 }]}
        >
          <Text style={{ ...t.body, color: c.brand }}>‹ 会话</Text>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ ...t.headline, color: c.foreground }} numberOfLines={1}>
            {a.title ?? a.sessionId}
          </Text>
        </View>
        <Dot tone={tone} />
      </View>

      {online ? null : (
        <View style={{
          paddingHorizontal: space.md, paddingVertical: space.xs,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
        }}>
          <StatusLine tone="warn">断开了 —— 下面是断线前的</StatusLine>
        </View>
      )}

      <ScrollView
        ref={list}
        style={{ flex: 1 }}
        // 往回翻就收键盘(iOS 的 interactive:跟着手指走,不是硬收);
        // 键盘还开着时点审批键要一次就中,所以 taps 不被键盘吃掉
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.md, gap: space.sm, paddingBottom: space.lg }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          // 24pt 的容差:滚动位置是浮点的,严格相等永远不成立
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
        }}
        scrollEventThrottle={100}
      >
        <Meta>
          {what}
          {a.phase === "active" && a.turnStartedAt ? ` · ${elapsed(a.turnStartedAt, now)}` : ""}
          {a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
        </Meta>
        {messages === null ? (
          waited ? (
            <Card style={{ gap: space.sm }}>
              <Headline>没等到时间线</Headline>
              <Hint>电脑那侧收到订阅了才会推。下面是这条连接说过的话:</Hint>
              <Meta>{`收到 ${diag.frames} 帧,其中时间线 ${diag.timelines} 条`}</Meta>
              {diag.log.map((line, i) => <Meta key={i}>{line}</Meta>)}
              <Button variant="outline" label="重新订阅" onPress={onRetry} />
            </Card>
          ) : (
            <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
              <Spinner />
            </View>
          )
        ) : messages.length === 0 ? (
          <Hint>这个会话还没有内容。</Hint>
        ) : (
          // 连续的工具调用先并成一组再画(shared/remote/timeline.ts)
          groupTimeline(messages).map((item) =>
            item.kind === "tools"
              ? <ToolGroup key={item.index} tools={item.tools} />
              : <Msg key={item.index} msg={item.message} />,
          )
        )}
      </ScrollView>

      {/* 审批在输入框上面:它是有时限的那个 */}
      <View>
        {a.pendingApproval ? (
          <View style={{
            padding: space.md,
            borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
            backgroundColor: c.background,
          }}>
            <Approval agent={a} onDecide={onDecide} online={online} />
          </View>
        ) : null}
        <Composer onSend={onSend} online={online} />
      </View>
    </View>
  );
}

/** 回一条消息。范围就到这里(ADR-0094):不建会话、不切模型、不带附件 ——
    手机端是"看 + 审批"的第三个投影窗口,不是第二个完整客户端。

    发送键是个圆的、只有一个箭头 —— 和桌面输入区右下角那个同一个形状。
    多行输入里的回车是换行不是发送:手机上没有 Shift 可以按,把回车做成发送
    等于让人没法打第二段。 */
function Composer({ onSend, online }: {
  onSend: (text: string) => boolean;
  online: boolean;
}) {
  const { c } = usePalette();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // 断线时输入框**不禁用**,只是发不出去:人可以照打,连接回来再按发送。
  // 禁用输入框会把已经打了一半的字连同光标一起抢走
  const ready = online && text.trim().length > 0;

  const submit = (): void => {
    const t = text.trim();
    if (!t) return;
    if (!onSend(t)) return setErr("没发出去 —— 你的 Mac 不在线");
    // 发出去了才清空:失败时把人打的字吞掉是不可接受的
    setErr(null);
    setText("");
  };

  return (
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
            borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
            paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11,
            // 长文本自己长高,但到五六行就封顶——再高就把时间线挤没了
            maxHeight: 132, ...t.body,
          }}
          placeholder={online ? "回一条…" : "断开了,连回来再发"}
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
  );
}

/** 一条消息。三种角色三种读法,和桌面对话视图一致:
    user 是右边的蓝气泡;
    assistant 是左边的裸正文走 markdown(它篇幅最长,套气泡整屏都是框);
    tool 不在这里 —— 它被 groupTimeline 折叠成一行了。 */
function Msg({ msg: m }: { msg: MobileMessage }) {
  const { c } = usePalette();
  const tail = m.truncated ? <Meta>… 太长了,在电脑上看全文</Meta> : null;

  if (m.role === "user") {
    return (
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <View style={{
          backgroundColor: c.primary, borderRadius: radius.control,
          paddingHorizontal: space.md, paddingVertical: space.sm, maxWidth: "88%",
        }}>
          {/* 用户打的是纯文本,不当 markdown 解析:把人手打的 * 渲染成粗体是错的 */}
          <Text style={{ ...t.body, color: c.primaryForeground }}>{m.text}</Text>
        </View>
        {tail}
      </View>
    );
  }
  return (
    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
      <Markdown source={m.text} />
      {tail}
    </View>
  );
}

/** 助手正文。解析在 shared/remote/markdown.ts(纯的、跟着根门禁跑),
    这里只负责把块和片段画出来。 */
function Markdown({ source }: { source: string }) {
  const { c } = usePalette();
  const blocks = parseMarkdown(source);
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((b, i) => {
        if (b.kind === "code") return <CodeBlock key={i} lang={b.lang} text={b.text} />;
        if (b.kind === "heading") {
          // 标题只用字号和字重拉开,不加下划线/色块 —— 桌面那侧也是
          const size = b.level <= 2 ? 20 : 17;
          return (
            <Text key={i} style={{ fontSize: size, lineHeight: size + 7, fontWeight: "700",
              letterSpacing: -0.3, color: c.foreground, marginTop: space.xs }}>
              <Spans spans={b.spans} />
            </Text>
          );
        }
        if (b.kind === "bullet" || b.kind === "ordered") {
          return (
            <View key={i} style={{ flexDirection: "row", gap: space.xs }}>
              {/* 记号列固定宽:序号 1 和 10 的正文要对齐 */}
              <Text style={{ ...t.body, color: c.mutedForeground, minWidth: 18, textAlign: "right" }}>
                {b.kind === "bullet" ? "•" : `${b.marker}.`}
              </Text>
              <Text style={{ ...t.body, color: c.foreground, flex: 1 }}>
                <Spans spans={b.spans} />
              </Text>
            </View>
          );
        }
        return (
          <Text key={i} style={{ ...t.body, color: c.foreground }}>
            <Spans spans={b.spans} />
          </Text>
        );
      })}
    </View>
  );
}

/** 行内片段。code 片给一块浅底 + 等宽,和桌面的 `--code-bg` 一个意思 */
function Spans({ spans }: { spans: MdSpan[] }) {
  const { c } = usePalette();
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <Text key={i} style={{
            fontFamily: MONO, fontSize: 14, color: c.foreground, backgroundColor: c.muted,
          }}>
            {` ${s.text} `}
          </Text>
        ) : (
          <Text key={i} style={s.bold ? { fontWeight: "700", color: c.foreground } : undefined}>
            {s.text}
          </Text>
        ),
      )}
    </>
  );
}

/** 代码块。**横向滚动,不换行** —— 代码换行之后缩进就没意义了,
    而缩进是读代码的第一层信息(桌面那侧的代码块也是横着滚的)。 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { c } = usePalette();
  return (
    <View style={{
      borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
      backgroundColor: c.card, overflow: "hidden",
    }}>
      {lang ? (
        <View style={{
          paddingHorizontal: space.sm + 2, paddingTop: space.xs, paddingBottom: 2,
        }}>
          <Meta>{lang}</Meta>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: space.sm + 2 }}>
        <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: c.foreground }}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** 折叠起来的一组工具调用。**默认收起** —— 一次 bash 的输出能把整屏占满,
    而人翻这一屏是为了看模型说了什么。和桌面的 `2 tool calls ›` 同一个形状。 */
function ToolGroup({ tools }: { tools: MobileMessage[] }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const names = tools.map((x) => splitTool(x).name);
  const label = tools.length === 1 ? names[0] : `${tools.length} 次工具调用`;

  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: 2 },
          pressed && { opacity: 0.5 },
        ]}
      >
        <Text style={{ ...t.footnote, color: c.mutedForeground, fontFamily: MONO }}>
          {label}
        </Text>
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>{open ? "▾" : "›"}</Text>
      </Pressable>
      {open
        ? tools.map((x, i) => {
            const { name, output } = splitTool(x);
            return (
              <View key={i} style={{
                borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth,
                borderColor: c.border, padding: space.sm + 2, gap: 2,
              }}>
                <Meta>{name}</Meta>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: c.mutedForeground }}>
                    {output}
                  </Text>
                </ScrollView>
                {x.truncated ? <Meta>… 太长了,在电脑上看全文</Meta> : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

/** 待批的那一块。形状照着桌面的 permission-grant:一条细边围出来的板、行首方块、
    动作行**右对齐的小胶囊**——安静,不抢卡片的主体。
    刻意不做左侧色条、不给它更深的底:更深的底在卡片里读成一个洞,而不是浮起来的一层。 */
function Approval({ agent: a, onDecide, online }: {
  agent: IslandAgent;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  /** 断线时两个键都按不动。**能按但按了没用是最坏的一种**:审批有时限,
      而一个"批过了"的错觉会让人放下手机走开 */
  online: boolean;
}) {
  const { c } = usePalette();
  const p = a.pendingApproval;
  if (!p) return null;
  return (
    <View style={{
      borderRadius: radius.card, padding: space.md, gap: space.sm, marginTop: space.xs,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {/* 方块对齐第一行文字,不是对齐整块的中线 —— 路径换行之后中线会跑偏 */}
        <View style={{ marginTop: 1 }}>
          <Tile>
            <Text style={{ ...t.headline, color: c.warn, fontFamily: MONO }}>!</Text>
          </Tile>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ ...t.body, color: c.foreground, fontFamily: MONO }} numberOfLines={1}>
            {p.verb} {p.target}
          </Text>
          {p.fullPath ? <Meta>{p.fullPath}</Meta> : null}
        </View>
      </View>
      {/* 顺序和轻重跟桌面 permission-grant 一致:拒绝是不着色的纯文字,批准是实底的;
          确认动作在右,和 iOS 弹窗一个方向。拒绝不染红——红是"这个动作危险"的意思,
          而这里危险的是批准 */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs }}>
        {online ? null : <Meta>断开了,按不了</Meta>}
        <Button size="auto" variant="quiet" label="拒绝" disabled={!online} onPress={() => onDecide(a, false)} />
        <Button size="auto" label="批准" disabled={!online} onPress={() => onDecide(a, true)} />
      </View>
    </View>
  );
}
