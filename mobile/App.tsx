// 手机端的全部界面。三屏,一个状态机推着走:
//   登录 → 配对(核对 6 位安全码) → 舰队(看 + 审批)
//
// 范围就到这里(ADR-0094):不建会话、不改设置、不切模型、不管 MCP。
// 屏幕少到不值得上路由 —— 一个 phase 字段比 expo-router 少一整层依赖。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { IslandAgent, IslandFleet } from "../src/shared/shellBridge.js";
import type { PinnedPeerStore, RemotePeer } from "../src/shared/remote/devices.js";
import type { MobileBridge } from "../src/shared/remote/mobileBridge.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { connect, devices, openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";

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

  if (error) return <Center><Text style={s.err}>{error}</Text></Center>;
  if (phase === "loading" || !store) return <Center><ActivityIndicator /></Center>;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      {phase === "signIn" ? (
        <SignIn onDone={() => setPhase(store.peerIdentity() ? "fleet" : "pair")} />
      ) : phase === "pair" ? (
        <Pair store={store} onPaired={() => setPhase("fleet")} />
      ) : (
        <Fleet store={store} onRepair={() => setPhase("pair")} />
      )}
    </SafeAreaView>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={[s.root, s.center]}>{children}</SafeAreaView>;
}

/* ── 登录 ───────────────────────────────────────────────
   OAuth 在上、邮箱密码在下,是因为**这个账号体系里注册走的是 OAuth**:
   用 Google 注册的账号根本没有密码,只留密码那条路的话它永远登不进来
   (虚拟机上实测就是这条:一个 Google 账号在这屏反复报 Invalid login credentials)。
   密码那半留着但收进折叠里 —— 桌面支持 signUpWithPassword,确实存在有密码的账号。 */
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
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Mr Otto</Text>
      <Text style={s.hint}>
        用<Text style={s.strong}>和电脑上同一个</Text>账号登录。
      </Text>
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Button
        label={busy === "google" ? "登录中…" : "用 Google 登录"}
        disabled={busy !== null}
        onPress={() => oauth("google")}
      />
      <Button
        label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
        disabled={busy !== null}
        onPress={() => oauth("github")}
      />
      {showPassword ? (
        <PasswordForm disabled={busy !== null} onError={setErr} onDone={onDone} />
      ) : (
        <Button label="用邮箱密码登录" variant="ghost" onPress={() => setShowPassword(true)} />
      )}
    </ScrollView>
  );
}

/** 邮箱密码那一半。只有桌面上用 signUpWithPassword 注册过的账号能走这条 */
function PasswordForm(props: {
  disabled: boolean;
  onError: (m: string | null) => void;
  onDone: () => void;
}) {
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

  return (
    <View style={s.pwBlock}>
      <TextInput
        style={s.input} placeholder="邮箱" placeholderTextColor="#6b7280"
        autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}
      />
      <TextInput
        style={s.input} placeholder="密码" placeholderTextColor="#6b7280"
        secureTextEntry value={password} onChangeText={setPassword}
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
   对上了才 pin —— 所以文案必须把"对不上就别配"说在按钮前面。 */
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
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>配对电脑</Text>
      <Text style={s.hint}>
        下面的 6 位数会同时显示在电脑的「设置 → 手机」里。
        <Text style={s.strong}>对不上就不要配</Text>——那说明中间有人换掉了公钥。
      </Text>
      {err ? <Text style={s.err}>{err}</Text> : null}
      {peers === null ? (
        <ActivityIndicator />
      ) : peers.length === 0 ? (
        <Text style={s.hint}>这个账号下还没有电脑登记。在电脑上打开「设置 → 手机」看一眼。</Text>
      ) : (
        peers.map((p) => (
          <View key={p.deviceId} style={s.card}>
            <Text style={s.cardTitle}>{p.label || p.deviceId}</Text>
            <Text style={s.code}>{p.code}</Text>
            <Button
              label={busy === p.deviceId ? "配对中…" : p.pinned ? "重新配对" : "安全码一致，配对"}
              disabled={busy === p.deviceId}
              onPress={() => void pin(p.deviceId)}
            />
          </View>
        ))
      )}
      <Button label="刷新" variant="ghost" onPress={refresh} />
    </ScrollView>
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
      <View style={[s.page, s.center]}>
        <Text style={s.h1}>你的 Mac 不在线</Text>
        <Text style={s.hint}>它上线之后这里会自动出现。</Text>
        <Button label="重新配对" variant="ghost" onPress={onRepair} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>会话</Text>
      {fleet.agents.length === 0 ? (
        <Text style={s.hint}>电脑上现在没有打开的会话。</Text>
      ) : (
        fleet.agents.map((a) => (
          <View key={a.sessionId} style={s.card}>
            <Text style={s.cardTitle}>{a.title ?? a.sessionId}</Text>
            <Text style={s.hint}>
              {a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲"}
              {a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
            </Text>
            {a.pendingApproval ? (
              <View style={s.approval}>
                <Text style={s.strong}>
                  {a.pendingApproval.verb} {a.pendingApproval.target}
                </Text>
                {a.pendingApproval.fullPath ? (
                  <Text style={s.path}>{a.pendingApproval.fullPath}</Text>
                ) : null}
                <View style={s.row}>
                  <Button grow label="批准" onPress={() => decide(a, true)} />
                  <Button grow label="拒绝" variant="danger" onPress={() => decide(a, false)} />
                </View>
              </View>
            ) : null}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
  /** 并排摆时平分宽度。竖着摆的按钮不要 flex —— 会把自己抻开 */
  grow?: boolean;
}) {
  const v = props.variant ?? "primary";
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        s.btn,
        props.grow && s.btnRow,
        v === "danger" && s.btnDanger,
        v === "ghost" && s.btnGhost,
        props.disabled && s.btnOff,
      ]}
    >
      <Text style={[s.btnText, v === "ghost" && s.btnGhostText]}>{props.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0d10" },
  center: { alignItems: "center", justifyContent: "center" },
  page: { padding: 20, gap: 12 },
  h1: { color: "#f3f4f6", fontSize: 24, fontWeight: "700" },
  hint: { color: "#9ca3af", fontSize: 14, lineHeight: 20 },
  strong: { color: "#f3f4f6", fontWeight: "700" },
  path: { color: "#9ca3af", fontSize: 12, fontFamily: "Menlo" },
  err: { color: "#f87171", fontSize: 14 },
  input: {
    backgroundColor: "#15181d", color: "#f3f4f6", borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
  },
  card: { backgroundColor: "#15181d", borderRadius: 12, padding: 16, gap: 8 },
  /** 折叠出来的邮箱密码块。上边一条线,把它和上面那两个 OAuth 按钮分开 */
  pwBlock: { gap: 12, borderTopWidth: 1, borderTopColor: "#262b33", paddingTop: 16, marginTop: 4 },
  cardTitle: { color: "#f3f4f6", fontSize: 16, fontWeight: "600" },
  // 等宽 + 拉开字距:这串数字是拿来跟另一块屏幕逐位比对的
  code: { color: "#f3f4f6", fontSize: 32, fontFamily: "Menlo", letterSpacing: 6, textAlign: "center" },
  approval: { borderTopWidth: 1, borderTopColor: "#262b33", paddingTop: 10, gap: 8 },
  row: { flexDirection: "row", gap: 10 },
  /** 并排那一行里的按钮才平分宽度 */
  btnRow: { flex: 1 },
  btn: {
    backgroundColor: "#2563eb", borderRadius: 10, paddingVertical: 14,
    // alignItems + justifyContent 都要:少一个,文字在某些容器里会跑到看不见的地方
    // (虚拟机上第一版就是一条没有字的蓝条)
    alignItems: "center", justifyContent: "center", minHeight: 48,
  },
  btnDanger: { backgroundColor: "#b91c1c" },
  btnGhost: { backgroundColor: "transparent" },
  btnOff: { opacity: 0.5 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  btnGhostText: { color: "#9ca3af" },
});
