// 电话那一格的四枚图标（#1356 A4）：路径逐字取自 demo 的图标表（wave / mic / kbd / hang），24×24 的描边
// 图标，用 react-native-svg 画——别的 Glyph 是用 View 拼的，这几枚的曲线拼不出来。
import Svg, { Path } from "react-native-svg";

function Stroke({ d, color, size, weight }: { d: string; color: string; size: number; weight: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** 声浪：「开电话」那颗钮、通话卡的记号 */
export function WaveGlyph({ color, size = 20, weight = 2 }: { color: string; size?: number; weight?: number }) {
  return <Stroke d="M2 12h3l2-7 3 14 3-10 2 5h7" color={color} size={size} weight={weight} />;
}

/** 麦克风：静音那颗 */
export function MicGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return <Stroke d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" color={color} size={size} weight={2} />;
}

/** 键盘：转文字那颗 */
export function KeyboardGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return <Stroke d="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10" color={color} size={size} weight={2} />;
}

/** 听筒：挂断那颗 */
export function HangUpGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Stroke
      d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"
      color={color}
      size={size}
      weight={2.2}
    />
  );
}
