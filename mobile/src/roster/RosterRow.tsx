// 名册一行（#1356 A1，spec §5.2 / §4）：脸 m 档 | 名字（16.5 / 600）+ 小字 / 第二行（一行截断）| 时间。
// 三格文字由 shared/mobileRoster.ts 算好（sub / line2 / timeTs），这里只画。
// 不画「在跑没在跑」、不画未读（#722 / #1282）：名册查不到谁在跑，画一个恒灰的点就是撒谎的勾。
// 按下整行变色（列表行的语汇），不缩放。
import { Pressable, Text, View } from "react-native";
import { rosterRowLabel, rosterTimeLabel, type RosterItem } from "../../../src/shared/mobileRoster.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { Face } from "../face/Face.js";
import { GroupFaces } from "../face/GroupFaces.js";
import { type as t, usePalette, withAlpha } from "../theme.js";

export function RosterRow({ item, now, onPress }: { item: RosterItem; now: number; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rosterRowLabel(item, now)}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10 },
        pressed && { backgroundColor: withAlpha(c.foreground, 0.07) },
      ]}
    >
      {item.kind === "agent" ? (
        <Face slot={item.slot} state="alive" tier="m" phase={facePhase(item.agentId)} />
      ) : (
        <GroupFaces agentIds={item.agentIds} slots={item.slots} height={52} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1}>
          <Text style={{ fontSize: 16.5, fontWeight: "600", letterSpacing: -0.2, color: c.foreground }}>{item.name}</Text>
          {item.sub !== "" ? <Text style={{ fontSize: 13, color: c.mutedForeground }}>{`  ${item.sub}`}</Text> : null}
        </Text>
        {item.line2 !== null ? (
          <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 19, color: c.mutedForeground }}>{item.line2}</Text>
        ) : null}
      </View>
      {item.timeTs !== null ? (
        <Text style={{ ...t.footnote, color: c.mutedForeground, alignSelf: "flex-start", marginTop: 6 }}>
          {rosterTimeLabel(item.timeTs, now)}
        </Text>
      ) : null}
    </Pressable>
  );
}
