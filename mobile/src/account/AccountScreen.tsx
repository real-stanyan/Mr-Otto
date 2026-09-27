// 账号页（#1356 A5，spec §5.8；A0 那版只有邮箱 + 退出 + 连接诊断）。从上往下：我是谁（首字圆 + 名字 + 邮箱 + 档位）
// → 两扇额度窗（还剩百分之几）→ 订阅 / 这周用了多少 / 它们共用的一台电脑 → 设置 → 退出。判据全在 shared 的
// mobileAccount（还没查到 ≠ 没订阅，ADR-0240）；连接诊断挪进了「设置」。后两行只在有主场时画（没有它们就没有可看的）。
// 头像圆是实色点缀色，不是 demo 的渐变（渐变要 expo-linear-gradient，不为一个圆加依赖）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import {
  ACCOUNT_FOOTER, accountBadge, accountInitial, accountName, accountQuota, subscriptionValue,
} from "../../../src/shared/mobileAccount.js";
import { machineShareText } from "../../../src/shared/mobileMachine.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { NoticeLine } from "../gate/NoticeLine.js";
import { useHome } from "../home/homeStore.js";
import { supabase } from "../supabase.js";
import { type as t, space, usePalette } from "../theme.js";
import { Group, Note, Page, Row, useNow } from "../ui.js";
import { refreshBilling, useBilling } from "./billingStore.js";
import { PlanPill } from "./PlanPill.js";
import { QuotaCard } from "./QuotaCard.js";

export function AccountScreen() {
  const { c } = usePalette();
  const navigation = useNavigation();
  const ws = useHome().home;
  const { billing, loadError } = useBilling();
  const now = useNow(60_000);
  const [who, setWho] = useState<{ name: string; email: string | null } | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      setWho({ name: accountName(u), email: u?.email ?? null });
    });
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refreshBilling();
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshBilling();
    });
    return () => sub.remove();
  }, []);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住，这一屏不用管。
  // 但登出会失败：断网而 access token 又过期时，supabase 刷新不了 session，就原样留着本地那份、
  // 也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生（A0 原话）
  const [busy, setBusy] = useState(false);
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

  const name = who?.name ?? "";
  const badge = accountBadge(billing);
  const sub = subscriptionValue(billing);
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 4 }}>
          <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: c.brand, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 22, fontWeight: "600", color: c.primaryForeground }}>{accountInitial(name)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 20, lineHeight: 25, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }} numberOfLines={1}>
              {who === null ? "读取中…" : name}
            </Text>
            {who?.email ? <Text style={{ ...t.footnote, color: c.mutedForeground }} numberOfLines={1}>{who.email}</Text> : null}
          </View>
          {badge !== null ? <PlanPill id={badge.id} label={badge.label} /> : null}
        </View>

        {loadError !== null ? <Note tone="warn">{loadError}</Note> : null}
        <QuotaCard quota={accountQuota(billing, now)} />

        <Group>
          <Row
            leading={<RowGlyph name="spark" />}
            label="订阅"
            {...(sub === null ? {} : { value: sub })}
            chevron
            onPress={() => navigation.navigate("Subscription")}
          />
          {ws !== null ? (
            <Row leading={<RowGlyph name="chart" />} label="这周用了多少" chevron onPress={() => navigation.navigate("Usage")} />
          ) : null}
          {ws !== null ? (
            <Row
              leading={<RowGlyph name="cloud" />}
              label="它们共用的一台电脑"
              detail={machineShareText(ws)}
              chevron
              onPress={() => navigation.navigate("Machine")}
            />
          ) : null}
        </Group>

        <Group>
          <Row leading={<RowGlyph name="gear" />} label="设置" chevron onPress={() => navigation.navigate("Settings")} />
        </Group>

        <Group footer={ACCOUNT_FOOTER}>
          <Row label={busy ? "退出中…" : "退出登录"} align="center" tone="destructive" disabled={busy} onPress={signOut} />
        </Group>
        {signOutNotice ? <NoticeLine notice={signOutNotice} /> : null}
      </View>
    </Page>
  );
}
