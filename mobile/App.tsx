// 手机端的全部界面。三屏,一个状态机推着走:
//   登录 → 配对(扫电脑上那张码) → 舰队(看 + 审批)
//
// 范围就到这里(ADR-0094):不建会话、不改设置、不切模型、不管 MCP。
// 屏幕少到不值得上路由 —— 一个 phase 字段比 expo-router 少一整层依赖。
//
// 视觉语言全部来自 src/theme.ts,那张表逐个值抄自桌面的 app.css:同一套
// Apple 四色底盘、同一套语义色、同样跟随系统深浅色。组件在 src/ui.tsx。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View,
  type ViewStyle,
} from "react-native";
import type { RemoteStats } from "../src/shared/remote/stats.js";
import type { PinnedPeerStore } from "../src/shared/remote/devices.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { Friends } from "./src/friends.js";
import { DitherBackground } from "./src/dither.js";
import { openStore } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, radius, space } from "./src/theme.js";
import { Button, Divider, Dot, Note, Page, Spinner, TabIcon, useKeyboardInset } from "./src/ui.js";
import { Pair } from "./src/pair/PairScreen.js";
import { Settings } from "./src/account/AccountScreen.js";
import { Fleet, type ConnStatus } from "./src/projects/Fleet.js";

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
      setPhase(s.peerIdentities().length > 0 ? "fleet" : "pair");
    })().catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <Screen center><Note tone="error">{error}</Note></Screen>;

  const booting = !store || phase === "loading";

  return (
    /* 抖动波场**只在开屏和登录页**:进了 app 之后每一屏都在说事(会话、好友、设置),
       背景再有花纹就是抢戏;这两屏上除了一个图标和三个输入框什么都没有,
       空着反而像没加载完。

       两屏共用**同一个** `<Screen>`,不是两次 return:拆开的话中间那块 WebView 会
       卸载再挂载,拿到 session 的那一刻波场从头重启一次——开屏刚起好的浪突然回到
       第 0 帧,比一直不动还显眼。同一个元素位置,React 认它是同一棵子树,波场连着走 */
    <Screen dither={booting || phase === "signIn"} center={booting}>
      {booting ? (
        <BootSpinner />
      ) : phase === "signIn" ? (
        <SignIn onDone={() => setPhase(store.peerIdentities().length > 0 ? "fleet" : "pair")} />
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
  /** 好友页签上那个数:待我处理的请求 + 没看过的私信。由好友那一屏算(它握着订阅) */
  const [friendBadge, setFriendBadge] = useState(0);
  /** 设置页那两块统计。桥在会话那一屏手里,所以数从那儿回流到这儿再发下去 */
  const [stats, setStats] = useState<RemoteStats | null>(null);
  /** 向桌面要一份统计。**拉取,不订阅** —— 由 Fleet 在连上之后填进来 */
  const askStats = useRef<(() => void) | null>(null);
  const refreshStats = useCallback(() => { askStats.current?.(); }, []);
  /** 连接状态由会话页那只桥算出来(它握着连接),显示在品牌栏上 */
  const [status, setStatus] = useState<ConnStatus | null>(null);

  const pane = (id: Tab): ViewStyle => ({
    flex: 1,
    // display:"none" 而不是条件渲染:见上面为什么不能卸载
    display: tab === id ? "flex" : "none",
  });

  return (
    <View style={{ flex: 1 }}>
      {/* 品牌栏。翻进详情屏时让位给那一屏自己的返回栏——两条顶栏叠着没有意义 */}
      {inDetail ? null : <BrandBar status={status} />}
      <View style={pane("sessions")}>
        <Fleet
          store={store} onRepair={onRepair}
          onDetailChange={setInDetail} onStatus={setStatus}
          onStats={setStats} askStats={askStats}
        />
      </View>
      <View style={pane("friends")}>
        <Friends onDetailChange={setInDetail} onBadge={setFriendBadge} />
      </View>
      <View style={pane("settings")}>
        <Settings
          store={store} onRepair={onRepair} onSignedOut={onSignedOut}
          stats={stats} online={status?.tone === "ok"}
          active={tab === "settings"} onRefreshStats={refreshStats}
        />
      </View>
      {inDetail ? null : <TabBar tab={tab} onTab={setTab} badges={{ friends: friendBadge }} />}
    </View>
  );
}


/** 顶部品牌栏:和桌面同一张脸 + 字标,右边挂连接状态。只出现一次,不跟着页签变。
    状态放这儿而不是放"会话"标题底下,是因为它**不属于任何一个页签** ——
    连的是同一条链路,在好友页和设置页一样是真的。挂在标题下面就成了会话页的
    一个属性,切到别的页签它凭空消失,而链路并没有变。 */
function BrandBar({ status }: { status: ConnStatus | null }) {
  const { c } = usePalette();
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.xs,
      paddingHorizontal: space.md, paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
    }}>
      <Image source={require("./assets/otto-mark.png")} style={{ width: 26, height: 26 }} />
      <Text style={{ ...t.headline, color: c.foreground }}>Mr Otto</Text>
      {/* 撑开:状态靠右,和字标之间不留固定间距——名字多长都不影响它站的位置 */}
      <View style={{ flex: 1 }} />
      {status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Dot tone={status.tone} />
          <Text style={{ ...t.footnote, color: c.mutedForeground }} numberOfLines={1}>
            {status.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function TabBar({ tab, onTab, badges }: {
  tab: Tab;
  onTab: (t: Tab) => void;
  /** 每个页签上那个数。0 或缺省 = 不画 —— 一个"0"的角标和一个红点一样吵 */
  badges?: Partial<Record<Tab, number>>;
}) {
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
          <View>
            <TabIcon name={x.id} color={tab === x.id ? c.foreground : c.mutedForeground} />
            {/* 角标压在图标右上角,溢出图标一点点 —— iOS 的位置就是这样,
                贴在图标里会跟线条糊在一起 */}
            {(badges?.[x.id] ?? 0) > 0 ? (
              <View style={{
                position: "absolute", top: -4, right: -8,
                minWidth: 16, height: 16, borderRadius: radius.pill, paddingHorizontal: 4,
                backgroundColor: c.destructive, alignItems: "center", justifyContent: "center",
              }}>
                <Text style={{
                  fontSize: 10, lineHeight: 12, fontWeight: "700", color: c.destructiveForeground,
                }}>
                  {badges![x.id]! > 99 ? "99+" : badges![x.id]}
                </Text>
              </View>
            ) : null}
          </View>
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

