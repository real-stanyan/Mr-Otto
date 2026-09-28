// 角标（#1386）：数字是点缀色的小胶囊、只知道「有」不知道「几条」的是一枚点（spec §3.1）。
// 不是红色：这个 app 里红只用来说「出事了」（DESIGN.md），有新消息不是出事。
// 外面一圈底色的环，把它和压着的头像隔开（demo 的 box-shadow: 0 0 0 2px）。
import { Text, View } from "react-native";
import { BADGE_COLORS, type FaceBadge } from "../../../src/shared/ottoFace/index.js";
import { badgeText } from "../../../src/shared/wechatInbox.js";
import { usePalette } from "../theme.js";

/** 外面那圈环有多宽。盒子是 content-box（环画在外面），所以圆角要连环一起算：只给内容那一半会画成圆角方块 */
const RING = 2;

export function CountBadge({ n, ring }: { n: number; ring?: string }) {
  const { c } = usePalette();
  return (
    <View
      style={{
        minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9 + (ring === undefined ? 0 : RING), alignItems: "center", justifyContent: "center",
        backgroundColor: c.brand, borderWidth: ring === undefined ? 0 : RING, borderColor: ring ?? "transparent",
        boxSizing: "content-box",
      }}
    >
      <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "600", color: "#ffffff", fontVariant: ["tabular-nums"] }}>{badgeText(n)}</Text>
    </View>
  );
}

export function DotBadge({ ring, size = 10 }: { ring?: string; size?: number }) {
  const { c } = usePalette();
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2 + (ring === undefined ? 0 : RING), backgroundColor: c.brand,
        borderWidth: ring === undefined ? 0 : RING, borderColor: ring ?? "transparent", boxSizing: "content-box",
      }}
    />
  );
}

/** 状态角标（#1282，ADR-0316 的语义色）：头像右下一个圆点，外面一圈底色的环。右上是未读，两枚不打架。
    这里的红只在「出错」时出现，与上面那条「红只用来说出事了」同一个意思 */
export function StatusBadge({ badge, ring, size }: { badge: FaceBadge; ring: string; size: number }) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2 + RING, backgroundColor: BADGE_COLORS[badge],
        borderWidth: RING, borderColor: ring, boxSizing: "content-box",
      }}
    />
  );
}
