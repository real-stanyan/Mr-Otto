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
  ActivityIndicator, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import type { IslandAgent, IslandFleet } from "../src/shared/shellBridge.js";
import type { PinnedPeerStore, RemotePeer } from "../src/shared/remote/devices.js";
import type { MobileBridge } from "../src/shared/remote/mobileBridge.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { connect, devices, openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, MONO, radius, space } from "./src/theme.js";
import {
  Button, Card, CodeTiles, Headline, Hint, Mono, Note, StatusLine, Strong, Title, Warn,
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

/** 每一屏的滚动容器。标题和正文之间留一口气,列表项之间留小的 */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
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
    <Page>
      <View style={{ gap: space.xs, paddingTop: space.lg }}>
        <Title>Mr Otto</Title>
        <Hint>用<Strong>和电脑上同一个</Strong>账号登录。</Hint>
      </View>
      {err ? <Note tone="error">{err}</Note> : null}
      <View style={{ gap: space.sm }}>
        <Button
          variant="secondary"
          label={busy === "google" ? "登录中…" : "用 Google 登录"}
          disabled={busy !== null}
          onPress={() => oauth("google")}
        />
        <Button
          variant="secondary"
          label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
          disabled={busy !== null}
          onPress={() => oauth("github")}
        />
      </View>
      {showPassword ? (
        <PasswordForm disabled={busy !== null} onError={setErr} onDone={onDone} />
      ) : (
        <Button label="用邮箱密码登录" variant="ghost" onPress={() => setShowPassword(true)} />
      )}
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
      <Button label="刷新" variant="ghost" onPress={refresh} />
    </Page>
  );
}

/* ── 舰队 ───────────────────────────────────────────────
   看 + 审批。桌面不在线时不假装有内容:一句"你的 Mac 不在线"
   (中继零落盘,没有队列可回放 —— 这是设计,不是缺陷)。 */
function Fleet({ store, onRepair }: { store: PinnedPeerStore; onRepair: () => void }) {
  const [fleet, setFleet] = useState<IslandFleet | null>(null);
  const [ready, setReady] = useState(false);
  const bridge = useRef<MobileBridge | null>(null);

  useEffect(() => {
    const b = connect(store, {
      onFrame: (f) => {
        if (f.type === "fleet") setFleet(f.fleet);
        // timeline / ping 在下一刀接:watch/unwatch 桌面那侧还没实现
      },
      onReady: (r) => {
        setReady(r);
        if (!r) setFleet(null); // 断了就别再展示一份陈旧快照
      },
    });
    bridge.current = b;
    return () => b.dispose();
  }, [store]);

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
        <Button label="重新配对" variant="ghost" onPress={onRepair} />
      </Page>
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
        fleet.agents.map((a) => <AgentCard key={a.sessionId} agent={a} onDecide={decide} />)
      )}
    </Page>
  );
}

function AgentCard({ agent: a, onDecide }: {
  agent: IslandAgent;
  onDecide: (a: IslandAgent, ok: boolean) => void;
}) {
  const { c } = usePalette();
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";

  return (
    <Card style={{ gap: space.sm }}>
      <Headline>{a.title ?? a.sessionId}</Headline>
      <StatusLine tone={tone}>
        {what}{a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
      </StatusLine>
      {a.pendingApproval ? (
        // 待批的那一块单独浮一层,左边一条 warn 色边 —— 一眼能在一列卡片里找到它
        <View style={{
          backgroundColor: c.background, borderRadius: radius.control, padding: space.md,
          gap: space.sm, marginTop: space.xs,
          borderLeftWidth: 3, borderLeftColor: c.warn,
          borderTopWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        }}>
          <Text style={{ ...t.body, color: c.foreground, fontFamily: MONO }}>
            {a.pendingApproval.verb} {a.pendingApproval.target}
          </Text>
          {a.pendingApproval.fullPath ? <Mono>{a.pendingApproval.fullPath}</Mono> : null}
          {/* 顺序和轻重跟桌面的 permission-grant 一致:拒绝是不着色的那个,
              批准是实底的那个;确认动作在右,和 iOS 的弹窗一个方向 */}
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
            <Button grow variant="secondary" label="拒绝" onPress={() => onDecide(a, false)} />
            <Button grow label="批准" onPress={() => onDecide(a, true)} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}
