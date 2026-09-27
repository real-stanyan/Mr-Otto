// 订阅（#1356 A5，spec §5.8）：几张档位卡 + 管理订阅。判据在 shared 的 mobileAccount（planOffers / subscriptionNotes）。
// 钮的去处（ADR-0203 决定 18）：没订阅 → checkout 开一张；订着的人换档 → Customer Portal（再开一张 checkout 会变成
// 两条订阅、两笔一起扣，网关回 409）。支付页开在 App 内浏览器里（整屏升起、左上「完成」），关掉那一刻重拉订阅。
// 不走 IAP（spec §12 第 6 条）：手机端不上架，上架那天要重判。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect } from "react";
import { AppState, Text, View } from "react-native";
import {
  planOffers, subscriptionNotes, SUBSCRIPTION_FOOTER, type PlanOfferAction, type PlanOfferView,
} from "../../../src/shared/mobileAccount.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { type as t, space, usePalette, withAlpha } from "../theme.js";
import { Button, Card, Hint, Note, Page, Spinner, StatusLine } from "../ui.js";
import { openBillingLink, refreshBilling, useBilling, type BillingLinkTarget } from "./billingStore.js";

export function SubscriptionScreen() {
  const { c } = usePalette();
  const { billing, loaded, loadError, link } = useBilling();

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

  const me = billing?.me ?? null;
  if (me === null) {
    // 还没查到 ≠ 没订阅：不画任何一张卡（画出来就是替他下了结论）
    return (
      <Page>
        {loaded && loadError !== null ? (
          <View style={{ gap: space.sm }}>
            <Note tone="warn">{loadError}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshBilling()} />
            </View>
          </View>
        ) : (
          <Spinner />
        )}
      </Page>
    );
  }

  const offers = planOffers(me);
  const notes = subscriptionNotes(me);
  const busy = link.kind === "opening" || link.kind === "syncing";
  const opening = (key: string): boolean => link.kind === "opening" && link.key === key;
  const open = (target: BillingLinkTarget, key: string): void => {
    void openBillingLink(target, key);
  };
  const act = (key: string, a: PlanOfferAction): void =>
    open(a.kind === "checkout" ? { kind: "checkout", planId: a.planId } : { kind: "portal" }, key);

  return (
    <Page>
      <View style={{ gap: space.md }}>
        {link.kind === "syncing" ? <StatusLine tone="busy">正在从 Stripe 同步…</StatusLine> : null}
        {link.kind === "error" ? <Note tone="error">{link.message}</Note> : null}
        {loadError !== null ? <Note tone="warn">{loadError}</Note> : null}
        {notes.pastDue !== null ? (
          <Card>
            <Text style={{ ...t.callout, color: c.warn }}>{notes.pastDue}</Text>
            <Button
              size="compact"
              label={opening("pastDue") ? "正在打开…" : "更新付款方式"}
              disabled={busy}
              onPress={() => open({ kind: "portal" }, "pastDue")}
            />
          </Card>
        ) : null}
        {offers.map((o) => (
          <PlanCard key={o.key} offer={o} opening={opening(o.key)} disabled={busy} onAction={(a) => act(o.key, a)} />
        ))}
        {notes.period !== null ? <Hint>{notes.period}</Hint> : null}
        <Hint>{SUBSCRIPTION_FOOTER}</Hint>
        {notes.canManage ? (
          <Button
            variant="secondary"
            label={opening("manage") ? "正在打开…" : "管理订阅 · 发票"}
            disabled={busy}
            onPress={() => open({ kind: "portal" }, "manage")}
          />
        ) : null}
      </View>
    </Page>
  );
}

/** 一张档位卡（demo 的 subscription 那几张 .card）：名字 + 价格一行、下面几行「带什么」、最底下那颗钮。
    当前这一档一圈点缀色边 +「你在这一档」；Free 是虚线、透明底、没有钮（它不是一件可买的东西） */
function PlanCard({ offer, opening, disabled, onAction }: {
  offer: PlanOfferView;
  opening: boolean;
  disabled: boolean;
  onAction: (a: PlanOfferAction) => void;
}) {
  const { c } = usePalette();
  const frame = offer.current
    ? { borderWidth: 1.5, borderColor: c.brand }
    : offer.free
      ? { borderStyle: "dashed" as const, borderWidth: 1, borderColor: c.border, backgroundColor: "transparent" }
      : null;
  const action = offer.action;
  return (
    <Card style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 18, lineHeight: 23, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }}>{offer.name}</Text>
        {offer.current ? (
          <View style={{ height: 22, paddingHorizontal: 9, borderRadius: 999, justifyContent: "center", backgroundColor: withAlpha(c.brand, 0.18) }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: c.brand }}>你在这一档</Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: "600", color: c.foreground }}>{offer.price}</Text>
      </View>
      <View style={{ gap: 6 }}>
        {offer.lines.map((l) => (
          <View key={l.text} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <View style={{ width: 14, paddingTop: 4, alignItems: "center" }}>
              {l.ok ? (
                <CheckGlyph color={c.ok} size={12} />
              ) : (
                <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: c.mutedForeground, marginTop: 5 }} />
              )}
            </View>
            <Text style={{ ...t.callout, color: l.ok ? c.foreground : c.mutedForeground, flex: 1 }}>{l.text}</Text>
          </View>
        ))}
      </View>
      {action !== null ? (
        <Button
          size="compact"
          variant={action.kind === "checkout" ? "primary" : "outline"}
          label={opening ? "正在打开…" : action.label}
          disabled={disabled}
          onPress={() => onAction(action)}
        />
      ) : null}
    </Card>
  );
}
