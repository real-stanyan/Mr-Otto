// 两扇额度窗那张卡 + 额度的颜色（#1356 A5）：还剩百分之几、一根按剩余填的条、什么时候刷新。颜色只用来说「出事了」——
// 充足时是弱色（ADR-0239）。toneColor 与用量页的大数字共用这一份。
import { Text, View } from "react-native";
import type { AccountQuota, QuotaToneView } from "../../../src/shared/mobileAccount.js";
import { Meter } from "../chrome/Meter.js";
import { type as t, usePalette, type Palette } from "../theme.js";
import { Card } from "../ui.js";

export function toneColor(c: Palette, tone: QuotaToneView): string {
  return tone === "deny" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
}

/** 账号页那张卡（demo 的 account 两栏）：左 5h、右本周；还没查到写「正在查额度…」，没有窗时说为什么（shared 的 accountQuota） */
export function QuotaCard({ quota }: { quota: AccountQuota }) {
  const { c } = usePalette();
  if (quota.kind === "loading") {
    return <Card><Text style={{ ...t.callout, color: c.mutedForeground }}>正在查额度…</Text></Card>;
  }
  if (quota.kind === "none") {
    return <Card><Text style={{ ...t.callout, color: c.mutedForeground }}>{quota.text}</Text></Card>;
  }
  return (
    <Card>
      <View style={{ flexDirection: "row", gap: 18 }}>
        {quota.windows.map((w) => (
          <View key={w.key} style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ ...t.footnote, color: c.mutedForeground }}>{w.label}</Text>
            <Text style={{ marginTop: 1 }} numberOfLines={1}>
              <Text style={{ fontSize: 20, lineHeight: 25, fontWeight: "600", color: w.tone === "neutral" ? c.foreground : toneColor(c, w.tone) }}>
                {w.remaining}
              </Text>
              <Text style={{ ...t.footnote, color: c.mutedForeground }}> 可用</Text>
            </Text>
            <Meter fill={w.fill} color={toneColor(c, w.tone)} style={{ marginTop: 7 }} />
            <Text style={{ ...t.footnote, color: c.mutedForeground, opacity: 0.7, marginTop: 6 }} numberOfLines={1}>{w.refresh}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
