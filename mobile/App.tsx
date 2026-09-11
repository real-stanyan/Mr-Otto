// 手机端的入口：开屏 → 登录 → 三栏（任务 / 项目 / 团队）。
//
// 三栏的导航在 src/nav/（ADR-0293）：每一栏一个原生栈，账号 / 好友 / 配对在根栈里。
// 配对不再是进门的一步——项目栏里没配过就给一张卡（spec §4.1）。
// 视觉语言全部来自 src/theme.ts（逐值抄自桌面的 app.css），组件在 src/ui.tsx。

import { useEffect, useState } from "react";
import { Image, SafeAreaView, StatusBar, Text, TextInput, View } from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, radius, space } from "./src/theme.js";
import { Button, Divider, Note, Page, Spinner, useKeyboardInset } from "./src/ui.js";
import { LinkProvider } from "./src/link.js";
import { RootNavigator } from "./src/nav/RootNavigator.js";

type Phase = "loading" | "signIn" | "main";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [store, setStore] = useState<PinnedPeerStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await openStore();
      setStore(s);
      const { data } = await supabase.auth.getSession();
      setPhase(data.session ? "main" : "signIn");
    })().catch((e: unknown) => setError(String(e)));
    // 退出登录（账号页）/ session 过期 → 回登录页。登录成功那条路由 SignIn 的 onDone 走。
    // 订阅时会先来一发 INITIAL_SESSION：开屏还没读完 session 时不抢着改 phase
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) setPhase((p) => (p === "loading" ? p : "signIn"));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (error) {
    return (
      <SafeAreaProvider>
        <Screen center><Note tone="error">{error}</Note></Screen>
      </SafeAreaProvider>
    );
  }

  if (phase === "main" && store) {
    return (
      <SafeAreaProvider>
        <ExpoStatusBar style="auto" />
        <LinkProvider store={store}>
          <RootNavigator />
        </LinkProvider>
      </SafeAreaProvider>
    );
  }

  const booting = !store || phase === "loading";
  return (
    <SafeAreaProvider>
      {/* 开屏与登录页共用**同一个** <Screen>：拆成两次 return 的话中间那块 WebView
          会卸载再挂载，拿到 session 那一刻波场从头重启一次 */}
      <Screen dither center={booting}>
        {booting ? <BootSpinner /> : <SignIn onDone={() => setPhase("main")} />}
      </Screen>
    </SafeAreaProvider>
  );
}

/** 开屏那个转圈。**自带一块底**,理由和登录页那两个 OAuth 按钮同一条:
    mutedForeground 的圈压在会动的波场上,走到亮的那半就没了 ——
    一个看不见的 loading 指示等于没有 loading 指示。给它 card + 一道边,
    它就站在自己的地面上,底下的浪怎么走都不影响 */
function BootSpinner() {
  const { c } = usePalette();
  return (
    <View style={{
      width: 56, height: 56, borderRadius: radius.control,
      backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
      alignItems: "center", justifyContent: "center",
    }}>
      <Spinner />
    </View>
  );
}

/**
 * 地面。状态栏跟着主题走 —— 深色底配浅色状态栏,反过来读不出来。
 *
 * `dither` 打开时那块波场铺在 **SafeAreaView 外面**:背景就该顶到屏幕边,
 * 缩在安全区里会在刘海和 home 条那儿各留一条底色,看着像没加载完。
 * 内容仍然在安全区内 —— 通栏的是背景,不是表单。
 */
function Screen({ children, center, dither }: {
  children: React.ReactNode; center?: boolean; dither?: boolean;
}) {
  const { c, isDark } = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {dither ? <DitherBackground isDark={isDark} /> : null}
      <SafeAreaView style={[
        { flex: 1 },
        center && { alignItems: "center", justifyContent: "center", padding: space.lg },
      ]}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        {children}
      </SafeAreaView>
    </View>
  );
}

/* ── 登录 ───────────────────────────────────────────────
   邮箱密码在上、第三方在下。**上面那块是默认展开的** —— 一个折叠起来的
   表单在登录屏上等于让人先猜一次"我该点哪儿"。

   两个 provider 按钮都是 outline,不是两个蓝按钮:用户有哪个账号就点哪个,
   两者平权。蓝色(primary)一屏只留给一个真正的主动作(登录)。

   **这个账号体系里注册主要走 OAuth**:用 Google 注册的账号根本没有密码,
   拿它去填上面的表单只会反复报 Invalid login credentials(虚拟机上实测过)。
   这条不再靠"把 OAuth 摆前面"来暗示,改成在密码真的被拒时当场说破 ——
   提示出现在人已经撞上问题的那一刻,比事前的一句话有用得多。 */
function SignIn({ onDone }: { onDone: () => void }) {
  const { c, isDark } = usePalette();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 键盘要让位:输入框在上半屏,但「登录」就贴在密码框下面
  const { root, keyboard } = useKeyboardInset(() => {});

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

  /** logo 一律 20pt:两个标记的视觉重量差不多,给同一个尺寸就够齐 */
  const mark = { width: 20, height: 20 };

  return (
    <View ref={root.ref} onLayout={root.onLayout} style={{ flex: 1, paddingBottom: keyboard }}>
      {/* 撑满高度、内容居中:这一屏东西不多,顶到天花板会在下面留一大片空 */}
      <Page grow>
        <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
          {/* 图标 + 字标是一个**竖排居中的锁定组合**,不是左上角的两行。
              这一屏的重心在下面那三样(邮箱/密码/登录),标识居中反而不跟输入框
              抢左对齐那条线 —— 一列左对齐的东西里混一个更大的图,眼睛会先去够它。

              图用**透明底**那张(头,不带白色圆角底板):底板是给桌面图标用的,
              贴在米色页面上会变成一块方形的白斑。字标比图小一档:大的是脸,
              名字只是把脸念出来。 */}
          <View style={{ alignItems: "center", gap: space.sm }}>
            <Image source={require("./assets/otto-head.png")} style={{ width: 96, height: 96 }} />
            <Text style={{ ...t.headline, color: c.foreground }}>Mr Otto</Text>
          </View>
          {err ? <Note tone="error">{err}</Note> : null}

          <PasswordForm disabled={busy !== null} onError={setErr} onDone={onDone} />

          <Divider label="或" />

          <View style={{ gap: space.sm }}>
            <Button
              variant="outline"
              icon={<Image source={require("./assets/google-mark.png")} style={mark} />}
              label={busy === "google" ? "登录中…" : "用 Google 登录"}
              disabled={busy !== null}
              onPress={() => oauth("google")}
            />
            <Button
              variant="outline"
              icon={<GitHubMark size={mark.width} />}
              label={busy === "github" ? "登录中…" : "用 GitHub 登录"}
              disabled={busy !== null}
              onPress={() => oauth("github")}
            />
          </View>
        </View>
      </Page>
    </View>
  );
}

/** GitHub 那个标记是**反白猫**:黑底挖出猫。深色下黑底就看不见了,
    换成白底那版 —— 挖出来的猫这时露的是页面底色,和浅色下同一个读法 */
function GitHubMark({ size }: { size: number }) {
  const { isDark } = usePalette();
  return (
    <Image
      source={isDark
        ? require("./assets/github-mark-light.png")
        : require("./assets/github-mark.png")}
      style={{ width: size, height: size }}
    />
  );
}

/** 邮箱密码那一半 */
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
    if (!email.trim() || !password) return;
    setBusy(true);
    props.onError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      // 「密码不对」和「这个账号压根没有密码」在 Supabase 这里回的是同一句话,
      // 而后者才是这个产品里更常见的那种。把两种可能都说出来,别让人在
      // 一个不存在的密码上试三遍
      const invalid = /invalid login credentials/i.test(error.message);
      return props.onError(invalid
        ? "邮箱或密码不对。如果这个账号是用 Google / GitHub 注册的，它没有密码——走下面那两个按钮。"
        : error.message);
    }
    props.onDone();
  };

  // 边框 1pt + c.input(比 c.border 亮半档):理由同 ui.tsx 的 Button——
  // hairline 在 3x 屏上是 0.33pt,这两个框原本看不出边界在哪
  const input = {
    backgroundColor: c.card, color: c.foreground, borderRadius: radius.control,
    borderWidth: 1, borderColor: c.input,
    paddingHorizontal: space.md, paddingVertical: 13, ...t.body,
  };

  return (
    <View style={{ gap: space.sm }}>
      <TextInput
        style={input} placeholder="邮箱" placeholderTextColor={c.mutedForeground}
        autoCapitalize="none" autoCorrect={false} autoComplete="email"
        keyboardType="email-address" returnKeyType="next"
        value={email} onChangeText={setEmail}
      />
      <TextInput
        style={input} placeholder="密码" placeholderTextColor={c.mutedForeground}
        autoComplete="current-password" secureTextEntry
        returnKeyType="go" onSubmitEditing={() => void submit()}
        value={password} onChangeText={setPassword}
      />
      <Button
        label={busy ? "登录中…" : "登录"}
        disabled={busy || props.disabled}
        onPress={() => void submit()}
      />
    </View>
  );
}
