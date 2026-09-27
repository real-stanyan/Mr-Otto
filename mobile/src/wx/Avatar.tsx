// 头像（#1386，照微信）：圆角方块，不是圆。三种——
// · 智能体 = 像素脸画在纸白底上（两个主题同一个值，DISC_COLOR），脸按「63 格宽」缩进去、往下挪 2 格
//   （demo 的 Face.draw 同一组数：63 比网格宽几格，四角多露一点底；往下挪是因为头发在上、下巴在下，
//   几何中心会让脸显得往上飘）。判断全在 src/shared/ottoFace/（art 那一层），这里只把几层 Path 摆进方块。
// · 人 = 头像图（profiles.avatar_url，data URL 或 https），没有就名字的第一个字；我 = 同样，底色反过来。
// · 群 = 九宫格拼图（不满的一行在最上面、居中，gridLayout），格子里是脸或首字。
// 会不会动由状态说（faceAnimates）：列表里一律 plain（静止一帧，名册查不到谁在跑，#722 / #1282），
// 只有此刻正在看的那一只（聊天页里打字的那张、通话那一张）才动。
import { memo, useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import Svg, { G, Path, Rect } from "react-native-svg";
import { DISC_COLOR, GRID_H, GRID_W, faceAnimates, type FaceState } from "../../../src/shared/ottoFace/index.js";
import { createFaceArtCache, faceArtKey } from "../../../src/shared/ottoFace/art.js";
import { gridLayout, initialOf, type AvatarSpec, type GridCell } from "../../../src/shared/wechatInbox.js";
import { subscribeFaceClock } from "../face/clock.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

const artOf = createFaceArtCache();
/** 方块宽几格（demo 的 CELLS） */
const CELLS = 63;
const VIEW = `${GRID_W / 2 - CELLS / 2} ${GRID_H / 2 - 2 - CELLS / 2} ${CELLS} ${CELLS}`;
const DIM_ALPHA = 0.45;

/** 圆角 = 边长的 16%（微信的比例） */
export function tileRadius(size: number): number {
  return Math.round(size * 0.16);
}

export const FaceTile = memo(function FaceTile({ slot, size, state = "plain", phase = 0, radius, label }: {
  slot: number;
  size: number;
  state?: FaceState;
  phase?: number;
  radius?: number;
  label?: string;
}) {
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
  return (
    <View
      style={{ width: size, height: size, borderRadius: radius ?? tileRadius(size), overflow: "hidden", backgroundColor: DISC_COLOR }}
      {...(label === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label })}
    >
      <Svg width={size} height={size} viewBox={VIEW}>
        <Rect x={GRID_W / 2 - CELLS / 2} y={GRID_H / 2 - 2 - CELLS / 2} width={CELLS} height={CELLS} fill={DISC_COLOR} />
        <G opacity={art.dim ? DIM_ALPHA : 1}>
          {art.layers.map((l) => <Path key={l.tone} d={l.d} fill={l.color} />)}
        </G>
      </Svg>
    </View>
  );
});

/** 一个人：有图画图，没图画名字的第一个字。`me` = 我自己那一格，底色反过来（demo 的 .me-av） */
export function PersonTile({ name, url, size, me = false, radius, label }: {
  name: string;
  url: string;
  size: number;
  me?: boolean;
  radius?: number;
  label?: string;
}) {
  const { c } = usePalette();
  const r = radius ?? tileRadius(size);
  const a11y = label === undefined
    ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
    : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label };
  if (url !== "") {
    return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: r, backgroundColor: c.secondary }} {...a11y} />;
  }
  return (
    <View
      style={{
        width: size, height: size, borderRadius: r, alignItems: "center", justifyContent: "center",
        backgroundColor: me ? c.foreground : c.secondary,
      }}
      {...a11y}
    >
      <Text style={{ fontSize: Math.round(size * 0.42), lineHeight: Math.round(size * 0.5), fontWeight: "600", color: me ? c.background : c.mutedForeground }}>
        {initialOf(name)}
      </Text>
    </View>
  );
}

/** 群：九宫格。格子里的脸不画底色以外的东西（小格上画不下角标），人是首字 */
export function GridTile({ cells, size, label }: { cells: readonly GridCell[]; size: number; label?: string }) {
  const { c } = usePalette();
  const { rows, cell, gap, pad } = gridLayout(cells.length, size);
  let k = 0;
  return (
    <View
      style={{
        width: size, height: size, borderRadius: tileRadius(size), overflow: "hidden", backgroundColor: c.secondary,
        padding: pad, justifyContent: "center", gap,
      }}
      {...(label === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label })}
    >
      {rows.map((n, ri) => (
        <View key={ri} style={{ flexDirection: "row", justifyContent: "center", gap }}>
          {Array.from({ length: n }, () => {
            const x = cells[k++]!;
            return x.kind === "face" ? (
              <FaceTile key={`${ri}-${x.id}-${k}`} slot={x.slot} size={cell} radius={2} />
            ) : x.url !== "" ? (
              <Image key={`${ri}-${k}`} source={{ uri: x.url }} style={{ width: cell, height: cell, borderRadius: 2 }} />
            ) : (
              <View
                key={`${ri}-${k}`}
                style={{ width: cell, height: cell, borderRadius: 2, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.12) }}
              >
                <Text style={{ fontSize: Math.max(7, cell * 0.5), fontWeight: "600", color: c.mutedForeground }}>{initialOf(x.name)}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** 按 shared 算好的头像说明画（会话列表、群聊列表用它） */
export function SpecAvatar({ spec, size }: { spec: AvatarSpec; size: number }) {
  if (spec.kind === "face") return <FaceTile slot={spec.slot} size={size} />;
  if (spec.kind === "person") return <PersonTile name={spec.name} url={spec.url} size={size} />;
  return <GridTile cells={spec.cells} size={size} />;
}
