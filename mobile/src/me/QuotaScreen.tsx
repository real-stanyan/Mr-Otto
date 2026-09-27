// 订阅与额度（#1386，spec §5.9，demo 的 mePage("quota")）：只画本周一格——还剩百分之几、一根按剩余填的条、
// 什么时候刷新。颜色只说「出事了」：充足时是弱色（ADR-0239）。5 小时那扇窗此刻比本周更紧且告急时，底下一句实话
// （真规矩没动，shared 的 weekQuota）。下面当前档位 + 订阅 / 换档（A5 那一页）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { accountBadge, weekQuota } from "../../../src/shared/mobileAccount.js";
import { PlanPill } from "../account/PlanPill.js";
import { toneColor } from "../account/tone.js";
import { refreshBilling, useBilling } from "../account/billingStore.js";
import { Meter } from "../chrome/Meter.js";
import { usePalette } from "../theme.js";
import { Group, Inset, ListPage, Note, Row, Spinner, useNow } from "../ui.js";

export function QuotaScreen() {
  const { c } = usePalette();
  const navigation = useNavigation();
  const { billing, loaded, loadError } = useBilling();
  const now = useNow(60_000);
  useFocusEffect(
    useCallback(() => {
      void refreshBilling();
    }, []),
  );
  const q = weekQuota(billing, now, loaded && loadError !== null);
  const badge = accountBadge(billing);
  return (
    <ListPage>
      {loadError !== null && billing !== null ? (
        <Inset><Note tone="warn">{loadError}</Note></Inset>
      ) : null}
      <Text style={{ fontSize: 13, lineHeight: 19, color: c.mutedForeground, paddingHorizontal: 16, paddingTop: 6 }}>
        智能体干活用的是你订阅的额度，按周算。
      </Text>
      {q.kind === "loading" ? (
        <View style={{ padding: 24 }}><Spinner /></View>
      ) : q.kind === "none" ? (
        <Inset><Text style={{ fontSize: 15, lineHeight: 22, color: c.mutedForeground }}>{q.text}</Text></Inset>
      ) : (
        <View style={{ marginHorizontal: 12, padding: 14, borderRadius: 14, backgroundColor: c.card, gap: 8 }}>
          <Text style={{ fontSize: 13, color: c.mutedForeground }}>本周</Text>
          <Text>
            <Text style={{ fontSize: 26, fontWeight: "600", letterSpacing: -0.3, color: q.week.tone === "neutral" ? c.foreground : toneColor(c, q.week.tone), fontVariant: ["tabular-nums"] }}>
              {q.week.remaining}
            </Text>
            <Text style={{ fontSize: 13, color: c.mutedForeground }}>  还剩</Text>
          </Text>
          <Meter fill={q.week.fill} color={toneColor(c, q.week.tone)} />
          <Text style={{ fontSize: 12, color: c.faint }}>{q.week.refresh}</Text>
          {q.h5Note !== null ? <Text style={{ fontSize: 13, lineHeight: 19, color: c.warn }}>{q.h5Note}</Text> : null}
        </View>
      )}
      <Group>
        <Row label="当前档位" trailing={badge !== null ? <PlanPill id={badge.id} label={badge.label} /> : undefined} />
        <Row label="订阅与换档" chevron onPress={() => navigation.navigate("Subscription")} />
      </Group>
    </ListPage>
  );
}
