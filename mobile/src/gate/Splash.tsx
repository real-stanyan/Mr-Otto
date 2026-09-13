// 冷启动那一屏：一张脸 + 一条细进度条，压在波场上（demo 的 splash，同桌面 Splash.tsx）。
// 进度是真实启动步数与最短停留两半合成（shared/splashProgress.ts），两边都满才放行——
// 启动其实只要一两百毫秒，不掺停留那半，这一屏就是一闪而过。
import { Image, View } from "react-native";
import { usePalette, withAlpha } from "../theme.js";

const TRACK = 160;

export function Splash({ progress }: { progress: number }) {
  const { c } = usePalette();
  return (
    <View style={{ alignItems: "center", gap: 24 }}>
      {/* 阴影在外层：Image 的圆角会把它自己的阴影一起裁掉 */}
      <View style={{
        borderRadius: 24, shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25,
        shadowOffset: { width: 0, height: 25 },
      }}>
        <Image source={require("../../assets/otto.png")} style={{ width: 96, height: 96, borderRadius: 24 }} />
      </View>
      <View style={{
        width: TRACK, height: 3, borderRadius: 2, overflow: "hidden",
        backgroundColor: withAlpha(c.foreground, 0.15),
      }}>
        <View style={{
          width: TRACK * Math.min(1, Math.max(0, progress)), height: 3, borderRadius: 2,
          backgroundColor: withAlpha(c.foreground, 0.8),
        }} />
      </View>
    </View>
  );
}
