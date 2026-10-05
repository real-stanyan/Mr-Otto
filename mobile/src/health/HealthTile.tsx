// Apple 健康的方块（#1671）：同 AppTile 的中性浮起底与尺寸（行首 40、弹窗顶 40、详情页 hero 64），里面是一颗红心——
// 「健康」App 自己的标识色。别的应用的 logo 走 appIcons.generated（只认打进包的），健康不是目录条目，单独画。
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { usePalette } from "../theme.js";

const HEART =
  '<svg viewBox="0 0 24 24"><path fill="#ff2d55" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4h2c.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';

export function HealthTile({ size = 40, dim = false }: { size?: 40 | 64; dim?: boolean }) {
  const { c } = usePalette();
  const big = size === 64;
  const mark = big ? 38 : 24;
  return (
    <View
      style={{
        width: size, height: size, borderRadius: big ? 15 : 9, backgroundColor: c.muted,
        alignItems: "center", justifyContent: "center", opacity: dim ? 0.45 : 1,
      }}
    >
      <SvgXml xml={HEART} width={mark} height={mark} />
    </View>
  );
}
