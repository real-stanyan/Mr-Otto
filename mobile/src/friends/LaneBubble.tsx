// 车道的一行（#1461 P1；#1523 多了朋友说的与朋友的车道；#1565 搬出来给抽屉共用）：我说的靠右、智能体与朋友说的靠左，
// 气泡描一圈虚线、底下一行说这句谁看得到——它与人话混排时必须一眼分得出「这句朋友看不看得到」。
// 朋友公开给我的那条（peer）底色用朋友气泡那一色，与我自己的车道分得开
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { LaneItem } from "../../../src/shared/pairChat.js";
import { usePalette, withAlpha } from "../theme.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";

export function LaneBubble({ item, name, slot, meName, meAvatar, friendName: fname, friendAvatar, meTile, friendTile, footer, peer }: {
  item: LaneItem; name: string; slot: number; meName: string; meAvatar: string; friendName: string; friendAvatar: string;
  /** 私聊页给的两边头像（连同底下那排小圆脸，#1642）；缺席 = 光头像（抽屉里） */
  meTile?: ReactNode; friendTile?: ReactNode;
  /** 底下那一行：仅你可见 / 你和 TA 都看得到 / TA 的智能体 · 两人都看得到 / 下发给 X */
  footer: string;
  peer: boolean;
}) {
  const { c } = usePalette();
  const mine = item.who === "me";
  const tint = peer ? c.foreground : c.brand;
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {mine ? (meTile ?? <PersonTile name={meName} url={meAvatar} size={40} me />) : item.who === "friend" ? (friendTile ?? <PersonTile name={fname} url={friendAvatar} size={40} />) : <FaceTile slot={slot} size={40} />}
      <View style={{ flexShrink: 1, maxWidth: "76%", alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
        {mine ? null : <Text style={{ fontSize: 12, color: c.mutedForeground }}>{item.who === "friend" ? fname : name}</Text>}
        <View
          style={{
            paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
            backgroundColor: withAlpha(tint, 0.06), borderWidth: 1, borderStyle: "dashed", borderColor: withAlpha(tint, 0.35),
          }}
        >
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{item.text}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Icon name={peer || footer !== "仅你可见" ? "users-round" : "lock-keyhole"} size={11} stroke={2} color={c.faint} />
          <Text style={{ fontSize: 11, color: c.faint }}>{footer}</Text>
        </View>
      </View>
    </View>
  );
}
