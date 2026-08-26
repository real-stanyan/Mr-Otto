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
  ActionSheetIOS, ActivityIndicator, Image, Platform, Pressable,
  SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
  type ViewStyle,
} from "react-native";
import type { IslandAgent, IslandFleet } from "../src/shared/shellBridge.js";
import type { MobileMessage, UpFrame } from "../src/shared/remote/frames.js";
import { fmtTokens, type RemoteStats } from "../src/shared/remote/stats.js";
import { activityWindow, heatLevel, heatWeeks } from "../src/shared/sessionActivity.js";
import { fmtUsd } from "../src/shared/modelPricing.js";
import { chunkUpload, UPLOAD_LIMITS } from "../src/shared/remote/uploads.js";
import { groupByWorkspace, groupTone, type WorkspaceGroup } from "../src/shared/remote/groups.js";
import { parseMarkdown, type Span as MdSpan } from "../src/shared/remote/markdown.js";
import { groupTimeline, splitTool } from "../src/shared/remote/timeline.js";
import type { PinnedPeerStore, RemotePeer } from "../src/shared/remote/devices.js";
import type { MobileBridge } from "../src/shared/remote/mobileBridge.js";
import { AuthCancelled, signInWithProvider, type OAuthProvider } from "./src/oauth.js";
import { Friends } from "./src/friends.js";
import {
  MAX_MB, NeedsRebuild, pickFiles, pickPhotos, prepareForUpload, takePhoto, tooBig,
  type Picked,
} from "./src/attach.js";
import { connect, devices, openStore, RELAY_BASE } from "./src/session.js";
import { supabase } from "./src/supabase.js";
import { usePalette, type as t, MONO, radius, space } from "./src/theme.js";
import {
  Button, Card, CodeTiles, DetailBar, Divider, Dot, Group, Headline, Hint, Meta, Note, Page, Row,
  Spinner, StatusLine, TabIcon, Tile, Title, useKeyboardInset, Warn,
} from "./src/ui.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "./app.json";

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
      {/* 抖动波场,**只有这一屏有**。登录页是唯一一个没有内容可看的屏 ——
          进了 app 之后每一屏都在说事(会话、好友、设置),背景再有花纹就是抢戏;
          这一屏上除了一个图标和三个输入框什么都没有,空着反而像没加载完。

          是一张预渲染的 PNG 不是 shader:见 scripts/gen-dither.mjs 开头。
          放在第一个子节点 = 压在最底下,表单画在它上面,不抢触摸 */}
      <Image
        source={isDark
          ? require("./assets/dither-dark.png")
          : require("./assets/dither-light.png")}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
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

  const input = {
    backgroundColor: c.card, color: c.foreground, borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
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

/** 顶栏右边那一句。tone 只承担"哪一类",话由 text 说全 —— 不靠颜色单独传信息 */
interface ConnStatus { tone: "ok" | "warn"; text: string }

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

/* ── 设置 ───────────────────────────────────────────────
   只放**这台手机自己**的事:账号、配对、连的哪个中继。电脑上的设置
   (模型、MCP、审批策略)不在这儿改 —— ADR-0094 的边界没动。

   形状是 iOS 的分组列表(Group/Row),不是一摞卡片。区别不在好看:一摞
   平权的 Card 里每一张都在说"我是独立的一件事",而这屏上多数行是同一件事
   的几个面 —— 邮箱和退出登录都属于账号。分组把从属关系画出来,footer 那句话
   也就有了地方待:说明贴着它说明的那一组,而不是塞进卡片里跟正文抢位置。

   退出登录单独一组、居中、红字,是 iOS 的老规矩:破坏性动作不跟只读信息
   同一块板 —— 挨着邮箱那行放,手指会顺着往下点。 */
function Settings({
  store, onRepair, onSignedOut, stats, online, active, onRefreshStats,
}: {
  store: PinnedPeerStore;
  onRepair: () => void;
  onSignedOut: () => void;
  /** 桌面答回来的统计。null = 还没问到(没连上,或刚翻进来) */
  stats: RemoteStats | null;
  online: boolean;
  /** 这一屏此刻是不是当前页签。三个页签都常驻挂载,不看这个就不知道人翻过来了 */
  active: boolean;
  onRefreshStats: () => void;
}) {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paired = store.peerIdentity() !== null;

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  // 翻到这一屏(而且连着)才问。**不订阅** —— 那两条查询在桌面上是全表扫描级的,
  // 挂在推送上等于每条工具事件都拖一次;而且用量本来就不该跟着每一帧出机器
  // (shared/remote/trim.ts 那道闸门的理由,见 shared/remote/stats.ts 开头)
  useEffect(() => {
    if (active && online) onRefreshStats();
  }, [active, online, onRefreshStats]);

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

      {/* 组与组之间比组内的行远一档,眼睛才会先分组再读行 */}
      <View style={{ gap: space.lg }}>
        <Group header="账号" footer="配对的电脑必须登同一个账号,否则在列表里根本看不见它。">
          <Row label="邮箱" value={email ?? "读取中…"} />
        </Group>

        <Group>
          <Row
            label={busy ? "退出中…" : "退出登录"}
            align="center" tone="destructive"
            disabled={busy} onPress={signOut}
          />
        </Group>

        <Group
          header="配对的电脑"
          footer={paired
            ? "换电脑、或安全码对不上时重新配一次。"
            : "还没配对 —— 配完才看得到会话。"}
        >
          <Row label={paired ? "已配对" : "未配对"} leading={<Dot tone={paired ? "ok" : "warn"} />} />
          <Row label="重新配对" chevron onPress={onRepair} />
        </Group>

        <StatsSection stats={stats} online={online} onRefresh={onRefreshStats} />

        {/* 中继看不见内容(端到端加密),但连的是哪一台是排查时的第一个问题。
            这三行是纯诊断信息 —— 不做成按钮,长按能选中拷走就够了 */}
        <Group header="连接" footer="出问题时把这三行长按拷下来一起发过来。">
          <Row label="中继" value={RELAY_BASE} mono />
          <Row label="本机" value={store.deviceId} mono />
          <Row label="版本" value={appJson.expo.version} mono />
        </Group>
      </View>
    </Page>
  );
}

/* ── 统计 ───────────────────────────────────────────────
   会话热力图 + 各模型用量。数在电脑上(全库事件日志),手机开口问一次、
   桌面答一次 —— 不订阅、不跟着 fleet 走(理由在 shared/remote/stats.ts 开头)。 */
function StatsSection({ stats, online, onRefresh }: {
  stats: RemoteStats | null;
  online: boolean;
  onRefresh: () => void;
}) {
  if (!stats) {
    return (
      <Group header="记录与用量" footer={online ? undefined : "连上电脑才看得到 —— 数在电脑上。"}>
        <Row
          label={online ? "读取中…" : "电脑不在线"}
          leading={<Dot tone={online ? "busy" : "warn"} />}
        />
      </Group>
    );
  }
  return (
    <View style={{ gap: space.lg }}>
      <ActivityCard stats={stats} />
      <UsageGroup stats={stats} onRefresh={onRefresh} />
    </View>
  );
}

/** 一格多大。8+2 是挑过的:27 列(半年)乘 10 = 270pt,最窄的 iPhone 也放得下,
    再小一档格子就分不出深浅了 */
const CELL = 8;
const CELL_GAP = 2;

/** 会话热力图。和桌面那张同一份投影(shared/sessionActivity.ts),同一个跨度 */
function ActivityCard({ stats }: { stats: RemoteStats }) {
  const { c } = usePalette();
  const scroll = useRef<ScrollView | null>(null);
  const weeks = heatWeeks(activityWindow(stats.activity, stats.sessions, stats.now, stats.activityDays));
  const max = stats.activity.reduce((m, d) => Math.max(m, d.count), 0);

  // 0 档不是"浅一点的蓝",是**没有颜色的底** —— 没干活和干得少必须一眼分得开。
  // 深浅用 opacity 而不是拼 rgba:主题给的是十六进制,拆通道要么多存一份
  // rgb 三元组,要么在这儿写个解析器,两样都比一个 opacity 贵
  const face = (level: number): ViewStyle =>
    level === 0 ? { backgroundColor: c.muted } : { backgroundColor: c.brand, opacity: 0.25 * level };

  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Headline>会话记录</Headline>
        <Meta>{`${stats.sessions} 个 · ${stats.activityDays} 天`}</Meta>
      </View>

      {/* 横向可滚:窄屏上宁可让人推一下,也不要把格子压到分不出深浅。
          默认停在最右边 —— 最近那几天才是人要看的 */}
      <ScrollView
        ref={scroll} horizontal showsHorizontalScrollIndicator={false}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <View style={{ flexDirection: "row", gap: CELL_GAP }}>
          {weeks.map((week, i) => (
            <View key={i} style={{ gap: CELL_GAP }}>
              {week.map((cell, j) => (
                <View
                  key={j}
                  style={{
                    width: CELL, height: CELL, borderRadius: 2,
                    // 窗口外的边角**不画** —— 画成空格子等于说"那天没干活",而那天根本不在窗口里
                    ...(cell === null ? { backgroundColor: "transparent" } : face(heatLevel(cell.count, max))),
                  }}
                />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: CELL_GAP }}>
        <Meta>少</Meta>
        {[0, 1, 2, 3, 4].map((l) => (
          <View key={l} style={{ width: CELL, height: CELL, borderRadius: 2, ...face(l) }} />
        ))}
        <Meta>多</Meta>
      </View>
    </Card>
  );
}

/** 各模型用量。一行一款:左边名字 + 厂商,右边花费 + 进/出。
    **查不到价的那一款右边是破折号,不是 $0** —— 0 是"免费"这个事实,不是"我不知道" */
function UsageGroup({ stats, onRefresh }: { stats: RemoteStats; onRefresh: () => void }) {
  const { c } = usePalette();
  const total = stats.models.reduce((n, m) => n + m.inTokens + m.outTokens, 0);
  return (
    <Group
      header={`各模型用量 · 近 ${stats.usageDays} 天`}
      footer={stats.totalCostUsd === null
        ? "有型号查不到价，所以不报合计——把查得到的几款加起来当总数，报的是一个偏小的数。"
        : `合计 ${fmtUsd(stats.totalCostUsd)} · ${fmtTokens(total)} tokens`}
    >
      {stats.models.length === 0 ? (
        <Row label={`近 ${stats.usageDays} 天没有调用`} />
      ) : (
        stats.models.map((m) => (
          <View key={`${m.provider}/${m.label}`} style={{
            flexDirection: "row", alignItems: "center", gap: space.sm,
            paddingHorizontal: space.md, paddingVertical: 10, minHeight: 56,
          }}>
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text style={{ ...t.body, color: c.foreground }} numberOfLines={1}>{m.label}</Text>
              <Meta>{m.provider}</Meta>
            </View>
            <View style={{ alignItems: "flex-end", gap: 1 }}>
              <Text style={{ ...t.body, color: c.foreground }}>
                {m.costUsd === null ? "—" : fmtUsd(m.costUsd)}
              </Text>
              <Meta>{`入 ${fmtTokens(m.inTokens)} · 出 ${fmtTokens(m.outTokens)}`}</Meta>
            </View>
          </View>
        ))
      )}
      <Row label="重新读一次" align="center" onPress={onRefresh} />
    </Group>
  );
}

/* ── 舰队 ───────────────────────────────────────────────
   看 + 审批。桌面不在线时不假装有内容:一句"你的 Mac 不在线"
   (中继零落盘,没有队列可回放 —— 这是设计,不是缺陷)。 */
function Fleet({ store, onRepair, onDetailChange, onStatus, onStats, askStats }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  /** 翻进详情屏时底栏要收起来 */
  onDetailChange: (inDetail: boolean) => void;
  /** 连接状态报给品牌栏 —— 桥在这儿,栏在上面 */
  onStatus: (s: ConnStatus) => void;
  /** 桌面答回来的统计。设置页要,而桥在这儿 */
  onStats: (s: RemoteStats) => void;
  /** 把"问一次"这个动作交出去。**只交动作,不交桥** ——
      桥的生命周期归这一屏,别的屏能做的只有开口问 */
  askStats: React.RefObject<(() => void) | null>;
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
  /** 桌面回过来的一句话(附件被拒之类)。**只有它能说"这个文件没收下"** ——
      静默丢弃在手机上和"传成功了"长得一模一样 */
  const [notice, setNotice] = useState<string | null>(null);
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
        if (f.type === "notice") setNotice(f.text);
        else if (f.type === "fleet") setFleet(f.fleet);
        else if (f.type === "stats") onStats(f.stats);
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
    askStats.current = () => { b.send({ type: "stats" }); };
    return () => {
      askStats.current = null;
      b.dispose();
    };
    // onStats 每次 render 都是新的(Shell 的 setState 其实是稳的,但类型上不保证),
    // 而这条连接一辈子只建一次 —— 让它进依赖等于每次渲染都重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * 发一条消息,可以带附件。**不乐观回显**:把一条没发出去的消息画在时间线上,
   * 比直接说"没连上"糟糕得多 —— 用户会以为电脑那边已经在跑了。
   *
   * 附件先分片传完,最后那条 send 才带上它们的 id。**顺序是要紧的**:
   * 反过来的话桌面会拿着一串还没到的 id,只能整条拒收。
   *
   * 回 null = 发出去了;回字符串 = 没发出去的理由。
   */
  const submitMessage = async (
    sessionId: string,
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ): Promise<string | null> => {
    const post = (f: UpFrame): boolean => bridge.current?.send(f) ?? false;
    const offline = "没发出去 —— 你的 Mac 不在线";

    const ids: string[] = [];
    // 先全部备好再开始发:进度条要有个分母,而且**图片要先转码缩放**
    // (prepareForUpload:HEIC → JPEG,超上限的按阶梯降)。它抛的错由调用方接住
    let sent = 0;
    const chunks: { name: string; parts: string[] }[] = [];
    for (const f of files) {
      const ready = await prepareForUpload(f);
      chunks.push({ name: ready.name, parts: chunkUpload(ready.data) });
    }
    const total = chunks.reduce((n, c) => n + c.parts.length, 0);

    for (const [i, c] of chunks.entries()) {
      // uploadId 只在这一条连接里有意义(桌面那侧断线就清空),所以不用全局唯一,
      // 只要这一轮里不撞
      const uploadId = `u${i}-${sent}-${text.length}-${c.parts.length}`;
      for (const [seq, data] of c.parts.entries()) {
        if (!post({ type: "upload", uploadId, seq, total: c.parts.length, name: c.name, data })) {
          return offline;
        }
        sent += 1;
        onProgress(sent, total);
      }
      ids.push(uploadId);
    }

    const ok = ids.length
      ? post({ type: "send", sessionId, text, uploads: ids })
      : post({ type: "send", sessionId, text });
    return ok ? null : offline;
  };

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

  useEffect(() => {
    onStatus(ready
      ? { tone: "ok", text: "已连上你的 Mac" }
      : { tone: "warn", text: settled ? "断开了" : "重连中…" });
  }, [ready, settled, onStatus]);

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
        notice={notice} onDismissNotice={() => setNotice(null)}
        onBack={closeSession} onDecide={decide}
        onSubmit={(text, files, p) => submitMessage(opened.sessionId, text, files, p)}
        onRetry={() => bridge.current?.send({ type: "watch", sessionId: opened.sessionId })}
      />
    );
  }

  return (
    <Page>
      <View style={{ paddingTop: space.sm }}><Title>会话</Title></View>
      {/* 品牌栏上那个点只说"断了",说不出"你正在看的是旧的"。这一句只在
          真断线、而且手里确实还留着上一份快照时出现 */}
      {ready || !settled ? null : (
        <StatusLine tone="warn">断开了 —— 下面是断线前的</StatusLine>
      )}
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
        { flexDirection: "row", alignItems: "center", gap: space.xs, paddingTop: space.sm },
        pressed && { opacity: 0.5 },
      ]}
    >
      {/* 组头原来和卡片里的元信息一样是 13px,一列卡片扫下来它读成又一条注脚,
          而不是"下面这些属于同一个工作区"的分界。提到 callout(15)+600:
          比卡片标题(17)小一档、又还是暗色,层级仍然在下面,但一眼能看见 */}
      <Text style={{ ...t.callout, fontWeight: "600", color: c.mutedForeground, width: 14 }}>
        {collapsed ? "▸" : "▾"}
      </Text>
      <Text
        style={{ ...t.callout, fontWeight: "600", color: c.mutedForeground }}
        numberOfLines={1}
      >
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
function SessionView({
  agent: a, now, messages, diag, online, notice, onDismissNotice,
  onBack, onDecide, onSubmit, onRetry,
}: {
  agent: IslandAgent;
  now: number;
  messages: MobileMessage[] | null;
  /** 连接活着没有。断了这一屏**不清空**——留着断线前的内容,顶上挂一条横幅
      说清楚它是旧的,同时把审批和发送都锁上 */
  online: boolean;
  diag: { frames: number; timelines: number; log: string[] };
  /** 桌面回过来的一句话,通常是"这个附件没收下"加理由 */
  notice: string | null;
  onDismissNotice: () => void;
  onBack: () => void;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  /** 回 null = 发出去了;回字符串 = 没发出去的理由 */
  onSubmit: (
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<string | null>;
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
      <DetailBar
        back="会话" title={a.title ?? a.sessionId} onBack={onBack}
        right={<Dot tone={tone} />}
      />

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
        <Composer onSubmit={onSubmit} online={online}
          notice={notice} onDismissNotice={onDismissNotice} />
      </View>
    </View>
  );
}

/** 回一条消息,可以带附件。范围仍然到这里(ADR-0094):不建会话、不切模型 ——
    手机端是"看 + 审批"的第三个投影窗口,不是第二个完整客户端。
    附件是后加的一条(ADR-0106):手机上最常见的一句话就是"看看这张图"。

    发送键是个圆的、只有一个箭头,＋ 在左边 —— 和桌面输入区那两个同一个形状、
    同一个位置。多行输入里的回车是换行不是发送:手机上没有 Shift 可以按,
    把回车做成发送等于让人没法打第二段。

    **附件先传完,最后那条消息才带上它们的 id。** 反过来的话桌面会拿着一串
    还没到的 id,只能整条拒收。 */
function Composer({ onSubmit, online, notice, onDismissNotice }: {
  onSubmit: (
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<string | null>;
  online: boolean;
  notice: string | null;
  onDismissNotice: () => void;
}) {
  const { c } = usePalette();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly Picked[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /** 传到第几片 / 一共几片。null = 没在传 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const busy = progress !== null;
  // 断线时输入框**不禁用**,只是发不出去:人可以照打,连接回来再按发送。
  // 禁用输入框会把已经打了一半的字连同光标一起抢走
  const ready = online && !busy && (text.trim().length > 0 || files.length > 0);

  const add = (picked: Picked[]): void => {
    // 这里只挡非图片:图片有缩放这条路,原图多大都先收下(见 attach.ts 的 tooBig)
    const big = picked.filter(tooBig);
    if (big.length) setErr(`${big.map((f) => f.name).join("、")} 超过 ${MAX_MB}MB,没加上`);
    const ok = picked.filter((f) => !tooBig(f));
    // 上限在这儿也挡一道:桌面那侧的重组器会拒,但让人选完了才被拒是坏的
    setFiles((prev) => [...prev, ...ok].slice(0, UPLOAD_LIMITS.maxPending));
  };

  const pick = (how: () => Promise<Picked[]>): void => {
    void (async () => {
      try {
        add(await how());
      } catch (e: unknown) {
        setErr(e instanceof NeedsRebuild ? e.message : e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const openPicker = (): void => {
    setErr(null);
    const choices: { label: string; go: () => Promise<Picked[]> }[] = [
      { label: "照片", go: pickPhotos },
      { label: "拍照", go: takePhoto },
      { label: "文件", go: pickFiles },
    ];
    if (Platform.OS !== "ios") return pick(choices[0]!.go);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...choices.map((x) => x.label), "取消"], cancelButtonIndex: choices.length },
      (i) => { if (i < choices.length) pick(choices[i]!.go); },
    );
  };

  const submit = (): void => {
    const t2 = text.trim();
    if (!t2 && files.length === 0) return;
    setErr(null);
    onDismissNotice();
    setProgress({ done: 0, total: 0 });
    void (async () => {
      try {
        const why = await onSubmit(t2, files, (done, total) => setProgress({ done, total }));
        if (why) return setErr(why);
        // 发出去了才清空:失败时把人打的字和选的文件一起吞掉是不可接受的
        setText("");
        setFiles([]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setProgress(null);
      }
    })();
  };

  return (
    <View style={{
      paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: space.xs,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
      backgroundColor: c.background,
    }}>
      {/* 桌面回来的话在最上面,而且要能按掉 —— 它说的是上一次发送的事 */}
      {notice ? (
        <Pressable onPress={onDismissNotice} accessibilityRole="button">
          <Note tone="error">{notice}</Note>
        </Pressable>
      ) : null}
      {err ? <Note tone="error">{err}</Note> : null}
      {progress ? (
        <Meta>{progress.total ? `传附件 ${progress.done}/${progress.total} 片…` : "处理附件…"}</Meta>
      ) : null}

      {files.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingVertical: 2 }}>
          {files.map((f, i) => (
            <Chip key={`${f.uri}#${i}`} file={f}
              onRemove={busy ? undefined : () => setFiles((p) => p.filter((_x, j) => j !== i))} />
          ))}
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        {/* ＋ 和桌面输入区左下角那个同一个位置、同一个意思 */}
        <Pressable
          accessibilityRole="button" accessibilityLabel="加附件"
          onPress={openPicker} disabled={busy} hitSlop={8}
          style={({ pressed }) => [
            {
              width: 44, height: 44, borderRadius: radius.pill,
              alignItems: "center", justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
            },
            busy && { opacity: 0.35 },
            pressed && !busy && { opacity: 0.6 },
          ]}
        >
          <Text style={{ ...t.title, color: c.foreground, marginTop: -2 }}>＋</Text>
        </Pressable>
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
          {busy
            ? <ActivityIndicator color={c.primaryForeground} />
            : <Text style={{ ...t.headline, color: c.primaryForeground }}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}

/** 一个待发的附件。名字一行截断 —— 手机上文件名能有半屏那么长 */
function Chip({ file, onRemove }: { file: Picked; onRemove?: () => void }) {
  const { c } = usePalette();
  const kb = file.bytes ? `${Math.max(1, Math.round(file.bytes / 1024))}KB` : "";
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: 220,
      paddingLeft: space.sm, paddingRight: onRemove ? 4 : space.sm, paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <Text style={{ ...t.footnote, color: c.foreground, flexShrink: 1 }} numberOfLines={1}>
        {file.name}
      </Text>
      {kb ? <Meta>{kb}</Meta> : null}
      {onRemove ? (
        <Pressable
          accessibilityRole="button" accessibilityLabel={`移除 ${file.name}`}
          onPress={onRemove} hitSlop={8}
          style={({ pressed }) => [
            { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
            pressed && { opacity: 0.5 },
          ]}
        >
          <Text style={{ ...t.footnote, color: c.mutedForeground }}>✕</Text>
        </Pressable>
      ) : null}
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
