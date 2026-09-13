// 账号页（原来底栏上的「设置」）。从 App.tsx 拆出来（#1237 M0），挂在根栈里、从右上头像进（ADR-0293）。

import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View, type ViewStyle } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import { fmtTokens, type RemoteStats } from "../../../src/shared/remote/stats.js";
import { activityWindow, heatLevel, heatWeeks } from "../../../src/shared/sessionActivity.js";
import { fmtUsd } from "../../../src/shared/modelPricing.js";
import { RELAY_BASE } from "../session.js";
import { supabase } from "../supabase.js";
import { usePalette, type as t, space } from "../theme.js";
import { Card, Dot, Group, Headline, Meta, Page, Row } from "../ui.js";
import { useNavigation } from "@react-navigation/native";
import { useLink } from "../link.js";
import { NoticeLine } from "../gate/NoticeLine.js";
// 版本号只有一个事实来源:打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

/* ── 设置 ───────────────────────────────────────────────
   只放**这台手机自己**的事:账号、配对、连的哪个中继。电脑上的设置
   (模型、MCP、审批策略)不在这儿改 —— ADR-0094 的边界没动。

   形状是 iOS 的分组列表(Group/Row),不是一摞卡片。区别不在好看:一摞
   平权的 Card 里每一张都在说"我是独立的一件事",而这屏上多数行是同一件事
   的几个面 —— 邮箱和退出登录都属于账号。分组把从属关系画出来,footer 那句话
   也就有了地方待:说明贴着它说明的那一组,而不是塞进卡片里跟正文抢位置。

   退出登录单独一组、居中、红字,是 iOS 的老规矩:破坏性动作不跟只读信息
   同一块板 —— 挨着邮箱那行放,手指会顺着往下点。 */
export function AccountScreen() {
  const navigation = useNavigation();
  // 到电脑那条连接归项目栏的 Fleet;这一屏只读它报上来的状态与统计,要统计时开口问一次
  const { store, status, stats, askStats } = useLink();
  const online = status?.tone === "ok";
  const onRefreshStats = useCallback(() => { askStats.current?.(); }, [askStats]);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paired = store.peerIdentities().length > 0;

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  // 翻到这一屏(而且连着)才问。**不订阅** —— 那两条查询在桌面上是全表扫描级的,
  // 挂在推送上等于每条工具事件都拖一次;而且用量本来就不该跟着每一帧出机器
  // (shared/remote/trim.ts 那道闸门的理由,见 shared/remote/stats.ts 开头)
  useEffect(() => {
    if (online) onRefreshStats();
  }, [online, onRefreshStats]);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住，这一屏不用管。
  // 但登出会失败：断网而 access token 又过期时，supabase 刷新不了 session，就原样留着本地那份、
  // 也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生
  const [signOutNotice, setSignOutNotice] = useState<AuthNotice | null>(null);
  const signOut = (): void => {
    void (async () => {
      setBusy(true);
      setSignOutNotice(null);
      try {
        const { error } = await supabase.auth.signOut();
        if (error) setSignOutNotice(authNoticeOf(error.message));
      } catch (e: unknown) {
        setSignOutNotice(authNoticeOf(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Page>
      {/* 标题「账号」是原生导航栏画的。组与组之间比组内的行远一档,眼睛才会先分组再读行 */}
      <View style={{ gap: space.lg }}>
        <Group header="账号" footer="配对的电脑必须登同一个账号,否则在列表里根本看不见它。">
          <Row label="邮箱" value={email ?? "读取中…"} />
        </Group>

        {/* 好友从页签降到这里(spec §4.6);M6 设置页换皮时连同角标一起接回 */}
        <Group>
          <Row label="好友" chevron onPress={() => navigation.navigate("Friends")} />
        </Group>

        <Group>
          <Row
            label={busy ? "退出中…" : "退出登录"}
            align="center" tone="destructive"
            disabled={busy} onPress={signOut}
          />
        </Group>
        {signOutNotice ? <NoticeLine notice={signOutNotice} /> : null}

        <Group
          header="配对的电脑"
          footer={paired
            ? "换电脑、或安全码对不上时重新配一次。"
            : "还没配对 —— 配完才看得到会话。"}
        >
          <Row label={paired ? "已配对" : "未配对"} leading={<Dot tone={paired ? "ok" : "warn"} />} />
          <Row label="重新配对" chevron onPress={() => navigation.navigate("Pair")} />
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

