// 这周用了多少（#1356 A5，spec §5.8）：这一周智能体们用掉了你周额度的百分之几、谁用掉的。**不报钱，报占比**
// （ADR-0264 决策 9：云端那几轮烧的是你的订阅额度，那笔钱在月费里）。判据是桌面那一份（workspaceUsageView，A5 挪进
// shared）+ 手机说法（mobileMachine）；分母读不到时报调用次数，组尾说清换了口径。读不到 ≠ 空：上一份照画。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { USAGE_EMPTY, usageHeroText, usageNote, usageTone } from "../../../src/shared/mobileMachine.js";
import { usageHeadline, usageRows, usageScale, type UsageRowView } from "../../../src/shared/workspaceUsageView.js";
import { refreshBilling, useBilling } from "../account/billingStore.js";
import { toneColor } from "../account/QuotaCard.js";
import { Meter } from "../chrome/Meter.js";
import { Face } from "../face/Face.js";
import { useHome } from "../home/homeStore.js";
import { type as t, space, usePalette } from "../theme.js";
import { Avatar, Button, Card, Group, Hint, Note, Page, Spinner, useNow } from "../ui.js";
import { refreshUsage, useMachine } from "./machineStore.js";

export function UsageScreen() {
  const { c } = usePalette();
  const ws = useHome().home;
  const { usage: load } = useMachine();
  const { billing } = useBilling();
  const now = useNow(60_000);
  const homeId = ws?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (homeId !== null) void refreshUsage(homeId);
      void refreshBilling();
    }, [homeId]),
  );

  if (ws === null) {
    return <Page><Hint>还没有智能体，也就还没有用量。</Hint></Page>;
  }
  const usage = load.kind === "ok" ? load.usage : load.kind === "error" ? load.usage : null;
  const error = load.kind === "error" ? load.message : null;
  if (usage === null) {
    return (
      <Page>
        {error !== null ? (
          <View style={{ gap: space.sm }}>
            <Note tone="warn">{`读不到用量：${error}`}</Note>
            <View style={{ alignItems: "flex-start" }}>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshUsage(ws.id)} />
            </View>
          </View>
        ) : (
          <Spinner />
        )}
      </Page>
    );
  }

  const head = usageHeadline(usage);
  const rows = usageRows(ws, usage);
  return (
    <Page>
      <View style={{ gap: space.lg }}>
        {error !== null ? <Note tone="warn">{`这一刻读不到最新的用量（${error}），下面是上一次的。`}</Note> : null}
        <Card style={{ alignItems: "center", paddingVertical: 20 }}>
          <Text style={{ fontSize: 38, lineHeight: 44, fontWeight: "700", letterSpacing: -1, color: c.foreground }}>
            {head.percent ?? `${head.calls} 次`}
          </Text>
          <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>{usageHeroText(usage, billing, now)}</Text>
          {head.fill !== null ? (
            <Meter fill={head.fill} color={toneColor(c, usageTone(usage))} style={{ alignSelf: "stretch", marginTop: 4 }} />
          ) : null}
        </Card>
        {rows.length === 0 ? (
          <Hint>{USAGE_EMPTY}</Hint>
        ) : (
          <Group header="谁用掉的" footer={usageNote(usageScale(usage))}>
            {rows.map((r) => <UsageRow key={r.agentId === "" ? "_unattributed" : r.agentId} row={r} />)}
          </Group>
        )}
      </View>
    </Page>
  );
}

/** 用量那一行（demo 的 usage 那一列）：脸（名册里查不到的不给脸，退首字母——ADR-0264）+ 名字 + 百分比，底下一根淡条
    （这一只在这几只合计里的比重，各行加起来正好是 1——不按最大值归一化，那样花得最多的那只常年满格） */
function UsageRow({ row }: { row: UsageRowView }) {
  const { c } = usePalette();
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 11, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {row.avatar !== null ? <Face slot={row.avatar.slot} tier="s" label={row.name} /> : <Avatar name={row.name} size={26} />}
        <Text style={{ ...t.body, fontSize: 15, color: c.foreground, flex: 1, minWidth: 0 }} numberOfLines={1}>{row.name}</Text>
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>{row.percent}</Text>
      </View>
      <Meter fill={row.share} color={c.mutedForeground} dim />
    </View>
  );
}
