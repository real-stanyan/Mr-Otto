// 应用图标位（#1430，demo 的 .tile；logo 是 #1437 加的）：中性浮起底的圆角方块，里面坐着这个应用自己的 logo。
// logo 只认打进包的那一批（appIcons.generated.ts，与桌面 McpEntryIcon 同一套资源，**永远不接远程 URL**）；
// 没有的（自己配的 server、目录里没配图标的）退回首字母。三档画法同桌面：
//   mono  —— 只取形状，颜色跟主题前景色走（生成时已把写死的颜色换成 currentColor）
//   color —— 品牌色照原样画
//   png   —— 有一批牌子不发 SVG 标
// 颜色只留给告警（needs_login 那一句走 warn）。三处尺寸：行首 40、弹窗顶 40、详情页 hero 64。
import { Image, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { appInitial } from "../../../src/shared/mobileConnectors.js";
import { usePalette } from "../theme.js";
import { APP_ICON_PNG, APP_ICON_SVG } from "./appIcons.generated.js";

export function AppTile({ name, icon = null, size = 40 }: { name: string; icon?: string | null; size?: 40 | 64 }) {
  const { c } = usePalette();
  const big = size === 64;
  const mark = big ? 38 : 24;
  const xml = icon === null ? undefined : APP_ICON_SVG[icon];
  const bitmap = icon === null ? undefined : APP_ICON_PNG[icon];
  return (
    <View
      style={{
        width: size, height: size, borderRadius: big ? 15 : 9, backgroundColor: c.muted,
        alignItems: "center", justifyContent: "center",
      }}
    >
      {xml !== undefined ? (
        <SvgXml xml={xml} width={mark} height={mark} color={c.foreground} />
      ) : bitmap !== undefined ? (
        <Image source={bitmap} style={{ width: mark, height: mark }} resizeMode="contain" />
      ) : (
        <Text style={{ fontSize: big ? 28 : 17, fontWeight: "600", color: c.mutedForeground }}>{appInitial(name)}</Text>
      )}
    </View>
  );
}
