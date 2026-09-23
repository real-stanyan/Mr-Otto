// Face —— 智能体的像素脸（#1356，spec §3.1）。判断全在 src/shared/ottoFace/（纯函数，进 vitest），
// 这里只把算好的几层画成 SVG：每种颜色一条 Path，viewBox 就是网格本身，缩放交给 SVG。
//
// · **盒子按脸的真实尺寸给**（网格 × 档位），不裁、不加圆底——demo 里被裁过三次。
// · 深色底上多画一圈浅色描边：这批脸的头发是纯黑的，贴在 #000 上整颗头会糊成一团。
// · 角标画在右上角：一个圆点 + 外圈一道 ringColor 的环，把它与头发隔开（桌面画在圆盘右下，
//   手机没有圆盘）。角标 = 声称，所以只有状态表里带角标的那几档才画。
// · **动不动由状态自己说**（faceAnimates），不另给开关；系统「减弱动态效果」开着时一律静止一帧。
//   会动的脸订阅一口共用的 25fps 钟，每拍只算 motion 键，键没变就不重画。
import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { DISC_COLOR, GRID_H, GRID_W, faceAnimates, type FaceState } from "../../../src/shared/ottoFace/index.js";
import { createFaceArtCache, faceArtKey, faceBox, type FaceTier } from "../../../src/shared/ottoFace/art.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { subscribeFaceClock } from "./clock.js";

const artOf = createFaceArtCache();

/** 角标半径（格）、它离右上角的系数、外环倍数——比例口径同桌面 paint.ts（BADGE_R / INSET / RING） */
const BADGE_R = GRID_H * 0.14;
const BADGE_INSET = 1.1;
const BADGE_RING = 1.42;
/** 离线那一档整张脸压到这个透明度（同 paint.ts 的 DIM_ALPHA） */
const DIM_ALPHA = 0.45;

export const Face = memo(function Face({ slot, state = "plain", tier = "m", phase = 0, label, ringColor }: {
  slot: number;
  state?: FaceState;
  tier?: FaceTier;
  phase?: number;
  label?: string;
  ringColor?: string;
}) {
  const { c, isDark } = usePalette();
  const reduce = useReduceMotion();
  const animated = faceAnimates(state) && !reduce;
  const [t, setT] = useState(0);

  useEffect(() => {
    if (!animated) return;
    let last = "";
    return subscribeFaceClock((now) => {
      const at = now + phase;
      const k = faceArtKey(slot, state, at);
      if (k === last) return;
      last = k;
      setT(at);
    });
  }, [animated, slot, state, phase]);

  const art = artOf(slot, state, animated ? t : 0);
  const { w, h } = faceBox(tier);
  const cx = GRID_W - BADGE_R * BADGE_INSET;
  const cy = BADGE_R * BADGE_INSET;

  return (
    <View
      style={{ width: w, height: h }}
      {...(label === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label })}
    >
      <Svg width={w} height={h} viewBox={`0 0 ${GRID_W} ${GRID_H}`}>
        {isDark && art.rim !== "" ? <Path d={art.rim} fill={DISC_COLOR} /> : null}
        <G opacity={art.dim ? DIM_ALPHA : 1}>
          {art.layers.map((l) => <Path key={l.tone} d={l.d} fill={l.color} />)}
        </G>
        {art.badge !== null ? (
          <G>
            <Circle cx={cx} cy={cy} r={BADGE_R * BADGE_RING} fill={ringColor ?? c.background} />
            <Circle cx={cx} cy={cy} r={BADGE_R} fill={art.badge} />
          </G>
        ) : null}
      </Svg>
    </View>
  );
});
