// 应用图标位（#1430，demo 的 .tile）：首字母方块，中性浮起底 + 次级字色。手机包里还没有厂商 logo；
// 颜色只留给告警（needs_login 那一句走 warn），图标本身不上色。三档：行首 40、弹窗顶 40、详情页 hero 64。
import { Text, View } from "react-native";
import { appInitial } from "../../../src/shared/mobileConnectors.js";
import { usePalette } from "../theme.js";

export function AppTile({ name, size = 40 }: { name: string; size?: 40 | 64 }) {
  const { c } = usePalette();
  const big = size === 64;
  return (
    <View
      style={{
        width: size, height: size, borderRadius: big ? 15 : 9, backgroundColor: c.muted,
        alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: big ? 28 : 17, fontWeight: "600", color: c.mutedForeground }}>{appInitial(name)}</Text>
    </View>
  );
}
