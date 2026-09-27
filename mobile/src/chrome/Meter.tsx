// 一根计量条（#1356 A5）：demo 的 `.meter` / `.ubar`——6pt 高、3pt 圆角，轨道是次级底色，填充色由调用方给
// （充足时弱色、快用完时 warn、用完 destructive——颜色只用来说「出事了」，ADR-0239）。dim = 用量页每一行那种淡一档的条
import { View, type StyleProp, type ViewStyle } from "react-native";
import { usePalette } from "../theme.js";

export function Meter({ fill, color, dim = false, style }: { fill: number; color: string; dim?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = usePalette();
  const pct = Math.round(Math.min(1, Math.max(0, fill)) * 1000) / 10;
  return (
    <View style={[{ height: 6, borderRadius: 3, backgroundColor: c.secondary, overflow: "hidden" }, style]}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 3, backgroundColor: color, opacity: dim ? 0.75 : 1 }} />
    </View>
  );
}
