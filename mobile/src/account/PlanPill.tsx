// 档位那枚小药丸（#1356 A5；demo 的 .pill）。四色与桌面 PlanBadge 同一套语义（ADR-0240）：Free 弱色、Lite 绿、Pro 点缀蓝、
// Max 橙——`warn` 在别处的意思是「出事了」，Max 借形不借义（桌面那边记着同一笔账）。
import { Text, View } from "react-native";
import type { PlanBadgeId } from "../../../src/shared/billingView.js";
import { usePalette, withAlpha } from "../theme.js";

export function PlanPill({ id, label }: { id: PlanBadgeId; label: string }) {
  const { c } = usePalette();
  const fg = id === "lite" ? c.ok : id === "pro" ? c.brand : id === "max" ? c.warn : c.mutedForeground;
  return (
    <View style={{
      height: 24, paddingHorizontal: 9, borderRadius: 999, justifyContent: "center",
      backgroundColor: id === "free" ? c.secondary : withAlpha(fg, 0.18),
    }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg }}>{label}</Text>
    </View>
  );
}
