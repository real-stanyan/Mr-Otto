// 图标（#1386）：lucide 的节点原样画成 react-native-svg（iconNodes.ts 是生成物）。描边粗细按用处给——
// 当前那一格底栏 2、别处 1.6~1.8，和 demo 同一组数。不为图标加字体依赖（expo-font 的图标字体要原生那一半）。
import { memo } from "react";
import Svg, { Circle, Ellipse, Line, Path, Polyline, Rect } from "react-native-svg";
import { ICON_NODES, type IconName, type IconNode } from "./iconNodes.js";

export type { IconName };

function node([tag, a]: IconNode, i: number) {
  const p = a as Record<string, string>;
  switch (tag) {
    case "path":
      return <Path key={i} d={p.d ?? ""} />;
    case "circle":
      return <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} />;
    case "rect":
      return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} ry={p.ry} />;
    case "line":
      return <Line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} />;
    case "polyline":
      return <Polyline key={i} points={p.points ?? ""} />;
    case "ellipse":
      return <Ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} />;
    default:
      return null;
  }
}

export const Icon = memo(function Icon({ name, size = 24, color, stroke = 1.75, fill = false }: {
  name: IconName;
  size?: number;
  color: string;
  stroke?: number;
  /** 填实（#1482）：桌面 `fill-current` 的同义——停钮那颗方块要的是实心，不是描边框。
      默认只描边，与改动前逐字相同 */
  fill?: boolean;
}) {
  const nodes = ICON_NODES[name] as readonly IconNode[];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? color : "none"}
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {nodes.map(node)}
    </Svg>
  );
});
