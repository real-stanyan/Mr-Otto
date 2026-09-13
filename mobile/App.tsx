// 手机端的入口：开屏 → 进门 → 三栏（任务 / 项目 / 团队）。
//
// 此刻画哪一屏由 shared/mobileGate.ts 的 gateView 说了算：冷启动没做完画开屏，没有 session 画闸门，
// 其余进三栏。登录 / 登出 / session 过期一律跟着 onAuthStateChange 走，不在各个按钮里分别切屏。
// 三栏的导航在 src/nav/（ADR-0293）；视觉语言全部来自 src/theme.ts（逐值抄自桌面 app.css）。

import { useCallback, useEffect, useState } from "react";
import { StatusBar, View } from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { gateView, resetHoldSurvives } from "../src/shared/mobileGate.js";
import { splashProgress } from "../src/shared/splashProgress.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, space } from "./src/theme.js";
import { Note } from "./src/ui.js";
import { LinkProvider } from "./src/link.js";
import { RootNavigator } from "./src/nav/RootNavigator.js";
import { GateScreen } from "./src/gate/GateScreen.js";
import { Splash } from "./src/gate/Splash.js";
import { readResetHold, writeResetHold } from "./src/gate/resetHold.js";
import { hasStoredSessionSync } from "./src/gate/storedSession.js";

/** 冷启动的步数：身份库、读 session。进度条的「真实」那一半按它数 */
const BOOT_STEPS = 2;

export default function App() {
  const [store, setStore] = useState<PinnedPeerStore | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [resetHold, setResetHold] = useState(false);
  const [done, setDone] = useState(0);
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setStore(await openStore());
      setDone((n) => n + 1);
      // 闸门问的是**盘上有没有一份登录记录**，不是「此刻拿不拿得到一个活 session」：
      // 断网 + access token 已过期时 getSession() 回 null，而盘上那份一个字节都没少
      // （supabase 只在**非**网络类错误且 token 真过期时才删它）。照它判就是把人锁在自己的 app 外面——
      // 桌面早就判过同一件事（ADR-0183），判据两端共用 src/shared/authSession.ts
      const { data } = await supabase.auth.getSession();
      const signedIn = data.session !== null || hasStoredSessionSync();
      setHasSession(signedIn);
      // 上一次停在「设新密码」那一步就被杀掉了：登录记录还在就接着按住；没了就是残留，清掉
      const held = await readResetHold();
      const keep = resetHoldSurvives(held, signedIn);
      if (held && !keep) await writeResetHold(false);
      setResetHold(keep);
      setDone((n) => n + 1);
    })().catch((e: unknown) => setError(String(e)));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // session 没了有两种，处置相反：**真登出**（supabase 把盘上那份一起清了）该落回登录卡；
      // **刷新不上**（断网、盘上那份还在）不该。只看 session 这一个入参分不出来，所以再问一次盘
      const signedIn = session !== null || hasStoredSessionSync();
      setHasSession(signedIn);
      if (!signedIn) {
        // 同冷启动那条规矩（resetHoldSurvives），只是随时都算：session 一没（登出、在别处被踢、刷新彻底失败），
        // 「按住」就只是残留——不清的话，停在「设一个新密码」那一步的人会被一个再也抬不起来的闸门困住
        setResetHold(false);
        void writeResetHold(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const progress = splashProgress({ done, total: BOOT_STEPS, elapsedMs: now - t0 });
  // 开屏那只钟：进度条到头就停，进了 app 之后不再每 100ms 醒一次
  useEffect(() => {
    if (progress >= 1) return;
    const id = setTimeout(() => setNow(Date.now()), 100);
    return () => clearTimeout(id);
  }, [progress, now]);

  // 找回密码那条路的「按住 / 放开」：先落盘再改状态——验码换来 session 的那一刻，闸门看到的已经是按住
  const hold = useCallback(async () => {
    await writeResetHold(true);
    setResetHold(true);
  }, []);
  const release = useCallback(async () => {
    await writeResetHold(false);
    setResetHold(false);
  }, []);

  const view = gateView({
    booted: store !== null && done >= BOOT_STEPS,
    splashDone: progress >= 1,
    hasSession,
    resetHold,
  });

  if (error) {
    return (
      <SafeAreaProvider>
        <Screen center><Note tone="error">{error}</Note></Screen>
      </SafeAreaProvider>
    );
  }

  if (view === "app" && store) {
    return (
      <SafeAreaProvider>
        <ExpoStatusBar style="auto" />
        <LinkProvider store={store}>
          <RootNavigator />
        </LinkProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      {/* 开屏与闸门共用**同一个** <Screen>：拆成两次 return 的话中间那块 WebView 会卸载再挂载，
          开屏刚起好的浪在进闸门那一刻回到第 0 帧 */}
      <Screen dither center={view === "splash"}>
        {view === "splash"
          ? <Splash progress={progress} />
          : <GateScreen resetHold={view === "resetHold"} onHold={hold} onRelease={release} />}
      </Screen>
    </SafeAreaProvider>
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
