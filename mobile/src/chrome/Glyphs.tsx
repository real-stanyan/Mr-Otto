// 用 View 画的几个小图标（#1356 A1 / A2）：返回 / 关闭 / 新建 / 设置 / 搜索 / 发送。沿用 ui.tsx 里
// Chevron 的做法——不为几个形状引一个图标依赖。颜色一律由调用方给（前景色 / 弱色 / 反白）。
import { View } from "react-native";

/** ‹ 返回：两道边转 45°（ui.tsx 的 Chevron 反过来） */
export function BackGlyph({ color, size = 11 }: { color: string; size?: number }) {
  return (
    <View style={{
      width: size, height: size, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderColor: color,
      transform: [{ rotate: "45deg" }], marginLeft: size * 0.4,
    }} />
  );
}

/** × 关闭：两根交叉的细条 */
export function CloseGlyph({ color, size = 14 }: { color: string; size?: number }) {
  const bar = { position: "absolute" as const, width: size * 1.25, height: 2, borderRadius: 1, backgroundColor: color };
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

/** ＋ 新建：一横一竖两根细条（CloseGlyph 不转 45°，粗细同 BackGlyph 的 2.2） */
export function PlusGlyph({ color, size = 16 }: { color: string; size?: number }) {
  const bar = { position: "absolute" as const, borderRadius: 1.1, backgroundColor: color };
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { width: size, height: 2.2 }]} />
      <View style={[bar, { width: 2.2, height: size }]} />
    </View>
  );
}

/** ⋯ 设置：三个点 */
export function MoreGlyph({ color }: { color: string }) {
  const dot = { width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: color };
  return (
    <View style={{ flexDirection: "row", gap: 3.5 }}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

/** 放大镜：一个圈 + 右下一根柄 */
export function SearchGlyph({ color, size = 16 }: { color: string; size?: number }) {
  const ring = size * 0.72;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{
        position: "absolute", left: 0, top: 0, width: ring, height: ring,
        borderRadius: ring / 2, borderWidth: 2, borderColor: color,
      }} />
      <View style={{
        position: "absolute", left: ring * 0.72, top: ring * 0.92, width: size * 0.42, height: 2,
        borderRadius: 1, backgroundColor: color, transform: [{ rotate: "45deg" }],
      }} />
    </View>
  );
}

/** ↑ 发送：一道竖杆 + 顶上一个尖 */
export function SendGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 16, height: 16, alignItems: "center" }}>
      <View style={{
        width: 9, height: 9, borderLeftWidth: 2.2, borderTopWidth: 2.2, borderColor: color,
        transform: [{ rotate: "45deg" }], marginTop: 2,
      }} />
      <View style={{ position: "absolute", top: 2.5, width: 2.2, height: 13, borderRadius: 1.1, backgroundColor: color }} />
    </View>
  );
}
