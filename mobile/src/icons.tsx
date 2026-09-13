// 图标。路径逐字取自 demo 的图标表（.demo/mobile-app-redesign.html 里 `const P=` 那张），
// 24×24 视框、描边、圆头圆角——和过目的那版是同一份图形。用到哪个才抄哪个进来。
// 不引 lucide-react-native（spec §10）：demo 的 spark 不是 lucide 原图。
import Svg, { Path } from "react-native-svg";

const PATHS = {
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  git: "M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 12a9 9 0 0 1-9 9",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, stroke = 1.7, color }: {
  name: IconName;
  size?: number;
  stroke?: number;
  color: string;
}) {
  return (
    <Svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    >
      <Path d={PATHS[name]} />
    </Svg>
  );
}
