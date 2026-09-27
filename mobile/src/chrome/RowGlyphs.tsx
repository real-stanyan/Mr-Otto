// 设置类清单行左边那一格（#1356 A5）：demo 的 `.ico`——29×29、圆角 8、次级底，里面一枚 15pt 的描边图标。
// 路径逐字取自 demo 的图标表（24×24 视框、线宽 2、圆头圆角，同 VoiceGlyphs 的画法）。颜色缺省是前景色。
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { usePalette } from "../theme.js";

export type RowGlyphName = "spark" | "chart" | "cloud" | "gear" | "folder" | "file" | "image" | "plug" | "book";

const PATHS: Record<RowGlyphName, string> = {
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  chart: "M3 3v18h18M7 15l4-5 3 3 5-7",
  cloud: "M18 16.5a4 4 0 0 0-.9-7.9 6 6 0 0 0-11.5 1.9A3.5 3.5 0 0 0 6 17.5z",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  image: "M3 5h18v14H3zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5-9 9",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
};

export function RowGlyph({ name, color }: { name: RowGlyphName; color?: string }) {
  const { c } = usePalette();
  return (
    <View style={{ width: 29, height: 29, borderRadius: 8, backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
      <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color ?? c.foreground} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d={PATHS[name]} />
      </Svg>
    </View>
  );
}
