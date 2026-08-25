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
  ActivityIndicator, Image, Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import type { IslandAgent, IslandFleet } from "../src/shared/shellBridge.js";
import type { MobileMessage } from "../src/shared/remote/frames.js";
import type { PinnedPeerStore, RemotePeer } from "../src/shared/remote/devices.js";
import type { MobileBridge } from "../src/shared/remote/mobileBridge.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { connect, devices, openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, MONO, radius, space } from "./src/theme.js";
import {
  Button, Card, CodeTiles, Dot, Headline, Hint, Meta, Note, StatusLine, Strong, Tile, Title, Warn,
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
        <Fleet store={store} onRepair={() => setPhase("pair")} />
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

/* ── 舰队 ───────────────────────────────────────────────
   看 + 审批。桌面不在线时不假装有内容:一句"你的 Mac 不在线"
   (中继零落盘,没有队列可回放 —— 这是设计,不是缺陷)。 */
function Fleet({ store, onRepair }: { store: PinnedPeerStore; onRepair: () => void }) {
  const [fleet, setFleet] = useState<IslandFleet | null>(null);
  const [ready, setReady] = useState(false);
  /** 打开的会话。null = 停在列表上 */
  const [open, setOpen] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<MobileMessage[] | null>(null);
  const bridge = useRef<MobileBridge | null>(null);
  /** 订阅状态归手机(桌面那侧的 watch 是连接级的,断了就忘)。
      重连后要靠这个 ref 把 watch 补发一次 —— 否则详情屏会永远停在旧内容 */
  const watching = useRef<string | null>(null);

  useEffect(() => {
    const b = connect(store, {
      onFrame: (f) => {
        if (f.type === "fleet") setFleet(f.fleet);
        // 只认自己订的那一个:换会话时旧订阅的迟到帧不该覆盖新屏
        else if (f.type === "timeline" && f.sessionId === watching.current) setTimeline(f.messages);
      },
      onReady: (r) => {
        setReady(r);
        if (!r) {
          setFleet(null); // 断了就别再展示一份陈旧快照
          setTimeline(null);
        } else if (watching.current) {
          b.send({ type: "watch", sessionId: watching.current });
        }
      },
    });
    bridge.current = b;
    return () => b.dispose();
  }, [store]);

  const openSession = (sessionId: string): void => {
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
    const sid = watching.current;
    watching.current = null;
    setOpen(null);
    setTimeline(null);
    if (sid) bridge.current?.send({ type: "unwatch", sessionId: sid });
  };

  // 有会话在跑才让钟走 —— 空闲时不必每秒唤醒 JS 线程
  const now = useTicker((fleet?.agents ?? []).some((a) => a.phase === "active"));

  const decide = (a: IslandAgent, ok: boolean): void => {
    const callId = a.pendingApproval?.callId;
    if (!callId) return;
    // send 回 false = 会话没建立。不乐观更新:审批这种动作显示成"批了"
    // 而其实没发出去,比显示"没连上"糟糕得多
    bridge.current?.send({
      type: ok ? "approve" : "deny", sessionId: a.sessionId, callId,
    });
  };

  if (!ready || !fleet) {
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
        agent={opened} now={now} messages={timeline}
        onBack={closeSession} onDecide={decide}
      />
    );
  }

  return (
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.sm }}>
        <Title>会话</Title>
        <StatusLine tone="ok">已连上你的 Mac</StatusLine>
      </View>
      {fleet.agents.length === 0 ? (
        <Card>
          <Headline>没有打开的会话</Headline>
          <Hint>在电脑上开一个,这里会自己出现。</Hint>
        </Card>
      ) : (
        fleet.agents.map((a) => (
          <AgentCard
            key={a.sessionId} agent={a} now={now} onDecide={decide}
            onOpen={() => openSession(a.sessionId)}
          />
        ))
      )}
    </Page>
  );
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

function AgentCard({ agent: a, now, onDecide, onOpen }: {
  agent: IslandAgent;
  now: number;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  onOpen: () => void;
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
          <Headline>{a.title ?? a.sessionId}</Headline>
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

      {a.pendingApproval ? <Approval agent={a} onDecide={onDecide} /> : null}
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
function SessionView({ agent: a, now, messages, onBack, onDecide }: {
  agent: IslandAgent;
  now: number;
  messages: MobileMessage[] | null;
  onBack: () => void;
  onDecide: (a: IslandAgent, ok: boolean) => void;
}) {
  const { c } = usePalette();
  const list = useRef<ScrollView | null>(null);
  const atBottom = useRef(true);
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";

  useEffect(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  }, [messages]);

  return (
    <View style={{ flex: 1 }}>
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

      <ScrollView
        ref={list}
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
          <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
            <Spinner />
          </View>
        ) : messages.length === 0 ? (
          <Hint>这个会话还没有内容。</Hint>
        ) : (
          messages.map((m, i) => <Msg key={i} msg={m} />)
        )}
      </ScrollView>

      {a.pendingApproval ? (
        <View style={{
          padding: space.md,
          borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
          backgroundColor: c.background,
        }}>
          <Approval agent={a} onDecide={onDecide} />
        </View>
      ) : null}
    </View>
  );
}

/** 一条消息。三种角色三种读法:
    user 是右边的蓝气泡(和桌面对话视图同一个位置和颜色);
    assistant 是左边的裸正文,不套气泡 —— 它占的篇幅最长,套上去整屏都是框;
    tool 是等宽的暗块,第一行是工具名。 */
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
          <Text style={{ ...t.body, color: c.primaryForeground }}>{m.text}</Text>
        </View>
        {tail}
      </View>
    );
  }
  if (m.role === "assistant") {
    return (
      <View style={{ gap: 2, paddingVertical: space.xs }}>
        <Text style={{ ...t.body, color: c.foreground }}>{m.text}</Text>
        {tail}
      </View>
    );
  }
  return (
    <View style={{
      borderRadius: radius.control, padding: space.sm + 2, gap: 2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <Text style={{ ...t.footnote, color: c.mutedForeground, fontFamily: MONO }}>{m.text}</Text>
      {tail}
    </View>
  );
}

/** 待批的那一块。形状照着桌面的 permission-grant:一条细边围出来的板、行首方块、
    动作行**右对齐的小胶囊**——安静,不抢卡片的主体。
    刻意不做左侧色条、不给它更深的底:更深的底在卡片里读成一个洞,而不是浮起来的一层。 */
function Approval({ agent: a, onDecide }: {
  agent: IslandAgent;
  onDecide: (a: IslandAgent, ok: boolean) => void;
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
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.xs }}>
        <Button size="auto" variant="quiet" label="拒绝" onPress={() => onDecide(a, false)} />
        <Button size="auto" label="批准" onPress={() => onDecide(a, true)} />
      </View>
    </View>
  );
}
